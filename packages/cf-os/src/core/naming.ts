// The hosted flow's naming conventions, in one place. `import` matches an account's resources
// against them to find a hosted instance's; `init` derives a fresh deployment's names from them, so
// fresh and migrated deployments look alike. If the hosted flow changes a suffix, this table is the
// only thing to edit.

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

/** Every resource named after instance `n`. */
export function matchers(n: string): Matcher[] {
  const hosted = "hosted" as const;
  return [
    {
      label: "Router Worker", kind: "worker", name: n, path: ["workers", "router", "name"], value: "name",
      source: hosted,
    },
    {
      label: "Workshop Worker (all user data)", kind: "worker", name: `${n}-backend`,
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

/** The seven Worker names for instance `n`, keyed as `deployment.jsonc`'s `workers` block keys them. */
export function workerNames(n: string): Record<WorkerKey, string> {
  return Object.fromEntries(matchers(n)
    .filter((matcher) => matcher.kind === "worker")
    .map((matcher) => [matcher.path[1], matcher.name])) as Record<WorkerKey, string>;
}

/** The Access application the hosted flow creates: `Cloudflare OS <instance> <fp8>`. */
export function accessAppName(n: string): RegExp {
  return new RegExp(`^Cloudflare OS ${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: |$)`);
}

/**
 * Router names of the hosted instances among `workers`: every Worker `N` beside a Worker carrying
 * the Workshop name `matchers(N)` gives it. Only an instance has a backend.
 */
export function findInstances(workers: CfWorker[]): string[] {
  const names = new Set(workers.map((worker) => worker.name));
  return [...names].filter((n) => names.has(workerNames(n).workshop)).toSorted();
}

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
