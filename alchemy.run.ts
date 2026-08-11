// Deploy your customized Cloudflare OS instance with alchemy:
//
//   pnpm alchemy deploy
//
// This file replaces `deployment.jsonc` + `scripts/deploy.mjs`: the
// configuration is typed code, the resources (KV, R2, AI Gateway, tokens,
// stored provider keys) are provisioned — not referenced — and every worker,
// binding, and build is declared by the `OperatingSystem` resource from the
// pinned cloudflare-os release (the `cloudflare-os` package in the
// submodule's workspace).
//
// ── Your deployment controls ──────────────────────────────────────────────
// Replace the placeholders below, then `pnpm alchemy deploy`. Secrets come
// from the environment (a `.env` works too), never from tracked files.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Gatekeeper, OperatingSystem } from "cloudflare-os";
import { Context } from "cloudflare-os/gatekeepers";

/** Hostname in an active Cloudflare zone. `undefined` → workers.dev route. */
const DOMAIN: string | undefined = "os.example.com";

/** The self-hosted Access application protecting {@link DOMAIN}. */
const ACCESS = {
  issuer: "https://<TEAM_NAME>.cloudflareaccess.com",
  audience: "<ACCESS_AUDIENCE>",
};

/** Email addresses granted the admin role (gates `/admin`). */
const ADMINS = ["<ADMIN_EMAIL>"];

export default Alchemy.Stack(
  "MyCompanyOS",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    // Private Worker receiving explicit backend error reports; it has no
    // public route and emits structured console errors for observability.
    const errorReporter = yield* Cloudflare.Worker("ErrorReporter", {
      main: "./packages/error-reporter/src/index.ts",
      compatibility: { date: "2026-08-04" },
      workersDev: false,
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: false },
      },
    });

    const os = yield* OperatingSystem("OS", {
      domain: DOMAIN,
      admins: ADMINS,
      auth: {
        // Cloudflare Access mode: identity is verified before a request
        // reaches the Worker. See docs/customization.md#sign-in-methods.
        access: { aud: ACCESS.audience, iss: ACCESS.issuer },
      },

      gatekeepers: [
        // Isolate Context data under a fixed sharing domain (deployments
        // sharing it can share collections). Omit for per-origin isolation.
        Context({ sharingDomain: "production" }),
        // The example wrapper-owned integration (packages/custom-gatekeeper)
        // follows the standard capnweb gatekeeper layout, so a packaged
        // manifest deploys it — the entry, compat flags, and Durable
        // Objects derive from its wrangler.jsonc. A gatekeeper can also be
        // any alchemy Worker: Gatekeeper({ name: "custom", worker: MyWorker })
        Gatekeeper({
          name: "custom",
          package: "custom-gatekeeper",
          env: {
            CUSTOM_NAME: "<ORGANIZATION_DISPLAY_NAME>",
            CUSTOM_MESSAGE: "<ORGANIZATION_GUIDANCE>",
          },
        }),
        // Scheduler and MCP deploy by default. Opt out like:
        //   Mcp({ enabled: false })   (from "cloudflare-os/gatekeepers")
      ],

      // Optional platform-funded model catalog. Delete the `ai` prop to
      // deploy without AI setup (users bring their own model keys). The
      // gateway, its Run+Read token, and the stored provider keys are all
      // provisioned by this prop — nothing to create in the dashboard.
      ai: {
        providers: {
          anthropic: yield* Config.redacted("ANTHROPIC_API_KEY"),
          openai: yield* Config.redacted("OPENAI_API_KEY"),
        },
        workersAi: true, // or "direct" to skip AI Gateway cost logs
      },

      backend: {
        services: [
          {
            binding: "ERROR_REPORTER",
            worker: errorReporter,
            entrypoint: "ErrorReporter",
            props: { service: "workshop", environment: "production" },
          },
        ],
      },
      frontend: {
        env: { VITE_FRONTEND_ERROR_REPORTING: "true" },
      },
    });

    return { url: os.url };
  }),
);
