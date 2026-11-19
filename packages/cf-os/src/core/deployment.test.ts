import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parse, type ParseError } from "jsonc-parser";
import {
  aiGatewayPlan,
  buildCommands,
  deployOrder,
  deployWaves,
  generateConfigs,
  generatedOutputs,
  PACKAGE_DIRS,
  PlaceholderError,
  pushIdentityVars,
  validateConfig,
  validateGatekeepers,
  workerDir,
  workerName,
  type WorkerId,
} from "./deployment.ts";
import { validatePushIdentity } from "./deployment-config.ts";
import type {
  BaseConfigs,
  DeploymentConfig,
  GeneratedConfigs,
  ProdWranglerConfig,
} from "./deployment-config.ts";
import type { GatekeeperCatalog } from "./gatekeepers.ts";
import { PUSH_IDENTITY_SECRET, PUSH_IDENTITY_VARS } from "./hosted-release.ts";
import { testCatalog, testCatalogWithGoogle } from "../test-support.ts";

const validConfig: DeploymentConfig = {
  accountId: "0123456789abcdef0123456789abcdef",
  publicBaseUrl: null,
  workers: {
    router: { name: "acme-cloudflare-os", route: { customDomain: "os.example.com" } },
    workshop: { name: "acme-cloudflare-os-backend" },
    context: { name: "acme-cloudflare-os-context" },
    scheduler: { name: "acme-cloudflare-os-scheduler" },
    websearch: { name: "acme-cloudflare-os-websearch" },
    customGatekeeper: { name: "acme-cloudflare-os-custom" },
    errorReporter: { name: "acme-cloudflare-os-errors" },
  },
  access: {
    issuer: "https://acme.cloudflareaccess.com",
    audience: "access-audience",
    admins: ["admin@example.com"],
  },
  aiGateway: {
    enabled: true,
    name: "cloudflare-os",
    accountId: null,
    providers: ["anthropic", "cloudflare"],
  },
  context: {
    sharingDomain: null,
    kvNamespaceId: "context-kv-id",
    artifacts: { enabled: true, namespace: "acme-context-collections" },
  },
  customGatekeeper: { name: "Acme", message: "Use the company handbook." },
  errorReporting: { enabled: true, environment: "production", release: "abc123" },
  resources: {
    blueprintsKvNamespaceId: "blueprints-kv-id",
    avatarsKvNamespaceId: "avatars-kv-id",
    blueprintContentBucket: "cloudflare-os-blueprints",
  },
  observability: {
    enabled: true,
    headSamplingRate: 0.5,
    logs: { invocationLogs: false },
    traces: { enabled: true, headSamplingRate: 0.25 },
  },
};

/** GitHub, Home Assistant and the MCP portal on offer, Email excluded, as upstream's packages say. */
const catalog = testCatalog();

/**
 * A copy of {@link validConfig} with `mutate` applied, typed loosely on purpose.
 *
 * Most of these variants assign something `DeploymentConfig` forbids, which is exactly what
 * `validateConfig` exists to catch: `deployment.jsonc` is hand-edited JSONC with no schema behind
 * it, so the type describes the valid shape rather than guaranteeing what is on disk.
 */
function variant(mutate: (config: Record<string, any>) => void): DeploymentConfig {
  const config = structuredClone(validConfig) as Record<string, any>;
  mutate(config);
  return config as DeploymentConfig;
}

/** Whether the pinned cloudflare-os has upstream's PDF renderer: a pin from before it does not. */
const PIN_HAS_PDF_RENDERER = existsSync(join(PACKAGE_DIRS.pdfRenderer, "wrangler.jsonc"));

/**
 * The renderer's base config on a pin without one: enough for the tests of how a deployment that
 * deploys it is generated, which a pin rolled back to must still pass.
 */
const STAND_IN_PDF_RENDERER: ProdWranglerConfig = {
  name: "pdf-renderer",
  main: "src/index.ts",
  compatibility_date: "2025-01-01",
} as ProdWranglerConfig;

// Read from disk rather than inlined, including the Error Reporter's: the deploy derives every
// generated config from these files, so a copy here could drift from what actually ships. Paths are
// from the repository root, where the test task runs.
async function baseConfigs(): Promise<BaseConfigs> {
  const entries = await Promise.all(Object.entries(PACKAGE_DIRS).map(async ([key, dir]) =>
    [key, key === "pdfRenderer" && !PIN_HAS_PDF_RENDERER
      ? structuredClone(STAND_IN_PDF_RENDERER)
      : await baseConfig(join(dir, "wrangler.jsonc"))] as const));
  return Object.fromEntries(entries) as unknown as BaseConfigs;
}

// Parsed the way `cf-os deploy` parses it, errors included. Swallowing them would let a base config
// that the deploy cannot read still pass these tests on a best-effort parse -- which is how the
// Scheduler's trailing commas hid: nine parse errors, and a config object that still looked usable.
async function baseConfig(path: string): Promise<ProdWranglerConfig> {
  const errors: ParseError[] = [];
  const result = parse(
    await readFile(path, "utf8"),
    errors,
    { allowTrailingComma: true },
  ) as ProdWranglerConfig;
  assert.deepEqual(errors, [], `${path} did not parse cleanly`);
  return result;
}

/** The Context data-isolation boundary carried by the Workshop's Gatekeeper binding. */
function sharingDomain(generated: GeneratedConfigs): unknown {
  return generated.workshop.services!
    .find((service) => service.binding === "GATEKEEPER_CONTEXT")!.props!.sharingDomain;
}

test("rejects deployment placeholders", () => {
  assert.throws(
    () => validateConfig(variant((c) => { c.accountId = "<CLOUDFLARE_ACCOUNT_ID>"; })),
    /placeholder/i);
});

test("rejects destructive or malformed deployment values", () => {
  const duplicateWorkers = structuredClone(validConfig);
  duplicateWorkers.workers.context.name = duplicateWorkers.workers.workshop.name;
  assert.throws(() => validateConfig(duplicateWorkers), /unique/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.observability.enabled = "true"; })), /boolean/i);

  assert.throws(
    () => validateConfig(variant((c) => {
      c.workers.router.route.customDomain = "os.example.com/path";
    })), /hostname/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.sharingDomain = ""; })),
    /sharingDomain must be null or a non-empty string/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.access.issuer += "/team"; })), /issuer.*origin/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.access.audience = "   "; })), /audience/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.access.audience = " access-audience "; })), /audience/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.access.admins = ["bad-address"]; })), /email/i);

  assert.throws(
    () => validateConfig(variant((c) => {
      c.observability.traces.headSamplingRate = 2;
    })), /sampling/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts.enabled = "true"; })),
    /Artifacts enabled.*boolean/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts = null; })),
    /Artifacts configuration.*object/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts = []; })),
    /Artifacts configuration.*object/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts.namespace = null; })),
    /namespace must be omitted/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.context.artifacts.namespace = "context/collections"; })),
    /namespace must be omitted/i);
});

test("rejects AI Gateway keys that no longer do anything", () => {
  // A silently-ignored workersAi block is how a deploy succeeds with an empty model picker.
  assert.throws(
    () => validateConfig(variant((c) => { c.aiGateway.workersAi = { mode: "gateway" }; })),
    /aiGateway\.workersAi does nothing/i);
  // Even with AI off: the key means the operator believes it still does something.
  assert.throws(
    () => validateConfig(variant((c) => {
      c.aiGateway = { enabled: false, workersAi: { mode: "direct" } };
    })),
    /aiGateway\.workersAi does nothing/i);
});

test("rejects malformed AI Gateway providers and account", () => {
  assert.throws(
    () => validateConfig(variant((c) => { c.aiGateway.providers = []; })),
    /Missing required deployment value: aiGateway.providers/);

  assert.throws(
    () => validateConfig(variant((c) => { c.aiGateway.providers = ["anthropic", "mistral"]; })),
    /providers must be a non-empty subset/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.aiGateway.accountId = "not-an-account"; })),
    /aiGateway.accountId must be null or 32 hexadecimal/i);
});

test("generates Access-mode Workshop, Context, and custom Gatekeeper configs", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs(), catalog);
  const vars = generated.workshop.vars!;

  assert.equal(generated.workshop.name, "acme-cloudflare-os-backend");
  assert.deepEqual(vars.ADMINS, ["admin@example.com"]);
  assert.equal(vars.CF_ACCESS_ISS, validConfig.access.issuer);
  assert.equal(vars.CF_ACCESS_AUD, validConfig.access.audience);
  assert.equal(vars.PUBLIC_BASE_URL, "https://os.example.com");
  assert.equal(vars.CF_AI_GATEWAY, "cloudflare-os");
  assert.equal(vars.CF_AI_GATEWAY_PROVIDERS, "anthropic,cloudflare");
  assert.deepEqual(generated.workshop.ai, { binding: "WORKERS_AI" });
  assert.deepEqual(generated.workshop.services, [
    {
      binding: "ERROR_REPORTER",
      service: "acme-cloudflare-os-errors",
      entrypoint: "ErrorReporter",
      props: {
        service: "acme-cloudflare-os-backend",
        environment: "production",
        release: "abc123",
      },
    },
    {
      binding: "GATEKEEPER_CONTEXT",
      service: "acme-cloudflare-os-context",
      entrypoint: "GatekeeperVendor",
      props: { sharingDomain: "https://os.example.com" },
    },
    {
      binding: "GATEKEEPER_SCHEDULER",
      service: "acme-cloudflare-os-scheduler",
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_WEBSEARCH",
      service: "acme-cloudflare-os-websearch",
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_CUSTOM",
      service: "acme-cloudflare-os-custom",
      entrypoint: "GatekeeperVendor",
    },
  ]);
  assert.deepEqual(generated.workshop.kv_namespaces, [
    { binding: "BLUEPRINTS", id: "blueprints-kv-id" },
    { binding: "AVATARS", id: "avatars-kv-id" },
  ]);
  assert.equal(generated.workshop.r2_buckets![0].bucket_name, "cloudflare-os-blueprints");
  assert.equal(generated.context.name, "acme-cloudflare-os-context");
  assert.equal(generated.context.kv_namespaces![0].id, "context-kv-id");
  assert.deepEqual(generated.context.artifacts, [{
    binding: "ARTIFACTS",
    namespace: "acme-context-collections",
  }]);
  assert.equal(generated.customGatekeeper!.name, "acme-cloudflare-os-custom");
  assert.deepEqual(generated.customGatekeeper!.vars, {
    CUSTOM_NAME: "Acme",
    CUSTOM_MESSAGE: "Use the company handbook.",
  });
  assert.equal(generated.errorReporter!.name, "acme-cloudflare-os-errors");
  assert.deepEqual(generated.workshop.observability!.logs, {
    invocation_logs: false,
  });
  assert.deepEqual(generated.workshop.observability!.traces, {
    enabled: true,
    head_sampling_rate: 0.25,
  });
  assert.equal(generated.workshop.services!.some(
    (service) => service.binding === "FRONTEND_ERROR_REPORTER"), false);
});

test("gives the router the public route, the frontend, and every service binding", async () => {
  const bases = await baseConfigs();
  const generated = generateConfigs(validConfig, bases, catalog);

  assert.equal(generated.router.name, "acme-cloudflare-os");
  assert.equal(generated.router.workers_dev, false);
  assert.deepEqual(generated.router.routes, [{ pattern: "os.example.com", custom_domain: true }]);
  // No entrypoint on any of them: the router forwards whole HTTP requests rather than making
  // vendor RPC calls, and the binding name is what selects the /gatekeeper/<name> path.
  assert.deepEqual(generated.router.services, [
    { binding: "WORKSHOP_BACKEND", service: "acme-cloudflare-os-backend" },
    { binding: "GATEKEEPER_CONTEXT", service: "acme-cloudflare-os-context" },
    { binding: "GATEKEEPER_SCHEDULER", service: "acme-cloudflare-os-scheduler" },
    { binding: "GATEKEEPER_WEBSEARCH", service: "acme-cloudflare-os-websearch" },
    { binding: "GATEKEEPER_CUSTOM", service: "acme-cloudflare-os-custom" },
  ]);
  // Inherited untouched: the base config already carries the ASSETS binding, the SPA fallback, and
  // the /gatekeeper/* prefix an OAuth Gatekeeper redirect needs.
  assert.deepEqual(generated.router.assets, bases.router.assets);
  assert.equal(generated.router.assets!.binding, "ASSETS");
  assert.equal(generated.router.assets!.directory, "../workshop-frontend/dist");
  assert.ok(generated.router.assets!.run_worker_first!.includes("/gatekeeper/*"),
    JSON.stringify(generated.router.assets));
});

/**
 * The hosted deploy preinstalls this one on every fresh instance (`PREINSTALL` in
 * cloudflare-os/scripts/release/manifest-lib.ts), so a starter that skipped it would not be the same
 * topology: a migrated instance would show none of its existing schedules, and the
 * Durable Objects holding them would be orphaned behind a Worker nothing is bound to.
 */
test("deploys the ambient Scheduler Gatekeeper the hosted flow preinstalls", async () => {
  const bases = await baseConfigs();
  const generated = generateConfigs(validConfig, bases, catalog);

  assert.equal(generated.scheduler.name, "acme-cloudflare-os-scheduler");
  // Reached by both, for the two different things a Gatekeeper does: vendor RPC from the backend,
  // and whole HTTP requests under /gatekeeper/scheduler from the router.
  assert.deepEqual(
    generated.workshop.services!.find((service) => service.binding === "GATEKEEPER_SCHEDULER"),
    {
      binding: "GATEKEEPER_SCHEDULER",
      service: "acme-cloudflare-os-scheduler",
      entrypoint: "GatekeeperVendor",
    });
  assert.deepEqual(
    generated.router.services!.find((service) => service.binding === "GATEKEEPER_SCHEDULER"),
    { binding: "GATEKEEPER_SCHEDULER", service: "acme-cloudflare-os-scheduler" });

  // Its Durable Object history has to arrive verbatim: those classes are where the schedules live.
  assert.deepEqual(generated.scheduler.migrations, bases.scheduler.migrations);
  assert.ok(generated.scheduler.migrations!.length > 0, "scheduler lost its DO migrations");
  // No configuration surface of its own -- which is what makes it installable with no user input
  // upstream, and deployable here from nothing but a Worker name.
  assert.equal(generated.scheduler.vars, undefined);
  assert.equal(generated.scheduler.kv_namespaces, undefined);
  assert.equal(generated.scheduler.secrets, undefined);

  const builds = buildCommands(validConfig, catalog).flat()
    .map(({ args }) => args)
    .filter((args) => args.includes("@gadgets/gatekeeper-scheduler"));
  assert.deepEqual(builds.map((args) => args.at(-1)), ["build:app", "build"]);
});

/**
 * The third ambient Gatekeeper the hosted flow preinstalls (`PREINSTALL` again). Skipping it would
 * leave a migrated instance's users without the search their blueprints call, and a fresh install
 * one capability short of the hosted topology.
 */
test("deploys the ambient Web Search Gatekeeper the hosted flow preinstalls", async () => {
  const bases = await baseConfigs();
  const generated = generateConfigs(validConfig, bases, catalog);

  assert.equal(generated.websearch.name, "acme-cloudflare-os-websearch");
  assert.deepEqual(
    generated.workshop.services!.find((service) => service.binding === "GATEKEEPER_WEBSEARCH"),
    {
      binding: "GATEKEEPER_WEBSEARCH",
      service: "acme-cloudflare-os-websearch",
      entrypoint: "GatekeeperVendor",
    });
  assert.deepEqual(
    generated.router.services!.find((service) => service.binding === "GATEKEEPER_WEBSEARCH"),
    { binding: "GATEKEEPER_WEBSEARCH", service: "acme-cloudflare-os-websearch" });

  // Carried verbatim from upstream: the Workers AI binding the search runs on, the rule that bundles
  // its agent-facing types as text, and the Durable Object history of its workspace facet.
  assert.deepEqual(generated.websearch.ai, bases.websearch.ai);
  assert.equal(generated.websearch.ai!.binding, "AI");
  assert.deepEqual(generated.websearch.rules, bases.websearch.rules);
  assert.deepEqual(generated.websearch.migrations, bases.websearch.migrations);
  assert.ok(generated.websearch.migrations!.length > 0, "websearch lost its DO migrations");
  assert.equal(generated.websearch.secrets, undefined);

  // It searches through the Workshop's gateway, when the AI binding can reach it; else `default`.
  assert.deepEqual(generated.websearch.vars, { CF_AI_GATEWAY: "cloudflare-os" });
  const off = generateConfigs(variant((c) => { c.aiGateway.enabled = false; }), bases, catalog);
  assert.equal(off.websearch.vars, undefined);
  const elsewhere = generateConfigs(variant((c) => { c.aiGateway.accountId = "fedcba9876543210fedcba9876543210"; }), bases, catalog);
  assert.equal(elsewhere.websearch.vars, undefined);

  // Built, and so type-checked, with the rest.
  const builds = buildCommands(validConfig, catalog).flat().map(({ args }) => args);
  assert.deepEqual(
    builds.filter((args) => args.includes("@gadgets/gatekeeper-websearch")).map((args) => args.at(-1)),
    ["build"]);
});

test("rejects a Web Search Worker name shared with another Worker", () => {
  assert.throws(
    () => validateConfig(variant((c) => { c.workers.websearch.name = c.workers.scheduler.name; })),
    /unique/i);
  assert.throws(
    () => validateConfig(variant((c) => { delete c.workers.websearch; })),
    /Missing required deployment value: workers.websearch.name/);
});

test("keeps every Worker behind the router off the public internet", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs(), catalog);
  for (const [name, worker] of generatedOutputs(generated)) {
    if (name !== "router") {
      assert.equal(worker.workers_dev, false, `${name} answers on workers.dev`);
      assert.equal(worker.routes, undefined, `${name} carries a public route`);
    }
    // A preview URL is an unauthenticated path around the Access-protected origin.
    assert.equal(worker.preview_urls, false, `${name} leaves preview URLs enabled`);
  }
  // The router serves the frontend, so the backend uploads no assets of its own.
  assert.equal(generated.workshop.assets, undefined);
});

test("scopes PUBLIC_BASE_URL and Context sharing to the public origin", async () => {
  const onWorkersDev = variant((c) => {
    c.workers.router.route = { workersDev: true };
    c.publicBaseUrl = "https://acme-cloudflare-os.acme.workers.dev";
  });

  const derived = generateConfigs(validConfig, await baseConfigs(), catalog);
  const explicit = generateConfigs(onWorkersDev, await baseConfigs(), catalog);

  assert.equal(derived.workshop.vars!.PUBLIC_BASE_URL, "https://os.example.com");
  assert.equal(
    explicit.workshop.vars!.PUBLIC_BASE_URL, "https://acme-cloudflare-os.acme.workers.dev");
  assert.equal(explicit.router.workers_dev, true);
  assert.equal(explicit.router.routes, undefined);

  // sharingDomain: null follows the public origin, which is what the hosted deploy sets it to.
  assert.equal(sharingDomain(derived), "https://os.example.com");
  assert.equal(sharingDomain(explicit), "https://acme-cloudflare-os.acme.workers.dev");

  // A pinned literal keeps the boundary stable across a hostname change, so it wins.
  const pinned = generateConfigs(
    variant((c) => { c.context.sharingDomain = "production"; }), await baseConfigs(), catalog);
  assert.equal(sharingDomain(pinned), "production");
  assert.equal(pinned.workshop.vars!.PUBLIC_BASE_URL, "https://os.example.com");
});

test("rejects a public origin it cannot derive or cannot trust", async () => {
  // Nothing in deployment.jsonc names the account's workers.dev subdomain, and PUBLIC_BASE_URL and
  // the Context sharing boundary both need an origin, so this cannot be left to a fallback.
  assert.throws(
    () => validateConfig(variant((c) => { c.workers.router.route = { workersDev: true }; })),
    /publicBaseUrl is required on a workersDev route/i);

  // Scoping Context data to a hostname the deployment does not answer on hides its collections.
  assert.throws(
    () => validateConfig(variant((c) => { c.publicBaseUrl = "https://other.example.com"; })),
    /does not match workers.router.route.customDomain/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.publicBaseUrl = "https://os.example.com/"; })),
    /HTTPS origin only/i);

  assert.throws(
    () => validateConfig(variant((c) => { c.publicBaseUrl = "http://os.example.com"; })),
    /HTTPS origin only/i);

  assert.throws(
    () => validateConfig(variant((c) => { delete c.publicBaseUrl; })),
    /publicBaseUrl must be present/i);
});

test("rejects a workersDev origin that is not the router's own", async () => {
  const onWorkersDev = (publicBaseUrl: string) => variant((c) => {
    c.workers.router.route = { workersDev: true };
    c.publicBaseUrl = publicBaseUrl;
  });

  // The account's workers.dev subdomain is unknowable here, but the rest of the hostname is not: a
  // typo in the Worker label, or an unrelated host, would silently become both PUBLIC_BASE_URL and
  // the Context isolation boundary.
  assert.throws(
    () => validateConfig(onWorkersDev("https://acme-cloudflare-o.acme.workers.dev")),
    /names Worker "acme-cloudflare-o", but the router is "acme-cloudflare-os"/);

  assert.throws(
    () => validateConfig(onWorkersDev("https://os.example.com")),
    /not a workers.dev origin/i);

  // A deeper name is a preview URL or an unrelated host, not the route wrangler serves.
  assert.throws(
    () => validateConfig(onWorkersDev("https://staging.acme-cloudflare-os.acme.workers.dev")),
    /not a workers.dev origin/i);

  // The shape wrangler actually serves stays valid, whatever the account subdomain is.
  const generated = generateConfigs(
    onWorkersDev("https://acme-cloudflare-os.some-account.workers.dev"), await baseConfigs(), catalog);
  assert.equal(
    generated.workshop.vars!.PUBLIC_BASE_URL, "https://acme-cloudflare-os.some-account.workers.dev");

  // The rule is scoped to the workersDev route. A custom domain has its own hostname, unrelated to
  // any Worker name, and is checked against `customDomain` instead -- both spellings stay valid.
  assert.equal(
    validateConfig(variant((c) => { c.publicBaseUrl = "https://os.example.com"; })).publicBaseUrl,
    "https://os.example.com");
  assert.equal(validateConfig(validConfig).publicBaseUrl, null);
});

test("routes AI Gateway over the Workers AI binding without an API token", async () => {
  const generated = generateConfigs(validConfig, await baseConfigs(), catalog);
  const vars = generated.workshop.vars!;

  assert.equal(vars.CF_AI_GATEWAY_ACCOUNT_ID, validConfig.accountId);
  // Absent, not "true": the backend takes the binding whenever it is bound, and the binding is
  // pre-authenticated inside the deployment's own account.
  assert.equal(vars.CF_AI_GATEWAY_USE_BINDING, undefined);
  assert.equal(generated.workshop.secrets, undefined);
  assert.deepEqual(aiGatewayPlan(validConfig), {
    gatewayAccountId: validConfig.accountId,
    crossAccount: false,
    needsToken: false,
    tokenReasons: [],
  });
});

test("requires a token for a gateway in another account", async () => {
  const config = variant((c) => { c.aiGateway.accountId = "fedcba9876543210fedcba9876543210"; });
  const generated = generateConfigs(config, await baseConfigs(), catalog);
  const vars = generated.workshop.vars!;

  assert.equal(vars.CF_AI_GATEWAY_ACCOUNT_ID, "fedcba9876543210fedcba9876543210");
  assert.equal(vars.CF_AI_GATEWAY_USE_BINDING, "false");
  assert.deepEqual(generated.workshop.secrets, { required: ["CF_AI_GATEWAY_API_TOKEN"] });
  // The Workers AI binding stays bound: webFetch's toMarkdown() runs on it too.
  assert.deepEqual(generated.workshop.ai, { binding: "WORKERS_AI" });
  assert.equal(aiGatewayPlan(config)!.tokenReasons.length, 1);
});

test("treats a differently-cased account ID as the same account", async () => {
  const config = variant((c) => { c.aiGateway.accountId = c.accountId.toUpperCase(); });
  const generated = generateConfigs(config, await baseConfigs(), catalog);

  // Same account written two ways, which the hex pattern accepts: the binding reaches this gateway,
  // so no CF_AI_GATEWAY_USE_BINDING opt-out and no token.
  assert.equal(generated.workshop.vars!.CF_AI_GATEWAY_ACCOUNT_ID, validConfig.accountId);
  assert.equal(generated.workshop.vars!.CF_AI_GATEWAY_USE_BINDING, undefined);
  assert.equal(generated.workshop.secrets, undefined);
  assert.equal(aiGatewayPlan(config)!.crossAccount, false);
  assert.deepEqual(aiGatewayPlan(config)!.tokenReasons, []);
});

test("requires a token for the google provider", async () => {
  const config = variant((c) => { c.aiGateway.providers = ["cloudflare", "google"]; });
  const generated = generateConfigs(config, await baseConfigs(), catalog);

  assert.deepEqual(generated.workshop.secrets, { required: ["CF_AI_GATEWAY_API_TOKEN"] });
  // Same account, so the binding still carries every other provider.
  assert.equal(generated.workshop.vars!.CF_AI_GATEWAY_USE_BINDING, undefined);
  assert.match(aiGatewayPlan(config)!.tokenReasons[0], /google/i);
});

test("omits disabled backend error reporting", async () => {
  const config = variant((c) => {
    c.errorReporting = { enabled: false, environment: "<ENVIRONMENT>", release: "<RELEASE>" };
  });

  const generated = generateConfigs(config, await baseConfigs(), catalog);

  assert.equal(generated.errorReporter, undefined);
  assert.equal(generated.workshop.services!.some(
    (service) => service.binding === "ERROR_REPORTER"), false);
});

test("omits dormant AI Gateway configuration", async () => {
  const config = variant((c) => {
    c.aiGateway = {
      enabled: false,
      name: "<AI_GATEWAY_NAME>",
      accountId: "<AI_GATEWAY_ACCOUNT_ID>",
      providers: [],
    };
  });

  const generated = generateConfigs(config, await baseConfigs(), catalog);
  const vars = generated.workshop.vars!;

  assert.equal(vars.CF_AI_GATEWAY, undefined);
  assert.equal(vars.CF_AI_GATEWAY_ACCOUNT_ID, undefined);
  assert.equal(vars.CF_AI_GATEWAY_PROVIDERS, undefined);
  assert.equal(generated.workshop.secrets, undefined);
  // Still bound: it is what webFetch's toMarkdown() runs on, independent of the model catalog.
  assert.deepEqual(generated.workshop.ai, { binding: "WORKERS_AI" });
  assert.equal(aiGatewayPlan(config), null);
});

test("uses the default Context Artifacts namespace when omitted", async () => {
  const config = variant((c) => { delete c.context.artifacts.namespace; });

  const generated = generateConfigs(config, await baseConfigs(), catalog);

  assert.deepEqual(generated.context.artifacts, [{
    binding: "ARTIFACTS",
    namespace: "gatekeeper-context-collections",
  }]);
});

test("omits disabled Context Artifacts configuration", async () => {
  const config = variant((c) => { c.context.artifacts = {}; });
  const bases = await baseConfigs();
  bases.context.artifacts = [{ binding: "ARTIFACTS", namespace: "upstream-default" }];

  const generated = generateConfigs(config, bases, catalog);

  assert.equal(generated.context.artifacts, undefined);
});

test("defaults Context Artifacts to disabled when configuration is omitted", async () => {
  const config = variant((c) => { delete c.context.artifacts; });

  const generated = generateConfigs(config, await baseConfigs(), catalog);

  assert.equal(generated.context.artifacts, undefined);
});

test("generates binding-only storage for automatic provisioning", async () => {
  const config = variant((c) => {
    c.context.kvNamespaceId = null;
    c.resources = {
      blueprintsKvNamespaceId: null,
      avatarsKvNamespaceId: null,
      blueprintContentBucket: null,
    };
  });

  const generated = generateConfigs(config, await baseConfigs(), catalog);

  assert.deepEqual(generated.workshop.kv_namespaces, [
    { binding: "BLUEPRINTS" },
    { binding: "AVATARS" },
  ]);
  assert.deepEqual(generated.workshop.r2_buckets, [{ binding: "BLUEPRINT_CONTENT" }]);
  assert.deepEqual(generated.context.kv_namespaces, [{ binding: "CONTEXT_COLLECTIONS" }]);
});

/**
 * The equivalent, for this repository, of upstream's `deploy-scripts.test.ts`. That one
 * auto-discovers per-package `deploy` scripts; here deploying is centralised in `deploy.ts`, so the
 * same invariant has to be asserted against the commands it spawns.
 *
 * Both halves are silent failures: a replayed cache hit and a dropped build-time flag each exit
 * zero and each still deploy.
 */
test("never lets a deploy replay a cached build artifact", () => {
  const commands = buildCommands(validConfig, catalog).flat();
  assert.ok(commands.length > 0, "expected at least one build command");
  for (const { args } of commands) {
    const command = args.join(" ");
    // `pnpm --filter <pkg> build` cannot see a Vite+ task, and two of the three submodule targets
    // are now tasks rather than scripts. `vp run` runs both.
    assert.ok(command.includes("vp run"),
      `build step does not go through vp run: ${command}`);
    assert.ok(command.includes("--no-cache"),
      `build step runs a vp task while deploying without --no-cache: ${command}\n` +
      "Deploys must not replay a cached artifact -- add --no-cache.");
    // Everything after the task specifier is forwarded to the task's own command, so a trailing
    // flag reaches `tsc` as an unknown option instead of reaching vp.
    assert.ok(args.indexOf("--no-cache") < args.indexOf("run") + 4,
      `--no-cache must precede the task name, not follow it: ${command}`);
  }
});

test("rebuilds the Context configurator app rather than replaying it", () => {
  // `gatekeeper-context`'s `build` script spawns `vp run --cache build:app` of its own, which the
  // outer --no-cache does not reach. Without this step a deploy ships whatever app.txt the cache
  // last archived.
  const context = buildCommands(validConfig, catalog).flat()
    .map(({ args }) => args)
    .filter((args) => args.includes("@gadgets/gatekeeper-context"));
  assert.deepEqual(context.map((args) => args.at(-1)), ["build:app", "build"]);
  assert.ok(context.every((args) => args.at(-2) === "--no-cache"), context.join("\n"));
});

test("passes VITE_CF_ACCESS_MODE explicitly rather than inheriting it", () => {
  const withAccessMode = buildCommands(validConfig, catalog).flat().filter(({ env }) => env);
  assert.deepEqual(withAccessMode.map(({ env }) => env), [{ VITE_CF_ACCESS_MODE: "true" }]);
  // It has to reach the frontend, which inlines it into the bundle, and nothing else.
  assert.match(withAccessMode[0].args.join(" "), /@gadgets\/workshop-frontend/);
});

test("builds what depends on itself in order, and everything else independently", () => {
  const chains = buildCommands(validConfig, catalog).map((chain) => chain.map(({ args }) => args.join(" ")));
  // Each nested `build:app` pair stays one chain, in order: `build` replays what `build:app` wrote.
  for (const pkg of ["@gadgets/gatekeeper-context", "@gadgets/gatekeeper-scheduler"]) {
    const chain = chains.find((commands) => commands.some((command) => command.includes(pkg)));
    assert.deepEqual(chain?.map((command) => command.split(" ").at(-1)), ["build:app", "build"], pkg);
  }
  // Every other package is a chain of its own.
  assert.deepEqual(chains.map((chain) => chain.length), [2, 2, 1, 1, 1, 1, 1, 1]);
  // The frontend and the router included: it is the router's deploy, not its build, that reads
  // ../workshop-frontend/dist, and every build finishes before anything deploys.
  const frontend = chains.findIndex((chain) => chain.some((command) => command.includes("workshop-frontend")));
  const router = chains.findIndex((chain) => chain.some((command) => command.includes("@gadgets/router")));
  assert.ok(frontend >= 0 && router >= 0 && frontend !== router, chains.join("\n"));
});

test("skips the Error Reporter build when error reporting is disabled", () => {
  const config = variant((c) => {
    c.errorReporting = { enabled: false, environment: "<ENVIRONMENT>", release: null };
  });
  const commands = buildCommands(config, catalog).flat().map(({ args }) => args.join(" "));
  assert.equal(commands.some((command) => command.includes("error-reporter")), false);
});

test("tells an unconfigured file apart from a wrong one", () => {
  assert.throws(() => validateConfig(variant((config) => { config.accountId = "<CLOUDFLARE_ACCOUNT_ID>"; })),
    PlaceholderError);
  assert.throws(() => validateConfig(variant((config) => { config.accountId = "nope"; })),
    (error: unknown) => error instanceof Error && !(error instanceof PlaceholderError));
});

/** {@link validConfig} with GitHub and the MCP portal added, and the custom Gatekeeper off. */
const withOptional = variant((c) => {
  c.customGatekeeper.enabled = false;
  c.gatekeepers = {
    github: { name: "acme-cloudflare-os-github", vars: { GITHUB_ORG: "acme" } },
    mcpportal: { name: "acme-cloudflare-os-mcpportal", vars: { MCP_PORTAL_URL: "https://portal.example.com/mcp" } },
  };
});

/** {@link validConfig} with Google added, whose Gatekeeper binds upstream's PDF renderer. */
const withGoogle = variant((c) => { c.gatekeepers = { google: { name: "acme-cloudflare-os-google" } }; });
const googleCatalog = testCatalogWithGoogle();

test("deploys the Gatekeepers together, then the Workshop, then the router", () => {
  assert.deepEqual(deployWaves(validConfig, catalog),
    [["errorReporter", "context", "scheduler", "websearch", "customGatekeeper"], ["workshop"], ["router"]]);
  assert.deepEqual(deployWaves(variant((config) => { config.errorReporting.enabled = false; }), catalog),
    [["context", "scheduler", "websearch", "customGatekeeper"], ["workshop"], ["router"]]);
  assert.deepEqual(deployWaves(withOptional, catalog), [
    ["errorReporter", "context", "scheduler", "websearch", "gatekeepers.github", "gatekeepers.mcpportal"],
    ["workshop"],
    ["router"],
  ]);
});

test("deploys every Worker after each one it binds", async () => {
  // Derived from the generated service bindings, so a binding added upstream fails here rather than
  // at a deploy the Workers API rejects for naming a script that does not exist yet.
  const cases: [DeploymentConfig, GatekeeperCatalog][] = [
    [validConfig, catalog], [variant((c) => { c.errorReporting.enabled = false; }), catalog], [withOptional, catalog],
    [withGoogle, googleCatalog],
  ];
  for (const [config, catalog] of cases) {
    const generated = new Map(generatedOutputs(generateConfigs(config, await baseConfigs(), catalog)));
    const waves = deployWaves(config, catalog);
    // Exactly the generated configs deploy, each from its own package.
    assert.deepEqual(new Set(waves.flat()), new Set(generated.keys()));
    const waveOf = new Map(waves.flatMap((wave, index) => wave.map((id) => [workerName(config, id), index] as const)));
    for (const [index, wave] of waves.entries()) {
      for (const id of wave) {
        assert.equal(generated.get(id)!.name, workerName(config, id));
        for (const { service } of generated.get(id)!.services ?? []) {
          assert.ok(waveOf.has(service), `${id} binds ${service}, which no wave deploys`);
          assert.ok(waveOf.get(service)! < index, `${id} binds ${service}, which deploys in wave ${waveOf.get(service)}`);
        }
      }
    }
  }
});

test("deploys every Worker before the router that binds them", () => {
  assert.deepEqual(deployOrder(validConfig, catalog), deployWaves(validConfig, catalog).flat());
  assert.deepEqual(deployOrder(validConfig, catalog),
    ["errorReporter", "context", "scheduler", "websearch", "customGatekeeper", "workshop", "router"]);
  assert.deepEqual(deployOrder(variant((config) => { config.errorReporting.enabled = false; }), catalog),
    ["context", "scheduler", "websearch", "customGatekeeper", "workshop", "router"]);
  // Every package the deploy reads a base config from is deployed, the PDF renderer only beside a
  // Gatekeeper that binds it, and nothing else.
  assert.deepEqual(new Set(deployOrder(validConfig, catalog)),
    new Set(Object.keys(PACKAGE_DIRS).filter((key) => key !== "pdfRenderer")));
  assert.deepEqual(new Set(deployOrder(withGoogle, googleCatalog)),
    new Set([...Object.keys(PACKAGE_DIRS), "gatekeepers.google"]));
});

test("carries upstream's limits to the PDF renderer and Google, and the renderer's compiled-WebAssembly rule",
  { skip: PIN_HAS_PDF_RENDERER ? false : "the pinned cloudflare-os has no pdf-renderer package" }, async () => {
    const generated = generateConfigs(withGoogle, await baseConfigs(), googleCatalog);
    const renderer = generated.pdfRenderer!;
    assert.deepEqual(renderer.limits, { cpu_ms: 300_000 });
    assert.ok(renderer.rules!.some((rule) => (rule as { type: string }).type === "CompiledWasm"));
    assert.deepEqual(generated.gatekeepers.google.limits, { subrequests: 100_000 });
  });

test("deploys upstream's PDF renderer first, and binds Google to it", async () => {
  const bases = await baseConfigs();
  const generated = generateConfigs(withGoogle, bases, googleCatalog);
  const renderer = generated.pdfRenderer!;
  // Named as the hosted deploy names an instance's, behind the router like every other Worker.
  assert.equal(renderer.name, "acme-cloudflare-os-pdf-renderer");
  assert.equal(workerName(withGoogle, "pdfRenderer"), renderer.name);
  assert.equal(renderer.workers_dev, false);
  assert.equal(renderer.preview_urls, false);
  assert.equal(renderer.routes, undefined);
  assert.deepEqual(generated.gatekeepers.google.services,
    [{ binding: "PDF_RENDERER", service: "acme-cloudflare-os-pdf-renderer", entrypoint: "PdfRenderer" }]);
  assert.deepEqual(deployWaves(withGoogle, googleCatalog)[0], ["pdfRenderer"]);
  assert.ok(buildCommands(withGoogle, googleCatalog).flat()
    .some(({ args }) => args.join(" ") === "--dir cloudflare-os exec vp run -F @gadgets/pdf-renderer --no-cache build"));

  // A name of its own goes to the Worker and to the binding.
  const named = variant((c) => { Object.assign(c, structuredClone(withGoogle)); c.workers.pdfRenderer = { name: "acme-pdf" }; });
  const own = generateConfigs(named, bases, googleCatalog);
  assert.equal(own.pdfRenderer!.name, "acme-pdf");
  assert.equal(own.gatekeepers.google.services![0].service, "acme-pdf");

  // Without a Gatekeeper that binds it, none: no config, no build, no wave.
  assert.equal(generateConfigs(withOptional, bases, catalog).pdfRenderer, undefined);
  assert.ok(!buildCommands(withOptional, catalog).flat().some(({ args }) => args.includes("@gadgets/pdf-renderer")));
  assert.ok(!deployOrder(withOptional, catalog).includes("pdfRenderer"));

  // Its name is checked only where it is deployed: a 51-character router name makes a 64-character
  // renderer name, which fails a deployment with Google and nothing else.
  type Change = Parameters<typeof variant>[0];
  const longRouter: Change = (c) => { c.workers.router.name = "a".repeat(51); };
  const withGoogleAnd = (change: Change) =>
    variant((c) => { Object.assign(c, structuredClone(withGoogle)); change(c); });
  assert.doesNotThrow(() => generateConfigs(variant(longRouter), bases, catalog));
  assert.throws(() => generateConfigs(withGoogleAnd(longRouter), bases, googleCatalog),
    /workers\.pdfRenderer\.name: a{51}-pdf-renderer is not a Worker name[\s\S]*set workers\.pdfRenderer\.name to a shorter one/);
  assert.equal(generateConfigs(withGoogleAnd((c) => { longRouter(c); c.workers.pdfRenderer = { name: "acme-pdf" }; }),
    bases, googleCatalog).pdfRenderer!.name, "acme-pdf");
  // A name another Worker has, likewise.
  const shared: Change = (c) => { c.workers.pdfRenderer = { name: c.workers.context.name }; };
  assert.doesNotThrow(() => generateConfigs(variant(shared), bases, catalog));
  assert.throws(() => generateConfigs(withGoogleAnd(shared), bases, googleCatalog),
    /names must be unique: acme-cloudflare-os-context is used twice/);
  // A block that is not a name is refused either way.
  assert.throws(() => validateConfig(variant((c) => { c.workers.pdfRenderer = {} as { name: string }; })),
    /workers.pdfRenderer must be an object with a name/);
});

test("locates and names every Worker by its id", () => {
  const ids: WorkerId[] = ["router", "customGatekeeper", "gatekeepers.github", "gatekeepers.mcpportal"];
  assert.deepEqual(ids.map((id) => workerDir(id, catalog)), [
    "cloudflare-os/packages/router",
    "packages/custom-gatekeeper",
    "cloudflare-os/packages/gatekeeper-github",
    "cloudflare-os/packages/gatekeeper-mcp-portal",
  ]);
  assert.deepEqual(ids.map((id) => workerName(withOptional, id)), [
    "acme-cloudflare-os", "acme-cloudflare-os-custom", "acme-cloudflare-os-github", "acme-cloudflare-os-mcpportal",
  ]);
});

test("with the custom Gatekeeper off, deploys nothing of it", async () => {
  const off = variant((c) => {
    // Its names are ignored, so their placeholders are too.
    c.customGatekeeper = { enabled: false, name: "<ORGANIZATION_DISPLAY_NAME>", message: "<ORGANIZATION_GUIDANCE>" };
    c.workers.customGatekeeper = { name: "<CUSTOM_GATEKEEPER_WORKER_NAME>" };
  });
  const generated = generateConfigs(off, await baseConfigs(), catalog);
  assert.equal(generated.customGatekeeper, undefined);
  assert.equal(generated.router.services!.some((service) => service.binding === "GATEKEEPER_CUSTOM"), false);
  assert.equal(generated.workshop.services!.some((service) => service.binding === "GATEKEEPER_CUSTOM"), false);
  assert.equal(buildCommands(off, catalog).flat().some(({ args }) => args.includes("custom-gatekeeper")), false);
  assert.equal(deployOrder(off, catalog).includes("customGatekeeper"), false);

  // Nor does it need a Worker name at all, or display text.
  const bare = variant((c) => {
    c.customGatekeeper = { enabled: false };
    delete c.workers.customGatekeeper;
  });
  assert.equal(generateConfigs(bare, await baseConfigs(), catalog).customGatekeeper, undefined);
  // Its old name is free for another Worker.
  assert.doesNotThrow(() => validateConfig(variant((c) => {
    c.customGatekeeper.enabled = false;
    c.workers.customGatekeeper.name = c.workers.context.name;
  })));
  assert.throws(() => validateConfig(variant((c) => { c.customGatekeeper.enabled = "no"; })),
    /customGatekeeper.enabled must be a boolean/);
});

test("with customGatekeeper.enabled absent, deploys the custom Gatekeeper as when it is true", async () => {
  const absent = variant((c) => { delete c.customGatekeeper.enabled; });
  const enabled = variant((c) => { c.customGatekeeper.enabled = true; });
  const bases = await baseConfigs();
  assert.deepEqual(generateConfigs(absent, bases, catalog), generateConfigs(enabled, bases, catalog));
  assert.deepEqual(buildCommands(absent, catalog), buildCommands(enabled, catalog));
  assert.deepEqual(deployWaves(absent, catalog), deployWaves(enabled, catalog));
  assert.equal(generateConfigs(absent, bases, catalog).customGatekeeper!.name, "acme-cloudflare-os-custom");
  // And still requires everything it did.
  assert.throws(() => validateConfig(variant((c) => { delete c.customGatekeeper.message; })),
    /Missing required deployment value: customGatekeeper.message/);
  assert.throws(() => validateConfig(variant((c) => { delete c.workers.customGatekeeper; })),
    /Missing required deployment value: workers.customGatekeeper.name/);
});

test("generates an optional Gatekeeper from its upstream config", async () => {
  const generated = generateConfigs(withOptional, await baseConfigs(), catalog);
  const github = generated.gatekeepers.github;
  const base = catalog.offered.find((gatekeeper) => gatekeeper.slug === "github")!.config;

  assert.equal(github.name, "acme-cloudflare-os-github");
  assert.equal(github.account_id, validConfig.accountId);
  assert.equal(github.workers_dev, false);
  assert.equal(github.routes, undefined);
  assert.equal(github.preview_urls, false);
  // The operator's vars, and the origin it builds its OAuth redirect from, under its own route.
  assert.deepEqual(github.vars, { GITHUB_ORG: "acme", BASE_URL: "https://os.example.com/gatekeeper/github" });
  // Upstream's own vars are kept, the operator's merged over them.
  assert.deepEqual(generated.gatekeepers.mcpportal.vars, {
    MCP_ALLOW_INSECURE: "false",
    MCP_PORTAL_URL: "https://portal.example.com/mcp",
    BASE_URL: "https://os.example.com/gatekeeper/mcpportal",
  });
  // Durable Object history, build command and rules arrive as upstream ships them.
  assert.ok(base.migrations!.length > 0);
  assert.deepEqual(github.migrations, base.migrations);
  assert.deepEqual(github.build, base.build);
  assert.deepEqual(github.rules, base.rules);
  assert.equal(github.observability!.head_sampling_rate, 0.5);
  // No secrets block: a first deploy has none yet, and wrangler would refuse it.
  assert.equal(github.secrets, undefined);
  // The catalog's copy is untouched.
  assert.equal(base.vars, undefined);

  // The router forwards whole requests, so no entrypoint; the Workshop calls it over vendor RPC.
  assert.deepEqual(generated.router.services!.filter((service) => /GITHUB|MCPPORTAL/.test(service.binding)), [
    { binding: "GATEKEEPER_GITHUB", service: "acme-cloudflare-os-github" },
    { binding: "GATEKEEPER_MCPPORTAL", service: "acme-cloudflare-os-mcpportal" },
  ]);
  assert.deepEqual(generated.workshop.services!.filter((service) => /GITHUB|MCPPORTAL/.test(service.binding)), [
    { binding: "GATEKEEPER_GITHUB", service: "acme-cloudflare-os-github", entrypoint: "GatekeeperVendor" },
    { binding: "GATEKEEPER_MCPPORTAL", service: "acme-cloudflare-os-mcpportal", entrypoint: "GatekeeperVendor" },
  ]);

  // On a workers.dev route, BASE_URL follows the public origin there.
  const onWorkersDev = generateConfigs(variant((c) => {
    Object.assign(c, structuredClone(withOptional));
    c.workers.router.route = { workersDev: true };
    c.publicBaseUrl = "https://acme-cloudflare-os.acme.workers.dev";
  }), await baseConfigs(), catalog);
  assert.equal(onWorkersDev.gatekeepers.github.vars!.BASE_URL,
    "https://acme-cloudflare-os.acme.workers.dev/gatekeeper/github");
  // None selected, none generated.
  assert.deepEqual(generateConfigs(validConfig, await baseConfigs(), catalog).gatekeepers, {});
});

test("routes an optional Gatekeeper's own Workers AI binding through the Workshop's gateway", async () => {
  const google = variant((c) => { c.gatekeepers = { google: { name: "acme-cloudflare-os-google" } }; });
  const withGoogle = testCatalogWithGoogle();
  const bases = await baseConfigs();

  // Upstream's binding carries over, and conversion goes through the gateway the AI binding reaches.
  const generated = generateConfigs(google, bases, withGoogle).gatekeepers.google;
  assert.equal(generated.ai!.binding, "AI");
  assert.equal(generated.vars!.CF_AI_GATEWAY, "cloudflare-os");
  // With the catalog off, or a gateway in another account, through none.
  const off = variant((c) => { Object.assign(c, structuredClone(google)); c.aiGateway.enabled = false; });
  assert.equal(generateConfigs(off, bases, withGoogle).gatekeepers.google.vars!.CF_AI_GATEWAY, undefined);
  const elsewhere = variant((c) => {
    Object.assign(c, structuredClone(google));
    c.aiGateway.accountId = "fedcba9876543210fedcba9876543210";
  });
  assert.equal(generateConfigs(elsewhere, bases, withGoogle).gatekeepers.google.vars!.CF_AI_GATEWAY, undefined);
  // The operator's vars win.
  const own = variant((c) => { c.gatekeepers = { google: { name: "acme-cloudflare-os-google", vars: { CF_AI_GATEWAY: "drive" } } }; });
  assert.equal(generateConfigs(own, bases, withGoogle).gatekeepers.google.vars!.CF_AI_GATEWAY, "drive");
  // A Gatekeeper without the binding gets no gateway.
  assert.equal(generateConfigs(withOptional, bases, catalog).gatekeepers.github.vars!.CF_AI_GATEWAY, undefined);
});

test("builds each optional Gatekeeper by its package name, uncached", () => {
  const chains = buildCommands(withOptional, catalog).map((chain) => chain.map(({ args }) => args.join(" ")));
  assert.ok(chains.some((chain) => chain.length === 1 &&
    chain[0] === "--dir cloudflare-os exec vp run -F @gadgets/github-gatekeeper --no-cache build"), chains.join("\n"));
  assert.ok(chains.some((chain) => chain.length === 1 &&
    chain[0] === "--dir cloudflare-os exec vp run -F @gadgets/mcp-portal-gatekeeper --no-cache build"), chains.join("\n"));
});

/** {@link validConfig} with `gatekeepers` set to `gatekeepers`, whatever its shape. */
function withGatekeepers(gatekeepers: unknown): DeploymentConfig {
  return variant((c) => { c.gatekeepers = gatekeepers; });
}

/** Asserts `validateConfig` refuses `gatekeepers` with `message`. */
function rejects(gatekeepers: unknown, message: RegExp): void {
  assert.throws(() => validateConfig(withGatekeepers(gatekeepers)), message);
}

test("rejects a malformed gatekeepers block", () => {

  rejects([], /gatekeepers must be an object/);
  rejects({ GitHub: { name: "acme-gk-github" } }, /gatekeepers.GitHub: a Gatekeeper slug is/);
  rejects({ "mcp-portal": { name: "acme-gk-mcp-portal" } }, /gatekeepers.mcp-portal: a Gatekeeper slug is/);
  rejects({ "1password": { name: "acme-gk-1password" } }, /a Gatekeeper slug is/);
  rejects({ ["a".repeat(21)]: { name: "acme-gk-long" } }, /a Gatekeeper slug is 1-20/);
  rejects({ scheduler: { name: "acme-gk-scheduler2" } }, /gatekeepers.scheduler: scheduler is one of the Gatekeepers the starter deploys/);
  rejects({ custom: { name: "acme-gk-custom2" } }, /gatekeepers.custom: custom is one of/);
  rejects({ github: "acme-gk-github" }, /gatekeepers.github must be an object/);
  rejects({ github: { name: 42 } }, /gatekeepers.github.name must be a Worker name/);
  rejects({ github: {} }, /gatekeepers.github.name must be a Worker name/);
  rejects({ github: { name: "acme-gk-github", secrets: {} } }, /only name and vars are allowed, not secrets/);
  rejects({ github: { name: "acme-gk-github", vars: [] } }, /gatekeepers.github.vars must be an object/);
  rejects({ github: { name: "acme-gk-github", vars: { GITHUB_ORG: 1 } } }, /gatekeepers.github.vars.GITHUB_ORG must be a string/);
  rejects({ github: { name: "acme-gk-github", vars: { BASE_URL: "https://elsewhere.example.com" } } },
    /gatekeepers.github.vars.BASE_URL: the deploy sets it/);
  rejects({ github: { name: "Acme GitHub" } }, /Worker names must use lowercase/);
  // Names are unique across workers and gatekeepers alike.
  rejects({ github: { name: validConfig.workers.workshop.name } },
    /names must be unique: acme-cloudflare-os-backend is used twice/);
  rejects({ github: { name: "acme-gk-shared" }, mcpportal: { name: "acme-gk-shared" } },
    /names must be unique: acme-gk-shared is used twice/);
  // A placeholder is an unconfigured file, as anywhere else.
  assert.throws(() => validateConfig(withGatekeepers({ github: { name: "<GITHUB_WORKER_NAME>" } })), PlaceholderError);

  assert.doesNotThrow(() => validateConfig(withGatekeepers({})));
  assert.doesNotThrow(() => validateConfig(withOptional));
});

test("rejects a Gatekeeper the catalog does not offer, or vars it would not take", () => {
  const refuses = (gatekeepers: Record<string, unknown>, message: RegExp, against = catalog) =>
    assert.throws(() => validateGatekeepers(variant((c) => { c.gatekeepers = gatekeepers; }), against), message);

  refuses({ email: { name: "acme-gk-email" } },
    /gatekeepers.email: the starter cannot deploy gatekeeper-email: upstream marks it not installable\./);
  refuses({ jira: { name: "acme-gk-jira" } },
    /gatekeepers.jira: upstream has no such Gatekeeper. Available: github, homeassistant, mcpportal\./);
  refuses({ github: { name: "acme-gk-github", vars: { CLIENT_SECRET: "s3cret" } } },
    /gatekeepers.github.vars.CLIENT_SECRET is a secret.*`CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef pnpm exec wrangler secret put CLIENT_SECRET --name acme-gk-github`/);
  refuses({ github: { name: "acme-gk-github" } },
    /the Gatekeeper catalog could not be read, so none can be deployed: no submodule/,
    { offered: [], excluded: [], unavailable: "no submodule" });

  // A required var input has to be there.
  const requiring = structuredClone(catalog);
  requiring.offered.find((gatekeeper) => gatekeeper.slug === "mcpportal")!.vars =
    [{ name: "MCP_PORTAL_URL", kind: "var", label: "Portal URL" }];
  refuses({ mcpportal: { name: "acme-gk-mcpportal" } },
    /Missing required deployment value: gatekeepers.mcpportal.vars.MCP_PORTAL_URL \(Portal URL\)/, requiring);
  assert.doesNotThrow(() => validateGatekeepers(withOptional, requiring));

  // generateConfigs checks the same, rather than generating something the catalog cannot build.
  return baseConfigs().then((bases) => assert.throws(
    () => generateConfigs(variant((c) => { c.gatekeepers = { email: { name: "acme-gk-email" } }; }), bases, catalog),
    /cannot deploy gatekeeper-email/));
});

test("needs no catalog when no optional Gatekeeper is selected", () => {
  const unavailable = { offered: [], excluded: [], unavailable: "no submodule" };
  assert.doesNotThrow(() => validateGatekeepers(validConfig, unavailable));
  assert.doesNotThrow(() => validateGatekeepers(variant((c) => { c.gatekeepers = {}; }), unavailable));
});

/** A push identity as a take-over writes one into the file. */
const pushIdentity = {
  serviceUrl: "https://push.example.com",
  installId: "install-acme",
  keyId: "key-1",
  webPushPublicKey: "BFixtureWebPushPublicKey",
};

/** {@link validConfig} with `pushIdentity` set to `block`, whatever it is. */
function withPush(block: unknown): DeploymentConfig {
  return variant((c) => { c.pushIdentity = block; });
}

test("sends the push identity on the Workshop, under the names the pinned backend reads", async () => {
  const bases = await baseConfigs();
  const generated = generateConfigs(withPush(pushIdentity), bases, catalog);
  const sent = {
    NOTIFICATION_SERVICE_URL: "https://push.example.com",
    CFOS_INSTALL_ID: "install-acme",
    CFOS_INSTALL_KEY_ID: "key-1",
    NOTIFICATION_WEB_PUSH_PUBLIC_KEY: "BFixtureWebPushPublicKey",
  };
  assert.deepEqual(pushIdentityVars(pushIdentity), sent);
  for (const [name, value] of Object.entries(sent)) assert.equal(generated.workshop.vars?.[name], value, name);
  // The variables and nothing else: every other key of every config is what it is without the block.
  const without = generateConfigs(validConfig, bases, catalog);
  const vars = { ...generated.workshop.vars };
  for (const name of Object.keys(sent)) delete vars[name];
  assert.deepEqual({ ...generated, workshop: { ...generated.workshop, vars } }, without);
  // On the Workshop alone: no other Worker reads them.
  for (const [id, config] of generatedOutputs(generated)) {
    if (id === "workshop") continue;
    assert.doesNotMatch(JSON.stringify(config), /NOTIFICATION_|CFOS_INSTALL/, id);
  }
  // The names are the ones the pinned backend declares, and the notification client reads.
  const declared = await readFile(join(PACKAGE_DIRS.workshop, "src", "env.d.ts"), "utf8");
  for (const name of [...Object.values(PUSH_IDENTITY_VARS), PUSH_IDENTITY_SECRET]) {
    assert.match(declared, new RegExp(`^\\s*${name}\\?: string;`, "m"), `${name} is not in the pinned backend's env.d.ts`);
  }
  assert.deepEqual(Object.values(PUSH_IDENTITY_VARS).toSorted(), Object.keys(sent).toSorted());
});

test("sends no browser-push key when the identity has none", async () => {
  for (const webPushPublicKey of [null, undefined]) {
    const generated = generateConfigs(withPush({ ...pushIdentity, webPushPublicKey }), await baseConfigs(), catalog);
    const vars = generated.workshop.vars ?? {};
    assert.equal(vars.NOTIFICATION_SERVICE_URL, "https://push.example.com");
    assert.equal(vars.CFOS_INSTALL_ID, "install-acme");
    assert.equal(vars.CFOS_INSTALL_KEY_ID, "key-1");
    assert.equal(Object.hasOwn(vars, "NOTIFICATION_WEB_PUSH_PUBLIC_KEY"), false);
  }
});

test("never names the push identity's signing key in a generated config, with the identity or without", async () => {
  const bases = await baseConfigs();
  const optional = variant((c) => {
    c.pushIdentity = pushIdentity;
    c.gatekeepers = { github: { name: "acme-cloudflare-os-github" } };
    // The one configuration that declares a secret at all, so the declaration is seen not to grow.
    c.aiGateway.providers = ["google"];
  });
  for (const config of [validConfig, withPush(null), withPush(pushIdentity), optional]) {
    const generated = generateConfigs(config, bases, catalog);
    // Not a variable, not a declared secret, not any other binding: a deploy that does not name a
    // secret leaves it bound, and one that named it as a variable would put the variable in its place.
    assert.doesNotMatch(JSON.stringify(generatedOutputs(generated)), /CFOS_INSTALL_PRIVATE_KEY|PRIVATE_KEY/i);
  }
  assert.deepEqual(generateConfigs(optional, bases, catalog).workshop.secrets, { required: ["CF_AI_GATEWAY_API_TOKEN"] });
  assert.equal(PUSH_IDENTITY_SECRET, "CFOS_INSTALL_PRIVATE_KEY");
});

test("without a push identity, generates what it generates for a file that never had the key", async () => {
  const bases = await baseConfigs();
  const never = generateConfigs(validConfig, bases, catalog);
  assert.equal(Object.hasOwn(validConfig, "pushIdentity"), false);
  assert.deepEqual(generateConfigs(withPush(null), bases, catalog), never);
  assert.deepEqual(Object.keys(never.workshop.vars ?? {}).toSorted(), [
    "ADMINS",
    "CF_ACCESS_AUD",
    "CF_ACCESS_ISS",
    "CF_AI_GATEWAY",
    "CF_AI_GATEWAY_ACCOUNT_ID",
    "CF_AI_GATEWAY_PROVIDERS",
    "PUBLIC_BASE_URL",
  ]);
  assert.doesNotMatch(JSON.stringify(generatedOutputs(never)), /NOTIFICATION_|CFOS_INSTALL/);
});

test("accepts a push identity as a take-over writes it, and none at all", () => {
  for (const block of [
    undefined,
    null,
    pushIdentity,
    { ...pushIdentity, webPushPublicKey: null },
    { serviceUrl: pushIdentity.serviceUrl, installId: pushIdentity.installId, keyId: pushIdentity.keyId },
    // Taken as the hosted flow set it: the backend reads the scheme and host, and ignores the rest.
    { ...pushIdentity, serviceUrl: "https://push.example.com/" },
  ]) {
    assert.doesNotThrow(() => validatePushIdentity(block), JSON.stringify(block));
    assert.doesNotThrow(() => validateConfig(withPush(block)), JSON.stringify(block));
  }
});

/** Asserts `validateConfig` refuses `pushIdentity` block `block` with `message`. */
function rejectsPush(block: unknown, message: RegExp): void {
  assert.throws(() => validateConfig(withPush(block)), message, JSON.stringify(block));
}

test("rejects a malformed push identity, naming the path", () => {
  for (const block of ["install-acme", 1, true, [pushIdentity], []]) {
    rejectsPush(block, /^Error: pushIdentity must be null or an object with serviceUrl, installId, keyId and webPushPublicKey\.$/);
  }
  // A service address the backend would refuse to send to, or cannot read.
  for (const serviceUrl of ["http://push.example.com", "push.example.com", "", " https://push.example.com", undefined, null, 7]) {
    rejectsPush({ ...pushIdentity, serviceUrl }, /^Error: pushIdentity\.serviceUrl must be the notification service's address, an https: URL .* It becomes NOTIFICATION_SERVICE_URL/);
  }
  // Whitespace anywhere in it, which the block's other values may not have either: the variable is sent as written.
  for (const serviceUrl of ["https://push.example.com/a b", "https://push.example.com/\nX", "https://push.example.com\t", "https://push.example.com "]) {
    rejectsPush({ ...pushIdentity, serviceUrl }, /^Error: pushIdentity\.serviceUrl must be the notification service's address, an https: URL without whitespace such as https:\/\/push\.example\.com\. It becomes NOTIFICATION_SERVICE_URL/);
  }
  // All or nothing: the backend sends no push without every one of the three.
  for (const value of [undefined, null, "", "key 1", "key-1\n", 7]) {
    rejectsPush({ ...pushIdentity, installId: value }, /^Error: pushIdentity\.installId must be a non-empty string without whitespace\. It becomes CFOS_INSTALL_ID; .* set pushIdentity to null/);
    rejectsPush({ ...pushIdentity, keyId: value }, /^Error: pushIdentity\.keyId must be a non-empty string without whitespace\. It becomes CFOS_INSTALL_KEY_ID; /);
  }
  for (const webPushPublicKey of ["", "B Fixture", 7, false, {}]) {
    rejectsPush({ ...pushIdentity, webPushPublicKey }, /^Error: pushIdentity\.webPushPublicKey must be null or a non-empty string without whitespace\. .* becomes NOTIFICATION_WEB_PUSH_PUBLIC_KEY\.$/);
  }
  // Still the template's: an unconfigured file, not a wrong one.
  assert.throws(() => validateConfig(withPush({ ...pushIdentity, installId: "<INSTALL_ID>" })), PlaceholderError);
});

test("refuses the signing key in the file, without repeating it", () => {
  const key = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg-not-a-real-key";
  for (const name of ["privateKey", "CFOS_INSTALL_PRIVATE_KEY", "secret", "extra"]) {
    assert.throws(() => validateConfig(withPush({ ...pushIdentity, [name]: key })), (error: Error) => {
      assert.equal(error.message,
        `pushIdentity: only serviceUrl, installId, keyId and webPushPublicKey are allowed, not ${name}. The key that ` +
        "signs with the identity is never in this file: it stays the secret CFOS_INSTALL_PRIVATE_KEY on the Workshop " +
        "Worker, where a deploy leaves it.");
      assert.ok(!error.message.includes(key));
      return true;
    });
  }
});
