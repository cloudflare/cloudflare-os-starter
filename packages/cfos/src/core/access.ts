// Cloudflare Access in front of a deployment: the self-hosted application covering the router's
// hostname, found if one already does and created if not. Idempotent -- an application already
// covering the hostname is reused, never duplicated, so re-running after a partial setup is safe.
//
// The application it creates admits exactly `access.admins`, by email. That is the narrowest policy
// that works; widening it (an email domain, an IdP group) is a dashboard decision, not a default.

import {
  CfAuthError,
  CfError,
  CfUnavailableError,
  accessAppCovers,
  issuerOf,
  type CfAccessApp,
  type CloudflareClient,
} from "./client.ts";
import { isPlaceholder, valueAtPath, type DeploymentEdit } from "./edits.ts";

const accountIdPattern = /^[a-f\d]{32}$/i;

/** Where to create a Zero Trust organization. */
export const ZERO_TRUST_SETUP = "https://developers.cloudflare.com/cloudflare-one/setup/";

/** What Access setup needs to know about a deployment. */
export interface AccessTarget {
  accountId: string;
  routerName: string;
  /** The hostname users reach the router on, and so the one Access has to cover. */
  host: string;
  admins: string[];
}

/** Whether `text` is one email address, as Access policies and `access.admins` take it. */
export function isEmail(text: string): boolean {
  return /^[^@\s<>]+@[^@\s<>]+$/.test(text);
}

/**
 * The inputs from a `deployment.jsonc` whose `access.issuer`/`audience` are still placeholders.
 * Checks only what Access setup depends on; everything else is `validateConfig`'s.
 */
export function accessTarget(file: Record<string, unknown>, where = "deployment.jsonc"): AccessTarget {
  const accountId = valueAtPath(file, ["accountId"]);
  if (typeof accountId !== "string" || !accountIdPattern.test(accountId)) {
    throw new Error(`${where}: set accountId (32 hexadecimal characters) first.`);
  }
  const routerName = valueAtPath(file, ["workers", "router", "name"]);
  if (typeof routerName !== "string" || !routerName || isPlaceholder(routerName)) {
    throw new Error(`${where}: set workers.router.name first; the Access application is named after it.`);
  }
  const customDomain = valueAtPath(file, ["workers", "router", "route", "customDomain"]);
  const workersDev = valueAtPath(file, ["workers", "router", "route", "workersDev"]);
  const publicBaseUrl = valueAtPath(file, ["publicBaseUrl"]);
  let host: string | undefined;
  if (typeof customDomain === "string" && customDomain && !isPlaceholder(customDomain)) {
    host = customDomain.toLowerCase();
  } else if (workersDev === true && typeof publicBaseUrl === "string" && !isPlaceholder(publicBaseUrl)) {
    try {
      host = new URL(publicBaseUrl).host.toLowerCase();
    } catch {
      host = undefined;
    }
  }
  if (!host) {
    throw new Error(
      `${where}: no hostname to protect. Set workers.router.route.customDomain, or on a workersDev ` +
      "route set publicBaseUrl to https://<router-name>.<subdomain>.workers.dev.");
  }
  const admins = valueAtPath(file, ["access", "admins"]);
  if (!Array.isArray(admins) || !admins.length ||
      !admins.every((email) => typeof email === "string" && isEmail(email))) {
    throw new Error(
      `${where}: set access.admins to at least one email address first. The new Access ` +
      "application admits exactly those addresses.");
  }
  return { accountId, routerName, host, admins: admins as string[] };
}

/** The Access application body for a fresh install. */
export function applicationBody(target: AccessTarget): Record<string, unknown> {
  return {
    type: "self_hosted",
    name: `Cloudflare OS ${target.routerName}`,
    domain: target.host,
    session_duration: "24h",
    // Inline, so the policy belongs to this application rather than becoming a reusable one other
    // applications could be attached to by mistake.
    policies: [{
      name: "Cloudflare OS admins",
      decision: "allow",
      include: target.admins.map((email) => ({ email: { email } })),
    }],
  };
}

/** The `deployment.jsonc` values for an application. */
export function accessEdits(issuer: string, app: CfAccessApp): DeploymentEdit[] {
  return [
    { path: ["access", "issuer"], value: issuer },
    { path: ["access", "audience"], value: app.aud },
  ];
}

/** What {@link lookupAccess} found. */
export type AccessLookup =
  /** Access cannot work here yet: no organization, or one without a team domain. */
  | { kind: "no-organization"; reason: string }
  | { kind: "found"; issuer: string; app: CfAccessApp }
  | { kind: "missing"; issuer: string };

/** The account's issuer, and the application already covering `target.host` if there is one. */
export async function lookupAccess(client: CloudflareClient, target: AccessTarget): Promise<AccessLookup> {
  let issuer: string | undefined;
  try {
    issuer = issuerOf(await client.getOrganization(target.accountId));
  } catch (error) {
    if (error instanceof CfAuthError || error instanceof CfUnavailableError) throw error;
    return {
      kind: "no-organization",
      reason: `Could not read the account's Zero Trust organization (${(error as Error).message}). ` +
        `Access needs one: create a team at ${ZERO_TRUST_SETUP}.`,
    };
  }
  if (!issuer) {
    return {
      kind: "no-organization",
      reason: `The account's Zero Trust organization has no team domain. Finish setting it up at ${ZERO_TRUST_SETUP}.`,
    };
  }
  const existing = (await client.listAccessApps(target.accountId, { domain: target.host }))
    .filter((app) => accessAppCovers(app, target.host) && app.aud);
  return existing.length ? { kind: "found", issuer, app: existing[0] } : { kind: "missing", issuer };
}

/** Creates the application for `target`, returning it with the edits that point the file at it. */
export async function createAccess(
  client: CloudflareClient,
  target: AccessTarget,
  issuer: string,
): Promise<{ app: CfAccessApp; edits: DeploymentEdit[] }> {
  const app = await client.createAccessApp(target.accountId, applicationBody(target));
  if (!app.aud) throw new CfError("Created the Access application, but the API returned no AUD tag.");
  return { app, edits: accessEdits(issuer, app) };
}

/** What {@link setupAccess} did. */
export type SetupResult =
  | { kind: "reused"; app: CfAccessApp; edits: DeploymentEdit[] }
  | { kind: "created"; app: CfAccessApp; edits: DeploymentEdit[] }
  | { kind: "dry-run"; request: unknown; issuer: string };

/**
 * Finds or creates the application for `target`. Writes nothing; the caller applies `edits`. With
 * `dryRun`, a create is validated and returned as the request it would send.
 */
export async function setupAccess(
  client: CloudflareClient,
  target: AccessTarget,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<SetupResult> {
  const lookup = await lookupAccess(client, target);
  if (lookup.kind === "no-organization") throw new Error(`${lookup.reason} Then re-run.`);
  if (lookup.kind === "found") {
    return { kind: "reused", app: lookup.app, edits: accessEdits(lookup.issuer, lookup.app) };
  }
  if (dryRun) {
    const request = await client.dryRunCreateAccessApp(target.accountId, applicationBody(target));
    return { kind: "dry-run", request, issuer: lookup.issuer };
  }
  return { kind: "created", ...await createAccess(client, target, lookup.issuer) };
}

/**
 * The One-time PIN identity provider: Access emails a code to the address being admitted. It needs
 * no configuration, and it is what the hosted flow signs people in with.
 */
export const ONE_TIME_PIN_PROVIDER: Readonly<Record<string, unknown>> = {
  name: "One-time PIN",
  type: "onetimepin",
  config: {},
};
