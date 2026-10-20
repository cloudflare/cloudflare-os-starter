// The steps of `cf-os init` as data: each takes answers (and what the account holds) and returns
// defaults, problems, or the `deployment.jsonc` edits that record them. The prompting, and every
// call to Cloudflare, belong to `commands/init.ts`.

import type { AccessTarget } from "./access.ts";
import { isEmail } from "./access.ts";
import type { CfAiGateway, CfWorker } from "./client.ts";
import { AI_GATEWAY_PROVIDERS, type AiGatewayProvider } from "./deployment-config.ts";
import { editsAsFragment, type DeploymentEdit } from "./edits.ts";
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
