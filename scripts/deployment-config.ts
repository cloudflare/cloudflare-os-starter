// The two shapes `deploy.ts` sits between: `deployment.jsonc` on the way in, and the
// `wrangler.prod.jsonc` files it generates on the way out.
//
// The wrangler side reuses the submodule's own declarations rather than redeclaring them, so a
// base-config change upstream surfaces here as a type error during `pnpm types:scripts` instead of
// as a silently dropped key at deploy time. The imports are type-only, which under
// `verbatimModuleSyntax` erase completely -- `node` never resolves them, so the submodule's
// runtime dependencies are not this script's problem.

import type {
  BindingDecl,
  ObservabilityConfig,
  WranglerConfig,
} from "../cloudflare-os/scripts/release/manifest-lib.ts";

/** A model provider the Workshop can serve through AI Gateway with deployment-managed keys. */
export type AiGatewayProvider = "anthropic" | "openai" | "google" | "cloudflare";

/** Every provider {@link AiGatewayProvider} allows, for validation and for error messages. */
export const AI_GATEWAY_PROVIDERS: readonly AiGatewayProvider[] =
  ["anthropic", "openai", "google", "cloudflare"];

/**
 * The public address of the router Worker. Exactly one field is set; `validateConfig` enforces
 * that, since wrangler would otherwise happily deploy both a custom domain and a workers.dev route.
 */
export interface RouterRoute {
  /** Evaluation route on the account's workers.dev subdomain. */
  workersDev?: boolean;
  /** Production hostname in an active Cloudflare zone. Wrangler creates DNS and TLS for it. */
  customDomain?: string;
}

/** Cloudflare Access trust boundary and the `/admin` allowlist. */
export interface AccessConfig {
  /** Access team origin, HTTPS with no path. */
  issuer: string;
  /** The self-hosted Access application's AUD tag. */
  audience: string;
  /** Access-verified emails allowed into `/admin`. */
  admins: string[];
}

/**
 * Deployment-managed model catalog, served through Cloudflare AI Gateway.
 *
 * Transport is derived rather than configured: the Workshop reaches the gateway over its
 * `WORKERS_AI` binding, which is pre-authenticated inside the Worker's own account. Only a gateway
 * in a *different* account, or the `google` provider, needs `CF_AI_GATEWAY_API_TOKEN` -- see
 * `AiGatewayConfig` in cloudflare-os/packages/workshop-backend/src/ai-gateway.ts, whose constructor
 * throws this script mirrors.
 */
export interface AiGatewayConfigInput {
  /** Whether the Workshop advertises a deployment-managed catalog at all. */
  enabled: boolean;
  /** Gateway name. `"default"` is the one Cloudflare creates for an account on first use. */
  name?: string;
  /** Account owning the gateway. `null` reuses the deployment's own `accountId`. */
  accountId?: string | null;
  /** Providers to advertise. Must be non-empty when enabled. */
  providers?: AiGatewayProvider[];
  /**
   * No longer configurable: Workers AI rides the same gateway route as every other provider.
   * Declared only so `validateConfig` can reject a leftover key loudly -- silently ignoring one
   * produces a deploy that succeeds with an empty model picker.
   */
  workersAi?: never;
}

/** Context Gatekeeper storage and the sharing boundary its data is scoped to. */
export interface ContextConfig {
  /**
   * Stable label isolating Context data belonging to this deployment. `null` scopes it to the
   * deployment's public origin, which is what the hosted deploy does.
   */
  sharingDomain: string | null;
  /** Existing snapshot KV namespace, or `null` for Wrangler automatic provisioning. */
  kvNamespaceId: string | null;
  /** Optional Git-compatible collection storage. Absent or `{}` means disabled. */
  artifacts?: { enabled?: boolean; namespace?: string };
}

/** Worker telemetry. Maps onto wrangler's `observability` block. */
export interface DeploymentObservabilityConfig {
  enabled: boolean;
  headSamplingRate: number;
  logs: { invocationLogs: boolean };
  traces: { enabled: boolean; headSamplingRate: number };
}

/**
 * `deployment.jsonc`, parsed.
 *
 * This describes the *valid* shape. The file is hand-edited JSONC with no schema behind it, so
 * every field is still checked at runtime by `validateConfig` -- the type is what makes the
 * generation code readable, not a guarantee about what is on disk.
 */
export interface DeploymentConfig {
  /** Cloudflare account owning every Worker and provisioned resource. 32 hex characters. */
  accountId: string;
  /**
   * The deployment's public origin: HTTPS, no path, no trailing slash. `null` derives it from
   * `workers.router.route.customDomain`, and is invalid on a workers.dev route -- the account's
   * workers.dev subdomain is not in this file and wrangler exposes no way to look it up.
   */
  publicBaseUrl: string | null;
  /** Permanent Worker service identities. Each must be unique within the account. */
  workers: {
    /** Owns the public route, serves the frontend, and proxies to every other Worker. */
    router: { name: string; route: RouterRoute };
    workshop: { name: string };
    context: { name: string };
    scheduler: { name: string };
    customGatekeeper: { name: string };
    /** Required only when `googleSheetsGuard.enabled`. */
    googleSheetsGuard?: { name: string };
    /** Only required when `errorReporting.enabled`. */
    errorReporter?: { name: string };
  };
  access: AccessConfig;
  aiGateway: AiGatewayConfigInput;
  context: ContextConfig;
  /** Display text the example custom Gatekeeper serves to agents. */
  customGatekeeper: { name: string; message: string };
  /** P3 exact-resource Google Sheets facade. Secrets hold the resource ID and fixed range. */
  googleSheetsGuard?: { enabled: boolean };
  /** Private explicit-issue destination. */
  errorReporting: { enabled: boolean; environment?: string; release?: string | null };
  /** Workshop KV/R2. `null` requests Wrangler automatic provisioning. */
  resources: {
    blueprintsKvNamespaceId: string | null;
    avatarsKvNamespaceId: string | null;
    blueprintContentBucket: string | null;
  };
  observability: DeploymentObservabilityConfig;
}

/**
 * `ObservabilityConfig` plus the traces block. Upstream's type does not declare it, though the
 * backend's own `wrangler.jsonc` sets it and this script writes it for every Worker.
 */
export interface ProdObservabilityConfig extends ObservabilityConfig {
  traces?: { enabled?: boolean; head_sampling_rate?: number };
}

/**
 * A generated `wrangler.prod.jsonc`: the subset of wrangler config upstream's `WranglerConfig`
 * declares, plus the keys this script writes that it does not.
 *
 * Four keys are replaced rather than added to. Upstream's observability type is deliberately closed
 * and has no `traces`; its `artifacts` is a single `BindingDecl`, while wrangler takes an array and
 * the Context Gatekeeper's entry carries a `namespace`; and its KV/R2 bindings are bare
 * `BindingDecl`s, because the release manifest replaces every id with a placeholder while a
 * generated config either names the resource or leaves it for automatic provisioning.
 *
 * `assets` is *not* redeclared -- upstream's is already the shape written here.
 */
export type ProdWranglerConfig =
  Omit<WranglerConfig, "observability" | "artifacts" | "kv_namespaces" | "r2_buckets">
  & {
    /** KV bindings. `id` absent requests Wrangler automatic provisioning. */
    kv_namespaces?: (BindingDecl & { id?: string })[];
    /** R2 bindings. `bucket_name` absent requests Wrangler automatic provisioning. */
    r2_buckets?: (BindingDecl & { bucket_name?: string })[];
    /** The deployment's account, pinned so a stray `CLOUDFLARE_ACCOUNT_ID` cannot redirect it. */
    account_id?: string;
    /** Whether the Worker answers on the account's workers.dev subdomain. */
    workers_dev?: boolean;
    /** Custom-domain routes. Wrangler creates DNS and TLS for each. */
    routes?: { pattern: string; custom_domain: boolean }[];
    /** Turned off on every Worker: a preview URL is an unauthenticated path around Access. */
    preview_urls?: boolean;
    observability?: ProdObservabilityConfig;
    /** Workers AI. Both the AI Gateway transport and what webFetch's `toMarkdown()` runs on. */
    ai?: BindingDecl;
    /** Secrets wrangler refuses to deploy without. Emitted only when one is genuinely needed. */
    secrets?: { required: string[] };
    /** Artifacts namespaces. An array, unlike upstream's single-binding declaration. */
    artifacts?: { binding: string; namespace: string }[];
  };

/** The generated configs, keyed as `deployment.jsonc` keys them. */
export interface GeneratedConfigs {
  router: ProdWranglerConfig;
  workshop: ProdWranglerConfig;
  context: ProdWranglerConfig;
  scheduler: ProdWranglerConfig;
  customGatekeeper: ProdWranglerConfig;
  /** Absent when `googleSheetsGuard.enabled` is false or omitted. */
  googleSheetsGuard?: ProdWranglerConfig;
  /** Absent when `errorReporting.enabled` is false. */
  errorReporter?: ProdWranglerConfig;
}

/** The upstream base configs the generated ones are derived from. */
export interface BaseConfigs {
  router: ProdWranglerConfig;
  workshop: ProdWranglerConfig;
  context: ProdWranglerConfig;
  scheduler: ProdWranglerConfig;
  customGatekeeper: ProdWranglerConfig;
  googleSheetsGuard: ProdWranglerConfig;
  errorReporter: ProdWranglerConfig;
}

/** One build step `deploy.ts` runs before deploying. See `buildCommands`. */
export interface BuildCommand {
  /** Arguments passed to `pnpm`, from the repository root. */
  args: string[];
  /**
   * Variables set on top of the ambient environment for this step alone. Explicit rather than
   * inherited: a build-time flag that arrives by inheritance is one a cached `vp` run would strip.
   */
  env?: Record<string, string>;
}
