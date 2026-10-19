// Cloudflare-side checks `cf-os check` and `cf-os deploy` run before building: that what
// `deployment.jsonc` names actually exists in the account. `validateConfig` can only check shape;
// an AUD tag from a different application, or a KV ID from a different account, passes it and then
// deploys a Workshop nobody can sign in to, or one bound to the wrong data.
//
// Optional by design. When the client has no credentials the checks are skipped with one line rather
// than failing, so an offline check keeps working; when it does have them, a mismatch is an error.
//
// An optional Gatekeeper's missing OAuth secrets are warnings instead (`gatekeeperSecretWarnings`):
// its Worker deploys and runs without them, and only connecting through it fails until they are set.

import {
  CfAuthError,
  CfUnavailableError,
  accessAppCovers,
  accessAppFor,
  accessAppHosts,
  issuerOf,
  type CloudflareClient,
} from "./client.ts";
import type { DeploymentConfig } from "./deployment-config.ts";
import { publicOrigin } from "./deployment.ts";
import { secretSetup, type GatekeeperCatalog } from "./gatekeepers.ts";

/** The outcome: what is wrong, or why nothing was checked. */
export type AccountCheck = { skipped: string } | { problems: string[] };

/**
 * Checks `config` against the account it names. `origin` is the deployment's public origin
 * (`publicOrigin(config)`), passed in rather than recomputed so the two can never disagree.
 */
export async function verifyAccount(
  client: CloudflareClient,
  config: DeploymentConfig,
  origin: string,
): Promise<AccountCheck> {
  const problems: string[] = [];
  try {
    await checkAccess(client, config, origin, problems);
    await checkStorage(client, config, problems);
    return { problems };
  } catch (error) {
    // Signed out, or `cf` missing or broken: not the deployment's fault either way. A token that
    // reads some of the account but not the rest still showed that what it read is wrong.
    if (error instanceof CfAuthError || error instanceof CfUnavailableError) {
      return problems.length ? { problems } : { skipped: error.message };
    }
    throw error;
  }
}

/** Pushes onto `problems` as it goes, so a later read that is not permitted keeps what was found. */
async function checkAccess(
  client: CloudflareClient,
  config: DeploymentConfig,
  origin: string,
  problems: string[],
): Promise<void> {
  const host = new URL(origin).host;

  let issuer: string | undefined;
  try {
    issuer = issuerOf(await client.getOrganization(config.accountId));
  } catch (error) {
    if (error instanceof CfAuthError || error instanceof CfUnavailableError) throw error;
    problems.push(`access.issuer: the account has no readable Zero Trust organization (${(error as Error).message}).`);
  }
  const configured = config.access.issuer.replace(/\/$/, "").toLowerCase();
  if (issuer && issuer.toLowerCase() !== configured) {
    problems.push(
      `access.issuer is ${config.access.issuer}, but the account's Zero Trust team domain is ` +
      `${issuer}. The Workshop would reject every Access token it is sent.`);
  }

  const all = await client.listAccessApps(config.accountId);
  const apps = all.filter((app) => app.aud === config.access.audience);
  const applied = accessAppFor(all, host);
  if (!apps.length) {
    problems.push(
      `access.audience: no Access application in account ${config.accountId} has AUD tag ` +
      `${config.access.audience}. Copy it from the application protecting ${host}, or run ` +
      "`pnpm cf-os access` to find or create it.");
  } else if (applied && applied.aud !== config.access.audience && apps.some((app) => accessAppCovers(app, host))) {
    problems.push(
      `access.audience: Access application "${applied.name}" (AUD ${applied.aud}) names ${host} more ` +
      `specifically than "${apps[0].name}" does, so it is the one Access applies there, and the Workshop ` +
      "would reject the tokens it issues. Point access.audience at it, or remove the hostname from it.");
  } else if (!applied || applied.aud !== config.access.audience) {
    problems.push(
      `access.audience: Access application "${apps[0].name}" does not gate every path of ${host}, ` +
      "which is where the router answers: it names " +
      `${accessAppHosts(apps[0]).join(", ") || "no hostname"}${apps[0].type ? `, as a ${apps[0].type} application` : ""}. ` +
      "Requests would reach the Workshop without an Access token. Add the hostname, with no path, " +
      "to a self-hosted application, or point access.audience at the one that has it.");
  }
}

async function checkStorage(client: CloudflareClient, config: DeploymentConfig, problems: string[]): Promise<void> {
  const kvPaths = [
    ["context.kvNamespaceId", config.context.kvNamespaceId],
    ["resources.blueprintsKvNamespaceId", config.resources.blueprintsKvNamespaceId],
    ["resources.avatarsKvNamespaceId", config.resources.avatarsKvNamespaceId],
  ] as const;
  // Only explicit IDs: null asks wrangler to provision, which needs nothing to exist yet.
  if (kvPaths.some(([, id]) => id)) {
    const ids = new Set((await client.listKvNamespaces(config.accountId)).map((namespace) => namespace.id));
    for (const [path, id] of kvPaths) {
      if (id && !ids.has(id)) {
        problems.push(`${path}: no KV namespace with ID ${id} in account ${config.accountId}.`);
      }
    }
  }
  const bucket = config.resources.blueprintContentBucket;
  if (bucket && !(await client.listR2Buckets(config.accountId)).includes(bucket)) {
    problems.push(`resources.blueprintContentBucket: no R2 bucket named ${bucket} in account ${config.accountId}.`);
  }
  // "default" is exempt: Cloudflare creates it on first use, so a fresh account legitimately lacks it.
  // A gateway in another account is out of reach of this account's credentials.
  const gateway = config.aiGateway;
  if (gateway.enabled && gateway.name && gateway.name !== "default" &&
      (gateway.accountId ?? config.accountId).toLowerCase() === config.accountId.toLowerCase() &&
      !(await client.listAiGateways(config.accountId)).some((candidate) => candidate.id === gateway.name)) {
    problems.push(
      `aiGateway.name: no AI Gateway named ${gateway.name} in account ${config.accountId}. The ` +
      "Workshop would advertise models whose every request fails.");
  }
}

/** `names` as a list in prose: "A", "A and B", "A, B and C" (with `or`, "A or B"). */
function prose(names: string[], conjunction: "and" | "or"): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} ${conjunction} ${names.at(-1)}`;
}

/**
 * One warning, as lines to print, for each optional Gatekeeper in `config` whose Worker lacks a
 * secret its catalog entry reads: the `wrangler secret put` commands for what is missing and the
 * redirect URI its OAuth app registers (core/gatekeepers.ts `secretSetup`). A Worker not deployed
 * yet lacks all of them, and is told so. A Gatekeeper that takes no secrets is not looked up.
 *
 * Never a problem: `wrangler deploy` keeps a Worker's secrets, so they can as well be set after the
 * deploy as before it. Signed out, or with a client that cannot run, it stops quietly with what it
 * found, as {@link verifyAccount} skips; any other failure to read a Worker's secrets is a warning
 * of its own.
 */
export async function gatekeeperSecretWarnings(
  client: CloudflareClient,
  config: DeploymentConfig,
  catalog: GatekeeperCatalog,
): Promise<string[]> {
  const origin = publicOrigin(config);
  const warnings: string[] = [];
  for (const [slug, { name: worker }] of Object.entries(config.gatekeepers ?? {})) {
    const entry = catalog.offered.find((gatekeeper) => gatekeeper.slug === slug);
    if (!entry?.secrets.length) continue;
    let present: string[] | null;
    try {
      present = await client.listWorkerSecrets(config.accountId, worker);
    } catch (error) {
      if (error instanceof CfAuthError || error instanceof CfUnavailableError) return warnings;
      const names = prose(entry.secrets.map(({ name }) => name), "and");
      warnings.push(`Warning: could not read ${worker}'s secrets to check for ${names}: ${(error as Error).message}`);
      continue;
    }
    const missing = entry.secrets.map(({ name }) => name).filter((name) => !present?.includes(name));
    if (!missing.length) continue;
    const setup = secretSetup(entry, slug, worker, origin, config.accountId);
    const heading = present === null
      ? `Warning: ${worker} is not deployed yet; after the deploy, set ${prose(missing, "and")}, ` +
        `or nobody can connect the ${slug} Gatekeeper:`
      : `Warning: ${worker} has no ${prose(missing, "or")}; nobody can connect the ${slug} Gatekeeper ` +
        `until ${missing.length === 1 ? "it is" : "they are"} set:`;
    warnings.push([
      heading,
      ...setup.commands.filter(({ name }) => missing.includes(name)).map(({ command }) => `  ${command}`),
      `Redirect URI to register with the provider: ${setup.redirectUri}`,
    ].join("\n"));
  }
  return warnings;
}
