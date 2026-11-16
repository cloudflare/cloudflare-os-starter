// Finds what an existing hosted-deploy instance already runs in an account, as the
// `deployment.jsonc` values that redeploy over it: Worker names, the storage it is bound to, its AI
// Gateway, its Access application, the optional Gatekeepers the starter can deploy over, and what
// its backend carries (admins, model providers, the public origin, the push identity). See
// docs/migrate-from-hosted.md for why each value matters.
//
// Nothing here is guessed. A resource that does not match `matchers()` (naming.ts) is reported as
// missing and left as it is in the file -- the cost of a wrong guess is a deploy that binds new,
// empty storage.
//
// Two sources, the second optional (`HostedSources`). The account's inventory is matched by name.
// What the instance's Workers run (core/hosted-release.ts), when it was read, says what the names
// cannot: which Workers the backend binds as its Gatekeepers, whatever they are called, and the
// values in the backend's variables.
//
// Every resource but the Workers is found by the instance's name, and the router's and the backend's
// names are the operator's to choose in the hosted flow, so no instance's name is taken from its two
// Workers' names alone: it is held against what the Workers carry (`instanceNameProblem`) before
// anything is matched under it.

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
  type CfWorkerBinding,
  type CloudflareClient,
} from "./client.ts";
import { AI_GATEWAY_PROVIDERS } from "./deployment-config.ts";
import { pushIdentityEdit, PUSH_IDENTITY_PATH, type DeploymentEdit } from "./edits.ts";
import type { ExcludedGatekeeper } from "./gatekeepers.ts";
import {
  DEPLOYMENT_VAR,
  GATEKEEPER_BINDING_PREFIX,
  PUSH_IDENTITY_SECRET,
  PUSH_IDENTITY_VARS,
  type HostedInstance,
} from "./hosted-release.ts";
import {
  accessAppInstance,
  accessAppName,
  BUILT_IN_GATEKEEPER_SLUGS,
  coreInstance,
  coreNames,
  gatekeeperInstance,
  gatewayInstance,
  matchers,
  type CoreNames,
} from "./naming.ts";

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

/**
 * Reads everything {@link discover} matches against: six reads, no writes, run at once. Whichever
 * finishes first, the error thrown is the first failure in the order they are listed here, the
 * organization's first, so a run fails the same way however the reads interleave.
 */
export async function fetchInventory(client: CloudflareClient, accountId: string): Promise<Inventory> {
  // Every read starts before the first await.
  const reads = {
    organization: quietly(client.getOrganization(accountId)),
    workers: quietly(client.listWorkers(accountId)),
    kvNamespaces: quietly(client.listKvNamespaces(accountId)),
    buckets: quietly(client.listR2Buckets(accountId)),
    gateways: quietly(client.listAiGateways(accountId)),
    accessApps: quietly(client.listAccessApps(accountId)),
  };
  let organization: CfOrganization | null;
  try {
    organization = await reads.organization;
  } catch (error) {
    if (error instanceof CfAuthError || error instanceof CfUnavailableError) throw error;
    organization = null;
  }
  return {
    workers: await reads.workers,
    kvNamespaces: await reads.kvNamespaces,
    buckets: await reads.buckets,
    gateways: await reads.gateways,
    accessApps: await reads.accessApps,
    organization,
  };
}

/** `promise`, with a no-op catch attached so it may reject before anything awaits it. */
function quietly<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
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

/**
 * A Gatekeeper Worker the starter deploys over: an optional Gatekeeper the catalog offers, which the
 * backend binds as `GATEKEEPER_<SLUG>`, or, where the instance's Workers were not read, the Worker
 * named `N-gk-<slug>`.
 */
export interface FoundGatekeeper {
  slug: string;
  /** Its Worker name. */
  name: string;
}

/** A Gatekeeper Worker of the instance the starter cannot deploy, and why. */
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
  /** Gatekeeper Workers of the instance the starter cannot deploy, which lose their binding on redeploy. */
  orphanedGatekeepers: OrphanedGatekeeper[];
  /** Anything else worth saying: ambiguity, disagreements between sources. */
  notes: string[];
}

/** What is known of an instance beyond the account's inventory. */
export interface HostedSources {
  /** Its router's and backend's Worker names, where they are not the hosted flow's defaults. */
  names?: CoreNames;
  /**
   * What its Workers run, read off the account (`readInstance`, core/hosted-release.ts). With it,
   * the Gatekeeper Workers are the ones its backend binds, and the backend's own values are written.
   * Without it, Gatekeepers are matched by the hosted flow's `N-gk-<slug>` naming alone and those
   * values are left for the operator.
   */
  instance?: HostedInstance;
}

/** The binding named `name` on the version serving most of the backend's traffic, if `instance` was read and has one. */
function backendBinding(instance: HostedInstance | undefined, name: string): CfWorkerBinding | undefined {
  return instance?.workers.find((worker) => worker.role === "backend")
    ?.reading.versions.at(0)?.bindings?.find((binding) => binding.name === name);
}

/** The text of the backend's plain variable `name`; undefined when it has none, or the instance was not read. */
function backendVar(instance: HostedInstance | undefined, name: string): string | undefined {
  const binding = backendBinding(instance, name);
  return binding?.type === "plain_text" ? binding.text : undefined;
}

/** The backend's plain variable holding the audience of the Access application in front of the instance. */
const ACCESS_AUDIENCE_VAR = "CF_ACCESS_AUD";

/** The backend's plain variable naming the AI Gateway its model calls go through. */
const AI_GATEWAY_VAR = "CF_AI_GATEWAY";

/** The backend's service binding to the Gatekeeper with install slug `slug`. */
function gatekeeperBinding(slug: string): string {
  return `${GATEKEEPER_BINDING_PREFIX}${slug.toUpperCase()}`;
}

/**
 * Matches `inventory` against instance `n`'s naming, and reads what `hosted` knows beyond it. A
 * Gatekeeper beyond the built-in ones is deployable when `offeredSlugs` has its slug, a repeat
 * install when it is a known slug plus digits (`google2`), and otherwise unknown, with `excluded`'s
 * reason if any.
 */
export function discover(
  n: string,
  inventory: Inventory,
  offeredSlugs: readonly string[] = [],
  excluded: readonly ExcludedGatekeeper[] = [],
  hosted: HostedSources = {},
): Discovery {
  const edits: DeploymentEdit[] = [];
  const rows: ReportRow[] = [];
  const notes: string[] = [];
  const workerNames = new Map(inventory.workers.map((worker) => [worker.name, worker]));
  const kvByTitle = new Map(inventory.kvNamespaces.map((namespace) => [namespace.title, namespace]));
  const core = coreNames(n, hosted.names);
  const prefix = `${n}-gk-`;
  // What the backend carries, and the Gatekeeper Workers it binds: undefined when the instance's
  // Workers were not read, which leaves names as the only evidence.
  const backend = hosted.instance?.backend ?? undefined;
  const bound = backend?.gatekeepers;

  for (const matcher of matchers(n, hosted.names).filter((candidate) => candidate.source === "hosted")) {
    let found: string | null = null;
    let expected = matcher.name;
    let note: string | undefined;
    // The slug of a built-in Gatekeeper's row. The router and the backend are never one, whatever they are called.
    const builtIn = matcher.kind === "worker" && matcher.path[1] !== "router" && matcher.path[1] !== "workshop";
    const slug = builtIn && matcher.name.startsWith(prefix) ? matcher.name.slice(prefix.length) : undefined;
    if (bound && slug !== undefined) {
      // A built-in Gatekeeper is the Worker the backend binds as it, whatever that Worker is called.
      const binding = bound.find((gatekeeper) => gatekeeper.slug === slug);
      expected = `the backend's ${gatekeeperBinding(slug)} service binding`;
      if (binding && workerNames.has(binding.worker)) found = binding.worker;
      else if (binding) note = `the backend binds ${binding.worker}, which the account does not have`;
      else if (workerNames.has(matcher.name)) {
        note = `Worker ${matcher.name} is in the account, but the backend does not bind it, so it is not this ` +
          "instance's; naming it here deploys over it";
      }
    } else if (matcher.kind === "worker" && workerNames.has(matcher.name)) found = matcher.name;
    if (matcher.kind === "kv") found = kvByTitle.get(matcher.name)?.id ?? null;
    if (matcher.kind === "r2" && inventory.buckets.includes(matcher.name)) found = matcher.name;
    if (matcher.kind === "gateway" && inventory.gateways.some((gateway) => gateway.id === matcher.name)) {
      found = matcher.name;
    }
    note ??= matcher.missing;
    rows.push({
      label: matcher.label,
      found,
      expected,
      path: matcher.path.join("."),
      ...(found === null && note ? { note } : {}),
    });
    if (matcher.kind === "gateway") {
      // The gateway holds the provider keys, so one the backend names otherwise is said, not settled here.
      const carried = backendVar(hosted.instance, AI_GATEWAY_VAR);
      if (carried !== undefined && carried !== matcher.name) {
        notes.push(`The backend's ${AI_GATEWAY_VAR} is ${carried}, not ${matcher.name}, the gateway the hosted flow names after ` +
          `the instance${found === null ? "" : ", which is the one written"}. Check aiGateway.name before deploying. If the ` +
          `instance's name is not ${n}, the storage and Access values here are another deployment's too: they are matched by that name.`);
      }
    }
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
  // The application is found by its name; the audience the backend itself checks sign-ins against
  // is the instance's own word, so one that is not the application's is said, not settled here.
  const checked = backendVar(hosted.instance, ACCESS_AUDIENCE_VAR);
  if (app?.aud && checked !== undefined && checked !== app.aud) {
    notes.push(`The backend's ${ACCESS_AUDIENCE_VAR} is ${checked}, not ${app.aud}, the AUD of the Access application ` +
      `${JSON.stringify(app.name)}, which is the one written. The instance checks sign-ins against the first, so a deploy ` +
      "with the second may turn its users away: check access.audience against the application protecting the router's " +
      "hostname before deploying.");
  }

  const issuer = inventory.organization ? issuerOf(inventory.organization) : undefined;
  rows.push({
    label: "Access issuer (team domain)",
    found: issuer ?? null,
    expected: "the account's Zero Trust organization",
    path: "access.issuer",
    ...(issuer ? {} : { note: "the account has no readable Zero Trust organization" }),
  });
  if (issuer) edits.push({ path: ["access", "issuer"], value: issuer });

  if (backend) {
    // The admins and the model providers, as the backend's own variables have them.
    const admins = (backend.admins ?? []).map((admin) => admin.trim()).filter(Boolean);
    rows.push({
      label: "Admins",
      found: admins.length ? admins.join(", ") : null,
      expected: "the backend's ADMINS variable",
      path: "access.admins",
    });
    if (admins.length) edits.push({ path: ["access", "admins"], value: admins });

    const providers = backend.providers ?? [];
    rows.push({
      label: "Model providers",
      found: providers.length ? providers.join(", ") : null,
      expected: "the backend's CF_AI_GATEWAY_PROVIDERS variable",
      path: "aiGateway.providers",
    });
    if (providers.length) edits.push({ path: ["aiGateway", "providers"], value: providers });
    const unknown = providers.filter((provider) => !AI_GATEWAY_PROVIDERS.some((known) => known === provider));
    if (unknown.length) {
      notes.push(`The backend advertises ${unknown.join(", ")}, which the starter does not serve ` +
        `(${AI_GATEWAY_PROVIDERS.join(", ")}): \`pnpm cf-os check\` refuses aiGateway.providers until it is taken out.`);
    }
  }

  // The public origin. The backend's PUBLIC_BASE_URL is where the instance itself says users reach
  // it, and is read first. Failing that, the Access application's primary hostname says the same;
  // and the router Worker's own record says what its workers.dev address is, which closes the gap
  // wrangler leaves (it has no command for the account's workers.dev subdomain).
  const appHost = app ? accessAppHosts(app)[0] : undefined;
  const routerUrl = workerNames.get(core.router)?.subdomain?.url?.replace(/\/$/, "");
  let origin: { route: Record<string, unknown>; publicBaseUrl: string | null; source: string } | undefined;
  const carried = backend?.publicBaseUrl ? new URL(backend.publicBaseUrl) : undefined;
  // A route is a custom domain or a workers.dev address, over HTTPS on its default port.
  const usable = carried && carried.protocol === "https:" && !carried.port ? carried : undefined;
  if (carried && !usable) {
    notes.push(`The backend's PUBLIC_BASE_URL is ${carried.origin}, which no route in deployment.jsonc expresses ` +
      "(a custom domain or workers.dev address, over HTTPS on its default port), so it is not used.");
  }
  if (usable) {
    const source = "the backend's PUBLIC_BASE_URL";
    origin = usable.hostname.endsWith(".workers.dev")
      ? { route: { workersDev: true }, publicBaseUrl: usable.origin, source }
      : { route: { customDomain: usable.hostname }, publicBaseUrl: null, source };
    if (appHost && appHost !== usable.hostname) {
      notes.push(`The backend's PUBLIC_BASE_URL is ${usable.origin}, but the Access application protects ${appHost}. ` +
        "Using PUBLIC_BASE_URL; check the application covers it.");
    }
    if (origin.publicBaseUrl && routerUrl && routerUrl !== origin.publicBaseUrl) {
      notes.push(`The backend's PUBLIC_BASE_URL is ${origin.publicBaseUrl}, but the router Worker's workers.dev ` +
        `address is ${routerUrl}. Using PUBLIC_BASE_URL; check which one users visit.`);
    }
  } else if (appHost && !appHost.endsWith(".workers.dev")) {
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
    expected: backend
      ? "the backend's PUBLIC_BASE_URL, the Access application's hostname or the router's workers.dev URL"
      : "the Access application's hostname or the router's workers.dev URL",
    path: "workers.router.route / publicBaseUrl",
    ...(origin ? { note: `from ${origin.source}` } : {}),
  });
  if (origin) {
    edits.push({ path: ["workers", "router", "route"], value: origin.route });
    edits.push({ path: ["publicBaseUrl"], value: origin.publicBaseUrl });
  }

  if (backend) {
    // The push identity: the four variables go into the file, and the key that signs with them stays
    // where it is, a secret of the backend Worker that nothing here reads.
    const { push } = backend;
    rows.push({
      label: "Push identity",
      found: push ? `install ${push.installId}, key ${push.keyId}, at ${push.serviceUrl}` : null,
      expected: `the backend's ${[PUSH_IDENTITY_VARS.serviceUrl, PUSH_IDENTITY_VARS.installId, PUSH_IDENTITY_VARS.keyId].join(", ")} variables`,
      path: PUSH_IDENTITY_PATH.join("."),
      ...(push ? {} : { note: "the instance has none, so it sends no push notifications, and a take-over changes nothing there" }),
    });
    if (push) {
      edits.push(pushIdentityEdit(push));
      notes.push(backend.pushKeyBound
        ? `The push identity's signing key is the secret ${PUSH_IDENTITY_SECRET} on ${core.backend}. It is not read and ` +
          "not written: a deploy leaves a Worker's secrets in place, so push keeps working as long as the Worker keeps " +
          "its name. Replacing that key, or registering another origin, takes the hosted flow."
        : `The backend carries a push identity but no ${PUSH_IDENTITY_SECRET} secret to sign with, so push does not ` +
          "work on the instance as it is. The identity is carried over all the same; the key is the hosted flow's to set.");
    }
    if (backendBinding(hosted.instance, DEPLOYMENT_VAR)) {
      notes.push(`The backend's ${DEPLOYMENT_VAR} variable, which makes the Workshop offer updates through the hosted ` +
        "flow, is not carried over: once this project deploys, the Updates offer goes away, and updates are " +
        "`cf-os update`'s.");
    }
  }

  const foundGatekeepers: FoundGatekeeper[] = [];
  const orphanedGatekeepers: OrphanedGatekeeper[] = [];
  const named = inventory.workers.map((worker) => worker.name).filter((candidate) => candidate.startsWith(prefix)).toSorted();
  // The Gatekeeper Workers: the ones the backend binds, by the slug of each binding, which is what
  // the hosted flow itself goes by; or, with no backend read, the Workers named `N-gk-<slug>`.
  const candidates = bound
    ? bound.map(({ slug, worker, binding }) => ({ slug, name: worker, binding }))
    : named.map((name) => ({ slug: name.slice(prefix.length), name, binding: undefined }));
  for (const { slug, name, binding } of candidates) {
    if (BUILT_IN_GATEKEEPER_SLUGS.includes(slug)) continue;
    if (!workerNames.has(name)) {
      notes.push(`The backend binds ${binding ?? gatekeeperBinding(slug)} to Worker ${name}, which the account does not have: ` +
        "there is nothing to deploy over, so it is left out.");
      continue;
    }
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
  if (bound) {
    for (const { binding, worker } of backend?.unmappedGatekeepers ?? []) {
      notes.push(`The backend's service binding ${binding}, to Worker ${worker}, names no Gatekeeper the hosted flow ` +
        "installs, so it maps to nothing here: a deploy drops the binding, and the Worker keeps running unbound.");
    }
    const taken = new Set(bound.map((gatekeeper) => gatekeeper.worker));
    const unbound = named.filter((name) => !taken.has(name) && !BUILT_IN_GATEKEEPER_SLUGS.includes(name.slice(prefix.length)));
    if (unbound.length) {
      notes.push("Named like this instance's Gatekeepers, but not bound by its backend, so no part of it, and left " +
        `alone: ${unbound.join(", ")}.`);
    }
  }
  // A Gatekeeper's own settings are not carried over, and a deploy overwrites a Worker's vars wholesale.
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

/** Something an instance's Workers carry that names the instance. */
export interface NameEvidence {
  /** The instance name it gives. */
  name: string;
  /** What gives it, as a clause of a message. */
  from: string;
}

/**
 * What `instance`'s backend carries that says which instance it is the backend of, in three tiers,
 * the most telling first. Each is a name the hosted flow derives from the instance's own, so it is
 * evidence only where it has the hosted flow's form; a value of any other form names no instance.
 *
 * 1. The Access application the backend's `CF_ACCESS_AUD` is the audience of, which the hosted flow
 *    names `Cloudflare OS <instance> <fp8>`. The audience is the one the backend itself checks
 *    sign-ins against, so the application is this instance's whatever any Worker is called.
 * 2. The Gatekeeper Workers the backend binds, each `<instance>-gk-<slug>` under the slug of its
 *    binding unless the operator named that one otherwise.
 * 3. The AI Gateway the backend's `CF_AI_GATEWAY` names, `<instance>-ai`: a gateway holds provider
 *    keys, so it is the one of these a hand points somewhere else on purpose.
 *
 * The `<fp8>` a version tag ends in is not asked: it names an installation, and nothing shows it
 * differs between two instances of one account, so an application is picked by the audience alone.
 */
export function nameEvidence(inventory: Inventory, instance: HostedInstance): [NameEvidence[], NameEvidence[], NameEvidence[]] {
  const audience = backendVar(instance, ACCESS_AUDIENCE_VAR);
  const byAudience = !audience ? [] : inventory.accessApps.flatMap((app) => {
    const name = app.aud === audience ? accessAppInstance(app.name ?? "") : null;
    return name === null ? [] : [{
      name,
      from: `the backend's ${ACCESS_AUDIENCE_VAR} is the audience of the Access application ${JSON.stringify(app.name)}`,
    }];
  });
  const byGatekeeper = (instance.backend?.gatekeepers ?? []).flatMap(({ slug, worker, binding }) => {
    const name = gatekeeperInstance(worker, slug);
    return name === null ? [] : [{ name, from: `the backend's ${binding} service binding points at Worker ${worker}` }];
  });
  const gateway = backendVar(instance, AI_GATEWAY_VAR);
  const gatewayName = gateway === undefined ? null : gatewayInstance(gateway);
  const byGateway = gatewayName === null ? [] : [{ name: gatewayName, from: `the backend's ${AI_GATEWAY_VAR} is ${gateway}` }];
  return [byAudience, byGatekeeper, byGateway];
}

/** What matching an instance under a name that is not its own does: why {@link instanceNameProblem} stops. */
const MATCHED_BY_NAME =
  "An instance's storage, AI Gateway and Access application are found by its name, so under another name these " +
  "Workers would be paired with another deployment's, or with none, and a deploy would bind them to it.";

/** The form of the one name that settles an instance's on its own: the first tier of {@link nameEvidence}. */
const ACCESS_APP_FORM = "`Cloudflare OS <instance> <fp8>`";

/**
 * Why `n` is not shown to be the name of the instance read as `instance`, as the lines to print;
 * null when it is.
 *
 * Everything but the two Workers is matched by `n` alone ({@link discover}), and the two Workers'
 * names are the operator's to choose: here with `--router` and `--backend`, and in the hosted flow
 * that deployed it, where an instance "moss" may have been given the router `moss-os` and the backend
 * `moss-os-backend`, which read as an instance "moss-os" under the hosted flow's own names. A name
 * typed wrong, another instance's, or one read off such a pair would write this instance's Workers
 * beside another deployment's storage and Access application, or beside none. So `n` is asked of
 * every instance, however its Workers are named.
 *
 * The Access application ({@link nameEvidence}'s first tier) decides alone where it names an
 * instance: it is tied to the backend by its audience and named after the instance, not after a
 * Worker, so a Gatekeeper Worker the operator named after something else does not unsettle it.
 *
 * Failing that, the next tier that names any instance decides, together with the two Workers' own
 * names where they are the hosted flow's pair for an instance ({@link coreInstance}), and everything
 * deciding must name `n`: evidence that disagrees is not settled by a guess. The gateway is asked only
 * when no Gatekeeper Worker names an instance, so one pointed elsewhere by hand does not unsettle an
 * instance its Gatekeepers name (`discover` notes it). An instance under the hosted flow's own names
 * that carries nothing else is `n` by those names. With nothing naming any instance there is nothing
 * to hold `n` against, and that stops too.
 *
 * The gateway deciding alone is the weakest case, a name a hand points at another instance's gateway
 * on purpose, and one thing the account's Worker list says outweighs it: Workers named as the hosted
 * flow names `n`'s own router and backend, which are not the two given. Those are instance `n` as
 * far as names go, so the two given are not shown to be, and that stops as well.
 */
export function instanceNameProblem(
  n: string,
  inventory: Inventory,
  names: CoreNames,
  instance: HostedInstance,
): string | null {
  const core = coreNames(n, names);
  const workers = `${core.router} and ${core.backend}`;
  const [byAudience, ...lower] = nameEvidence(inventory, instance);
  const paired = coreInstance(core);
  const byWorkers: NameEvidence[] = paired === null ? [] : [{
    name: paired,
    from: `Workers ${workers} are named as the hosted flow names an instance's router and backend`,
  }];
  const deciding = byAudience.length ? byAudience : [...byWorkers, ...lower.find((tier) => tier.length) ?? []];
  const [byGatekeeper = [], byGateway = []] = lower;
  const own = coreNames(n);
  const listed = (name: string) => inventory.workers.some((worker) => worker.name === name);
  // The gateway alone names `n`, for two Workers that are not named as `n`'s, beside two that are.
  if (!byAudience.length && !byWorkers.length && !byGatekeeper.length && byGateway.length &&
    byGateway.every((evidence) => evidence.name === n) && listed(own.router) && listed(own.backend)) {
    return [
      `Whether "${n}" is the name of the instance ${workers} belong to cannot be told from what they carry:`,
      ...byGateway.map((evidence) => `  ${evidence.from}, which names instance ${evidence.name}`),
      `  the account has Workers ${own.router} and ${own.backend}, named as the hosted flow names instance ${n}'s own router and backend`,
      `A gateway is shared, or pointed at another instance's, by hand, so alone it does not show that ${workers} are ` +
        `instance ${n}'s and ${own.router} and ${own.backend} are not. An Access application named ${ACCESS_APP_FORM} that the ` +
        `backend's ${ACCESS_AUDIENCE_VAR} is the audience of would settle it; there is none.`,
      `${MATCHED_BY_NAME} If ${own.router} and ${own.backend} are the instance, run this for ${n} without --router and --backend.`,
    ].join("\n");
  }
  if (!deciding.length) {
    return [
      `Nothing ${workers} carry says they are instance "${n}"'s: the backend's ${ACCESS_AUDIENCE_VAR} is the audience of no ` +
        `Access application named ${ACCESS_APP_FORM}, it binds no Gatekeeper Worker named ` +
        `\`<instance>-gk-<slug>\`, and its ${AI_GATEWAY_VAR} is not \`<instance>-ai\`.`,
      `${MATCHED_BY_NAME} One of those has to name "${n}" before the instance is taken over under --router and --backend.`,
    ].join("\n");
  }
  const named = [...new Set(deciding.map((evidence) => evidence.name))];
  if (named.length === 1 && named[0] === n) return null;
  const [only] = named;
  return [
    named.length === 1
      ? `"${n}" is not the name of the instance ${workers} belong to, by what they carry:`
      : `Whether "${n}" is the name of the instance ${workers} belong to cannot be told from what they carry:`,
    ...deciding.map((evidence) => `  ${evidence.from}, which names instance ${evidence.name}`),
    ...named.length > 1 && !byAudience.length
      ? [`An Access application named ${ACCESS_APP_FORM} that the backend's ${ACCESS_AUDIENCE_VAR} is the audience of would settle it; there is none.`]
      : [],
    MATCHED_BY_NAME + (named.length === 1 && only !== undefined
      // Both names spelled out: the two Workers are not `only`'s under the hosted flow's own names.
      ? ` If the instance is ${only}, run this for ${only}, with --router ${core.router} --backend ${core.backend}.`
      : " What they carry names more than one instance, so there is no saying which it is" +
        (paired === n ? "." : ": check --router and --backend.")),
  ].join("\n");
}
