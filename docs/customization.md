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
| `publicBaseUrl` | The deployment's public origin | `null` to derive it from the router's custom domain; on a `workers.dev` route, the router's own `https://<router-name>.<subdomain>.workers.dev` |
| `workers.*.name` | Stable Worker service identities | Unique lowercase names; changing one creates a differently named Worker |
| `workers.router.route` | The deployment's public address | `customDomain` for production or `workersDev: true` for evaluation |
| `access` | Cloudflare Access trust and administrator list | Access team issuer, application audience, and verified email list |
| `aiGateway` | Deployment-managed model catalog | Enabled by default over the Workers AI binding; which providers to advertise, and which gateway |
| `context` | Context sharing boundary, snapshot KV, and optional Artifacts repositories | `null` to scope data to the public origin, or a pinned stable label; automatic or existing KV; Git-backed collections disabled or enabled |
| `customGatekeeper` | Example integration identity and guidance | Organization-specific display text |
| `googleSheetsGuard` | Optional P3 fixed-range Google Sheets facade | Disabled or enabled; credentials, spreadsheet ID, and range remain Worker secrets |
| `errorReporting` | Private explicit-issue destination | Console Reporter enabled state, environment, and release metadata |
| `resources` | Blueprint/avatar KV and blueprint-content R2 | `null` to provision or explicit IDs/names to reuse |
| `observability` | Worker telemetry | Structured logs, invocation logs, traces, and sampling; see the [observability guide](observability.md) |

Secrets are never valid values in this file. Install them interactively with Wrangler against the Worker that consumes them.

### Workers and routing

The default deployment is six Workers. Enabling `googleSheetsGuard` adds an optional seventh Worker. Keep active Worker names unique: service bindings use these names, so update and deploy them together.

| Worker | Role |
| --- | --- |
| `router` | Owns the public route and serves the frontend. Proxies `/api` and `/blueprint-screenshot` to the Workshop, and `/gatekeeper/<name>` to the Gatekeeper whose service binding matches. |
| `workshop` | The Cloudflare OS backend, holding all user data in Durable Objects. |
| `context` | The Context Gatekeeper. |
| `scheduler` | The Scheduler Gatekeeper, which gives agents scheduled and recurring work. |
| `customGatekeeper` | This repository's example integration. |
| `googleSheetsGuard` | Optional wrapper-owned P3 facade for one fixed range in one synthetic Google Spreadsheet. |
| `errorReporter` | The private explicit-issue destination. |

Context and Scheduler are *ambient*: upstream's release marks both `PREINSTALL`, so the hosted flow installs them on every instance and this starter deploys them for the same reason. Neither takes configuration beyond its name — the Scheduler takes none at all.

Only the router takes a route; every other active Worker is reachable only over service bindings, and the deploy turns off `workers.dev` and [Preview URLs](https://developers.cloudflare.com/workers/configuration/previews/) on all of them. That keeps the router the single Access-protected way in.

For production, set a [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) on it:

```jsonc
"workers": { "router": { "name": "acme-os", "route": { "customDomain": "os.example.com" } } }
```

The hostname must belong to an active Cloudflare zone and cannot conflict with an existing CNAME. Wrangler creates the DNS record and certificate, and `publicBaseUrl` can stay `null` — the deploy derives the public origin from the domain. For evaluation, use the account's [`workers.dev`](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) subdomain instead:

```jsonc
"publicBaseUrl": "https://acme-os.<subdomain>.workers.dev",
"workers": { "router": { "name": "acme-os", "route": { "workersDev": true } } }
```

`publicBaseUrl` is required there, because nothing in `deployment.jsonc` knows your account's `workers.dev` subdomain. If using workers.dev that value must be `https://<router-name>.<subdomain>.workers.dev`. Two things read the origin — `PUBLIC_BASE_URL`, which upstream builds absolute links and OAuth redirect URIs from, and the Context sharing boundary under [Storage](#storage) — so a typo here would deploy successfully and then hide existing Context data and break every redirect.

On a custom domain the hostname is yours and has nothing to do with any Worker name, so `pnpm check` compares `publicBaseUrl` against `customDomain` instead: leave it `null` and the deploy derives the origin from the domain, or set it to exactly `https://<customDomain>`.

### Sign-in methods

Cloudflare OS supports three ways to sign users in. This starter deploys Cloudflare Access.

| Method | How it works | In this starter |
| --- | --- | --- |
| Cloudflare Access | Access verifies identity before the request reaches the Worker, and the Workshop trusts the signed Access JWT. The password login and signup pages are disabled. | Deployed by default |
| Built-in password accounts | Cloudflare OS serves its own username and password login plus signup. This is the upstream default. | Requires deploy script changes |
| Auth Gatekeepers | Gatekeepers that advertise `providesAuth` add "Continue with ..." buttons, alongside or instead of password login. | Requires deploy script changes |

Access mode is the default here because unauthenticated requests never reach application code. `scripts/deploy.ts` implements it by setting `CF_ACCESS_ISS` and `CF_ACCESS_AUD` on the Workshop and building the frontend with `VITE_CF_ACCESS_MODE=true`.

To run another method, drop those two variables and the build flag, then set upstream's `AUTH_GATEKEEPERS` allowlist for provider sign-in. `DISABLE_PASSWORD_AUTH=true` makes a deployment provider-only. Upstream ignores it unless at least one auth Gatekeeper is allowlisted, so a deployment cannot lock everyone out. The wrapper's validation assumes Access mode, so review the upstream Workshop backend and frontend documentation before changing it.

The `admins` list gates `/admin` in every method.

#### Cloudflare Access

Create a [self-hosted Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) covering the router's hostname. Then configure:

- `issuer`: the team origin, such as `https://acme.cloudflareaccess.com`, with no path.
- `audience`: the application's [AUD tag](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag).
- `admins`: Access-verified email addresses allowed into `/admin`.

Access policies decide who can sign in. The `admins` list decides which signed-in identities can change runtime policy. Keep both narrow.

### Storage

Wrangler supports [automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) for KV and R2. Leave these values as `null` for a new deployment:

```jsonc
"context": {
  "sharingDomain": null,
  "kvNamespaceId": null
},
"resources": {
  "blueprintsKvNamespaceId": null,
  "avatarsKvNamespaceId": null,
  "blueprintContentBucket": null
}
```

Wrangler creates resources with the Worker name as a prefix and reconnects them on future deploys. To adopt existing data, replace the relevant `null` with a [KV namespace ID](https://developers.cloudflare.com/kv/reference/kv-commands/#kv-namespace) or [R2 bucket name](https://developers.cloudflare.com/r2/reference/wrangler-commands/#r2-bucket).

`context.sharingDomain` is not storage but a data-isolation boundary: Context collections are visible only within it. `null` scopes them to the deployment's public origin, which is what the hosted deploy does. Changing the boundary hides existing collections even with the right KV bound, so pin it to a literal string when a hostname change must not move it:

```jsonc
"context": { "sharingDomain": "https://os.example.com" }
```

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

Every provider, Workers AI included, is reached through [AI Gateway](https://developers.cloudflare.com/ai-gateway/). The transport is the Workshop's `WORKERS_AI` binding, which is pre-authenticated inside your own account — so the default configuration needs **no API token at all**:

```jsonc
"aiGateway": {
  "enabled": true,
  "name": "default",
  "accountId": null,
  "providers": ["cloudflare"]
}
```

Cloudflare can [create the `default` gateway on first use](https://developers.cloudflare.com/changelog/post/2026-03-02-default-gateway/). `accountId: null` means the gateway lives in the deployment's own account, which is what makes the binding transport usable.

The binding stays bound whatever you configure here: as well as carrying gateway traffic, it is what the agent's `webFetch` tool runs document-to-Markdown conversion on.

| Configuration | Result |
| --- | --- |
| `enabled: true`, `providers: ["cloudflare"]` | Workers AI models over the binding. No token, no keys of your own. The default. |
| Add `anthropic` or `openai` | Their models appear too. Keys live on the gateway ([Unified Billing or BYOK](https://developers.cloudflare.com/ai-gateway/get-started/#provider-authentication)), not in this repository. Still no token. |
| Add `google` | Needs `CF_AI_GATEWAY_API_TOKEN`. pi's Google adapter refuses a custom fetch, so Google inference cannot ride the binding. |
| `accountId` set to another account | Needs `CF_AI_GATEWAY_API_TOKEN`. The binding only reaches gateways in the Worker's own account, so the generated config sets `CF_AI_GATEWAY_USE_BINDING: "false"` and the HTTPS transport takes over. |
| `enabled: false` | No deployment-managed catalog. Each user supplies their own model API keys — and a Workshop [migrated from the hosted deploy](migrate-from-hosted.md) will show an empty model picker. |

`pnpm check` reports which of the last two applies before it deploys anything.

#### When a token is required

Only the two rows above need one. Create a narrowly scoped [API token](https://dash.cloudflare.com/profile/api-tokens) following the current [AI Gateway authentication guidance](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) — a Run + Read token; current guidance calls for Account permissions `AI Gateway - Read`, `AI Gateway - Edit`, and `Workers AI - Read`. Install it without putting the value on the command line:

```sh
CLOUDFLARE_ACCOUNT_ID=your-account-id pnpm exec wrangler secret put CF_AI_GATEWAY_API_TOKEN --name your-workshop-worker
```

Note: Use the `accountId` from your own `deployment.jsonc`, i.e the account the Workshop deploys to.

In exactly those cases the generated Wrangler config [declares the secret as required](https://developers.cloudflare.com/workers/configuration/secrets/#validate-secrets-before-deploy), so the deploy fails clearly if it is missing. On the default path it does not, so a deployment that needs no token is never blocked waiting for one.

### Observability

The starter enables structured custom logs and a private console-backed Error Reporter, while invocation logs, traces, and browser reporting remain separate controls. See [Observability and error reporting](observability.md) for signal selection, sampling, triage, privacy, source maps, frontend reporting, and external destinations.

## Custom Gatekeepers

Keep deployment-owned Gatekeepers under `packages/`, outside the `cloudflare-os` submodule. `scripts/deploy.ts` binds this repository's example as `GATEKEEPER_CUSTOM` and Context as `GATEKEEPER_CONTEXT`, twice each: on the Workshop with the `GatekeeperVendor` entrypoint for RPC, and on the router with no entrypoint, where the binding name is what routes `/gatekeeper/custom` and `/gatekeeper/context` to it. A Gatekeeper that serves HTTP — an OAuth redirect, for instance — needs both.

The minimal example flow is:

1. `types.d.ts` defines the API visible to TypeScript callers.
2. `CustomSessionImpl.getDeploymentInfo()` authorizes an observation before returning data.
3. `CustomGatekeeper` reads deployment values and creates the session.
4. `CustomAccount` exposes that session as a singleton.
5. `GatekeeperVendor` advertises credential-free auto-provisioning.
6. The Workshop service binding makes the vendor available to Cloudflare OS.

Read the [package guide](../packages/custom-gatekeeper/README.md) and upstream [`write-gatekeeper` skill](https://github.com/cloudflare/cloudflare-os/blob/main/.agents/skills/write-gatekeeper/SKILL.md) before adding OAuth, URL-scoped resources, writes, simulations, hooks, configurator UI, or stricter observer verification.

### P3 Google Sheets Guard

`packages/google-sheets-guard` is disabled by default. When enabled, the deploy adds a private
facade Worker bound as `GATEKEEPER_GOOGLE_SHEETS_GUARD`; the router maps that binding to
`/gatekeeper/google-sheets-guard`, while Workshop uses the internal vendor ID
`google_sheets_guard`.

The facade inherits the pinned upstream Google OAuth and Sheets reader, but exposes only
`readApprovedRange()`. Its spreadsheet ID and quoted-sheet bounded A1 range are required Worker
secrets, and the range cannot exceed 1,000 cells. Arbitrary ranges, range batches, metadata
discovery, writes, actions, and use as a Google sign-in provider fail closed. Cloudflare OS
`ApprovalQueue` authorization runs before each agent-visible range read reaches the upstream API;
upstream's post-read observation remains a second record. This is not an OM OS Canonical Runtime
Authorization connection and does not grant OM OS Authority or Permission.

The inherited OAuth flow still requests Google identity scopes plus `spreadsheets.readonly` and
`drive.metadata.readonly`. That token is not Google-enforced to one spreadsheet. Enable P3 only
with a dedicated Google account whose ACL exposes no personal or production content and only the
approved synthetic spreadsheet.

The inherited OAuth/identity flow and observer ACL verification remain control-plane operations
and may contact Google without that per-range `ApprovalQueue` check. The pre-authorization claim
is limited to `readApprovedRange()` data-plane calls.

Enabling the package declares four required secrets without storing their values in Git:

```jsonc
"googleSheetsGuard": { "enabled": true }
```

- `CLIENT_ID`
- `CLIENT_SECRET`
- `P3_SPREADSHEET_ID`
- `P3_ALLOWED_RANGE`, for example `'P3_READONLY'!A1:D20`

OAuth client creation, secret installation, account connection, and the first runtime read remain
separate Human Gates. See the [package boundary](../packages/google-sheets-guard/README.md).

## Code extensions

Prefer wrapper-owned Workers and [service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) over patches inside the submodule. Modify upstream only when a Worker boundary cannot express the behavior, and keep the change as a reviewable upstream commit or fork rather than a generated overlay.

## Upgrade

1. Record the current `cloudflare-os` gitlink for rollback.
2. Update the submodule to the intended upstream commit.
3. Review Workshop and Context Wrangler base-config changes and Gatekeeper contracts.
4. Diff `cloudflare-os/pnpm-workspace.yaml`'s `catalog:` against this repository's and re-sync it. Two submodule packages are members of this workspace and resolve `catalog:` here, so a missing entry fails the install and a *stale* one silently gives the tree two copies of `capnweb` — a failure that only appears once the two installs are separate, as they are in CI.
5. Run `pnpm install`, `pnpm --dir cloudflare-os install`, `pnpm lint`, and `pnpm check`.
6. Deploy and verify Access, administrator access, storage, configured AI, Context, custom observations, and the Error Reporter query surface.
7. If needed, restore the previous gitlink and redeploy, or use [Workers rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) when bindings remain compatible.

Do not update the submodule blindly. The deployment script derives from upstream configs so incompatible base changes remain visible during review and checks.
