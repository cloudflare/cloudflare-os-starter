// The steps of `cf-os init` as data: each takes answers (and what the account holds) and returns
// defaults, problems, or the `deployment.jsonc` edits that record them. The prompting, and every
// call to Cloudflare, belong to `commands/init.ts`.

import type { AccessTarget } from "./access.ts";
import { isEmail } from "./access.ts";
import type { CfAiGateway, CfWorker } from "./client.ts";
import { AI_GATEWAY_PROVIDERS, type AiGatewayProvider } from "./deployment-config.ts";
import { editsAsFragment, isPlaceholder, PUSH_IDENTITY_PATH, valueAtPath, type DeploymentEdit } from "./edits.ts";
import { UNDECLARED_VARS, type CatalogGatekeeper } from "./gatekeepers.ts";
import { gatekeeperWorkerName, WORKER_NAME, workerNames, type WorkerKey } from "./naming.ts";

/**
 * The derived names of `n` that already belong to a Worker in the account: the starter's own, and
 * `<n>-gk-<slug>` for each of the optional Gatekeepers `slugs`.
 */
export function nameCollisions(n: string, workers: CfWorker[], slugs: readonly string[] = []): string[] {
  const existing = new Set(workers.map((worker) => worker.name));
  return [...Object.values(workerNames(n)), ...slugs.map((slug) => gatekeeperWorkerName(n, slug))]
    .filter((name) => existing.has(name));
}

/** Where the router answers: a hostname in one of the account's zones, or its workers.dev address. */
export type RouteChoice = { customDomain: string } | { workersDevSubdomain: string };

/** The hostname offered in `zone`. */
export function defaultHost(zone: string): string {
  return `os.${zone}`;
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Why `host` is not a hostname at all, or undefined when it is. */
export function hostnameProblem(host: string): string | undefined {
  return HOSTNAME.test(host) ? undefined : "Enter a lowercase hostname, such as os.example.com.";
}

/** Why `host` cannot be the router's custom domain in `zone`, or undefined when it can. */
export function hostProblem(host: string, zone: string): string | undefined {
  const problem = hostnameProblem(host);
  if (problem) return problem;
  if (host !== zone && !host.endsWith(`.${zone}`)) return `${host} is not in the zone ${zone}.`;
  return undefined;
}

/** Why `subdomain` cannot be a workers.dev subdomain, or undefined when it can. */
export function subdomainProblem(subdomain: string): string | undefined {
  return WORKER_NAME.test(subdomain)
    ? undefined
    : "Enter just the subdomain: <subdomain> in <worker>.<subdomain>.workers.dev.";
}

/** The hostname users reach router `name` on. */
export function routerHost(name: string, route: RouteChoice): string {
  return "customDomain" in route ? route.customDomain : `${name}.${route.workersDevSubdomain}.workers.dev`;
}

/** Comma- or space-separated email addresses, as typed. */
export function parseAdmins(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((email) => email.trim()).filter(Boolean))];
}

/** Why `text` is not a usable admin list, or undefined when it is. */
export function adminsProblem(text: string): string | undefined {
  const admins = parseAdmins(text);
  if (!admins.length) return "Enter at least one email address.";
  const bad = admins.find((email) => !isEmail(email));
  return bad ? `${bad} is not an email address.` : undefined;
}

/** The gateway Cloudflare creates for an account on first use. */
export const DEFAULT_GATEWAY = "default";

/** Gateway names to offer: `default` first, whether or not it exists yet, then the account's own. */
export function gatewayChoices(gateways: CfAiGateway[]): string[] {
  return [DEFAULT_GATEWAY, ...gateways.map((gateway) => gateway.id).filter((id) => id !== DEFAULT_GATEWAY)];
}

/** Providers offered, with what each needs. */
export const PROVIDER_HINTS: Readonly<Record<AiGatewayProvider, string>> = {
  cloudflare: "Workers AI, no key needed",
  anthropic: "needs a key stored on the gateway",
  openai: "needs a key stored on the gateway",
  google: "also needs CF_AI_GATEWAY_API_TOKEN",
};

/** Every provider, in the order offered. */
export const PROVIDERS: readonly AiGatewayProvider[] = AI_GATEWAY_PROVIDERS;

/** The example custom Gatekeeper's display text, defaulted from the account's name. */
export function defaultCustomGatekeeper(accountName: string | undefined): { name: string; message: string } {
  const name = accountName?.trim() || "Cloudflare OS";
  return { name, message: `This is ${name}'s Cloudflare OS deployment.` };
}

/** The value of the Gatekeeper question's choice for the example custom Gatekeeper. */
export const CUSTOM_GATEKEEPER_CHOICE = "custom";

/** What an optional Gatekeeper needs, beside its name in the Gatekeeper question. */
export function gatekeeperHint(entry: CatalogGatekeeper): string {
  const vars = [...entry.vars, ...UNDECLARED_VARS[entry.slug] ?? []].map((input) => input.name);
  return [
    entry.secrets.length ? `needs ${entry.secrets.map((input) => input.name).join(", ")}` : "no credentials",
    ...vars.length ? [`vars ${vars.join(", ")}`] : [],
    ...entry.singleton ? ["one install only"] : [],
  ].join(", ");
}

/** The optional Gatekeepers chosen, and the ones the file lists that were not. */
export interface GatekeeperAnswers {
  /** Worker name by slug. */
  gatekeepers: Record<string, string>;
  /** Slugs whose `gatekeepers` entries the file holds, to remove. */
  removedGatekeepers: string[];
}

/**
 * The edits recording {@link GatekeeperAnswers}. Each chosen one sets only its `name`, so vars added
 * by hand stay; a removed one goes whole.
 */
function gatekeeperEdits(answers: GatekeeperAnswers): DeploymentEdit[] {
  return [
    ...Object.entries(answers.gatekeepers)
      .map(([slug, name]) => ({ path: ["gatekeepers", slug, "name"], value: name })),
    ...answers.removedGatekeepers.map((slug) => ({ path: ["gatekeepers", slug], value: undefined })),
  ];
}

/** Everything a new deployment is asked. */
export interface NewDeploymentAnswers extends GatekeeperAnswers {
  accountId: string;
  /** Base name: the router's, and the root of every other derived name. */
  name: string;
  route: RouteChoice;
  admins: string[];
  aiGateway: { name: string; providers: AiGatewayProvider[] };
  /** The example custom Gatekeeper's display text, or null when it is not deployed. */
  customGatekeeper: { name: string; message: string } | null;
}

/**
 * The edit clearing the push identity `file` holds, with a note, when the new deployment `answers`
 * describe is not the one it belongs to. A push identity is one installation's, and the key that
 * signs with it is a secret on that installation's Workshop Worker: under another Workshop Worker
 * name, or in another account, the deploy would send a Worker with no such key another
 * installation's identity. The same Workshop Worker in the same account keeps it, as long as the
 * Worker is there to hold the key: `workers` is the account's Workers where they were listed, null
 * where they could not be, and a list that lacks the Worker shows the deploy would create it, with
 * no key. Only a list that could not be read leaves the same name in the same account the benefit of
 * the doubt.
 */
export function strayPushIdentity(
  file: Record<string, unknown>,
  answers: Pick<NewDeploymentAnswers, "accountId" | "name">,
  workers: readonly CfWorker[] | null,
): { edits: DeploymentEdit[]; note?: string } {
  const path = [...PUSH_IDENTITY_PATH];
  const block = valueAtPath(file, path);
  if (block === undefined || block === null) return { edits: [] };
  const account = valueAtPath(file, ["accountId"]);
  const workshop = valueAtPath(file, ["workers", "workshop", "name"]);
  const deployed = workerNames(answers.name).workshop;
  const sameWorker = typeof account === "string" && !isPlaceholder(account) &&
    account.toLowerCase() === answers.accountId.toLowerCase() && workshop === deployed;
  const gone = sameWorker && workers !== null && !workers.some((worker) => worker.name === deployed);
  if (sameWorker && !gone) return { edits: [] };
  const described = `The file's ${path.join(".")} block is the push identity of the deployment it described`;
  const without = "the block is set to null: push notifications reach open browser tabs only.";
  return {
    edits: [{ path, value: null }],
    note: gone
      ? `${described}, whose signing key is a secret on its Workshop Worker, ${deployed}. The account has no Worker of ` +
        `that name, so the one this deployment creates has no such key, and ${without}`
      : `${described}${typeof workshop === "string" && !isPlaceholder(workshop) ? ` (Workshop Worker ${workshop})` : ""}, ` +
        `whose signing key is a secret on that Worker. A new deployment has no such key, so ${without}`,
  };
}

/**
 * The edits recording a new deployment. Storage, error reporting and observability keep the
 * template's defaults (automatic provisioning, on, unchanged); Access's issuer and audience come
 * from the Access step. Without the custom Gatekeeper, its Worker name and text are left as they
 * are: the deploy ignores them.
 */
export function newDeploymentEdits(answers: NewDeploymentAnswers): DeploymentEdit[] {
  const names = workerNames(answers.name);
  const route = answers.route;
  const custom = answers.customGatekeeper;
  return [
    { path: ["accountId"], value: answers.accountId },
    {
      path: ["publicBaseUrl"],
      value: "customDomain" in route ? null : `https://${routerHost(answers.name, route)}`,
    },
    ...(Object.entries(names) as [WorkerKey, string][])
      .filter(([key]) => key !== "customGatekeeper" || custom)
      .map(([key, name]) => ({ path: ["workers", key, "name"], value: name })),
    {
      path: ["workers", "router", "route"],
      value: "customDomain" in route ? { customDomain: route.customDomain } : { workersDev: true },
    },
    { path: ["access", "admins"], value: answers.admins },
    { path: ["aiGateway", "enabled"], value: true },
    { path: ["aiGateway", "name"], value: answers.aiGateway.name },
    { path: ["aiGateway", "accountId"], value: null },
    { path: ["aiGateway", "providers"], value: answers.aiGateway.providers },
    { path: ["customGatekeeper", "enabled"], value: custom !== null },
    ...custom ? [
      { path: ["customGatekeeper", "name"], value: custom.name },
      { path: ["customGatekeeper", "message"], value: custom.message },
    ] : [],
    ...gatekeeperEdits(answers),
  ];
}

/** The Access application a new deployment needs. */
export function newDeploymentAccessTarget(answers: NewDeploymentAnswers): AccessTarget {
  return {
    accountId: answers.accountId,
    routerName: answers.name,
    host: routerHost(answers.name, answers.route),
    admins: answers.admins,
  };
}

/**
 * The first of `candidates` that is a usable admin list, as the admin question offers it:
 * comma-separated. A takeover hands it what the instance's backend carries, then the file's own
 * list, so the instance's admins are the default wherever they were read. Undefined when none is a
 * list of email addresses.
 */
export function offeredAdmins(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.every((entry) => typeof entry === "string") && !adminsProblem(candidate.join(","))) {
      return candidate.join(", ");
    }
  }
  return undefined;
}

/**
 * The model providers among `value` the provider question can offer, in the order it lists them:
 * what a takeover preselects from the instance's backend. One the starter does not serve is left
 * out, as the question has no such choice; discovery says so itself.
 */
export function offeredProviders(value: unknown): AiGatewayProvider[] {
  return Array.isArray(value) ? PROVIDERS.filter((provider) => value.includes(provider)) : [];
}

/**
 * Why a takeover of `instance` moves the project's Cloudflare OS pin, said after the question that
 * confirms the move, which says from which commit to which. `release` is the release the instance
 * runs; null when only `--commit` says what it was built from.
 */
export function pinMoveReason(instance: string, release: string | null): string {
  return `${instance} runs ${release === null ? "the commit --commit names" : `release ${release}`}, which this ` +
    "project's pin is behind: deployed as it is, it would put older code over storage the instance has already " +
    "migrated, which cannot be undone. The move is staged, not committed, and merges nothing of the starter.";
}

/** What a takeover is asked beyond what discovery finds. */
export interface TakeoverAnswers extends GatekeeperAnswers {
  admins: string[];
  /** Asked only when the instance has no Web Search Worker yet. */
  websearch?: string;
  /** The example custom Gatekeeper, or null when it is not deployed. */
  customGatekeeper: {
    /** Its Worker name. */
    worker: string;
    /** Its display text. */
    display: { name: string; message: string };
  } | null;
  errorReporter: string;
  /** The providers to advertise on the instance's gateway. */
  providers: AiGatewayProvider[];
}

/** The edits recording a takeover's answers. */
export function takeoverEdits(answers: TakeoverAnswers): DeploymentEdit[] {
  const custom = answers.customGatekeeper;
  return [
    { path: ["access", "admins"], value: answers.admins },
    ...(answers.websearch ? [{ path: ["workers", "websearch", "name"], value: answers.websearch }] : []),
    ...custom ? [{ path: ["workers", "customGatekeeper", "name"], value: custom.worker }] : [],
    { path: ["workers", "errorReporter", "name"], value: answers.errorReporter },
    { path: ["aiGateway", "providers"], value: answers.providers },
    { path: ["customGatekeeper", "enabled"], value: custom !== null },
    ...custom ? [
      { path: ["customGatekeeper", "name"], value: custom.display.name },
      { path: ["customGatekeeper", "message"], value: custom.display.message },
    ] : [],
    ...gatekeeperEdits(answers),
  ];
}

/**
 * `edits` as the operator reads them before they are written: the values set, as the nested
 * fragment they make, then each removal on a line of its own, since a fragment cannot show one.
 */
export function describeEdits(edits: DeploymentEdit[]): string {
  const removed = edits.filter((edit) => edit.value === undefined);
  return [
    JSON.stringify(editsAsFragment(edits.filter((edit) => edit.value !== undefined)), null, 2),
    ...removed.map((edit) => `Removed: ${edit.path.join(".")}`),
  ].join("\n");
}
