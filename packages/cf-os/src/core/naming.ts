// The hosted flow's naming conventions, in one place. `import` matches an account's resources
// against them to find a hosted instance's; `init` derives a fresh deployment's names from them, so
// fresh and migrated deployments look alike. If the hosted flow changes a suffix, this table is the
// only thing to edit.
//
// Two names are the operator's to choose in the hosted flow, the router Worker's and the backend
// Worker's (`CoreNames`); everything else is named after the instance.

import type { CfWorker } from "./client.ts";

/** One resource named after the instance. */
export interface Matcher {
  /** What it is, for the report. */
  label: string;
  kind: "worker" | "kv" | "r2" | "gateway";
  /** The name it gets, for instance `n`. */
  name: string;
  /** Where its value goes in `deployment.jsonc`. */
  path: string[];
  /** What to write there: the name itself, or (KV) the namespace's ID. */
  value: "name" | "id";
  /**
   * `hosted`: the hosted flow creates it, so discovery looks for it. `suggestion`: the hosted flow
   * has no such resource; the name is only what a fresh deployment, or a takeover, is offered.
   */
  source: "hosted" | "suggestion";
  /** Said when a hosted resource is missing. */
  missing?: string;
}

/**
 * The names of an instance's router and backend Workers where they are not the hosted flow's
 * defaults, `<instance>` and `<instance>-backend`: what `--router` and `--backend` give.
 */
export interface CoreNames {
  router?: string;
  backend?: string;
}

/** The router and backend Worker names of instance `n`: `names`' where it gives one, else the hosted flow's default. */
export function coreNames(n: string, names: CoreNames = {}): Required<CoreNames> {
  return { router: names.router ?? n, backend: names.backend ?? `${n}-backend` };
}

/**
 * The instance a router and a backend are named after, when the two carry the names the hosted flow
 * gives an instance's by default ({@link coreNames}); null for any other two. The operator may give
 * the two any names, these included, so it is what the names say and no proof of the instance.
 */
export function coreInstance({ router, backend }: Required<CoreNames>): string | null {
  return backend === coreNames(router).backend ? router : null;
}

/**
 * Every resource named after instance `n`. `names` gives the router's and the backend's where the
 * instance was deployed under names of its own; every other resource is named after `n` either way.
 */
export function matchers(n: string, names: CoreNames = {}): Matcher[] {
  const hosted = "hosted" as const;
  const core = coreNames(n, names);
  return [
    {
      label: "Router Worker", kind: "worker", name: core.router, path: ["workers", "router", "name"], value: "name",
      source: hosted,
    },
    {
      label: "Workshop Worker (all user data)", kind: "worker", name: core.backend,
      path: ["workers", "workshop", "name"], value: "name", source: hosted,
    },
    {
      label: "Context Gatekeeper Worker", kind: "worker", name: `${n}-gk-context`,
      path: ["workers", "context", "name"], value: "name", source: hosted,
    },
    {
      label: "Scheduler Gatekeeper Worker", kind: "worker", name: `${n}-gk-scheduler`,
      path: ["workers", "scheduler", "name"], value: "name", source: hosted,
    },
    {
      label: "Web Search Gatekeeper Worker", kind: "worker", name: `${n}-gk-websearch`,
      path: ["workers", "websearch", "name"], value: "name", source: hosted,
      missing: "instances deployed before Web Search shipped have none; name it yourself " +
        `(e.g. "${n}-gk-websearch") and the deploy creates it`,
    },
    {
      label: "Custom Gatekeeper Worker", kind: "worker", name: `${n}-gk-custom`,
      path: ["workers", "customGatekeeper", "name"], value: "name", source: "suggestion",
    },
    {
      label: "Error Reporter Worker", kind: "worker", name: `${n}-errors`,
      path: ["workers", "errorReporter", "name"], value: "name", source: "suggestion",
    },
    {
      label: "Blueprints KV namespace", kind: "kv", name: `${n}-blueprints`,
      path: ["resources", "blueprintsKvNamespaceId"], value: "id", source: hosted,
    },
    {
      label: "Avatars KV namespace", kind: "kv", name: `${n}-avatars`,
      path: ["resources", "avatarsKvNamespaceId"], value: "id", source: hosted,
    },
    {
      label: "Context collections KV namespace", kind: "kv", name: `${n}-context-collections`,
      path: ["context", "kvNamespaceId"], value: "id", source: hosted,
    },
    {
      label: "Blueprint content R2 bucket", kind: "r2", name: `${n}-blueprint-content`,
      path: ["resources", "blueprintContentBucket"], value: "name", source: hosted,
    },
    {
      label: "AI Gateway", kind: "gateway", name: `${n}-ai`, path: ["aiGateway", "name"], value: "name",
      source: hosted,
    },
  ];
}

/** A `workers.<key>` entry in `deployment.jsonc`. */
export type WorkerKey =
  "router" | "workshop" | "context" | "scheduler" | "websearch" | "customGatekeeper" | "errorReporter";

/**
 * The seven Worker names for instance `n`, keyed as `deployment.jsonc`'s `workers` block keys them,
 * the router's and the backend's being `names`' where it gives them.
 */
export function workerNames(n: string, names: CoreNames = {}): Record<WorkerKey, string> {
  return Object.fromEntries(matchers(n, names)
    .filter((matcher) => matcher.kind === "worker")
    .map((matcher) => [matcher.path[1], matcher.name])) as Record<WorkerKey, string>;
}

/** The Access application the hosted flow creates: `Cloudflare OS <instance> <fp8>`. */
export function accessAppName(n: string): RegExp {
  return new RegExp(`^Cloudflare OS ${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: |$)`);
}

/**
 * The instance an Access application is named after, when its name is exactly the one the hosted
 * flow creates an instance's application under ({@link accessAppName}); null for a name of any
 * other form.
 */
export function accessAppInstance(name: string): string | null {
  return /^Cloudflare OS (\S+) [0-9a-f]{8}$/.exec(name)?.[1] ?? null;
}

/**
 * The instance an AI Gateway is named after, when it carries the name the hosted flow gives an
 * instance's gateway ({@link matchers}); null for any other.
 */
export function gatewayInstance(gateway: string): string | null {
  const suffix = "-ai";
  return gateway.endsWith(suffix) && gateway.length > suffix.length ? gateway.slice(0, -suffix.length) : null;
}

/**
 * The instance a Gatekeeper Worker is named after, when it carries the name the hosted flow gives
 * the Gatekeeper with install slug `slug` ({@link gatekeeperWorkerName}); null when it is called
 * anything else.
 */
export function gatekeeperInstance(worker: string, slug: string): string | null {
  const suffix = `-gk-${slug}`;
  return worker.endsWith(suffix) && worker.length > suffix.length ? worker.slice(0, -suffix.length) : null;
}

/**
 * Router names of the hosted instances among `workers`: every Worker `N` beside a Worker carrying
 * the Workshop name `matchers(N)` gives it. Only an instance has a backend. An instance deployed
 * under a router or backend name of its own ({@link CoreNames}) is not among them: nothing in a list
 * of Worker names says which two belong together, so it is named by the operator, with `--router`
 * and `--backend` ({@link CUSTOM_NAMES_HINT}).
 *
 * A name listed here is what two Worker names say, and not yet the instance's: an instance whose
 * router and backend the operator called `X` and `X-backend` is listed as `X` whatever it is named.
 * A take-over holds the name against what the backend carries before it matches anything under it
 * (`instanceNameProblem`, discovery.ts).
 */
export function findInstances(workers: CfWorker[]): string[] {
  const names = new Set(workers.map((worker) => worker.name));
  return [...names].filter((n) => names.has(workerNames(n).workshop)).toSorted();
}

/** What to do about an instance the hosted flow's naming does not find: said wherever one was not found. */
export const CUSTOM_NAMES_HINT =
  "An instance deployed under Worker names of its own is not found by name: pass its name with " +
  "--router <name> and --backend <name>, the router and backend Workers it was deployed under.";

/** The `N-gk-*` suffixes of the Gatekeepers the starter always deploys: the source of BUILT_IN_GATEKEEPER_SLUGS. */
export function deployedGatekeeperSuffixes(n: string): Set<string> {
  const prefix = `${n}-gk-`;
  return new Set(Object.values(workerNames(n))
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length)));
}

/**
 * The install slugs of the Gatekeepers the starter always deploys (or, for `custom`, deploys unless
 * it is turned off). None can be an optional Gatekeeper's: each slug is one `GATEKEEPER_<SLUG>`
 * binding and one `/gatekeeper/<slug>` route.
 */
export const BUILT_IN_GATEKEEPER_SLUGS: readonly string[] = [...deployedGatekeeperSuffixes("n")];

/** The Worker name of optional Gatekeeper `slug` for instance `n`, as the hosted flow names it. */
export function gatekeeperWorkerName(n: string, slug: string): string {
  return `${n}-gk-${slug}`;
}

/** A Worker name: lowercase letters, digits and inner hyphens, at most 63 characters. */
export const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Why `n` cannot be a base name, or undefined when it can. It has to leave room for the longest
 * suffix in {@link matchers}, and for each selected optional Gatekeeper's `-gk-<slug>`, since every
 * derived name is a Worker, KV namespace or bucket name too.
 */
export function baseNameProblem(n: string, slugs: readonly string[] = []): string | undefined {
  if (!WORKER_NAME.test(n)) return "Use lowercase letters, numbers and hyphens, starting and ending with a letter or number.";
  const longest = [...matchers(n).map((matcher) => matcher.name), ...slugs.map((slug) => gatekeeperWorkerName(n, slug))]
    .reduce((max, name) => Math.max(max, name.length), 0);
  if (longest > 63) return `Too long: the longest derived name would be ${longest} characters, over Workers' 63.`;
  return undefined;
}
