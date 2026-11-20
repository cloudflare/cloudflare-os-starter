// The two shapes a deploy sits between: `deployment.jsonc` on the way in, and the
// `wrangler.prod.jsonc` files `generateConfigs` (deployment.ts) produces on the way out. The one
// module typing the deployment file, so a later move to another config format is a translation.
// `validateConfig` (deployment.ts) checks the file against these types; the `pushIdentity` block's
// own check, `validatePushIdentity`, is here beside its type.
//
// The wrangler side reuses the submodule's own declarations rather than redeclaring them, so a
// base-config change upstream surfaces here as a type error during the `cf-os` type-check instead of
// as a silently dropped key at deploy time. The imports from the submodule are type-only, which
// under `verbatimModuleSyntax` erase completely -- `node` never resolves them, so the submodule's
// runtime dependencies are not this module's problem.

import type {
  BindingDecl,
  ObservabilityConfig,
  WranglerConfig,
} from "@gadgets/scripts/release/manifest-lib";
import { PUSH_IDENTITY_SECRET, PUSH_IDENTITY_VARS, type PushIdentity } from "./hosted-release.ts";

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
 * throws `validateConfig` mirrors.
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
    /**
     * The Web Search Gatekeeper. Ambient, like Context and Scheduler, and preinstalled by the hosted
     * flow. Searches through `aiGateway`'s gateway; through the account's `default` one when that is
     * disabled or in another account.
     */
    websearch: { name: string };
    /** Only required when `customGatekeeper.enabled` is not false. */
    customGatekeeper?: { name: string };
    /** Only required when `errorReporting.enabled`. */
    errorReporter?: { name: string };
    /**
     * Upstream's PDF renderer, deployed only when a selected optional Gatekeeper binds it (Google,
     * to transcribe scanned PDFs). It has no route and no storage. Absent, it is named
     * `<router name>-pdf-renderer`, as the hosted deploy names an instance's.
     */
    pdfRenderer?: { name: string };
  };
  /**
   * Optional upstream Gatekeepers, keyed by the hosted deploy's install slug (`github`,
   * `mcpportal`). Absent means none. Each one is offered by the catalog `gatekeeper-catalog.ts`
   * reads from the submodule, and `validateGatekeepers` checks the entries against it.
   */
  gatekeepers?: Record<string, GatekeeperEntry>;
  access: AccessConfig;
  aiGateway: AiGatewayConfigInput;
  context: ContextConfig;
  /**
   * The example custom Gatekeeper: whether it is deployed (absent means it is), and the display
   * text it serves to agents, which only matters when it is.
   */
  customGatekeeper: { enabled?: boolean; name: string; message: string };
  /** Private explicit-issue destination. */
  errorReporting: { enabled: boolean; environment?: string; release?: string | null };
  /** Workshop KV/R2. `null` requests Wrangler automatic provisioning. */
  resources: {
    blueprintsKvNamespaceId: string | null;
    avatarsKvNamespaceId: string | null;
    blueprintContentBucket: string | null;
  };
  observability: DeploymentObservabilityConfig;
  /**
   * The push identity a take-over carried over from a hosted instance: who this installation is to
   * the notification service ({@link validatePushIdentity}). Absent or `null` on a deployment that
   * has none, which sends no push notifications and deploys no variable for one.
   */
  pushIdentity?: PushIdentity | null;
}

/** The fields of `deployment.jsonc`'s `pushIdentity` block, in the order `cf-os import` writes them. */
const PUSH_IDENTITY_FIELDS = ["serviceUrl", "installId", "keyId", "webPushPublicKey"] as const satisfies readonly (keyof PushIdentity)[];

/** A value of the block, each sent as a variable and some as an HTTP header: something, with no whitespace anywhere in it. */
const PUSH_IDENTITY_TOKEN = /^\S+$/;

/**
 * Checks `deployment.jsonc`'s `pushIdentity` block, throwing the first problem with the config path
 * it concerns. Absent or `null` is a deployment without one, and passes.
 *
 * The block is all or nothing, as the backend reads it: without the service's origin, the install ID
 * and the key ID together it sends no push at all, so a block missing one is a mistake and not a
 * smaller identity. `webPushPublicKey` alone may be `null` (or absent), which offers no browser push.
 * The service's address must be an `https:` URL, since the backend refuses to send a signed request
 * to any other, with no whitespace anywhere in it, like the block's other values; it is otherwise
 * taken as written, so the variable a deploy sends is the one the hosted flow set.
 *
 * The key that signs with the identity has no field here, and a key added for it is refused: the
 * file is committed, and the key is the secret {@link PUSH_IDENTITY_SECRET} on the Workshop Worker,
 * which a deploy neither reads nor sends.
 */
export function validatePushIdentity(block: unknown): void {
  if (block === undefined || block === null) return;
  if (typeof block !== "object" || Array.isArray(block)) {
    throw new Error("pushIdentity must be null or an object with serviceUrl, installId, keyId and webPushPublicKey.");
  }
  const fields = new Map<string, unknown>(Object.entries(block));
  const allowed: readonly string[] = PUSH_IDENTITY_FIELDS;
  const unknown = [...fields.keys()].filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new Error(
      `pushIdentity: only ${allowed.slice(0, -1).join(", ")} and ${allowed.at(-1)} are allowed, not ${unknown.join(", ")}. ` +
      `The key that signs with the identity is never in this file: it stays the secret ${PUSH_IDENTITY_SECRET} on the ` +
      "Workshop Worker, where a deploy leaves it.");
  }
  const serviceUrl = fields.get("serviceUrl");
  let service: URL | undefined;
  try {
    service = typeof serviceUrl === "string" && PUSH_IDENTITY_TOKEN.test(serviceUrl) ? new URL(serviceUrl) : undefined;
  } catch {
    service = undefined;
  }
  if (service?.protocol !== "https:") {
    throw new Error(
      "pushIdentity.serviceUrl must be the notification service's address, an https: URL without whitespace such as " +
      `https://push.example.com. It becomes ${PUSH_IDENTITY_VARS.serviceUrl}, and the Workshop sends its signed ` +
      "requests to no other kind of address.");
  }
  for (const field of ["installId", "keyId"] as const) {
    const value = fields.get(field);
    if (typeof value !== "string" || !PUSH_IDENTITY_TOKEN.test(value)) {
      throw new Error(
        `pushIdentity.${field} must be a non-empty string without whitespace. It becomes ${PUSH_IDENTITY_VARS[field]}; ` +
        "without it the Workshop sends no push at all, so set pushIdentity to null to deploy without one.");
    }
  }
  const webPushPublicKey = fields.get("webPushPublicKey");
  if (webPushPublicKey !== undefined && webPushPublicKey !== null &&
      (typeof webPushPublicKey !== "string" || !PUSH_IDENTITY_TOKEN.test(webPushPublicKey))) {
    throw new Error(
      "pushIdentity.webPushPublicKey must be null or a non-empty string without whitespace. null offers no " +
      `browser push; a string becomes ${PUSH_IDENTITY_VARS.webPushPublicKey}.`);
  }
}

/** One optional Gatekeeper in `deployment.jsonc`'s `gatekeepers` block. */
export interface GatekeeperEntry {
  /** Its Worker name. A permanent service identity, like every name in `workers`. */
  name: string;
  /**
   * Plain-text vars merged over its base config's. Never `BASE_URL`, which the deploy sets, and
   * never a secret: those go to the Worker with `wrangler secret put`.
   */
  vars?: Record<string, string>;
}

/**
 * `ObservabilityConfig` plus the traces block. Upstream's type does not declare it, though the
 * backend's own `wrangler.jsonc` sets it and `generateConfigs` writes it for every Worker.
 */
export interface ProdObservabilityConfig extends ObservabilityConfig {
  traces?: { enabled?: boolean; head_sampling_rate?: number };
}

/**
 * A generated `wrangler.prod.jsonc`: the subset of wrangler config upstream's `WranglerConfig`
 * declares, plus the keys `generateConfigs` writes that it does not.
 *
 * Four keys are replaced rather than added to. Upstream's observability type is deliberately closed
 * and has no `traces`; its `artifacts` is a single `BindingDecl`, while wrangler takes an array and
 * the Context Gatekeeper's entry carries a `namespace`; and its KV/R2 bindings are bare
 * `BindingDecl`s, because the release manifest replaces every id with a placeholder while a
 * generated config either names the resource or leaves it for automatic provisioning.
 *
 * `assets` and `ai` are *not* redeclared -- upstream's are already the shapes written here.
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
  websearch: ProdWranglerConfig;
  /** Absent when `customGatekeeper.enabled` is false. */
  customGatekeeper?: ProdWranglerConfig;
  /** Absent when `errorReporting.enabled` is false. */
  errorReporter?: ProdWranglerConfig;
  /** Present only when a selected optional Gatekeeper binds the PDF renderer. */
  pdfRenderer?: ProdWranglerConfig;
  /** One per `gatekeepers` entry, by slug. */
  gatekeepers: Record<string, ProdWranglerConfig>;
}

/** The upstream base configs the generated ones are derived from. */
export interface BaseConfigs {
  router: ProdWranglerConfig;
  workshop: ProdWranglerConfig;
  context: ProdWranglerConfig;
  scheduler: ProdWranglerConfig;
  websearch: ProdWranglerConfig;
  customGatekeeper: ProdWranglerConfig;
  errorReporter: ProdWranglerConfig;
  /**
   * Present only when a selected optional Gatekeeper binds the PDF renderer: a pin from before
   * upstream had the package has none to read.
   */
  pdfRenderer?: ProdWranglerConfig;
}

/** One build step a check or deploy runs before deploying. See `buildCommands`. */
export interface BuildCommand {
  /** Arguments passed to `pnpm`, from the repository root. */
  args: string[];
  /**
   * Variables set on top of the ambient environment for this step alone. Explicit rather than
   * inherited: a build-time flag that arrives by inheritance is one a cached `vp` run would strip.
   */
  env?: Record<string, string>;
}
