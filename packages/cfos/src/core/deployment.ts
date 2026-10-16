// The deployment as pure data: `validateConfig` checks a parsed `deployment.jsonc`, then
// `generateConfigs` derives each Worker's `wrangler.prod.jsonc` from its upstream base config, and
// `buildCommands`/`deployWaves` say what a check or deploy runs and what of it can run together. No
// I/O: the base configs come in parsed and the commands go out as arguments, for
// `commands/deploy.ts` to read and run.

import { AI_GATEWAY_PROVIDERS } from "./deployment-config.ts";
import type {
  BaseConfigs,
  BuildCommand,
  DeploymentConfig,
  GeneratedConfigs,
  ProdWranglerConfig,
  RouterRoute,
} from "./deployment-config.ts";

/**
 * Where each Worker's package lives, relative to the project root, keyed as `deployment.jsonc` keys
 * the Workers. Its base `wrangler.jsonc` is read from there, and its generated config written beside
 * it.
 */
export const PACKAGE_DIRS = {
  router: "cloudflare-os/packages/router",
  workshop: "cloudflare-os/packages/workshop-backend",
  context: "cloudflare-os/packages/gatekeeper-context",
  scheduler: "cloudflare-os/packages/gatekeeper-scheduler",
  websearch: "cloudflare-os/packages/gatekeeper-websearch",
  customGatekeeper: "packages/custom-gatekeeper",
  errorReporter: "packages/error-reporter",
} as const;

/** A key of {@link PACKAGE_DIRS}: one deployable Worker. */
export type PackageKey = keyof typeof PACKAGE_DIRS;

/**
 * The generated config's file name, beside each base `wrangler.jsonc`. One deployment per checkout;
 * use separate worktrees for concurrent deploys.
 */
export const GENERATED_NAME = "wrangler.prod.jsonc";
const defaultContextArtifactsNamespace = "gatekeeper-context-collections";
const accountIdPattern = /^[a-f\d]{32}$/i;

const requiredPaths = [
  "accountId",
  "workers.router.name",
  "workers.workshop.name",
  "workers.context.name",
  "workers.scheduler.name",
  "workers.websearch.name",
  "workers.customGatekeeper.name",
  "access.issuer",
  "access.audience",
  "access.admins",
  "aiGateway.enabled",
  "errorReporting.enabled",
  "customGatekeeper.name",
  "customGatekeeper.message",
  "observability.enabled",
  "observability.headSamplingRate",
  "observability.logs.invocationLogs",
  "observability.traces.enabled",
  "observability.traces.headSamplingRate",
];

// `aiGateway.accountId` is deliberately absent: null is its normal value, meaning "the gateway
// lives in the deployment's own account".
const aiGatewayPaths = [
  "aiGateway.name",
  "aiGateway.providers",
];

const errorReportingPaths = [
  "workers.errorReporter.name",
  "errorReporting.environment",
];

const resourcePaths = [
  "context.kvNamespaceId",
  "resources.blueprintsKvNamespaceId",
  "resources.avatarsKvNamespaceId",
  "resources.blueprintContentBucket",
];

function valueAt(object: DeploymentConfig, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (value, key) => (value as Record<string, unknown> | undefined)?.[key], object);
}

/**
 * The deployment's public origin: the address the router answers on.
 *
 * Two things read it, and both are load-bearing in different ways. `PUBLIC_BASE_URL` is what
 * upstream builds absolute links and OAuth redirect URIs from. The Context Gatekeeper's
 * `sharingDomain` prop is a data-isolation boundary, so a value that changes silently hides
 * collections rather than breaking a link.
 *
 * `validateConfig` guarantees that one of the two sources below is present, and that they agree when
 * both are.
 */
export function publicOrigin(config: DeploymentConfig): string {
  const explicit = config.publicBaseUrl;
  if (explicit) return explicit.replace(/\/$/, "");
  return `https://${config.workers.router.route.customDomain!}`;
}

function validatePublicBaseUrl(config: DeploymentConfig, route: RouterRoute): void {
  const value = config.publicBaseUrl;
  if (value === undefined) {
    throw new Error(
      "publicBaseUrl must be present. Use null to derive it from " +
      "workers.router.route.customDomain.");
  }
  if (value === null) {
    if (!route.customDomain) {
      throw new Error(
        "publicBaseUrl is required on a workersDev route. The account's workers.dev subdomain is " +
        "not in deployment.jsonc and wrangler exposes no command to look it up, so there is " +
        "nothing to derive the public origin from -- and PUBLIC_BASE_URL and the Context sharing " +
        "boundary both need one. Set it to https://<router-name>.<subdomain>.workers.dev.");
    }
    return;
  }
  if (typeof value !== "string") {
    throw new Error("publicBaseUrl must be null or a string.");
  }
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    throw new Error("publicBaseUrl must be an HTTPS origin such as https://os.example.com.");
  }
  if (!value.startsWith("https://") || origin !== value) {
    throw new Error(
      "publicBaseUrl must be an HTTPS origin only, with no path and no trailing slash.");
  }
  if (route.customDomain && value !== `https://${route.customDomain}`) {
    throw new Error(
      `publicBaseUrl (${value}) does not match workers.router.route.customDomain ` +
      `(${route.customDomain}). Context data would then be scoped to a hostname this deployment ` +
      "does not answer on. Leave publicBaseUrl null to derive it from the custom domain.");
  }
  // On a workersDev route there is nothing to cross-check the value against the way a custom domain
  // checks itself, so check its shape instead. The account's workers.dev subdomain is unknowable
  // here, but the rest of the hostname is not: wrangler serves the Worker at
  // <worker-name>.<subdomain>.workers.dev, so anything else is a typo or an unrelated host -- and it
  // would silently become both PUBLIC_BASE_URL and the Context isolation boundary, hiding existing
  // Context data and breaking every absolute link and OAuth redirect the backend builds.
  if (route.workersDev) {
    const labels = new URL(value).host.split(".");
    const [worker, subdomain, ...suffix] = labels;
    const routerName = config.workers.router.name;
    if (labels.length !== 4 || suffix.join(".") !== "workers.dev" ||
        !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(subdomain ?? "")) {
      throw new Error(
        `publicBaseUrl (${value}) is not a workers.dev origin. On a workersDev route it must be ` +
        `https://${routerName}.<subdomain>.workers.dev, where <subdomain> is the account's ` +
        "workers.dev subdomain. It becomes PUBLIC_BASE_URL and the Context sharing boundary, so a " +
        "hostname this deployment does not answer on hides Context data and breaks redirects.");
    }
    if (worker !== routerName) {
      throw new Error(
        `publicBaseUrl (${value}) names Worker "${worker}", but the router is ` +
        `"${routerName}". The router is what answers on the public origin, so this origin belongs ` +
        `to a different Worker. Use https://${routerName}.${subdomain}.workers.dev, or change ` +
        "workers.router.name if the other name is the one you meant.");
    }
  }
}

/** The file still holds a template `<PLACEHOLDER>`: it has not been configured yet. */
export class PlaceholderError extends Error {}

/**
 * Checks `config` against everything a deploy relies on, throwing the first problem with the config
 * path it concerns. A file that still holds template placeholders throws {@link PlaceholderError}.
 */
export function validateConfig(config: DeploymentConfig): DeploymentConfig {
  const activePaths = [
    ...requiredPaths,
    ...(config.aiGateway?.enabled ? aiGatewayPaths : []),
    ...(config.errorReporting?.enabled ? errorReportingPaths : []),
  ];
  for (const path of activePaths) {
    const value = valueAt(config, path);
    if (value === undefined || value === null || value === "" || Array.isArray(value) && !value.length) {
      throw new Error(`Missing required deployment value: ${path}`);
    }
  }

  for (const path of resourcePaths) {
    const value = valueAt(config, path);
    if (value === undefined || value !== null && (typeof value !== "string" || !value)) {
      throw new Error(`Deployment resource must be null or a non-empty string: ${path}`);
    }
  }

  let activeConfig: DeploymentConfig = config.aiGateway.enabled
    ? config
    : { ...config, aiGateway: { enabled: false } };
  if (!config.errorReporting.enabled) {
    activeConfig = {
      ...activeConfig,
      workers: { ...activeConfig.workers, errorReporter: undefined },
      errorReporting: { enabled: false },
    };
  }
  const placeholder = JSON.stringify(activeConfig).match(/<[^>]+>/)?.[0];
  if (placeholder) throw new PlaceholderError(`Replace deployment placeholder ${placeholder}.`);

  const stringPaths = activePaths.filter((path) => ![
    "access.admins",
    "aiGateway.enabled",
    "aiGateway.providers",
    "errorReporting.enabled",
    "observability.enabled",
    "observability.headSamplingRate",
    "observability.logs.invocationLogs",
    "observability.traces.enabled",
    "observability.traces.headSamplingRate",
  ].includes(path));
  for (const path of stringPaths) {
    if (typeof valueAt(config, path) !== "string") {
      throw new Error(`Deployment value must be a string: ${path}`);
    }
  }

  if (!accountIdPattern.test(config.accountId)) {
    throw new Error("Cloudflare account IDs must be 32 hexadecimal characters.");
  }
  const workerNames = Object.entries(config.workers)
    .filter(([key]) => key !== "errorReporter" || config.errorReporting.enabled)
    .map(([, worker]) => worker.name);
  if (new Set(workerNames).size !== workerNames.length) {
    throw new Error(
      "Router, Workshop, Context, Scheduler, Web Search, custom Gatekeeper, and Error Reporter " +
      "names must be unique.");
  }
  if (!workerNames.every((name) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))) {
    throw new Error("Worker names must use lowercase letters, numbers, and hyphens.");
  }

  const route = config.workers.router.route;
  if (!route || Boolean(route.workersDev) === Boolean(route.customDomain)) {
    throw new Error("Set exactly one router route: workersDev or customDomain.");
  }
  if (route.workersDev !== undefined && route.workersDev !== true) {
    throw new Error("Router workersDev must be boolean true when selected.");
  }
  if (route.customDomain !== undefined && typeof route.customDomain !== "string") {
    throw new Error("Router customDomain must be a string.");
  }
  const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (route.customDomain && !hostnamePattern.test(route.customDomain)) {
    throw new Error("Router customDomain must be a lowercase hostname.");
  }

  validatePublicBaseUrl(config, route);

  const sharingDomain = config.context.sharingDomain;
  if (sharingDomain !== null &&
      (typeof sharingDomain !== "string" || !sharingDomain.trim())) {
    throw new Error(
      "context.sharingDomain must be null or a non-empty string. null scopes Context data to the " +
      "deployment's public origin, which is what the hosted deploy does.");
  }

  const issuer = new URL(config.access.issuer);
  if (issuer.protocol !== "https:" ||
      issuer.origin !== config.access.issuer.replace(/\/$/, "")) {
    throw new Error("Cloudflare Access issuer must be an HTTPS origin only.");
  }
  if (!config.access.audience.trim() || config.access.audience !== config.access.audience.trim()) {
    throw new Error("Cloudflare Access audience must not be blank or padded with whitespace.");
  }
  if (!Array.isArray(config.access.admins) ||
      !config.access.admins.every((email) =>
        typeof email === "string" && /^[^@\s]+@[^@\s]+$/.test(email))) {
    throw new Error("Every Access administrator must be an email address.");
  }

  validateAiGateway(config);

  if (typeof config.errorReporting.enabled !== "boolean") {
    throw new Error("Error reporting enabled must be a boolean.");
  }
  const release = config.errorReporting.release;
  if (release !== null && release !== undefined &&
      (typeof release !== "string" || !release.trim() || release !== release.trim())) {
    throw new Error("Error reporting release must be null or a non-padded string.");
  }

  const artifactsConfig = config.context.artifacts;
  if (artifactsConfig !== undefined &&
      (artifactsConfig === null || typeof artifactsConfig !== "object" ||
       Array.isArray(artifactsConfig))) {
    throw new Error("Context Artifacts configuration must be an object when present.");
  }
  const artifactsEnabled = artifactsConfig?.enabled;
  if (artifactsEnabled !== undefined && typeof artifactsEnabled !== "boolean") {
    throw new Error("Context Artifacts enabled must be a boolean.");
  }
  const artifactsNamespace = artifactsConfig?.namespace;
  if (artifactsNamespace !== undefined &&
      (typeof artifactsNamespace !== "string" ||
       !/^[a-z\d][a-z\d._-]*$/i.test(artifactsNamespace))) {
    throw new Error("Context Artifacts namespace must be omitted or start with a letter or number and use only letters, numbers, dots, underscores, and hyphens.");
  }

  const sampling = config.observability.headSamplingRate;
  if (typeof config.observability.enabled !== "boolean") {
    throw new Error("Observability enabled must be a boolean.");
  }
  if (typeof sampling !== "number" || sampling < 0 || sampling > 1) {
    throw new Error("Observability headSamplingRate must be between 0 and 1.");
  }
  if (typeof config.observability.logs.invocationLogs !== "boolean" ||
      typeof config.observability.traces.enabled !== "boolean") {
    throw new Error("Observability log and trace controls must be booleans.");
  }
  const traceSampling = config.observability.traces.headSamplingRate;
  if (typeof traceSampling !== "number" || traceSampling < 0 || traceSampling > 1) {
    throw new Error("Observability trace sampling must be between 0 and 1.");
  }
  return config;
}

/**
 * How the Workshop reaches AI Gateway, derived rather than configured.
 *
 * The Worker cannot discover its own account at runtime, so it cannot tell whether the gateway it
 * is pointed at is one its `WORKERS_AI` binding can reach. The deploy can: it holds both account
 * IDs. Everything below follows from comparing them.
 */
export interface AiGatewayPlan {
  /** The account owning the gateway, with `aiGateway.accountId: null` resolved. */
  gatewayAccountId: string;
  /** Whether the gateway lives outside the deployment's own account. */
  crossAccount: boolean;
  /** Whether `CF_AI_GATEWAY_API_TOKEN` has to be installed before the Workshop will start a chat. */
  needsToken: boolean;
  /** One sentence per reason a token is needed. Empty when the binding transport covers it all. */
  tokenReasons: string[];
}

/**
 * {@link AiGatewayPlan} for `config`, or null when the deployment advertises no model catalog.
 *
 * Both IDs are lowercased first. `accountIdPattern` accepts either case, so the same account can be
 * written two ways across `accountId` and `aiGateway.accountId`; comparing the raw strings would
 * read that as cross-account and demand a token for a gateway the binding can reach in-account.
 * Lowercase is also the form the dashboard and the API expect, so it is what the vars carry.
 */
export function aiGatewayPlan(config: DeploymentConfig): AiGatewayPlan | null {
  if (!config.aiGateway.enabled) return null;
  const deploymentAccountId = config.accountId.toLowerCase();
  const gatewayAccountId = (config.aiGateway.accountId ?? config.accountId).toLowerCase();
  const crossAccount = gatewayAccountId !== deploymentAccountId;
  const tokenReasons: string[] = [];
  if (crossAccount) {
    tokenReasons.push(
      `aiGateway.accountId (${gatewayAccountId}) is not the deployment account, so the generated ` +
      "config sets CF_AI_GATEWAY_USE_BINDING=false: the Workers AI binding only reaches gateways " +
      "in the Worker's own account. That leaves the HTTPS transport, which needs a Run + Read " +
      "CF_AI_GATEWAY_API_TOKEN. The opt-out is a flag rather than an unbound WORKERS_AI because " +
      "webFetch's toMarkdown() runs on that binding too.");
  }
  if (config.aiGateway.providers?.includes("google")) {
    tokenReasons.push(
      "The google provider needs CF_AI_GATEWAY_API_TOKEN: pi's Google adapter refuses a custom " +
      "fetch, so Google inference cannot ride the Workers AI binding transport.");
  }
  return { gatewayAccountId, crossAccount, needsToken: tokenReasons.length > 0, tokenReasons };
}

/**
 * The deploy-time half of `AiGatewayConfig`'s constructor checks
 * (cloudflare-os/packages/workshop-backend/src/ai-gateway.ts), mirroring `resolveAiGateway()` in
 * cloudflare-os/scripts/preview/staging-config.ts. A configuration the backend would reject belongs
 * in a failed `cfos check`, not in somebody's first chat.
 */
function validateAiGateway(config: DeploymentConfig): void {
  if (config.aiGateway.workersAi !== undefined) {
    throw new Error(
      "aiGateway.workersAi does nothing: Workers AI rides the same gateway route as every other " +
      "provider. Leaving the key in place deploys a Workshop with an empty model picker. Delete " +
      "it; list \"cloudflare\" in aiGateway.providers to keep Workers AI models.");
  }
  if (typeof config.aiGateway.enabled !== "boolean") {
    throw new Error("AI Gateway enabled must be a boolean.");
  }
  if (!config.aiGateway.enabled) return;

  const providers = config.aiGateway.providers;
  if (!Array.isArray(providers) || providers.length === 0 ||
      !providers.every((provider) => AI_GATEWAY_PROVIDERS.includes(provider))) {
    throw new Error(
      `AI Gateway providers must be a non-empty subset of ${AI_GATEWAY_PROVIDERS.join(", ")}.`);
  }

  const gatewayAccountId = config.aiGateway.accountId;
  if (gatewayAccountId !== undefined && gatewayAccountId !== null &&
      (typeof gatewayAccountId !== "string" || !accountIdPattern.test(gatewayAccountId))) {
    throw new Error(
      "aiGateway.accountId must be null or 32 hexadecimal characters. null reuses the " +
      "deployment's own account, which is what lets the Workers AI binding reach the gateway " +
      "without an API token.");
  }
}

function routeConfig(route: RouterRoute) {
  return route.workersDev
    ? { workers_dev: true, routes: undefined }
    : { workers_dev: false, routes: [{ pattern: route.customDomain!, custom_domain: true }] };
}

function setCommon(
  config: ProdWranglerConfig,
  deployment: DeploymentConfig,
  name: string,
  route: RouterRoute = { workersDev: false },
): void {
  config.account_id = deployment.accountId;
  config.name = name;
  config.workers_dev = route.workersDev;
  delete config.routes;
  if (route.customDomain) Object.assign(config, routeConfig(route));
  // The router is the Access-protected origin, and a preview URL is an unauthenticated path around
  // it. Off on every Worker: the six behind the router have no business being publicly reachable
  // either.
  config.preview_urls = false;
  config.observability = {
    ...config.observability,
    enabled: deployment.observability.enabled,
    head_sampling_rate: deployment.observability.headSamplingRate,
    logs: {
      ...config.observability?.logs,
      invocation_logs: deployment.observability.logs.invocationLogs,
    },
    traces: {
      ...config.observability?.traces,
      enabled: deployment.observability.traces.enabled,
      head_sampling_rate: deployment.observability.traces.headSamplingRate,
    },
  };
}

/** Every Worker's `wrangler.prod.jsonc`, derived from its base config. Validates `config` first. */
export function generateConfigs(config: DeploymentConfig, bases: BaseConfigs): GeneratedConfigs {
  validateConfig(config);
  const router = structuredClone(bases.router);
  const workshop = structuredClone(bases.workshop);
  const context = structuredClone(bases.context);
  const scheduler = structuredClone(bases.scheduler);
  const websearch = structuredClone(bases.websearch);
  const customGatekeeper = structuredClone(bases.customGatekeeper);
  const errorReporter = config.errorReporting.enabled
    ? structuredClone(bases.errorReporter)
    : undefined;
  const origin = publicOrigin(config);

  setCommon(router, config, config.workers.router.name, config.workers.router.route);
  router.services = [
    { binding: "WORKSHOP_BACKEND", service: config.workers.workshop.name },
    // No entrypoint and no props: the router forwards whole HTTP requests, unlike the backend's
    // vendor-RPC bindings. The binding name is what picks the /gatekeeper/<name> path.
    { binding: "GATEKEEPER_CONTEXT", service: config.workers.context.name },
    { binding: "GATEKEEPER_SCHEDULER", service: config.workers.scheduler.name },
    { binding: "GATEKEEPER_WEBSEARCH", service: config.workers.websearch.name },
    { binding: "GATEKEEPER_CUSTOM", service: config.workers.customGatekeeper.name },
  ];

  setCommon(workshop, config, config.workers.workshop.name);
  workshop.vars = {
    ADMINS: config.access.admins,
    CF_ACCESS_ISS: config.access.issuer.replace(/\/$/, ""),
    CF_ACCESS_AUD: config.access.audience,
    // Upstream builds OAuth redirect URIs and other absolute links from this. The backend has no
    // public route of its own, so the router's origin is the only correct value.
    PUBLIC_BASE_URL: origin,
  };
  const gateway = aiGatewayPlan(config);
  if (gateway) {
    Object.assign(workshop.vars, {
      CF_AI_GATEWAY: config.aiGateway.name,
      CF_AI_GATEWAY_ACCOUNT_ID: gateway.gatewayAccountId,
      CF_AI_GATEWAY_PROVIDERS: config.aiGateway.providers!.join(","),
      ...(gateway.crossAccount ? { CF_AI_GATEWAY_USE_BINDING: "false" } : {}),
    });
    // Only when a token is genuinely needed. On the common path the WORKERS_AI binding is the
    // transport and is pre-authenticated in-account, so demanding a secret would block a deploy
    // that has everything it needs. Where one IS needed, wrangler refusing to deploy without it is
    // a better check than anything this script could do.
    if (gateway.needsToken) {
      workshop.secrets = {
        required: [...new Set([
          ...(workshop.secrets?.required ?? []),
          "CF_AI_GATEWAY_API_TOKEN",
        ])],
      };
    }
  }
  // Unconditional: as well as being the AI Gateway transport, this binding is what webFetch's
  // toMarkdown() runs on.
  workshop.ai = { binding: "WORKERS_AI" };
  workshop.services = [
    ...(config.errorReporting.enabled ? [{
      binding: "ERROR_REPORTER",
      service: config.workers.errorReporter!.name,
      entrypoint: "ErrorReporter",
      props: {
        service: config.workers.workshop.name,
        environment: config.errorReporting.environment,
        ...(config.errorReporting.release ? { release: config.errorReporting.release } : {}),
      },
    }] : []),
    {
      binding: "GATEKEEPER_CONTEXT",
      service: config.workers.context.name,
      entrypoint: "GatekeeperVendor",
      props: { sharingDomain: config.context.sharingDomain ?? origin },
    },
    // No props: unlike Context, the Scheduler scopes nothing to a domain -- its schedules live in
    // its own `ScheduleDriver`/`SchedulerGatekeeper` Durable Objects, which belong to that Worker's
    // script identity and are reached through `ctx.exports` rather than a binding.
    {
      binding: "GATEKEEPER_SCHEDULER",
      service: config.workers.scheduler.name,
      entrypoint: "GatekeeperVendor",
    },
    // No props either: searches are scoped to nobody, and the only state is the per-workspace
    // `WebSearchGatekeeper` facet, reached through `ctx.exports`.
    {
      binding: "GATEKEEPER_WEBSEARCH",
      service: config.workers.websearch.name,
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_CUSTOM",
      service: config.workers.customGatekeeper.name,
      entrypoint: "GatekeeperVendor",
    },
  ];
  workshop.kv_namespaces = [
    { binding: "BLUEPRINTS", ...(config.resources.blueprintsKvNamespaceId
      ? { id: config.resources.blueprintsKvNamespaceId } : {}) },
    { binding: "AVATARS", ...(config.resources.avatarsKvNamespaceId
      ? { id: config.resources.avatarsKvNamespaceId } : {}) },
  ];
  workshop.r2_buckets = [
    { binding: "BLUEPRINT_CONTENT", ...(config.resources.blueprintContentBucket
      ? { bucket_name: config.resources.blueprintContentBucket } : {}) },
  ];
  // The router serves the frontend, and it is the only Worker with a public route.
  delete workshop.assets;

  setCommon(context, config, config.workers.context.name);
  context.kv_namespaces = [
    { binding: "CONTEXT_COLLECTIONS", ...(config.context.kvNamespaceId
      ? { id: config.context.kvNamespaceId } : {}) },
  ];
  if (config.context.artifacts?.enabled ?? false) {
    context.artifacts = [{
      binding: "ARTIFACTS",
      namespace: config.context.artifacts?.namespace ?? defaultContextArtifactsNamespace,
    }];
  } else {
    delete context.artifacts;
  }

  // Nothing but the common block: the Scheduler takes no vars, no secrets and no storage bindings of
  // its own -- which is what makes it installable with no user interaction upstream, and deployable
  // here without adding a configuration surface for it.
  setCommon(scheduler, config, config.workers.scheduler.name);

  // Likewise nothing of its own to configure. Its base config's `ai` binding, `.txt` rule and
  // Durable Object migrations carry over as they are. The search itself goes through the account's
  // `default` AI Gateway (`GATEWAY_ID` in gatekeeper-websearch/src/search.ts), which Cloudflare
  // creates on first use -- independent of `aiGateway.name`, which only steers the Workshop.
  setCommon(websearch, config, config.workers.websearch.name);

  setCommon(customGatekeeper, config, config.workers.customGatekeeper.name);
  customGatekeeper.vars = {
    CUSTOM_NAME: config.customGatekeeper.name,
    CUSTOM_MESSAGE: config.customGatekeeper.message,
  };

  if (errorReporter) {
    setCommon(errorReporter, config, config.workers.errorReporter!.name);
  }

  return {
    router, workshop, context, scheduler, websearch, customGatekeeper,
    ...(errorReporter && { errorReporter }),
  };
}

// `--no-cache` goes before the task name. Everything after it is `[ADDITIONAL_ARGS]`, forwarded to
// the task's own command -- `vp run -F x build --no-cache` reaches `tsc` as an unknown option.

/** `vp run --no-cache <task>` for a package in the submodule's workspace. */
function submoduleBuild(pkg: string, task = "build"): string[] {
  return ["--dir", "cloudflare-os", "exec", "vp", "run", "-F", pkg, "--no-cache", task];
}

/** `vp run --no-cache <task>` for a package in this repository's own workspace. */
function ownBuild(pkg: string, task = "build"): string[] {
  return ["exec", "vp", "run", "-F", pkg, "--no-cache", task];
}

/**
 * The build steps `cfos check` and `cfos deploy` run, from the project root, as chains: the steps
 * inside one chain run in order, and the chains are independent of each other, so they can run
 * concurrently.
 *
 * Every one goes through `vp run` rather than `pnpm --filter <pkg> build`. Two of the three
 * submodule targets have no `build` *script* at all any more -- they have a Vite+ *task*, which
 * `pnpm --filter` cannot see -- and `vp run` runs scripts and tasks alike, so one form covers both.
 *
 * `--no-cache` on every one. A cache hit is only as good as its fingerprint, which is cheap to get
 * wrong on a build you can re-run and expensive on a deploy you cannot; it is upstream's rule for
 * the same reason (cloudflare-os/scripts/deploy-scripts.test.ts). It also restores the full ambient
 * environment, which is the belt to `workshop-frontend`'s `env: ['VITE_*']` braces: under a *cached*
 * `vp` run only declared patterns survive, and an undeclared variable is dropped from the command
 * and from the fingerprint both.
 *
 * The frontend and the router are separate chains even though the router serves
 * `../workshop-frontend/dist`: it is the router's *deploy* that reads those assets, not its build,
 * and every build finishes before anything deploys.
 */
export function buildCommands(config: DeploymentConfig): BuildCommand[][] {
  return [
    // `build:app` first, and separately. `gatekeeper-context`'s `build` is a package.json script
    // that spawns `vp run --cache build:app` itself, and the outer `--no-cache` does not reach a
    // nested invocation carrying its own flag -- measured: the configurator app replayed from
    // cache. Rebuilding it here from source is what upstream's own `deploy` script does; the
    // `build` step below then type-checks and replays the bytes this step just wrote.
    [
      { args: submoduleBuild("@gadgets/gatekeeper-context", "build:app") },
      { args: submoduleBuild("@gadgets/gatekeeper-context") },
    ],
    // The Scheduler's `build` nests the same cached `vp run build:app`, so it needs the same pair.
    [
      { args: submoduleBuild("@gadgets/gatekeeper-scheduler", "build:app") },
      { args: submoduleBuild("@gadgets/gatekeeper-scheduler") },
    ],
    // A type-check only: wrangler's own build command runs capnweb-validate at deploy time.
    [{ args: submoduleBuild("@gadgets/gatekeeper-websearch") }],
    [{ args: ownBuild("custom-gatekeeper") }],
    ...(config.errorReporting.enabled ? [[{ args: ownBuild("error-reporter") }]] : []),
    // Access mode is a build-time constant in the frontend bundle (`src/useAuth.ts`), so it is set
    // here rather than inherited: a bundle built under a different value is wrong, not just stale.
    [{ args: submoduleBuild("@gadgets/workshop-frontend"), env: { VITE_CF_ACCESS_MODE: "true" } }],
    [{ args: submoduleBuild("@gadgets/router") }],
    [{ args: submoduleBuild("@gadgets/workshop-backend") }],
  ];
}

/**
 * The Workers in deploy waves: those inside one wave can deploy concurrently, and each wave starts
 * only once the one before has deployed. A service binding must name a Worker that already exists
 * -- the Workers API rejects one to a script that does not -- so the Workshop, which binds every
 * Gatekeeper and the Error Reporter, follows all of them, and the router, which binds the Workshop
 * and every Gatekeeper, goes last. A failure before the router leaves the previous router version
 * serving.
 */
export function deployWaves(config: DeploymentConfig): PackageKey[][] {
  return [
    [
      ...(config.errorReporting.enabled ? ["errorReporter" as const] : []),
      "context", "scheduler", "websearch", "customGatekeeper",
    ],
    ["workshop"],
    ["router"],
  ];
}

/** {@link deployWaves}, flattened: one order the Workers can deploy in, one at a time. */
export function deployOrder(config: DeploymentConfig): PackageKey[] {
  return deployWaves(config).flat();
}
