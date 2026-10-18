import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { pnpmCommand } from "../cloudflare-os/scripts/pnpm-command.ts";
import { resolveBinEntry } from "../cloudflare-os/scripts/bin-entry.ts";
import { AI_GATEWAY_PROVIDERS } from "./deployment-config.ts";
import type {
  BaseConfigs,
  BuildCommand,
  DeploymentConfig,
  GeneratedConfigs,
  ProdWranglerConfig,
  RouterRoute,
} from "./deployment-config.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// One deployment per checkout; use separate worktrees for concurrent deploys.
const generatedName = "wrangler.prod.jsonc";
const packageDirs = {
  router: "cloudflare-os/packages/router",
  workshop: "cloudflare-os/packages/workshop-backend",
  context: "cloudflare-os/packages/gatekeeper-context",
  scheduler: "cloudflare-os/packages/gatekeeper-scheduler",
  customGatekeeper: "packages/custom-gatekeeper",
  googleSheetsGuard: "packages/google-sheets-guard",
  errorReporter: "packages/error-reporter",
} as const;
const generatedPaths = Object.fromEntries(
  Object.entries(packageDirs).map(([name, dir]) => [name, join(root, dir, generatedName)]),
) as Record<keyof typeof packageDirs, string>;
const defaultContextArtifactsNamespace = "gatekeeper-context-collections";
const accountIdPattern = /^[a-f\d]{32}$/i;

const requiredPaths = [
  "accountId",
  "workers.router.name",
  "workers.workshop.name",
  "workers.context.name",
  "workers.scheduler.name",
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

const googleSheetsGuardPaths = [
  "workers.googleSheetsGuard.name",
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

export function validateConfig(config: DeploymentConfig): DeploymentConfig {
  const googleSheetsGuard = config.googleSheetsGuard;
  if (googleSheetsGuard !== undefined &&
      (googleSheetsGuard === null || typeof googleSheetsGuard !== "object" ||
       Array.isArray(googleSheetsGuard) || typeof googleSheetsGuard.enabled !== "boolean")) {
    throw new Error(
      "Google Sheets Guard configuration must be an object with boolean enabled.");
  }
  const activePaths = [
    ...requiredPaths,
    ...(config.aiGateway?.enabled ? aiGatewayPaths : []),
    ...(config.errorReporting?.enabled ? errorReportingPaths : []),
    ...(config.googleSheetsGuard?.enabled ? googleSheetsGuardPaths : []),
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
  if (placeholder) throw new Error(`Replace deployment placeholder ${placeholder}.`);

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
    .filter(([key, worker]) => worker !== undefined &&
      (key !== "errorReporter" || config.errorReporting.enabled) &&
      (key !== "googleSheetsGuard" || config.googleSheetsGuard?.enabled))
    .map(([, worker]) => worker!.name);
  if (new Set(workerNames).size !== workerNames.length) {
    throw new Error(
      "Router, Workshop, Context, Scheduler, and custom Gatekeeper names must be unique.");
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
 * is pointed at is one its `WORKERS_AI` binding can reach. This script can: it holds both account
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
 * in a failed `pnpm check`, not in somebody's first chat.
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
  // it. Off on every Worker: the five behind the router have no business being publicly reachable
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

export function generateConfigs(config: DeploymentConfig, bases: BaseConfigs): GeneratedConfigs {
  validateConfig(config);
  const router = structuredClone(bases.router);
  const workshop = structuredClone(bases.workshop);
  const context = structuredClone(bases.context);
  const scheduler = structuredClone(bases.scheduler);
  const customGatekeeper = structuredClone(bases.customGatekeeper);
  const googleSheetsGuard = config.googleSheetsGuard?.enabled
    ? structuredClone(bases.googleSheetsGuard)
    : undefined;
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
    { binding: "GATEKEEPER_CUSTOM", service: config.workers.customGatekeeper.name },
    ...(googleSheetsGuard ? [{
      binding: "GATEKEEPER_GOOGLE_SHEETS_GUARD",
      service: config.workers.googleSheetsGuard!.name,
    }] : []),
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
    {
      binding: "GATEKEEPER_CUSTOM",
      service: config.workers.customGatekeeper.name,
      entrypoint: "GatekeeperVendor",
    },
    ...(googleSheetsGuard ? [{
      binding: "GATEKEEPER_GOOGLE_SHEETS_GUARD",
      service: config.workers.googleSheetsGuard!.name,
      entrypoint: "GatekeeperVendor",
    }] : []),
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

  setCommon(customGatekeeper, config, config.workers.customGatekeeper.name);
  customGatekeeper.vars = {
    CUSTOM_NAME: config.customGatekeeper.name,
    CUSTOM_MESSAGE: config.customGatekeeper.message,
  };

  if (googleSheetsGuard) {
    setCommon(googleSheetsGuard, config, config.workers.googleSheetsGuard!.name);
    googleSheetsGuard.vars = {
      BASE_URL: `${origin}/gatekeeper/google-sheets-guard`,
    };
    googleSheetsGuard.secrets = {
      required: [
        "CLIENT_ID",
        "CLIENT_SECRET",
        "P3_SPREADSHEET_ID",
        "P3_ALLOWED_RANGE",
      ],
    };
  }

  if (errorReporter) {
    setCommon(errorReporter, config, config.workers.errorReporter!.name);
  }

  return {
    router, workshop, context, scheduler, customGatekeeper,
    ...(googleSheetsGuard && { googleSheetsGuard }),
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
 * The build steps `pnpm check` and `pnpm deploy` run, in order, from the repository root.
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
 * The ordering matters at the end: the frontend has to build before the router deploy picks up
 * `../workshop-frontend/dist` as its assets.
 */
export function buildCommands(config: DeploymentConfig): BuildCommand[] {
  return [
    // `build:app` first, and separately. `gatekeeper-context`'s `build` is a package.json script
    // that spawns `vp run --cache build:app` itself, and the outer `--no-cache` does not reach a
    // nested invocation carrying its own flag -- measured: the configurator app replayed from
    // cache. Rebuilding it here from source is what upstream's own `deploy` script does; the
    // `build` step below then type-checks and replays the bytes this step just wrote.
    { args: submoduleBuild("@gadgets/gatekeeper-context", "build:app") },
    { args: submoduleBuild("@gadgets/gatekeeper-context") },
    // The Scheduler's `build` nests the same cached `vp run build:app`, so it needs the same pair.
    { args: submoduleBuild("@gadgets/gatekeeper-scheduler", "build:app") },
    { args: submoduleBuild("@gadgets/gatekeeper-scheduler") },
    { args: ownBuild("custom-gatekeeper") },
    ...(config.googleSheetsGuard?.enabled ? [
      // The wrapper inherits the pinned Google worker. Its imported module references generated
      // configurator assets even though this facade never exposes the picker, so build them from
      // the same pinned source before Wrangler bundles the facade.
      { args: submoduleBuild("@gadgets/google-gatekeeper", "build:configurator") },
      { args: ownBuild("google-sheets-guard") },
    ] : []),
    ...(config.errorReporting.enabled ? [{ args: ownBuild("error-reporter") }] : []),
    // Access mode is a build-time constant in the frontend bundle (`src/useAuth.ts`), so it is set
    // here rather than inherited: a bundle built under a different value is wrong, not just stale.
    { args: submoduleBuild("@gadgets/workshop-frontend"), env: { VITE_CF_ACCESS_MODE: "true" } },
    { args: submoduleBuild("@gadgets/router") },
    { args: submoduleBuild("@gadgets/workshop-backend") },
  ];
}

// `allowTrailingComma` because wrangler accepts them and upstream uses them: the Scheduler's base
// config closes `build`, `migrations` and `observability` with one. Without the option every such
// comma is a parse *error*, so the deploy refuses a file wrangler itself reads happily.
const jsoncOptions = { allowTrailingComma: true };

async function readJsonc<T>(path: string): Promise<T> {
  const errors: ParseError[] = [];
  const result = parse(await readFile(path, "utf8"), errors, jsoncOptions) as T;
  if (errors.length) {
    const where = relative(root, path) || path;
    throw new Error(`${where}: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
  }
  return result;
}

// Every validateConfig message names a config path, so say which file those paths live in.
async function readDeployment(path: string): Promise<DeploymentConfig> {
  const config = await readJsonc<DeploymentConfig>(path);
  try {
    return validateConfig(config);
  } catch (error) {
    throw new Error(`${relative(root, path)}: ${(error as Error).message}`, { cause: error });
  }
}

function runCommand(
  command: string,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  label: string,
): void {
  const result = spawnSync(command, argv, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const where = relative(root, cwd) || ".";
    throw new Error(`${where}: ${label} failed. Its output is above.`);
  }
}

// Spawned through pnpmCommand rather than as a bare "pnpm": on Windows the pnpm on PATH is a `.cmd`
// shim Node refuses to spawn without a shell, and `shell: true` would re-split argv and break any
// checkout path containing a space.
function run(args: string[], cwd = root, env: NodeJS.ProcessEnv = process.env): void {
  const [command, argv] = pnpmCommand(args, env);
  runCommand(command, argv, cwd, env, `pnpm ${args.join(" ")}`);
}

/**
 * `wrangler deploy` for one package, spawned as `node <entry>` when the entry point behind the
 * `.bin` shim can be found. That saves the ~0.33s `pnpm exec` costs per call and sidesteps the
 * Windows `.cmd` shim entirely; when it cannot be resolved, the pnpm path is still there.
 */
function deployWorker(dir: string, extraArgs: string[]): void {
  const cwd = join(root, dir);
  const args = ["deploy", "--config", generatedName, ...extraArgs];
  const entry = resolveBinEntry(cwd, "wrangler");
  if (entry) {
    runCommand(process.execPath, [entry, ...args], cwd, process.env, `wrangler ${args.join(" ")}`);
  } else {
    run(["exec", "wrangler", ...args], cwd);
  }
}

function requireSubmodule(): void {
  if (!existsSync(join(root, "cloudflare-os/package.json"))) {
    throw new Error("CloudflareOS submodule is not initialized. Run git submodule update --init.");
  }
}

function build(config: DeploymentConfig): void {
  for (const { args, env } of buildCommands(config)) {
    run(args, root, env ? { ...process.env, ...env } : process.env);
  }
}

// Said once, up front, rather than discovered when the first chat throws.
function reportAiGateway(config: DeploymentConfig): void {
  const gateway = aiGatewayPlan(config);
  if (!gateway) {
    console.warn(
      "\naiGateway.enabled is false: this deployment advertises no model catalog, and each user " +
      "supplies their own model API keys. A Workshop migrated from the hosted deploy will show an " +
      "empty model picker -- see docs/migrate-from-hosted.md.");
    return;
  }
  if (!gateway.needsToken) return;
  // CLOUDFLARE_ACCOUNT_ID pins the account the way the deploys themselves are pinned: every
  // generated config carries `account_id`, but `wrangler secret put` takes only `--name`
  console.warn(
    `\nCF_AI_GATEWAY_API_TOKEN is required by this configuration:\n` +
    gateway.tokenReasons.map((reason) => `  - ${reason}`).join("\n") +
    `\nInstall it before deploying:\n  CLOUDFLARE_ACCOUNT_ID=${config.accountId} ` +
    `pnpm exec wrangler secret put CF_AI_GATEWAY_API_TOKEN ` +
    `--name ${config.workers.workshop.name}\n`);
}

async function main(): Promise<void> {
  requireSubmodule();
  const config = await readDeployment(join(root, "deployment.jsonc"));
  const generated = generateConfigs(config, {
    router: await readJsonc(join(root, packageDirs.router, "wrangler.jsonc")),
    workshop: await readJsonc(join(root, packageDirs.workshop, "wrangler.jsonc")),
    context: await readJsonc(join(root, packageDirs.context, "wrangler.jsonc")),
    scheduler: await readJsonc(join(root, packageDirs.scheduler, "wrangler.jsonc")),
    customGatekeeper: await readJsonc(join(root, packageDirs.customGatekeeper, "wrangler.jsonc")),
    googleSheetsGuard: await readJsonc(join(root, packageDirs.googleSheetsGuard, "wrangler.jsonc")),
    errorReporter: await readJsonc(join(root, packageDirs.errorReporter, "wrangler.jsonc")),
  });
  reportAiGateway(config);

  try {
    for (const [name, generatedConfig] of Object.entries(generated)) {
      await writeFile(
        generatedPaths[name as keyof typeof generatedPaths],
        JSON.stringify(generatedConfig, null, 2) + "\n");
    }
    const check = process.argv.includes("--check");
    if (check) run(["test"]);
    build(config);
    const deployArgs = check ? ["--dry-run"] : [];
    if (config.errorReporting.enabled) {
      deployWorker(packageDirs.errorReporter, deployArgs);
    }
    deployWorker(packageDirs.context, deployArgs);
    deployWorker(packageDirs.scheduler, deployArgs);
    deployWorker(packageDirs.customGatekeeper, deployArgs);
    if (config.googleSheetsGuard?.enabled) {
      deployWorker(packageDirs.googleSheetsGuard, deployArgs);
    }
    deployWorker(packageDirs.workshop, deployArgs);
    // Last: it binds every one of the above.
    deployWorker(packageDirs.router, deployArgs);
  } finally {
    await Promise.all(Object.values(generatedPaths).map((path) => rm(path, { force: true })));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    // One line, no stack: every failure here is a config or subprocess problem, not a script bug.
    console.error(`\nDeploy failed. ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
