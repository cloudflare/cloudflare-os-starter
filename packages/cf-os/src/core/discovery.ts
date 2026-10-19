// Finds what an existing hosted-deploy instance already runs in an account, as the
// `deployment.jsonc` values that redeploy over it: Worker names, the storage it is bound to, its AI
// Gateway, its Access application, and the optional Gatekeepers the starter can deploy over. See
// docs/migrate-from-hosted.md for why each value matters.
//
// Nothing here is guessed. A resource that does not match `matchers()` (naming.ts) is reported as
// missing and left as it is in the file -- the cost of a wrong guess is a deploy that binds new,
// empty storage.

import {
  CfAuthError,
  CfUnavailableError,
  accessAppHosts,
  issuerOf,
  type CfAccessApp,
  type CfAiGateway,
  type CfKvNamespace,
  type CfOrganization,
  type CfWorker,
  type CloudflareClient,
} from "./client.ts";
import type { DeploymentEdit } from "./edits.ts";
import type { ExcludedGatekeeper } from "./gatekeepers.ts";
import { accessAppName, BUILT_IN_GATEKEEPER_SLUGS, matchers } from "./naming.ts";

/** What the account holds, as far as discovery is concerned. */
export interface Inventory {
  workers: CfWorker[];
  kvNamespaces: CfKvNamespace[];
  buckets: string[];
  gateways: CfAiGateway[];
  accessApps: CfAccessApp[];
  /** Null when the account has no Zero Trust organization (or it could not be read). */
  organization: CfOrganization | null;
}

/** Reads everything {@link discover} matches against. Six reads, no writes. */
export async function fetchInventory(client: CloudflareClient, accountId: string): Promise<Inventory> {
  let organization: CfOrganization | null;
  try {
    organization = await client.getOrganization(accountId);
  } catch (error) {
    if (error instanceof CfAuthError || error instanceof CfUnavailableError) throw error;
    organization = null;
  }
  return {
    workers: await client.listWorkers(accountId),
    kvNamespaces: await client.listKvNamespaces(accountId),
    buckets: await client.listR2Buckets(accountId),
    gateways: await client.listAiGateways(accountId),
    accessApps: await client.listAccessApps(accountId),
    organization,
  };
}

/** One line of the report. */
export interface ReportRow {
  label: string;
  /** The value found, or null when nothing matched. */
  found: string | null;
  /** What was looked for, for the missing case. */
  expected: string;
  /** Config path the value belongs at. */
  path: string;
  note?: string;
}

/** An `N-gk-<slug>` Worker the starter deploys over: an optional Gatekeeper the catalog offers. */
export interface FoundGatekeeper {
  slug: string;
  /** Its Worker name. */
  name: string;
}

/** An `N-gk-*` Worker the starter cannot deploy, and why. */
export interface OrphanedGatekeeper {
  name: string;
  kind: "repeat" | "unknown";
  reason: string;
}

/** What {@link discover} concluded. */
export interface Discovery {
  /**
   * Whether instance `n` exists: its router and Workshop are both in the account, as
   * `findInstances` tells one. `edits` alone cannot say, as it holds account-wide values too.
   */
  matched: boolean;
  /** The values to write: found ones only. */
  edits: DeploymentEdit[];
  rows: ReportRow[];
  /** Optional Gatekeepers the instance runs that the catalog offers, written to `gatekeepers`. */
  foundGatekeepers: FoundGatekeeper[];
  /** `N-gk-*` Workers the starter cannot deploy, which lose their binding on redeploy. */
  orphanedGatekeepers: OrphanedGatekeeper[];
  /** Anything else worth saying: ambiguity, disagreements between sources. */
  notes: string[];
}

/**
 * Matches `inventory` against instance `n`'s naming. Each `N-gk-<slug>` Worker beyond the built-in
 * ones is deployable when `offeredSlugs` (the catalog's) has its slug; a repeat install when its
 * slug is one of those, or a built-in's, plus digits, as the hosted deploy names a second install
 * (`google2`); otherwise unknown, with `excluded`'s reason when the catalog names one.
 */
export function discover(
  n: string,
  inventory: Inventory,
  offeredSlugs: readonly string[] = [],
  excluded: readonly ExcludedGatekeeper[] = [],
): Discovery {
  const edits: DeploymentEdit[] = [];
  const rows: ReportRow[] = [];
  const notes: string[] = [];
  const workerNames = new Map(inventory.workers.map((worker) => [worker.name, worker]));
  const kvByTitle = new Map(inventory.kvNamespaces.map((namespace) => [namespace.title, namespace]));

  for (const matcher of matchers(n).filter((candidate) => candidate.source === "hosted")) {
    let found: string | null = null;
    if (matcher.kind === "worker" && workerNames.has(matcher.name)) found = matcher.name;
    if (matcher.kind === "kv") found = kvByTitle.get(matcher.name)?.id ?? null;
    if (matcher.kind === "r2" && inventory.buckets.includes(matcher.name)) found = matcher.name;
    if (matcher.kind === "gateway" && inventory.gateways.some((gateway) => gateway.id === matcher.name)) {
      found = matcher.name;
    }
    rows.push({
      label: matcher.label,
      found,
      expected: matcher.name,
      path: matcher.path.join("."),
      ...(found === null && matcher.missing ? { note: matcher.missing } : {}),
    });
    if (found === null) continue;
    edits.push({ path: matcher.path, value: found });
    if (matcher.kind === "gateway") {
      // The gateway lives in this account, which is what lets the Workshop reach it over its
      // WORKERS_AI binding without a token.
      edits.push({ path: ["aiGateway", "enabled"], value: true });
      edits.push({ path: ["aiGateway", "accountId"], value: null });
    }
  }

  // Access: the application, its AUD, and the hostname it protects.
  const pattern = accessAppName(n);
  const apps = inventory.accessApps.filter((app) => pattern.test(app.name ?? ""));
  const app = apps.length === 1 ? apps[0] : undefined;
  if (apps.length > 1) {
    notes.push(
      `${apps.length} Access applications are named like this instance's (` +
      apps.map((candidate) => JSON.stringify(candidate.name)).join(", ") +
      "). Pick the one protecting the router's hostname and copy its AUD into access.audience.");
  }
  rows.push({
    label: "Access application AUD",
    found: app?.aud ?? null,
    expected: `an application named "Cloudflare OS ${n} ..."`,
    path: "access.audience",
  });
  if (app?.aud) edits.push({ path: ["access", "audience"], value: app.aud });

  const issuer = inventory.organization ? issuerOf(inventory.organization) : undefined;
  rows.push({
    label: "Access issuer (team domain)",
    found: issuer ?? null,
    expected: "the account's Zero Trust organization",
    path: "access.issuer",
    ...(issuer ? {} : { note: "the account has no readable Zero Trust organization" }),
  });
  if (issuer) edits.push({ path: ["access", "issuer"], value: issuer });

  // The public origin. The Access application's primary hostname says where users reach the
  // instance; the router Worker's own record says what its workers.dev address is, which closes the
  // gap wrangler leaves (it has no command for the account's workers.dev subdomain).
  const appHost = app ? accessAppHosts(app)[0] : undefined;
  const routerUrl = workerNames.get(n)?.subdomain?.url?.replace(/\/$/, "");
  let origin: { route: Record<string, unknown>; publicBaseUrl: string | null; source: string } | undefined;
  if (appHost && !appHost.endsWith(".workers.dev")) {
    origin = { route: { customDomain: appHost }, publicBaseUrl: null, source: "the Access application" };
  } else if (appHost) {
    origin = { route: { workersDev: true }, publicBaseUrl: `https://${appHost}`, source: "the Access application" };
    if (routerUrl && routerUrl !== origin.publicBaseUrl) {
      notes.push(
        `The Access application protects ${origin.publicBaseUrl}, but the router Worker's ` +
        `workers.dev address is ${routerUrl}. Using the Access hostname; check which one users visit.`);
    }
  } else if (routerUrl) {
    origin = { route: { workersDev: true }, publicBaseUrl: routerUrl, source: "the router Worker" };
  }
  rows.push({
    label: "Public origin",
    found: origin ? origin.publicBaseUrl ?? `https://${String(origin.route.customDomain)}` : null,
    expected: "the Access application's hostname or the router's workers.dev URL",
    path: "workers.router.route / publicBaseUrl",
    ...(origin ? { note: `from ${origin.source}` } : {}),
  });
  if (origin) {
    edits.push({ path: ["workers", "router", "route"], value: origin.route });
    edits.push({ path: ["publicBaseUrl"], value: origin.publicBaseUrl });
  }

  const foundGatekeepers: FoundGatekeeper[] = [];
  const orphanedGatekeepers: OrphanedGatekeeper[] = [];
  const prefix = `${n}-gk-`;
  for (const name of inventory.workers.map((worker) => worker.name).filter((candidate) => candidate.startsWith(prefix)).toSorted()) {
    const slug = name.slice(prefix.length);
    if (BUILT_IN_GATEKEEPER_SLUGS.includes(slug)) continue;
    if (offeredSlugs.includes(slug)) {
      foundGatekeepers.push({ slug, name });
      continue;
    }
    const base = slug.replace(/\d+$/, "");
    if (base !== slug && (offeredSlugs.includes(base) || BUILT_IN_GATEKEEPER_SLUGS.includes(base))) {
      orphanedGatekeepers.push({
        name, kind: "repeat",
        reason: `a second install of ${base}; the starter deploys one Worker per Gatekeeper package`,
      });
      continue;
    }
    const reason = excluded.find((candidate) => candidate.slug === slug)?.reason;
    orphanedGatekeepers.push({
      name, kind: "unknown",
      reason: reason ? `the starter cannot deploy it: ${reason}` : `no Gatekeeper in the submodule has the slug ${slug}`,
    });
  }
  for (const { slug, name } of foundGatekeepers) {
    rows.push({ label: `${slug} Gatekeeper Worker`, found: name, expected: name, path: `gatekeepers.${slug}.name` });
    edits.push({ path: ["gatekeepers", slug, "name"], value: name });
  }
  // Discovery reads Worker names, not their settings, and a deploy replaces a Worker's vars wholesale.
  if (foundGatekeepers.length) {
    notes.push("A deploy keeps the found optional Gatekeepers' secrets but replaces their plain vars with " +
      "the package's own and BASE_URL. Copy any var a Worker relies on (its dashboard settings list them: " +
      "GITLAB_URL for a self-managed GitLab, MCP_PORTAL_URL for an MCP portal) into " +
      "gatekeepers.<slug>.vars before deploying.");
  }

  const matched = ["workers.router.name", "workers.workshop.name"]
    .every((path) => rows.some((row) => row.path === path && row.found !== null));
  return { matched, edits, rows, foundGatekeepers, orphanedGatekeepers, notes };
}
