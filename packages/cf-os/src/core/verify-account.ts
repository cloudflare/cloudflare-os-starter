// Cloudflare-side checks `cf-os check` and `cf-os deploy` run before building: that what
// `deployment.jsonc` names actually exists in the account. `validateConfig` can only check shape;
// an AUD tag from a different application, or a KV ID from a different account, passes it and then
// deploys a Workshop nobody can sign in to, or one bound to the wrong data.
//
// Optional by design. When the client has no credentials the checks are skipped with one line rather
// than failing, so an offline check keeps working; when it does have them, a mismatch is an error.
//
// `verifyMigrations` is the other check made before anything is built or deployed, and a separate
// one, with its own reads and its own verdict: that no Worker about to be deployed over has Durable
// Object storage migrated past the migrations this project's configuration has for it. A project
// pinned behind what the account runs reaches a deploy by many roads (a take-over refused and
// deployed anyway, a pin rolled back, an old checkout); this holds whichever was taken. It is not
// optional the way the first is: without credentials it reports that it checked nothing, and what
// that means is the caller's to decide. `cf-os check`, which deploys nothing, says so and carries
// on; `cf-os deploy` refuses, since wrangler uploads over newer storage with no more than a warning.
//
// An optional Gatekeeper's missing OAuth secrets are warnings instead (`gatekeeperSecretWarnings`).

import {
  CfAuthError,
  CfUnavailableError,
  accessAppCovers,
  accessAppFor,
  accessAppHosts,
  issuerOf,
  type CfAccessApp,
  type CfAiGateway,
  type CfKvNamespace,
  type CfOrganization,
  type CloudflareClient,
} from "./client.ts";
import type { DeploymentConfig } from "./deployment-config.ts";
import type { GatekeeperCatalog } from "./gatekeepers.ts";
import {
  flowTag,
  instanceRelease,
  liveMigrations,
  migrationGap,
  readWorkers,
  versionReleases,
  type MigrationStep,
  type ReleaseReport,
  type WorkerReading,
} from "./hosted-release.ts";

/** The outcome: what is wrong, or why nothing was checked. */
export type AccountCheck = { skipped: string } | { problems: string[] };

/**
 * Checks `config` against the account it names. `origin` is the deployment's public origin
 * (`publicOrigin(config)`), passed in rather than recomputed so the two can never disagree.
 *
 * Every read it needs runs at once ({@link startReads}), and the results are judged one by one in a
 * fixed order: the organization, the Access applications, then the storage. So the problems, and the
 * read a signed-out or partly permitted token stops at, are the same whichever read finishes first.
 */
export async function verifyAccount(
  client: CloudflareClient,
  config: DeploymentConfig,
  origin: string,
): Promise<AccountCheck> {
  const reads = startReads(client, config);
  const problems: string[] = [];
  try {
    await checkAccess(reads, config, origin, problems);
    await checkStorage(reads, config, problems);
    return { problems };
  } catch (error) {
    // Signed out, or `cf` missing or broken: not the deployment's fault either way. A token that
    // reads some of the account but not the rest still showed that what it read is wrong; what was
    // read after the read it stopped at is not looked at.
    if (error instanceof CfAuthError || error instanceof CfUnavailableError) {
      return problems.length ? { problems } : { skipped: error.message };
    }
    throw error;
  }
}

/** The reads {@link verifyAccount} judges, started; a storage read is absent when nothing needs it. */
interface AccountReads {
  organization: Promise<CfOrganization>;
  accessApps: Promise<CfAccessApp[]>;
  kvNamespaces?: Promise<CfKvNamespace[]>;
  buckets?: Promise<string[]>;
  gateways?: Promise<CfAiGateway[]>;
}

/** The KV IDs `config` names, by config path. */
function kvPaths(config: DeploymentConfig) {
  return [
    ["context.kvNamespaceId", config.context.kvNamespaceId],
    ["resources.blueprintsKvNamespaceId", config.resources.blueprintsKvNamespaceId],
    ["resources.avatarsKvNamespaceId", config.resources.avatarsKvNamespaceId],
  ] as const;
}

/**
 * The AI Gateway to look for in the account, if any. "default" is exempt: Cloudflare creates it on
 * first use, so a fresh account legitimately lacks it. A gateway in another account is out of reach
 * of this account's credentials.
 */
function gatewayToFind(config: DeploymentConfig): string | undefined {
  const gateway = config.aiGateway;
  return gateway.enabled && gateway.name && gateway.name !== "default" &&
    (gateway.accountId ?? config.accountId).toLowerCase() === config.accountId.toLowerCase()
    ? gateway.name
    : undefined;
}

/** Starts every read `config` calls for, at once, in the order they are judged. */
function startReads(client: CloudflareClient, config: DeploymentConfig): AccountReads {
  return {
    organization: started(client.getOrganization(config.accountId)),
    accessApps: started(client.listAccessApps(config.accountId)),
    // Only explicit IDs: null asks wrangler to provision, which needs nothing to exist yet.
    ...(kvPaths(config).some(([, id]) => id) ? { kvNamespaces: started(client.listKvNamespaces(config.accountId)) } : {}),
    ...(config.resources.blueprintContentBucket ? { buckets: started(client.listR2Buckets(config.accountId)) } : {}),
    ...(gatewayToFind(config) ? { gateways: started(client.listAiGateways(config.accountId)) } : {}),
  };
}

/** `promise`, with a no-op catch attached so it may reject before anything awaits it. */
function started<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/** Pushes onto `problems` as it goes, so a later read that is not permitted keeps what was found. */
async function checkAccess(
  reads: AccountReads,
  config: DeploymentConfig,
  origin: string,
  problems: string[],
): Promise<void> {
  const host = new URL(origin).host;

  let issuer: string | undefined;
  try {
    issuer = issuerOf(await reads.organization);
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

  const all = await reads.accessApps;
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

async function checkStorage(reads: AccountReads, config: DeploymentConfig, problems: string[]): Promise<void> {
  if (reads.kvNamespaces) {
    const ids = new Set((await reads.kvNamespaces).map((namespace) => namespace.id));
    for (const [path, id] of kvPaths(config)) {
      if (id && !ids.has(id)) {
        problems.push(`${path}: no KV namespace with ID ${id} in account ${config.accountId}.`);
      }
    }
  }
  const bucket = config.resources.blueprintContentBucket;
  if (bucket && reads.buckets && !(await reads.buckets).includes(bucket)) {
    problems.push(`resources.blueprintContentBucket: no R2 bucket named ${bucket} in account ${config.accountId}.`);
  }
  const gateway = gatewayToFind(config);
  if (gateway && reads.gateways && !(await reads.gateways).some((candidate) => candidate.id === gateway)) {
    problems.push(
      `aiGateway.name: no AI Gateway named ${gateway} in account ${config.accountId}. The ` +
      "Workshop would advertise models whose every request fails.");
  }
}

/** A Worker a deploy is about to upload over, as the project's generated configuration has it. */
export interface DeployedWorker {
  /** Its name in the account. */
  name: string;
  /** The Durable Object `migrations` of its generated configuration; absent when it has none. */
  migrations?: readonly MigrationStep[];
}

/**
 * The outcome of {@link verifyMigrations}: the refusal, which is null when every Worker may be
 * deployed over, or why that could not be told. `skipped` is no verdict: credentials kept a read from
 * being made and nothing that was read shows a gap, so a caller about to deploy must not go on.
 */
export type MigrationCheck = { skipped: string } | { refusal: string | null };

/** A read that has finished: what it gave, or the error it failed with. */
type Settled<T> = { value: T } | { error: unknown };

/** `read`, settled: never rejects, so two can be awaited together and judged in a fixed order. */
function settled<T>(read: Promise<T>): Promise<Settled<T>> {
  return read.then((value) => ({ value }), (error: unknown) => ({ error }));
}

/** Whether `error` is the lack of credentials, or of a `cf` to use them: no fault of the account's. */
function withoutCredentials(error: unknown): error is CfAuthError | CfUnavailableError {
  return error instanceof CfAuthError || error instanceof CfUnavailableError;
}

/**
 * `name` and every release its live versions the hosted flow uploaded give evidence of, as
 * {@link instanceRelease} weighs them. A version made by hand is left out: the release variable it
 * carries is left over from the last hosted upload, and says nothing of what it runs.
 */
function releaseReports({ name, versions }: WorkerReading): ReleaseReport[] {
  return versions
    .filter((version) => flowTag(version) !== null)
    .flatMap((version) => versionReleases(version).map((release) => ({ name, release })));
}

/**
 * The command that moves the pin to what the Workers named `refused` run, with the commit left for
 * the operator to supply, and beside it the release their live versions name where that is known:
 * every one of them is the hosted flow's upload, names the same newest release, and its id carries
 * the commit.
 *
 * The commit is never put into the command. Nothing here knows where the project's pin stands to
 * it, `cf-os update --to` moves the pin either way, and a Worker is refused for other reasons than a
 * pin behind (a name pointing at a Worker of another kind, a class added by hand): a command ready
 * to run would roll back a pin already past that release. So the release is named with the one
 * case it is the commit to pass in.
 *
 * Only the refused Workers count, and all of them must agree. A release named by a Worker that was
 * not refused, or by some of the refused ones only, is not shown to be what the others run.
 */
function pinFix(refused: readonly string[], readings: readonly (WorkerReading | null)[]): string {
  const generic = "`pnpm cf-os update --to <commit>`, with the cloudflare-os commit those Workers were deployed from or a newer one";
  const named = refused.map((name) => {
    const reading = readings.find((candidate) => candidate?.name === name);
    return reading ? releaseReports(reading) : [];
  });
  const newest = instanceRelease(named.flat());
  if (newest.kind !== "known" || newest.release.sha7 === null) return generic;
  const { id, sha7 } = newest.release;
  if (!named.every((reports) => reports.some(({ release }) => release.id === id))) return generic;
  return `${generic} (their live versions, which the hosted flow uploaded, name release ${id}, built from commit ` +
    `${sha7}: pass it only where this project's pin is behind that commit, as \`update --to\` an older commit moves ` +
    "the pin back)";
}

/**
 * Refuses a deploy over a Worker whose Durable Object storage was migrated past what this project
 * has for it: each of `workers` is read as it runs in account `accountId` and held against the
 * migrations of its generated configuration ({@link migrationGap}). A live migration tag that is
 * none of the configuration's is a gap; where the API reports no tag, so is a stored class that no
 * migration of the configuration creates. A Worker the account does not have yet, or one with no
 * Durable Object storage, has nothing to be behind and passes.
 *
 * The refusal names each such Worker with what was found, and the fix: move the pin to what the
 * account runs, or take the instance over again. Deploying anyway would run older code over storage
 * a newer release migrated, and no later deploy takes that back.
 *
 * Read-only: the account's Durable Object namespaces once, and each Worker's deployments and live
 * versions, a few Workers at a time. The two reads start together, both are awaited, and they are
 * judged in a fixed order, so the verdict is the same whichever finishes first:
 *
 * - A read that fails for any reason but credentials is a refusal: a deploy that cannot tell must
 *   not go ahead.
 * - A read credentials kept from being made takes nothing away from the other. What was read is
 *   still judged, and a gap it shows is a refusal: the classes a Worker stores, with no tag to go
 *   with them, or a tag, with no classes.
 * - Only when no gap shows and a read was not made is the check `skipped`, with the reason. That is
 *   not a pass ({@link MigrationCheck}).
 */
export async function verifyMigrations(
  client: CloudflareClient,
  accountId: string,
  workers: readonly DeployedWorker[],
): Promise<MigrationCheck> {
  if (!workers.length) return { refusal: null };
  const [namespacesRead, workersRead] = await Promise.all([
    settled(client.listDurableObjectNamespaces(accountId)),
    settled(readWorkers(client, accountId, workers.map(({ name }) => name))),
  ]);
  const failures = [namespacesRead, workersRead].flatMap((read) => "error" in read ? [read.error] : []);
  const broken = failures.find((error) => !withoutCredentials(error));
  if (broken !== undefined) {
    const reason = broken instanceof Error ? broken.message : String(broken);
    return {
      refusal: "What the account's Workers run could not be read, so whether their Durable Object storage is ahead of " +
        `this project's pinned cloudflare-os is not known:\n  - ${reason}\n` +
        "Deploying older code over storage a newer release has migrated cannot be undone, so nothing was built or " +
        "deployed. Run this again once the read works.",
    };
  }
  const namespaces = "value" in namespacesRead ? namespacesRead.value : [];
  const readings = "value" in workersRead ? workersRead.value : null;
  const gaps = workers.flatMap(({ name, migrations }, index) => {
    // Unread, a Worker is taken to be there with no tag reported, so the classes it stores still count.
    const reading = readings ? readings[index] : { name, deployment: null, versions: [] };
    return migrationGap(liveMigrations(name, reading, namespaces), migrations) ?? [];
  });
  if (gaps.length) {
    return {
      refusal: "This project's pinned cloudflare-os is behind the Durable Object storage of Workers it would deploy over:\n" +
        `${gaps.map(({ message }) => `  - ${message}`).join("\n")}\n` +
        "Deploying would put older code over storage a newer release has already migrated, which cannot be undone, so " +
        "nothing was built or deployed. Move the pin to what those Workers run, or past it, first: " +
        `${pinFix(gaps.map(({ worker }) => worker), readings ?? [])}; ` +
        "or take the instance over again with a fresh command from the hosted deploy flow, which moves the pin forward " +
        "only (docs/migrate-from-hosted.md).",
    };
  }
  const [unread] = failures;
  return withoutCredentials(unread) ? { skipped: unread.message } : { refusal: null };
}

/** `names` as a list in prose: "A", "A and B", "A, B and C" (with `or`, "A or B"). */
export function prose(names: string[], conjunction: "and" | "or"): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} ${conjunction} ${names.at(-1)}`;
}

/** How many Workers' secrets are read at once: a handful of `cf` processes, never one per Gatekeeper. */
export const SECRET_READS_AT_ONCE = 4;

/**
 * Starts `task` on each of `items`, at most `limit` at a time, and returns their promises in
 * `items`' order, each {@link started}.
 *
 * `mapConcurrent` (run-tasks.ts) is the same pool, but resolves only once every task has, and the
 * core cannot import it.
 */
export function startBounded<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R>[] {
  const results = items.map(() => Promise.withResolvers<R>());
  // A bare `next++` is a safe claim: JS runs it to completion before any other runner resumes.
  let next = 0;
  const runner = async () => {
    for (let i = next++; i < items.length; i = next++) {
      try {
        results[i].resolve(await task(items[i]));
      } catch (error) {
        results[i].reject(error);
      }
    }
  };
  for (let i = 0; i < Math.min(limit, items.length); i++) void runner();
  return results.map(({ promise }) => started(promise));
}

/**
 * One warning for each optional Gatekeeper in `config` whose Worker lacks a secret, pointing at
 * `cf-os secrets <slug>` with `configFlag`. Never a problem: a deploy keeps a Worker's secrets.
 * Signed out, it stops quietly with what it found, as {@link verifyAccount} skips.
 */
export async function gatekeeperSecretWarnings(
  client: CloudflareClient,
  config: DeploymentConfig,
  catalog: GatekeeperCatalog,
  configFlag = "",
): Promise<string[]> {
  const looked = Object.entries(config.gatekeepers ?? {}).flatMap(([slug, { name: worker }]) => {
    const entry = catalog.offered.find((gatekeeper) => gatekeeper.slug === slug);
    return entry?.secrets.length ? [{ slug, worker, names: entry.secrets.map(({ name }) => name) }] : [];
  });
  // Read a few at a time, every read awaited, then judged in the file's order, so the warnings, and
  // where a signed-out read stops them, do not depend on which read finishes first.
  type Read = { present: string[] | null } | { error: Error };
  const reads = await Promise.all(startBounded(looked, SECRET_READS_AT_ONCE, async ({ worker }): Promise<Read> => {
    try {
      return { present: await client.listWorkerSecrets(config.accountId, worker) };
    } catch (error) {
      return { error: error as Error };
    }
  }));
  const warnings: string[] = [];
  for (const [index, { slug, worker, names }] of looked.entries()) {
    const read = reads[index];
    if ("error" in read) {
      if (read.error instanceof CfAuthError || read.error instanceof CfUnavailableError) return warnings;
      warnings.push(`Warning: could not read ${worker}'s secrets to check for ${prose(names, "and")}: ${read.error.message}`);
      continue;
    }
    const { present } = read;
    const missing = names.filter((name) => !present?.includes(name));
    if (!missing.length) continue;
    const command = `\`pnpm cf-os secrets ${slug}${configFlag}\``;
    warnings.push(present === null
      ? `Warning: ${worker} is not deployed yet; after the deploy, ${command} sets its ${prose(missing, "and")}.`
      : `Warning: ${worker} has no ${prose(missing, "or")}; nobody can connect the ${slug} Gatekeeper until ` +
        `${command} sets ${missing.length === 1 ? "it" : "them"}.`);
  }
  return warnings;
}
