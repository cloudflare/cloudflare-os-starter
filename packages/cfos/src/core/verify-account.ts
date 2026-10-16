// Cloudflare-side checks `cfos check` and `cfos deploy` run before building: that what
// `deployment.jsonc` names actually exists in the account. `validateConfig` can only check shape;
// an AUD tag from a different application, or a KV ID from a different account, passes it and then
// deploys a Workshop nobody can sign in to, or one bound to the wrong data.
//
// Optional by design. When the client has no credentials the checks are skipped with one line rather
// than failing, so an offline check keeps working; when it does have them, a mismatch is an error.

import {
  CfAuthError,
  CfUnavailableError,
  accessAppCovers,
  accessAppHosts,
  issuerOf,
  type CloudflareClient,
} from "./client.ts";
import type { DeploymentConfig } from "./deployment-config.ts";

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
  try {
    return {
      problems: [...await checkAccess(client, config, origin), ...await checkStorage(client, config)],
    };
  } catch (error) {
    // Signed out, or `cf` missing or broken: not the deployment's fault either way.
    if (error instanceof CfAuthError || error instanceof CfUnavailableError) {
      return { skipped: error.message };
    }
    throw error;
  }
}

async function checkAccess(client: CloudflareClient, config: DeploymentConfig, origin: string): Promise<string[]> {
  const problems: string[] = [];
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

  const apps = (await client.listAccessApps(config.accountId, { aud: config.access.audience }))
    .filter((app) => app.aud === config.access.audience);
  if (!apps.length) {
    problems.push(
      `access.audience: no Access application in account ${config.accountId} has AUD tag ` +
      `${config.access.audience}. Copy it from the application protecting ${host}, or run ` +
      "`pnpm cfos access` to find or create it.");
  } else if (!apps.some((app) => accessAppCovers(app, host))) {
    problems.push(
      `access.audience: Access application "${apps[0].name}" covers ` +
      `${accessAppHosts(apps[0]).join(", ") || "no hostname"}, not ${host}, which is where the ` +
      "router answers. Requests would reach the Workshop without an Access token. Add the hostname " +
      "to the application, or point access.audience at the one that covers it.");
  }
  return problems;
}

async function checkStorage(client: CloudflareClient, config: DeploymentConfig): Promise<string[]> {
  const problems: string[] = [];
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
  return problems;
}
