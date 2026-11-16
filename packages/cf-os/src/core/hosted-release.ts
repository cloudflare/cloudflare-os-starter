// What a hosted-deploy instance runs, read off its Workers: the release each was uploaded from, the
// Workers changed by hand since, the one release the instance counts as running, the commit a
// takeover must pin, and the values its backend carries. See docs/migrate-from-hosted.md.
//
// The hosted flow marks every Worker version it uploads three ways, read here in this order:
//
//   1. annotations: `workers/tag` is `gd:<run number, or the whole id of a hand-built release>:<fp8>`,
//      where `<fp8>` names the installation, and `workers/message` is
//      `Cloudflare OS <operation> from release <release id>`, optionally followed by an upload id;
//   2. the plain variable CLOUDFLARE_OS_RELEASE_ID;
//   3. on the backend alone, `releaseId` in the JSON variable CLOUDFLARE_OS_DEPLOYMENT.
//
// A release id is `r<CI run number, zero-padded>-<sha7 of the cloudflare-os commit>`, or any other
// name of the same characters for a staging or hand-built release, which says neither which release
// is newer nor which commit it was built from.
//
// The rule every function here keeps: a takeover never pins the project behind what the instance
// runs. Deploying older code over storage a newer release migrated cannot be undone, so evidence that
// disagrees stops with a message instead of being settled by a guess.
//
// The same rule's last check, for `check` and `deploy`, is here too: what the account says of a
// Worker's Durable Object migrations (`readMigrations`) held against the migrations in the project's
// configuration for it (`migrationGap`).
//
// A reading holds the text of a Worker's variables. What goes to stdout is `instanceSummary`, which
// an instance also serialises as; a reading itself is never printed.

import {
  TRIGGERED_BY_ANNOTATION,
  VERSION_MESSAGE_ANNOTATION,
  VERSION_TAG_ANNOTATION,
  type CfDurableObjectNamespace,
  type CfWorkerBinding,
  type CfWorkerDeployment,
  type CfWorkerVersion,
  type CloudflareClient,
} from "./client.ts";

/** A release id: what the hosted flow names a release, and what `--release` takes. */
export const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A full commit SHA, which `--commit` takes. */
export const FULL_COMMIT = /^[0-9a-f]{40}$/i;

/** The plain variable every Worker of a hosted instance carries its release id in. */
export const RELEASE_ID_VAR = "CLOUDFLARE_OS_RELEASE_ID";

/**
 * The JSON variable describing the install to the backend, which makes the Workshop offer updates
 * through the hosted flow. Read for its `releaseId`; a takeover does not carry it over.
 */
export const DEPLOYMENT_VAR = "CLOUDFLARE_OS_DEPLOYMENT";

/** The prefix of the backend's service binding to each Gatekeeper Worker: `GATEKEEPER_<SLUG>`. */
export const GATEKEEPER_BINDING_PREFIX = "GATEKEEPER_";

/** A Gatekeeper binding's name as the hosted flow writes one, capturing what its slug is read from. */
const GATEKEEPER_BINDING = /^GATEKEEPER_([A-Z0-9_]+)$/;

/** An install slug, as the hosted flow accepts one: lowercase letters and digits, starting with a letter. */
const GATEKEEPER_SLUG = /^[a-z][a-z0-9]*$/;

/**
 * The router's service binding to its backend, in the pinned router's configuration and in the one
 * this project generates. A Worker is the router of the backend this binding points at, and of no
 * other.
 */
export const ROUTER_BACKEND_BINDING = "WORKSHOP_BACKEND";

/**
 * The backend's plain variables that make up its push identity, by the field of
 * {@link PushIdentity} each fills: the names the pinned backend reads (`env.d.ts` of
 * `cloudflare-os/packages/workshop-backend`).
 */
export const PUSH_IDENTITY_VARS = {
  serviceUrl: "NOTIFICATION_SERVICE_URL",
  installId: "CFOS_INSTALL_ID",
  keyId: "CFOS_INSTALL_KEY_ID",
  webPushPublicKey: "NOTIFICATION_WEB_PUSH_PUBLIC_KEY",
} as const;

/**
 * The backend's secret holding the key that signs its push requests. Only ever seen here as a
 * binding's name: its text is not readable through the API, and nothing asks for it.
 */
export const PUSH_IDENTITY_SECRET = "CFOS_INSTALL_PRIVATE_KEY";

/** The longest `workers/message` the API keeps; one this long may have lost its end. */
const MESSAGE_LIMIT = 100;

/** How many Workers are read at once: a handful of `cf` processes, never one per Worker. */
export const WORKER_READS_AT_ONCE = 4;

/** A release id, taken apart. */
export interface Release {
  id: string;
  /** The CI run number of an `r<run>-...` id, which orders releases; null for any other id. */
  run: number | null;
  /** The abbreviated cloudflare-os commit an `r<run>-<sha7>` id ends with; null for any other id. */
  sha7: string | null;
}

/** `id` taken apart, or null when it is not a release id at all. */
export function parseRelease(id: string): Release | null {
  if (!RELEASE_ID.test(id)) return null;
  const run = runNumber(/^r(\d+)-/.exec(id)?.[1]);
  return { id, run, sha7: run === null ? null : /^r\d+-([0-9a-f]{7})$/.exec(id)?.[1] ?? null };
}

/** `digits` as a run number, or null when there are none or too many to count with. */
function runNumber(digits: string | undefined): number | null {
  if (digits === undefined) return null;
  const run = Number.parseInt(digits, 10);
  return Number.isSafeInteger(run) ? run : null;
}

/** Where a Worker's release was read, in the order the sources are tried. */
export type ReleaseSource = "annotations" | "release-var" | "deployment-var" | "tag";

/** How each {@link ReleaseSource} is named in a report. */
const SOURCE_LABELS: Record<ReleaseSource, string> = {
  annotations: "its live version's annotations",
  "release-var": RELEASE_ID_VAR,
  "deployment-var": `${DEPLOYMENT_VAR}.releaseId`,
  tag: "its live version's tag alone",
};

/** A release, as far as some evidence names it. */
export interface NamedRelease {
  /** The release id; null when only its run number is known, from a version's tag. */
  id: string | null;
  /** The run number that orders it; null for an id that carries none. */
  run: number | null;
  /** The abbreviated commit it was built from; null when the id carries none. */
  sha7: string | null;
}

/** The release one live version of a Worker was uploaded from, and where that was read. */
export interface WorkerRelease extends NamedRelease {
  source: ReleaseSource;
}

/** A version tag the hosted flow wrote, taken apart. */
export interface FlowTag {
  /** The release segment: a run number, or the whole id of a hand-built release. */
  release: string;
  /** The eight hex digits every tag of one installation ends with. */
  fingerprint: string;
}

/** `version`'s tag taken apart, or null when the hosted flow did not write it. */
export function flowTag(version: CfWorkerVersion): FlowTag | null {
  const match = /^gd:([A-Za-z0-9][A-Za-z0-9._-]*):([0-9a-f]{8})$/.exec(version.annotations?.[VERSION_TAG_ANNOTATION] ?? "");
  return match ? { release: match[1], fingerprint: match[2] } : null;
}

/** What a Worker runs, as read from the account. */
export interface WorkerReading {
  name: string;
  /** The deployment serving its traffic; null when it has none (uploaded, never deployed). */
  deployment: CfWorkerDeployment | null;
  /**
   * The versions that deployment sends traffic to, the largest share first. One, unless a gradual
   * rollout is under way; none without a deployment.
   */
  versions: CfWorkerVersion[];
}

/** The binding of `version` named `name`, if it has one. */
function bindingNamed(version: CfWorkerVersion | undefined, name: string): CfWorkerBinding | undefined {
  return version?.bindings?.find((binding) => binding.name === name);
}

/** The text of `version`'s plain variable `name`; undefined when it has none, or it is of another type. */
function plainVar(version: CfWorkerVersion | undefined, name: string): string | undefined {
  const binding = bindingNamed(version, name);
  return binding?.type === "plain_text" ? binding.text : undefined;
}

/**
 * The value of `version`'s JSON variable `name`, or undefined when it has none. JSON held as text
 * is parsed, wherever the text is: in a plain variable, as the backend itself accepts for a list
 * set where only text can be, or as the value the API hands over for a JSON one.
 */
function jsonVar(version: CfWorkerVersion | undefined, name: string): unknown {
  const binding = bindingNamed(version, name);
  const value = binding?.type === "json" ? binding.json : binding?.type === "plain_text" ? binding.text : undefined;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** The release id the message of `version` names, unless the message may have lost its end. */
function messageRelease(version: CfWorkerVersion): Release | null {
  const message = version.annotations?.[VERSION_MESSAGE_ANNOTATION] ?? "";
  const match = / from release (\S+)/.exec(message);
  if (!match) return null;
  // An id that runs to the end of a message as long as the API keeps may be cut short.
  if (message.length >= MESSAGE_LIMIT && match.index + match[0].length === message.length) return null;
  return parseRelease(match[1]);
}

/** The release id `version`'s {@link RELEASE_ID_VAR} holds, if any. */
function varRelease(version: CfWorkerVersion): Release | null {
  const id = plainVar(version, RELEASE_ID_VAR);
  return id === undefined ? null : parseRelease(id);
}

/** The release id `version`'s {@link DEPLOYMENT_VAR} names, if any. */
function deploymentVarRelease(version: CfWorkerVersion): Release | null {
  const install = jsonVar(version, DEPLOYMENT_VAR);
  if (!install || typeof install !== "object" || !("releaseId" in install)) return null;
  return typeof install.releaseId === "string" ? parseRelease(install.releaseId) : null;
}

/**
 * Whether `release` is the one a tag's release segment stands for: its run number, or the id itself.
 * A segment of digits too many to count with stands for no run number, and so for no release.
 */
function agrees(release: Release, segment: string): boolean {
  if (release.id === segment) return true;
  const run = /^\d+$/.test(segment) ? runNumber(segment) : null;
  return run !== null && release.run === run;
}

/** Whether `release` is provably older than `than`: both carry a run number, and its own is the lower. */
function olderThan(release: NamedRelease, than: NamedRelease): boolean {
  return release.run !== null && than.run !== null && release.run < than.run;
}

/**
 * Every release `version` gives evidence of, the one it was uploaded from first; none when nothing
 * on it says. `backend` also reads {@link DEPLOYMENT_VAR}, which only the backend carries.
 *
 * On a version the hosted flow tagged, the tag is the first evidence: an id read from the message
 * or a variable is the version's release only when it is the release the tag stands for, and failing
 * all of them the tag's own segment is the answer -- the id itself for a hand-built release, a bare
 * run number for a CI one, which orders it without naming its commit. A version without the tag has
 * only its variables to go by.
 *
 * The rest are the ids the message and the variables name that are some other release and not
 * provably an older one. The hosted flow writes tag, message and variables in one upload, so they
 * differ only on a version made by hand, and then nothing says which to believe: each is reported,
 * so the newest counts or, where no run numbers order them, the disagreement stops the takeover.
 * One left over from an older release adds nothing and is dropped.
 */
export function versionReleases(version: CfWorkerVersion, { backend = false }: { backend?: boolean } = {}): WorkerRelease[] {
  const tag = flowTag(version);
  const named: (Release & { source: ReleaseSource })[] = [];
  const name = (source: ReleaseSource, release: Release | null) => {
    if (release) named.push({ ...release, source });
  };
  if (tag) name("annotations", messageRelease(version));
  name("release-var", varRelease(version));
  if (backend) name("deployment-var", deploymentVarRelease(version));
  const first: WorkerRelease | undefined =
    named.find((release) => !tag || agrees(release, tag.release)) ?? (tag ? tagRelease(tag) : undefined);
  if (!first) return [];
  const releases = [first];
  for (const release of named) {
    if (!olderThan(release, first) && !releases.some((seen) => seen.id === release.id)) releases.push(release);
  }
  return releases;
}

/** What a tag alone says of the release: the id it carries whole, or the run number it stands for. */
function tagRelease(tag: FlowTag): WorkerRelease {
  const whole = /^\d+$/.test(tag.release) ? null : parseRelease(tag.release);
  return whole
    ? { ...whole, source: "tag" }
    : { id: null, run: runNumber(tag.release), sha7: null, source: "tag" };
}

/** The release `version` was uploaded from ({@link versionReleases}' first), or null when nothing on it says. */
export function versionRelease(version: CfWorkerVersion, options: { backend?: boolean } = {}): WorkerRelease | null {
  return versionReleases(version, options).at(0) ?? null;
}

/** A Worker whose live code is not, or not only, a version the hosted flow uploaded. */
export interface HandEditedWorker {
  name: string;
  /** Why it reads as changed by hand. */
  reason: string;
  /** The live version that is not the hosted flow's; null when the Worker has no live deployment. */
  versionId: string | null;
  /** The client that created that version, as the API names it: `dash`, `wrangler`, `api`, ... */
  source: string | null;
  /** What made that version: `upload`, `secret`, ... */
  trigger: string | null;
  /** When that version was created. */
  createdOn: string | null;
}

/**
 * `reading` as a hand-edited Worker, or null when every version serving its traffic is one the
 * hosted flow uploaded. A Worker with no live deployment counts: nothing shows its code is the
 * hosted flow's.
 */
export function handEdited(reading: WorkerReading): HandEditedWorker | null {
  const version = reading.versions.find((candidate) => !flowTag(candidate));
  if (!version && reading.versions.length) return null;
  const others = reading.versions.length - 1;
  return {
    name: reading.name,
    reason: !version ? "it has no live deployment"
      : others ? `one of the ${others + 1} versions its deployment sends traffic to is not the hosted flow's`
      : "its live version is not one the hosted flow uploaded",
    versionId: version?.id ?? null,
    source: version?.source ?? null,
    trigger: version?.annotations?.[TRIGGERED_BY_ANNOTATION] ?? reading.deployment?.annotations?.[TRIGGERED_BY_ANNOTATION] ?? null,
    createdOn: version?.created_on ?? null,
  };
}

/** What a deploy does to a hand-edited Worker, and so what to do first. Said once under the list. */
export const HAND_EDITED_NOTICE =
  "A deploy replaces each of these Workers' code, vars and bindings with the project's, so a change made by hand " +
  "must go into deployment.jsonc or the source first, or it is lost.";

/** The report's lines for the hand-edited Workers, with {@link HAND_EDITED_NOTICE}; none when there are none. */
export function formatHandEdited(workers: readonly HandEditedWorker[]): string[] {
  if (!workers.length) return [];
  const width = Math.max(...workers.map((worker) => worker.name.length));
  return [
    "Workers changed by hand since the hosted flow deployed them:",
    ...workers.map((worker) => {
      const version = worker.versionId === null ? "" : [
        `version ${worker.versionId}`,
        worker.source === null ? "" : `source ${worker.source}`,
        worker.trigger === null ? "" : `triggered by ${worker.trigger}`,
        worker.createdOn === null ? "" : `created ${worker.createdOn}`,
      ].filter(Boolean).join(", ");
      return `  ${worker.name.padEnd(width)}  ${worker.reason}${version ? ` (${version})` : ""}`;
    }),
    HAND_EDITED_NOTICE,
  ];
}

/**
 * The Durable Object migration tag the API reports with a version serving `reading`'s traffic, or
 * null when it reports none. Null is no evidence: see {@link LiveMigrations}.
 */
export function liveMigrationTag(reading: WorkerReading): string | null {
  for (const version of reading.versions) {
    if (typeof version.migration_tag === "string" && version.migration_tag) return version.migration_tag;
  }
  return null;
}

/**
 * What the account says of one Worker's Durable Object migrations, from two reads.
 *
 * The migration tag is the direct evidence, and the weaker read: `cf` has no command for the
 * endpoints documented to report it, so it is known only when the reply for a live version happens
 * to carry it. The Worker's Durable Object namespaces are the read that always answers: a migration
 * that adds a class creates its namespace on deploy, so the classes with a namespace are the ones
 * the migrations applied so far have left. A Worker with classes and no tag is therefore one whose
 * tag the API did not report, never one without migrations, and it is a state of its own so that
 * nothing mistakes the first for the second.
 */
export type LiveMigrations =
  /** The account has no Worker by the name: a deploy creates it, with no storage to run behind. */
  | { worker: string; state: "absent" }
  /** The Worker is there with no Durable Object class and no tag reported: no migration has left it storage. */
  | { worker: string; state: "no-storage" }
  /** The API reports the tag its live code was deployed with. `classes` are the ones with a namespace. */
  | { worker: string; state: "tagged"; tag: string; classes: string[] }
  /** It has Durable Object classes, so migrations were applied, and the API did not report their tag. */
  | { worker: string; state: "untagged"; classes: string[] };

/**
 * What `reading` and the account's Durable Object `namespaces` say of Worker `worker`'s migrations.
 * `reading` is null for a Worker the account does not have.
 */
export function liveMigrations(
  worker: string,
  reading: WorkerReading | null,
  namespaces: readonly CfDurableObjectNamespace[],
): LiveMigrations {
  if (!reading) return { worker, state: "absent" };
  const classes = [...new Set(namespaces.filter((namespace) => namespace.script === worker).map((namespace) => namespace.class))]
    .toSorted();
  const tag = liveMigrationTag(reading);
  if (tag !== null) return { worker, state: "tagged", tag, classes };
  return classes.length ? { worker, state: "untagged", classes } : { worker, state: "no-storage" };
}

/**
 * Reads the live Durable Object migrations of each of `workers`, in their order: the account's
 * Durable Object namespaces once, and each Worker's deployments and live versions
 * ({@link readWorkers}). Read-only, within the Workers Scripts Read permission.
 *
 * `workers` is every Worker a deploy is about to replace, not only the ones whose configuration has
 * migrations: a live Worker that stores Durable Objects under a configuration with no migrations at
 * all is the widest gap there is, and {@link migrationGap} refuses it only when it is asked.
 */
export async function readMigrations(
  client: CloudflareClient,
  accountId: string,
  workers: readonly string[],
): Promise<LiveMigrations[]> {
  if (!workers.length) return [];
  const [namespaces, readings] = await Promise.all([
    client.listDurableObjectNamespaces(accountId),
    readWorkers(client, accountId, workers),
  ]);
  return workers.map((worker, index) => liveMigrations(worker, readings[index], namespaces));
}

/**
 * One step of a Worker's Durable Object migrations, as its wrangler configuration lists them. Only
 * `tag` is required; the steps' other fields are read where they name classes
 * ({@link migrationClasses}).
 */
export interface MigrationStep {
  tag: string;
  [field: string]: unknown;
}

/** The strings among `value`'s items, or held in each item's `field` when one is given; none when it is no list. */
function namesIn(value: unknown, field?: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    const name = field === undefined ? item
      : item && typeof item === "object" ? new Map<string, unknown>(Object.entries(item)).get(field)
      : undefined;
    return typeof name === "string" ? [name] : [];
  });
}

/**
 * Every Durable Object class `steps` create at some point: added, renamed to, or transferred in. A
 * class a later step deletes or renames away is still one of them, since a Worker any number of
 * steps behind the last may hold it.
 */
export function migrationClasses(steps: readonly MigrationStep[]): Set<string> {
  return new Set(steps.flatMap((step) => [
    ...namesIn(step.new_classes),
    ...namesIn(step.new_sqlite_classes),
    ...namesIn(step.renamed_classes, "to"),
    ...namesIn(step.transferred_classes, "to"),
  ]));
}

/** Evidence that a Worker's storage was migrated past what a project's configuration knows. */
export type MigrationGap =
  /** Its live migration tag is none of the configuration's. */
  | { worker: string; kind: "tag"; tag: string; message: string }
  /** It stores objects of classes no migration in the configuration creates. */
  | { worker: string; kind: "classes"; classes: string[]; message: string };

/**
 * Whether `live` shows the Worker's storage migrated past `steps`, the migrations in the project's
 * generated configuration for it: the evidence, or null when there is none. Deploying over such a
 * Worker runs older code on storage a newer release migrated, which cannot be undone, so a gap is a
 * refusal. The message says what was found; what to do about it is the caller's to add.
 *
 * - With the live tag known, it must be one of the configuration's tags.
 * - Without it, every class the Worker stores objects of must be one the configuration's migrations
 *   create. That sees a newer release that added a class or renamed one, which is how migrations
 *   move on; one whose only step deletes classes leaves nothing to see, and passes.
 * - A Worker the account lacks, or one without Durable Object storage, has nothing to run behind.
 */
export function migrationGap(live: LiveMigrations, steps: readonly MigrationStep[] = []): MigrationGap | null {
  if (live.state === "absent" || live.state === "no-storage") return null;
  const { worker } = live;
  if (live.state === "tagged") {
    const tags = steps.map((step) => step.tag);
    if (tags.includes(live.tag)) return null;
    return {
      worker,
      kind: "tag",
      tag: live.tag,
      message: `Worker ${worker}'s live Durable Object migration tag is ${live.tag}, which is not among the tags of ` +
        `this project's configuration for it (${tags.join(", ") || "it has no migrations"}).`,
    };
  }
  const known = migrationClasses(steps);
  const classes = live.classes.filter((name) => !known.has(name));
  if (!classes.length) return null;
  return {
    worker,
    kind: "classes",
    classes,
    message: `Worker ${worker} stores Durable Objects of ${classes.length === 1 ? "a class" : "classes"} no migration in ` +
      `this project's configuration for it creates (${classes.join(", ")}).`,
  };
}

/** A Gatekeeper Worker the backend is bound to. */
export interface BoundGatekeeper {
  /** The install slug: the binding's name after {@link GATEKEEPER_BINDING_PREFIX}, lowercased. */
  slug: string;
  /** The binding's name on the backend. */
  binding: string;
  /** The Worker it points at, whatever that Worker is called. */
  worker: string;
}

/**
 * A service binding of the backend named like a Gatekeeper's that gives no slug the hosted flow
 * accepts, or a slug another binding already gave: one made by hand. It maps to no Gatekeeper.
 */
export interface UnmappedBinding {
  /** The binding's name on the backend. */
  binding: string;
  /** The Worker it points at. */
  worker: string;
}

/** The backend's push identity, less the signing key: what a takeover writes into the project. */
export interface PushIdentity {
  /** The notification service's origin. */
  serviceUrl: string;
  /** This installation's identity with the service. */
  installId: string;
  /** Which generation of the installation's signing key is the active one. */
  keyId: string;
  /** The key browsers subscribe to push with; null when the backend has none, and offers no browser push. */
  webPushPublicKey: string | null;
}

/** What the backend's live version carries that a takeover writes into the project. */
export interface BackendValues {
  /** `ADMINS`: the deployment's admins. Null when the variable is absent or not a list. */
  admins: string[] | null;
  /** `CF_AI_GATEWAY_PROVIDERS`: the model providers advertised. Null when the variable is absent. */
  providers: string[] | null;
  /** `PUBLIC_BASE_URL`: the origin users reach the instance at. Null when absent or not an origin. */
  publicBaseUrl: string | null;
  /**
   * The Gatekeeper Workers it is bound to, by slug: the service bindings named
   * `GATEKEEPER_<SLUG>` as the hosted flow names them, each slug once.
   */
  gatekeepers: BoundGatekeeper[];
  /**
   * Its other service bindings whose name starts {@link GATEKEEPER_BINDING_PREFIX}, by name. Their
   * Workers are read with the instance's, so a release one runs still counts, and they are no
   * Gatekeeper to map to the catalog.
   */
  unmappedGatekeepers: UnmappedBinding[];
  /** Its push identity; null unless the service's origin, the install ID and the key ID are all set. */
  push: PushIdentity | null;
  /**
   * Whether a secret named {@link PUSH_IDENTITY_SECRET} is bound: the signing key `push` is no use
   * without. The binding's name and type are all that is looked at.
   */
  pushKeyBound: boolean;
}

/** `value` as an HTTP(S) origin, or null when it is anything more or anything else. */
function originOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return value.replace(/\/$/, "") === url.origin ? url.origin : null;
}

/** The values the backend carries, read off the version serving most of its traffic. */
export function backendValues(reading: WorkerReading): BackendValues {
  const version = reading.versions.at(0);
  const admins = jsonVar(version, "ADMINS");
  const providers = plainVar(version, "CF_AI_GATEWAY_PROVIDERS");
  const serviceUrl = plainVar(version, PUSH_IDENTITY_VARS.serviceUrl);
  const installId = plainVar(version, PUSH_IDENTITY_VARS.installId);
  const keyId = plainVar(version, PUSH_IDENTITY_VARS.keyId);
  const gatekeepers: BoundGatekeeper[] = [];
  const unmappedGatekeepers: UnmappedBinding[] = [];
  for (const { name, type, service } of version?.bindings ?? []) {
    if (type !== "service" || !service || !name.startsWith(GATEKEEPER_BINDING_PREFIX)) continue;
    const slug = GATEKEEPER_BINDING.exec(name)?.[1].toLowerCase();
    if (slug !== undefined && GATEKEEPER_SLUG.test(slug) && !gatekeepers.some((seen) => seen.slug === slug)) {
      gatekeepers.push({ slug, binding: name, worker: service });
    } else {
      unmappedGatekeepers.push({ binding: name, worker: service });
    }
  }
  return {
    admins: Array.isArray(admins) ? admins.filter((admin): admin is string => typeof admin === "string") : null,
    providers: providers === undefined ? null : providers.split(",").map((provider) => provider.trim()).filter(Boolean),
    publicBaseUrl: originOf(plainVar(version, "PUBLIC_BASE_URL")),
    gatekeepers: gatekeepers.toSorted((a, b) => a.slug.localeCompare(b.slug)),
    unmappedGatekeepers: unmappedGatekeepers.toSorted((a, b) => a.binding.localeCompare(b.binding)),
    push: serviceUrl && installId && keyId
      ? { serviceUrl, installId, keyId, webPushPublicKey: plainVar(version, PUSH_IDENTITY_VARS.webPushPublicKey) || null }
      : null,
    pushKeyBound: bindingNamed(version, PUSH_IDENTITY_SECRET)?.type === "secret_text",
  };
}

/** One word on which release the instance runs: what {@link instanceRelease} and {@link decideCommit} weigh. */
export interface ReleaseReport {
  /** Who says so: a Worker's name, or `--release` for the command's own. */
  name: string;
  release: NamedRelease;
}

/** The one release an instance counts as running, or why there is no saying. */
export type InstanceRelease =
  /** Every report names it, or it has the highest run number. `behind` are the reports of older releases. */
  | { kind: "known"; release: Release; behind: ReleaseReport[] }
  /** The newest report is a bare run number: which release is known, its id and commit are not. */
  | { kind: "run-only"; run: number; reports: ReleaseReport[] }
  /** The reports differ and no run numbers order them. */
  | { kind: "unorderable"; reports: ReleaseReport[] }
  /** No Worker says which release it runs. */
  | { kind: "none" };

/** How `report` reads in a message: who says so, and the release named. */
function describeReport({ name, release }: ReleaseReport): string {
  return `${name}: ${release.id ?? `run ${release.run}`}`;
}

/**
 * The release an instance runs, from what each of its Workers reports. One release across them is
 * the answer. Mixed releases are settled by run number, the highest winning, since storage follows
 * the newest code deployed over it; reports that differ without run numbers to order them, or that
 * share a run number under two ids, are not settled at all.
 */
export function instanceRelease(reports: readonly ReleaseReport[]): InstanceRelease {
  if (!reports.length) return { kind: "none" };
  const ids = new Set(reports.map(({ release }) => release.id));
  const [only] = reports;
  if (ids.size === 1 && only.release.id !== null) {
    return { kind: "known", release: { id: only.release.id, run: only.release.run, sha7: only.release.sha7 }, behind: [] };
  }
  const runs = reports.map(({ release }) => release.run);
  if (runs.includes(null)) return { kind: "unorderable", reports: [...reports] };
  const highest = Math.max(...runs.filter((run) => run !== null));
  const newest = reports.filter(({ release }) => release.run === highest);
  const named = newest.flatMap(({ release }) => release.id === null ? [] : [{ id: release.id, run: release.run, sha7: release.sha7 }]);
  if (!named.length) return { kind: "run-only", run: highest, reports: [...reports] };
  if (new Set(named.map(({ id }) => id)).size > 1) return { kind: "unorderable", reports: [...reports] };
  return { kind: "known", release: named[0], behind: reports.filter(({ release }) => release.run !== highest) };
}

/** Why {@link decideCommit} stopped. */
export type CommitStop =
  /** `--commit` or `--release` is not of the form the flag takes. */
  | "invalid"
  /** `--commit` is not the commit of the release it was given with, or of the one the instance runs. */
  | "mismatch"
  /** The account shows the instance past the release the command was made for. */
  | "stale"
  /** Releases that cannot be ordered disagree. */
  | "unorderable"
  /** The release is unknown, or its id names no commit. */
  | "no-commit";

/** What a takeover pins, or why it must not go on. */
export type CommitDecision =
  | {
    ok: true;
    /** What to pin: `--commit`'s full SHA, or the release id's abbreviated one. */
    commit: string;
    /** Whether `commit` is a full SHA. An abbreviated one is still to be resolved in upstream's history. */
    full: boolean;
    /** The release `commit` is the commit of; null when `--commit` came with no release to go with it. */
    release: string | null;
    /** Where `commit` came from: the flag, or the release id's sha7. */
    from: "flag" | "release";
    /**
     * The commits the instance's own Workers name that `commit` is not ({@link CommitFloor}), which
     * what is pinned must be at or past as well. Absent when there are none: the newest release of
     * the Workers' that names a commit is the one `commit` is the commit of, or none of them names one.
     */
    atLeast?: CommitFloor[];
  }
  | { ok: false; reason: CommitStop; message: string };

/**
 * A commit one of the instance's Workers names as the one it runs, through its release id, where the
 * commit to pin is another. The command's `--release` and `--commit` are the operator's word, and a
 * Worker's own release id is the account's: whatever the flags say, the pin must not end up behind a
 * commit a Worker runs, and only upstream's commit graph can say whether it would.
 */
export interface CommitFloor {
  /** The abbreviated commit the release id ends in. */
  commit: string;
  /** The release id naming it. */
  release: string;
  /** The Workers reporting that release. */
  workers: string[];
}

/** What to do when the commit is not to be had from the account. */
const ASK_FOR_COMMIT = "could not determine the commit; pass --commit, or copy the command from the deploy flow";

/** A stop, as a {@link CommitDecision}. */
function stop(reason: CommitStop, message: string): CommitDecision {
  return { ok: false, reason, message };
}

/**
 * Whether `report` shows the instance somewhere other than at or before the release `made` a
 * command was made for: a higher run number, or an id that differs with no run numbers to say which
 * of the two is the newer.
 */
function movedPast({ release }: ReleaseReport, made: Release): boolean {
  if (release.id === made.id) return false;
  if (release.run === null || made.run === null) return true;
  return release.run > made.run || release.run === made.run && release.id !== null;
}

/**
 * The commits `reports` hold a pin of `commit` to ({@link CommitFloor}): the one each of the newest
 * of them that names a commit does, where it is not `commit` itself. A report is left out only when
 * a run number puts it behind another that names a commit, which then stands for it. A newer report
 * that names none (a bare run number, an id with no commit in it) stands for nothing: the commit
 * the Workers behind it name is still the newest one known to run.
 */
function floors(reports: readonly ReleaseReport[], commit: string): CommitFloor[] {
  const found = new Map<string, CommitFloor>();
  for (const { name, release } of reports) {
    if (reports.some((other) => other.release.sha7 !== null && olderThan(release, other.release))) continue;
    if (release.id === null || release.sha7 === null || commit.startsWith(release.sha7)) continue;
    const floor = found.get(release.id) ?? { commit: release.sha7, release: release.id, workers: [] };
    if (!floor.workers.includes(name)) floor.workers.push(name);
    found.set(release.id, floor);
  }
  return [...found.values()];
}

/** `decision`, with the commits `reports` hold it to when it is one to pin ({@link floors}). */
function held(decision: CommitDecision, reports: readonly ReleaseReport[]): CommitDecision {
  if (!decision.ok) return decision;
  const atLeast = floors(reports, decision.commit);
  return atLeast.length ? { ...decision, atLeast } : decision;
}

/**
 * The commit a takeover pins, from what the instance's Workers report and the command's `--release`
 * and `--commit`.
 *
 * With `--commit`, that commit, unless something shows it is not the one to pin:
 *
 * - it is not the commit `--release` ends in;
 * - a Worker reports a higher run number than the release the command was made for, or an id that
 *   cannot be ordered against it: the instance moved after the command was made. That release is
 *   `--release`, or without one, the newest reported release whose commit `--commit` is;
 * - with neither to judge it by, it is not the commit the instance's own release ends in, or, where
 *   its newest reports disagree and each names a commit, any of theirs. Whether it is older or
 *   newer cannot be told here, and older must never be pinned.
 *
 * Without it, the commit the instance's release ends in, `--release` counted as one more report, to
 * be resolved in upstream's history. A release that is unknown, or whose id names no commit, stops
 * and asks for `--commit`.
 *
 * Either way the flags are not the last word on a commit to pin: where the newest release a Worker
 * itself reports that names a commit names another one, the decision carries it (`atLeast`), for the
 * pin to be held against in upstream's history too. A `--release` no Worker reports, with a run
 * number above them all, would otherwise pass an older commit as the newest; so would a `--commit`
 * given because one Worker's newer release names none.
 */
export function decideCommit(
  reports: readonly ReleaseReport[],
  flags: { release?: string; commit?: string } = {},
): CommitDecision {
  return held(decide(reports, flags), reports);
}

/** {@link decideCommit}, before the Workers' own commits are held against the answer. */
function decide(
  reports: readonly ReleaseReport[],
  flags: { release?: string; commit?: string },
): CommitDecision {
  const named = flags.release === undefined ? null : parseRelease(flags.release);
  if (flags.release !== undefined && !named) {
    return stop("invalid", `--release ${JSON.stringify(flags.release)} is not a release id: copy it from the deploy flow.`);
  }
  if (flags.commit === undefined) {
    return fromRelease(instanceRelease(named ? [...reports, { name: "--release", release: named }] : reports));
  }
  if (!FULL_COMMIT.test(flags.commit)) {
    return stop("invalid", `--commit ${JSON.stringify(flags.commit)} is not a full commit SHA: pass all 40 hex digits.`);
  }
  const commit = flags.commit.toLowerCase();
  if (named?.sha7 && !commit.startsWith(named.sha7)) {
    return stop("mismatch", `--commit ${commit} is not the commit of --release ${named.id}, which ends in ` +
      `${named.sha7}: copy the whole command from the deploy flow.`);
  }
  // Without --release, the newest reported release built from the commit: one commit can be built
  // by more than one run, and an earlier build of it left on a Worker is not the instance moving on.
  const made = named ?? reports
    .flatMap(({ release }) => {
      const { id, run, sha7 } = release;
      return id !== null && sha7 !== null && commit.startsWith(sha7) ? [{ id, run, sha7 }] : [];
    })
    .toSorted((a, b) => (b.run ?? 0) - (a.run ?? 0))
    .at(0);
  if (made) {
    const moved = reports.filter((report) => movedPast(report, made));
    if (moved.length) {
      const reached = instanceRelease(moved);
      const to = reached.kind === "known" ? reached.release.id
        : reached.kind === "run-only" ? `run ${reached.run}`
        : moved.map(describeReport).join(", ");
      return stop("stale", `The command is for release ${made.id}, which is not what the account shows: the instance ` +
        `moved to ${to} since this command was made; get a fresh one from the deploy flow.`);
    }
    return { ok: true, commit, full: true, release: made.id, from: "flag" };
  }
  const running = instanceRelease(reports);
  if (running.kind === "known" && running.release.sha7) {
    return stop("mismatch", `--commit ${commit} is not the commit of ${running.release.id}, the release the instance ` +
      `runs, which ends in ${running.release.sha7}. Take the instance over at its own release (leave --commit out, or ` +
      "copy the command from the deploy flow), then move on with `pnpm cf-os update --to <commit>`.");
  }
  if (running.kind === "unorderable") {
    // The reports disagree, and the commit is none of theirs. Where a newest one leaves its commit
    // unsaid, --commit may be that one's; where each names its own, it is no release's at all.
    const newest = newestReports(reports);
    if (newest.every(({ release }) => release.sha7 !== null)) {
      return stop("mismatch", `--commit ${commit} is not the commit of any release the instance's Workers report ` +
        `(${newest.map(describeReport).join(", ")}), each of which names its own: copy the command from the deploy flow.`);
    }
  }
  return { ok: true, commit, full: true, release: running.kind === "known" ? running.release.id : null, from: "flag" };
}

/**
 * The reports no run number puts behind another: those of the highest run, or every one of them
 * when one carries no run number to be ordered by.
 */
function newestReports(reports: readonly ReleaseReport[]): ReleaseReport[] {
  const runs = reports.map(({ release }) => release.run);
  if (runs.includes(null)) return [...reports];
  const highest = Math.max(...runs.filter((run) => run !== null));
  return reports.filter(({ release }) => release.run === highest);
}

/** The decision without `--commit`: the abbreviated commit `running` ends in, or the stop that asks for the flag. */
function fromRelease(running: InstanceRelease): CommitDecision {
  switch (running.kind) {
    case "known":
      return running.release.sha7
        ? { ok: true, commit: running.release.sha7, full: false, release: running.release.id, from: "release" }
        : stop("no-commit", `Release ${running.release.id} does not say which commit it was built from: ${ASK_FOR_COMMIT}.`);
    case "run-only":
      return stop("no-commit", `The instance runs release run ${running.run}, and nothing on its Workers gives that ` +
        `release's id: ${ASK_FOR_COMMIT}.`);
    case "unorderable":
      return stop("unorderable", `The releases named cannot be put in order (${running.reports.map(describeReport).join(", ")}), ` +
        `so there is no saying which is the newest: ${ASK_FOR_COMMIT}.`);
    case "none":
      return stop("no-commit", `No Worker of the instance says which release it runs, and no --release was given: ${ASK_FOR_COMMIT}.`);
  }
}

/** What a Worker is to its instance. */
export type WorkerRole = "router" | "backend" | "gatekeeper" | "other";

/** One Worker of an instance, read and judged. */
export interface InstanceWorker {
  name: string;
  role: WorkerRole;
  /** For a Gatekeeper the backend binds: the slug of that binding. */
  slug?: string;
  /**
   * What was read of it, variables' text included. The property is not enumerable: a copy made by
   * spreading or cloning the Worker does not carry it, so no copy prints it either.
   */
  reading: WorkerReading;
  /**
   * Every release the versions serving its traffic give evidence of ({@link versionReleases}), the
   * largest share's first.
   */
  releases: WorkerRelease[];
  /** Set when the Worker was changed by hand ({@link handEdited}). */
  handEdited: HandEditedWorker | null;
  /** The installation fingerprint its live version's tag ends with; null when it has no such tag. */
  fingerprint: string | null;
  /** Every installation fingerprint among the tags of the versions serving its traffic: one, unless they disagree. */
  fingerprints: string[];
}

/** A hosted instance, as its Workers describe it. */
export interface HostedInstance {
  /** Its Workers that are in the account: the router, the backend, the bound Gatekeepers by slug, then any others. */
  workers: InstanceWorker[];
  /** Names it was read under that the account has no Worker for. */
  missing: string[];
  /** Every release its Workers report, in `workers`' order. */
  reports: ReleaseReport[];
  /** The release it counts as running. */
  release: InstanceRelease;
  /** Its Workers changed by hand. */
  handEdited: HandEditedWorker[];
  /** What its backend carries; null when the backend is not in the account or has no live version. */
  backend: BackendValues | null;
  /** The router and backend names it was read under, when it was read from an account ({@link readInstance}). */
  asked?: { router: string; backend: string };
}

/** `reading` judged as the instance's `role`. */
export function instanceWorker(reading: WorkerReading, role: WorkerRole, slug?: string): InstanceWorker {
  const releases: WorkerRelease[] = [];
  for (const version of reading.versions) {
    for (const release of versionReleases(version, { backend: role === "backend" })) {
      if (!releases.some((seen) => seen.id === release.id && seen.run === release.run)) releases.push(release);
    }
  }
  const fingerprints = [...new Set(reading.versions.flatMap((version) => flowTag(version)?.fingerprint ?? []))];
  const worker: InstanceWorker = {
    name: reading.name,
    role,
    ...(slug === undefined ? {} : { slug }),
    reading,
    releases,
    handEdited: handEdited(reading),
    fingerprint: fingerprints.at(0) ?? null,
    fingerprints,
  };
  Object.defineProperty(worker, "reading", { enumerable: false });
  return printedAs(worker, () => workerSummary(worker));
}

/**
 * The instance `workers` make up, `missing` being the names the account had no Worker for and
 * `asked` the router and backend names it was read under.
 */
export function hostedInstance(
  workers: readonly InstanceWorker[],
  missing: readonly string[] = [],
  asked?: { router: string; backend: string },
): HostedInstance {
  const reports = workers.flatMap(({ name, releases }) => releases.map((release) => ({ name, release })));
  const backend = workers.find((worker) => worker.role === "backend");
  const instance: HostedInstance = {
    workers: [...workers],
    missing: [...missing],
    reports,
    release: instanceRelease(reports),
    handEdited: workers.flatMap((worker) => worker.handEdited ?? []),
    backend: backend?.reading.versions.length ? backendValues(backend.reading) : null,
    ...(asked ? { asked: { ...asked } } : {}),
  };
  return printedAs(instance, () => instanceSummary(instance));
}

/**
 * `value`, printing as `summary()` wherever it is serialised (`JSON.stringify` and so `--json`
 * output). A reading holds the text of every plain and JSON variable of a Worker, which is
 * configuration and not for printing wholesale: one typed into the wrong kind of variable may be a
 * credential. The property is not enumerable, so comparing and listing a value's fields is unchanged.
 *
 * A copy (a spread, `structuredClone`) does not carry the property and prints its own fields, which
 * is why a Worker's reading is not an enumerable one ({@link InstanceWorker.reading}): a copy of a
 * Worker, or of an instance, has no reading to print.
 */
function printedAs<T extends object>(value: T, summary: () => unknown): T {
  return Object.defineProperty(value, "toJSON", { value: summary, enumerable: false });
}

/** What is printed of one Worker of an instance: everything but its reading. */
export interface WorkerSummary {
  name: string;
  role: WorkerRole;
  slug?: string;
  releases: WorkerRelease[];
  handEdited: HandEditedWorker | null;
  fingerprint: string | null;
}

/** `worker` without its reading: what a result on stdout may carry of it. */
export function workerSummary({ name, role, slug, releases, handEdited: edited, fingerprint }: InstanceWorker): WorkerSummary {
  return { name, role, ...(slug === undefined ? {} : { slug }), releases, handEdited: edited, fingerprint };
}

/** What is printed of an instance: its Workers without their readings, and everything judged from them. */
export interface InstanceSummary {
  workers: WorkerSummary[];
  missing: string[];
  release: InstanceRelease;
  handEdited: HandEditedWorker[];
  backend: BackendValues | null;
}

/**
 * `instance` for a result on stdout: no reading, so no variable but the ones {@link backendValues}
 * picks out by name. An instance or a Worker of one serialises as this by itself, and a copy of
 * either carries no reading; a reading ({@link WorkerReading}) held on its own is never to be printed.
 */
export function instanceSummary(instance: HostedInstance): InstanceSummary {
  return {
    workers: instance.workers.map(workerSummary),
    missing: instance.missing,
    release: instance.release,
    handEdited: instance.handEdited,
    backend: instance.backend,
  };
}

/** The Workers an instance cannot be taken over without. */
const REQUIRED_ROLES: readonly ("router" | "backend")[] = ["router", "backend"];

/** Why an instance as read is not one to take over. */
export type InstanceStop =
  /** The account has no Worker under the router's or the backend's name, or one name was given for both. */
  | { reason: "missing"; role: "router" | "backend"; message: string }
  /** The router or the backend is in the account with no live deployment to read. */
  | { reason: "undeployed"; role: "router" | "backend"; message: string }
  /** The Worker read as the router is not bound to the Worker read as the backend. */
  | { reason: "unlinked"; message: string }
  /** A Worker has two parts in the instance: the router or the backend is also a Gatekeeper, or one Worker is two Gatekeepers. */
  | { reason: "roles"; message: string }
  /** Its Workers carry the tags of more than one installation. */
  | { reason: "installations"; message: string };

/** The Worker `version` reaches as its backend ({@link ROUTER_BACKEND_BINDING}), or null when it is bound to none. */
function backendOf(version: CfWorkerVersion): string | null {
  const binding = bindingNamed(version, ROUTER_BACKEND_BINDING);
  return binding?.type === "service" ? binding.service ?? null : null;
}

/**
 * What stops a takeover of `instance` before anything is pinned or written; none when it is whole,
 * which is when the Workers read as its router and its backend are shown to be exactly that, of
 * one instance. A name typed wrong must stop here: a Worker read in the wrong part has its
 * Gatekeepers unread, or another deployment's code under it, and a commit decided from the rest may
 * be behind a Worker the takeover deploys over.
 *
 * - Its router or its backend is not in the account, or one name was given for both. Without the
 *   backend its Gatekeepers were never read, so the releases reported are not the whole instance's.
 * - Its router or its backend has no live deployment: nothing says what it runs, and for the
 *   backend, which Gatekeeper Workers it binds.
 * - Its router is not bound to its backend. A router reaches its backend through the service binding
 *   {@link ROUTER_BACKEND_BINDING}, so every version serving the router's traffic must point that
 *   binding at the backend. Names the wrong way round, a Worker of some other kind and another
 *   deployment's router all fail it, changed by hand or not.
 * - The backend binds the router's or the backend's own name as a Gatekeeper, or binds one Worker as
 *   two Gatekeepers: a deploy would put one part's code over another's.
 * - Its Workers were uploaded for more than one installation, by the fingerprint the hosted flow ends
 *   every version tag with: a name given for the router or the backend belongs to another
 *   deployment, which a takeover would deploy over. A Worker changed by hand carries no fingerprint
 *   and counts for neither.
 */
export function instanceStops(instance: HostedInstance): InstanceStop[] {
  const stops: InstanceStop[] = [];
  const { asked } = instance;
  const core = {
    router: instance.workers.find((worker) => worker.role === "router"),
    backend: instance.workers.find((worker) => worker.role === "backend"),
  };
  for (const role of REQUIRED_ROLES) {
    const worker = core[role];
    if (worker) {
      if (worker.reading.versions.length) continue;
      stops.push({
        reason: "undeployed",
        role,
        message: `Worker ${worker.name}, read as the instance's ${role}, has no live deployment, so nothing says what it ` +
          `runs${role === "backend" ? " or which Gatekeeper Workers it binds" : ""}: check --${role}, or deploy it ` +
          "through the hosted flow first.",
      });
      continue;
    }
    const name = asked?.[role];
    stops.push({
      reason: "missing",
      role,
      message: asked && asked.router === asked.backend
        ? `--router and --backend both name Worker ${asked.router}: an instance has one of each, under two names.`
        : `The account has no ${role} Worker${name === undefined ? "" : ` named ${name}`} for the instance: pass ` +
          `--${role} <name> with the name it was deployed under.`,
    });
  }
  const { router, backend } = core;
  if (router && backend && router.reading.versions.length) {
    const reached = router.reading.versions.map(backendOf);
    if (!reached.every((name) => name === backend.name)) {
      const elsewhere = [...new Set(reached.flatMap((name) => name === null || name === backend.name ? [] : [name]))];
      const swapped = backend.reading.versions.some((version) => backendOf(version) === router.name);
      stops.push({
        reason: "unlinked",
        message: `Worker ${router.name} is not the router of ${backend.name}: ` +
          (elsewhere.length
            ? `its ${ROUTER_BACKEND_BINDING} service binding points at ${elsewhere.join(", ")}`
            : `it has no ${ROUTER_BACKEND_BINDING} service binding`) +
          ", and a router reaches its backend through that binding. " +
          (swapped
            ? `${backend.name} is bound that way to ${router.name}: --router and --backend are the wrong way round.`
            : "Check --router and --backend: a takeover deploys over both, so they must be one instance's."),
      });
    }
  }
  const bound = instance.backend?.gatekeepers ?? [];
  const named = [...bound, ...instance.backend?.unmappedGatekeepers ?? []];
  for (const role of REQUIRED_ROLES) {
    const worker = core[role];
    const bindings = named.filter((binding) => binding.worker === worker?.name).map(({ binding }) => binding);
    if (!worker || !bindings.length) continue;
    stops.push({
      reason: "roles",
      message: `Worker ${worker.name} is a Gatekeeper of the instance, not its ${role}: the backend binds it as ` +
        `${bindings.join(", ")}. Check --router and --backend.`,
    });
  }
  for (const worker of new Set(bound.map((gatekeeper) => gatekeeper.worker))) {
    const bindings = bound.filter((gatekeeper) => gatekeeper.worker === worker).map(({ binding }) => binding);
    if (bindings.length < 2) continue;
    stops.push({
      reason: "roles",
      message: `Worker ${worker} is bound as more than one Gatekeeper (${bindings.join(", ")}): each Gatekeeper is a ` +
        "Worker of its own, and a deploy would put one's code over the other's. Point each binding at its own Worker " +
        "through the hosted flow first.",
    });
  }
  const installations = new Map<string, string[]>();
  for (const worker of instance.workers) {
    for (const fingerprint of worker.fingerprints) {
      installations.set(fingerprint, [...installations.get(fingerprint) ?? [], worker.name]);
    }
  }
  if (installations.size > 1) {
    const groups = [...installations].map(([fingerprint, names]) => `${names.join(", ")} (${fingerprint})`);
    stops.push({
      reason: "installations",
      message: `These Workers are not one installation's: ${groups.join("; ")}. Each was uploaded by the hosted flow for ` +
        "the installation in brackets; check --router and --backend, and take over one installation's Workers only.",
    });
  }
  return stops;
}

/**
 * The report's lines for what `instance` runs: each Worker's release and where it was read, then
 * the release the instance counts as running.
 */
export function formatReleases(instance: HostedInstance): string[] {
  const width = Math.max(0, ...instance.workers.map((worker) => worker.name.length));
  const lines = instance.workers.map((worker) => {
    const releases = worker.releases.map((release) => `${release.id ?? `run ${release.run}`} (from ${SOURCE_LABELS[release.source]})`);
    return `  ${worker.name.padEnd(width)}  ${releases.join(", ") || "no release named"}`;
  });
  const { release } = instance;
  const summary = release.kind === "known"
      ? `The instance runs release ${release.release.id}` +
        (release.behind.length ? `, the newest of its Workers' (${release.behind.map(describeReport).join(", ")}).` : ".")
    : release.kind === "run-only" ? `The instance runs release run ${release.run}; nothing on its Workers gives that release's id.`
    : release.kind === "unorderable" ? "The instance's Workers name releases that cannot be put in order."
    : "No Worker of the instance says which release it runs.";
  return [...lines, summary];
}

/**
 * Reads what Worker `name` runs: its deployments, then each version the live one sends traffic to.
 * Null when the account has no Worker by that name.
 */
export async function readWorker(client: CloudflareClient, accountId: string, name: string): Promise<WorkerReading | null> {
  const deployments = await client.listWorkerDeployments(accountId, name);
  if (deployments === null) return null;
  const deployment = deployments.at(0) ?? null;
  const live = (deployment?.versions ?? [])
    .filter((version) => version.percentage > 0)
    .toSorted((a, b) => b.percentage - a.percentage);
  const versions: CfWorkerVersion[] = [];
  for (const { version_id: id } of live) versions.push(await client.getWorkerVersion(accountId, name, id));
  return { name, deployment, versions };
}

/**
 * {@link readWorker} for each of `names`, at most {@link WORKER_READS_AT_ONCE} at a time, in
 * `names`' order. After a read fails no further Worker is started, and the failure thrown is that of
 * the earliest name to fail, so a run fails the same way however the reads interleave.
 */
export async function readWorkers(
  client: CloudflareClient,
  accountId: string,
  names: readonly string[],
): Promise<(WorkerReading | null)[]> {
  const readings = new Map<number, WorkerReading | null>();
  const failures = new Map<number, unknown>();
  // A bare `next++` is a safe claim: JS runs it to completion before any other runner resumes.
  let next = 0;
  const runner = async () => {
    for (let index = next++; index < names.length && !failures.size; index = next++) {
      try {
        readings.set(index, await readWorker(client, accountId, names[index]));
      } catch (error) {
        failures.set(index, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKER_READS_AT_ONCE, names.length) }, runner));
  if (failures.size) throw failures.get(Math.min(...failures.keys()));
  return names.map((_, index) => readings.get(index) ?? null);
}

/**
 * Reads the instance whose router and backend Workers are `router` and `backend`: the backend
 * first, as its `GATEKEEPER_*` bindings are what names its Gatekeeper Workers, then the router,
 * those Gatekeepers, the Workers of its other bindings of that prefix, and any `others` found some
 * other way, such as by the hosted flow's naming.
 * Read-only: deployments and versions, within the Workers Scripts Read permission. What comes back
 * is what was found, whole or not: {@link instanceStops} says whether it is an instance to take over.
 */
export async function readInstance(
  client: CloudflareClient,
  accountId: string,
  { router, backend, others = [] }: { router: string; backend: string; others?: readonly string[] },
): Promise<HostedInstance> {
  const backendReading = await readWorker(client, accountId, backend);
  // What each version serving the backend's traffic binds: a rollout's smaller share may bind a
  // Gatekeeper Worker the larger does not, and its release counts all the same.
  const bound = (backendReading?.versions ?? [])
    .map((version) => backendValues({ name: backend, deployment: null, versions: [version] }));
  // The first role a name is given stands: a Worker is read once, as what it is to the instance
  // first. A name with a second part to play is not settled by that: `instanceStops` refuses it.
  const roles = new Map<string, { role: WorkerRole; slug?: string }>([[backend, { role: "backend" }]]);
  const claim = (name: string, entry: { role: WorkerRole; slug?: string }) => {
    if (!roles.has(name)) roles.set(name, entry);
  };
  claim(router, { role: "router" });
  for (const { gatekeepers } of bound) {
    for (const { worker, slug } of gatekeepers) claim(worker, { role: "gatekeeper", slug });
  }
  for (const { unmappedGatekeepers } of bound) {
    for (const { worker } of unmappedGatekeepers) claim(worker, { role: "other" });
  }
  for (const name of others) claim(name, { role: "other" });
  const rest = [...roles.keys()].filter((name) => name !== backend);
  const readings = new Map<string, WorkerReading | null>([[backend, backendReading]]);
  for (const [index, reading] of (await readWorkers(client, accountId, rest)).entries()) readings.set(rest[index], reading);
  const ordered = [router, backend, ...rest.filter((name) => name !== router)];
  const workers: InstanceWorker[] = [];
  const missing: string[] = [];
  for (const name of new Set(ordered)) {
    const reading = readings.get(name);
    const entry = roles.get(name);
    if (!reading || !entry) missing.push(name);
    else workers.push(instanceWorker(reading, entry.role, entry.slug));
  }
  return hostedInstance(workers, missing, { router, backend });
}
