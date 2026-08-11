# Customizing Cloudflare OS

This wrapper exposes controls at three depths. Start in the Admin UI, move to deployment configuration when the trust or infrastructure boundary changes, and write code only for capabilities that neither layer can express.

## Admin UI

Use `/admin` for runtime policy that should not require a deployment:

- Site name, logo, and accent color
- Announcements and agent instructions
- Connector availability and auto-provisioning policy
- Signup behavior, featured blueprints, and output formats

Authentication and authorization are deliberately absent. Sign-in configuration and administrator identities remain deployment-controlled so a compromised admin session cannot redefine the trust boundary.

### Branding

Set the site name, logo, and accent color from the General tab in `/admin`. Logo uploads accept PNG, JPEG, WebP, and SVG files up to 5 MB. The browser scales the longest edge to 256 pixels without cropping and converts the result to PNG. The server then checks the PNG header and rejects anything over 256 KB or 512 pixels before storing it in the deployment's blueprint-content R2 bucket. Square images work best.

The custom logo appears in the app chrome, sign-in screens, and browser tab on each user's next connection. Use **Restore default** to remove it.

## Deployment configuration

[`deployment.jsonc`](../deployment.jsonc) is an annotated, non-secret control surface. Its groups map directly to generated Wrangler configuration:

| Path | Controls | Choices |
| --- | --- | --- |
| `accountId` | Resource ownership | A 32-character [Cloudflare account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/) |
| `workers.*.name` | Stable Worker service identities | Unique lowercase names; changing one creates a differently named Worker |
| `workers.workshop.route` | Public Workshop address | `customDomain` for production or `workersDev: true` for evaluation |
| `access` | Cloudflare Access trust and administrator list | Access team issuer, application audience, and verified email list |
| `aiGateway` | Deployment-funded model catalog | Disabled, Workers AI direct, or provider traffic through AI Gateway |
| `context` | Context sharing boundary, snapshot KV, and optional Artifacts repositories | A stable domain label; automatic or existing KV; Git-backed collections disabled or enabled |
| `customGatekeeper` | Example integration identity and guidance | Organization-specific display text |
| `errorReporting` | Private explicit-issue destination | Console Reporter enabled state, environment, and release metadata |
| `resources` | Blueprint/avatar KV and blueprint-content R2 | `null` to provision or explicit IDs/names to reuse |
| `observability` | Worker telemetry | Structured logs, invocation logs, traces, and sampling; see the [observability guide](observability.md) |

Secrets are never valid values in this file. Install them interactively with Wrangler against the Worker that consumes them.

### Workers and routing

Keep the four Worker names unique. Service bindings use these names, so update and deploy them together.

For production, set a [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/):

```jsonc
"route": { "customDomain": "os.example.com" }
```

The hostname must belong to an active Cloudflare zone and cannot conflict with an existing CNAME. Wrangler creates the DNS record and certificate. For evaluation, use the account's [`workers.dev`](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) subdomain instead:

```jsonc
"route": { "workersDev": true }
```

### Sign-in methods

Cloudflare OS supports three ways to sign users in. This starter deploys Cloudflare Access.

| Method | How it works | In this starter |
| --- | --- | --- |
| Cloudflare Access | Access verifies identity before the request reaches the Worker, and the Workshop trusts the signed Access JWT. The password login and signup pages are disabled. | Deployed by default |
| Built-in password accounts | Cloudflare OS serves its own username and password login plus signup. This is the upstream default. | Requires deploy script changes |
| Auth Gatekeepers | Gatekeepers that advertise `providesAuth` add "Continue with ..." buttons, alongside or instead of password login. | Requires deploy script changes |

Access mode is the default here because unauthenticated requests never reach application code. `scripts/deploy.mjs` implements it by setting `CF_ACCESS_ISS` and `CF_ACCESS_AUD` on the Workshop and building the frontend with `VITE_CF_ACCESS_MODE=true`.

To run another method, drop those two variables and the build flag, then set upstream's `AUTH_GATEKEEPERS` allowlist for provider sign-in. `DISABLE_PASSWORD_AUTH=true` makes a deployment provider-only. Upstream ignores it unless at least one auth Gatekeeper is allowlisted, so a deployment cannot lock everyone out. The wrapper's validation assumes Access mode, so review the upstream Workshop backend and frontend documentation before changing it.

The `admins` list gates `/admin` in every method.

#### Cloudflare Access

Create a [self-hosted Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) covering the Workshop hostname. Then configure:

- `issuer`: the team origin, such as `https://acme.cloudflareaccess.com`, with no path.
- `audience`: the application's [AUD tag](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag).
- `admins`: Access-verified email addresses allowed into `/admin`.

Access policies decide who can sign in. The `admins` list decides which signed-in identities can change runtime policy. Keep both narrow.

### Storage

Wrangler supports [automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) for KV and R2. Leave these values as `null` for a new deployment:

```jsonc
"context": {
  "sharingDomain": "production",
  "kvNamespaceId": null
},
"resources": {
  "blueprintsKvNamespaceId": null,
  "avatarsKvNamespaceId": null,
  "blueprintContentBucket": null
}
```

Wrangler creates resources with the Worker name as a prefix and reconnects them on future deploys. To adopt existing data, replace the relevant `null` with a [KV namespace ID](https://developers.cloudflare.com/kv/reference/kv-commands/#kv-namespace) or [R2 bucket name](https://developers.cloudflare.com/r2/reference/wrangler-commands/#r2-bucket).

### Context Artifacts

The Context Gatekeeper can use [Artifacts](https://developers.cloudflare.com/artifacts/) as Git-compatible storage for Context collections. This is disabled when `enabled` is omitted or false and requires Artifacts access on the deployment account. Enable it without specifying a namespace to use `gatekeeper-context-collections`:

```jsonc
"artifacts": { "enabled": true }
```

To isolate repositories under another stable namespace, add the optional property:

```jsonc
"artifacts": {
  "enabled": true,
  "namespace": "acme-context-collections"
}
```

Artifacts creates the namespace implicitly when the first repository is created. Keep the selected namespace stable: existing Git-backed collections refer to repositories in it. Disabling the binding later stops repository refresh and token management but does not delete repositories; the last synchronized Context content remains readable. Write tokens grant repository mutation authority, so protect them like other credentials and revoke them when no longer needed.

### AI models

AI is optional for deployment. The Workers AI binding remains available to Cloudflare OS platform features, but the current upstream model transport uses HTTPS. A deployment-funded model catalog therefore requires `CF_AI_GATEWAY_API_TOKEN` even for Workers AI.

| Mode | Configuration | Result |
| --- | --- | --- |
| No platform model | `aiGateway.enabled: false` | Deploys without an AI secret; no funded model catalog is advertised |
| Workers AI direct | Enable AI, include only `cloudflare`, set `workersAi.mode: "direct"` | Calls the Workers AI REST endpoint without Gateway model logs |
| Workers AI through Gateway | Enable AI, include `cloudflare`, set `workersAi.mode: "gateway"` | Adds [AI Gateway observability](https://developers.cloudflare.com/ai-gateway/observability/) |
| External providers | Add `anthropic`, `openai`, or `google` | Exposes supported models through [AI Gateway](https://developers.cloudflare.com/ai-gateway/) and its billing/key configuration |

To fund Workers AI directly:

```jsonc
"aiGateway": {
  "enabled": true,
  "name": "default",
  "accountId": "<CLOUDFLARE_ACCOUNT_ID>",
  "providers": ["cloudflare"],
  "workersAi": { "mode": "direct" }
}
```

To route it through AI Gateway, change `mode` to `gateway` and add the gateway name. Cloudflare can [create the `default` gateway on first use](https://developers.cloudflare.com/changelog/post/2026-03-02-default-gateway/). Add external providers only after selecting [Unified Billing or BYOK](https://developers.cloudflare.com/ai-gateway/get-started/#provider-authentication).

Create a narrowly scoped [API token](https://dash.cloudflare.com/profile/api-tokens) following the current [AI Gateway authentication guidance](https://developers.cloudflare.com/ai-gateway/configuration/authentication/), then install it without putting the value on the command line. When AI is enabled, the generated Wrangler config [declares this secret as required](https://developers.cloudflare.com/workers/configuration/secrets/#validate-secrets-before-deploy), so deployment fails clearly if it is missing.

```sh
pnpm exec wrangler secret put CF_AI_GATEWAY_API_TOKEN --name your-workshop-worker
```

For Workers AI through the default gateway, current Cloudflare guidance calls for Account permissions `AI Gateway - Read`, `AI Gateway - Edit`, and `Workers AI - Read`. Recheck the linked guidance when enabling other providers.

### Observability

The starter enables structured custom logs and a private console-backed Error Reporter, while invocation logs, traces, and browser reporting remain separate controls. See [Observability and error reporting](observability.md) for signal selection, sampling, triage, privacy, source maps, frontend reporting, and external destinations.

## Custom Gatekeepers

Keep deployment-owned Gatekeepers under `packages/`, outside the `cloudflare-os` submodule. `scripts/deploy.mjs` binds this repository's example to the Workshop as `GATEKEEPER_CUSTOM` and Context as `GATEKEEPER_CONTEXT`.

The minimal example flow is:

1. `types.d.ts` defines the API visible to TypeScript callers.
2. `CustomSessionImpl.getDeploymentInfo()` authorizes an observation before returning data.
3. `CustomGatekeeper` reads deployment values and creates the session.
4. `CustomAccount` exposes that session as a singleton.
5. `GatekeeperVendor` advertises credential-free auto-provisioning.
6. The Workshop service binding makes the vendor available to Cloudflare OS.

Read the [package guide](../packages/custom-gatekeeper/README.md) and upstream [`write-gatekeeper` skill](https://github.com/cloudflare/cloudflare-os/blob/main/.agents/skills/write-gatekeeper/SKILL.md) before adding OAuth, URL-scoped resources, writes, simulations, hooks, configurator UI, or stricter observer verification.

## Code extensions

Prefer wrapper-owned Workers and [service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) over patches inside the submodule. Modify upstream only when a Worker boundary cannot express the behavior, and keep the change as a reviewable upstream commit or fork rather than a generated overlay.

## Upgrade

1. Record the current `cloudflare-os` gitlink for rollback.
2. Update the submodule to the intended upstream commit.
3. Review Workshop and Context Wrangler base-config changes and Gatekeeper contracts.
4. Run `pnpm install`, `pnpm --dir cloudflare-os install`, and `pnpm check`.
5. Deploy and verify Access, administrator access, storage, configured AI, Context, custom observations, and the Error Reporter query surface.
6. If needed, restore the previous gitlink and redeploy, or use [Workers rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) when bindings remain compatible.

Do not update the submodule blindly. The deployment script derives from upstream configs so incompatible base changes remain visible during review and checks.
