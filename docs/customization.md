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
| `gatekeepers` | Optional upstream Gatekeepers, one Worker each | Slugs from upstream's catalog, each with a Worker name and optional vars; see [Optional Gatekeepers](#optional-gatekeepers) |
| `access` | Cloudflare Access trust and administrator list | Access team issuer, application audience, and verified email list |
| `aiGateway` | Deployment-managed model catalog | Enabled by default over the Workers AI binding; which providers to advertise, and which gateway |
| `context` | Context sharing boundary, snapshot KV, and optional Artifacts repositories | `null` to scope data to the public origin, or a pinned stable label; automatic or existing KV; Git-backed collections disabled or enabled |
| `customGatekeeper` | Whether the example integration deploys, and its identity and guidance | `enabled: false` to deploy none; organization-specific display text |
| `errorReporting` | Private explicit-issue destination | Console Reporter enabled state, environment, and release metadata |
| `resources` | Blueprint/avatar KV and blueprint-content R2 | `null` to provision or explicit IDs/names to reuse |
| `observability` | Worker telemetry | Structured logs, invocation logs, traces, and sampling; see the [observability guide](observability.md) |

Secrets are never valid values in this file. Install them interactively with Wrangler against the Worker that consumes them.

### Workers and routing

The deployment is up to seven Workers of its own, plus one per [optional Gatekeeper](#optional-gatekeepers). Keep their names unique: service bindings use these names, so update and deploy them together.

| Worker | Role |
| --- | --- |
| `router` | Owns the public route and serves the frontend. Proxies `/api` and `/blueprint-screenshot` to the Workshop, and `/gatekeeper/<name>` to the Gatekeeper whose service binding matches. |
| `workshop` | The Cloudflare OS backend, holding all user data in Durable Objects. |
| `context` | The Context Gatekeeper. |
| `scheduler` | The Scheduler Gatekeeper, which gives agents scheduled and recurring work. |
| `websearch` | The Web Search Gatekeeper, which lets agents search the public web. |
| `customGatekeeper` | This repository's example integration. Not deployed when `customGatekeeper.enabled` is `false`. |
| `errorReporter` | The private explicit-issue destination. |

Context, Scheduler and Web Search are *ambient*: upstream's release marks all three `PREINSTALL`, so the hosted flow installs them on every instance and this starter deploys them for the same reason. None takes configuration beyond its name. Web Search runs on its own Workers AI binding and searches through the Workshop's gateway, `aiGateway.name`, so its searches share that gateway's provider keys, limits and logs: the deploy sets it as the Worker's `CF_AI_GATEWAY`, as upstream's deploy service does. With `aiGateway.enabled: false`, or a gateway in another account, which the binding cannot reach, it searches through the account's `default` gateway instead, which Cloudflare creates on first use.

Web Search does need the account to pay for searches, which the free Workers AI allowance does not cover: chats can work while every search fails. Before enabling it, either load [AI Gateway credits](https://developers.cloudflare.com/web-search/how-to-use/#prerequisites) on the account or store a Ceramic API key on the gateway it searches through, under the alias `default`, since upstream pins Ceramic as the provider and AI Gateway uses no other alias for it. With credits, each search spends them, and there is no per-user limit. With a key, Ceramic bills you instead, and a search no longer falls back to credits: a revoked or empty key fails every search. On a public server, set Web Search to disabled in `/admin` unless that is acceptable: in the default mode, optional, onboarding offers it switched on. See upstream's [Web Search guide](https://github.com/cloudflare/cloudflare-os/blob/main/packages/gatekeeper-websearch/README.md#deployment).

Only the router takes a route; every other Worker is reachable only over service bindings, and the deploy turns off `workers.dev` and [Preview URLs](https://developers.cloudflare.com/workers/configuration/previews/) on all of them. That keeps the router the single Access-protected way in.

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

On a custom domain the hostname is yours and has nothing to do with any Worker name, so `pnpm cf-os check` compares `publicBaseUrl` against `customDomain` instead: leave it `null` and the deploy derives the origin from the domain, or set it to exactly `https://<customDomain>`.

### Optional Gatekeepers

Upstream ships more Gatekeepers than the ones this starter always deploys: GitHub, Google, Slack, Notion, GitLab, Linear, the MCP connectors and others. The hosted deploy offers them from a catalog upstream's release tooling builds from its `packages/gatekeeper-*`. `cf-os` builds the same catalog from the pinned submodule, with the same code (`cloudflare-os/scripts/release/manifest-lib.ts`), so `pnpm cf-os init` offers what the hosted flow offers. It leaves out what the starter cannot deploy from a name alone: whatever upstream marks not installable (Email, which needs Email Routing), and anything declaring KV, R2, service or Artifacts bindings, or taking another Worker's name as an input. A file that selects one fails `pnpm cf-os check` with the reason.

Each one is an entry under `gatekeepers`, keyed by its slug:

```jsonc
"gatekeepers": {
  "github": { "name": "acme-os-gk-github" },
  "mcpportal": {
    "name": "acme-os-gk-mcpportal",
    "vars": { "MCP_PORTAL_URL": "https://portal.example.com/mcp" }
  }
}
```

- **The slug** is the hosted install slug: the package directory's name without `gatekeeper-`, keeping only lowercase letters and digits, so `gatekeeper-mcp-portal` is `mcpportal`. It names the `GATEKEEPER_<SLUG>` binding both the Workshop and the router get, and so the `/gatekeeper/<slug>` route and the vendor ID blueprints refer to it by. `context`, `scheduler`, `websearch` and `custom` are taken.
- **`name`** is its Worker's name, a permanent service identity like those under `workers`. `init` suggests `<router name>-gk-<slug>`, as the hosted flow names it.
- **`vars`** are plain-text vars, merged over the ones in the package's own `wrangler.jsonc`; its README lists what it reads. A deploy sets exactly these, replacing any set on the Worker another way. Nothing but `name` and `vars` is allowed.
- **`BASE_URL` is managed.** The deploy sets it to `<public origin>/gatekeeper/<slug>`, as the hosted release does. Upstream's optional Gatekeepers build their OAuth redirect from it and fail every request without it, so `vars` cannot set it.
- **Secrets go to the Worker, never into this file.** An OAuth Gatekeeper reads `CLIENT_ID` and `CLIENT_SECRET`, or whatever its package declares, and `check` refuses a declared secret's name under `vars`. It can only know the declared ones: a secret a package's README documents without declaring it, such as the MCP portal's `MCP_PORTAL_TOKEN`, is yours to keep out of `vars` and set with Wrangler the same way. Create an OAuth app with the provider, register `<public origin>/gatekeeper/<slug>/oauth` as its redirect URI, and set each secret with Wrangler:

  ```sh
  CLOUDFLARE_ACCOUNT_ID=your-account-id pnpm exec wrangler secret put CLIENT_ID --name acme-os-gk-github
  ```

  `init` prints the provider's console page, upstream's setup steps, the redirect URI and these commands. Deploying first is fine: the Gatekeeper deploys, but nobody can connect it until its secrets are set, and later deploys keep them. `check` and `deploy` warn about each secret still missing, and never fail on one.
- **One install per package.** The hosted flow can install an OAuth Gatekeeper twice, for two OAuth apps (`google2`, say); the starter deploys each package at most once.
- **Removing an entry unbinds it.** The next deploy drops its two bindings, so the Workshop stops offering it and users' connections to it disappear. Its Worker, and the Durable Objects holding its state, keep running unbound: the CLI never deletes a Worker. To delete it, `CLOUDFLARE_ACCOUNT_ID=your-account-id pnpm exec wrangler delete --name <its Worker name>`.

### Sign-in methods

Cloudflare OS supports three ways to sign users in. This starter deploys Cloudflare Access.

| Method | How it works | In this starter |
| --- | --- | --- |
| Cloudflare Access | Access verifies identity before the request reaches the Worker, and the Workshop trusts the signed Access JWT. The password login and signup pages are disabled. | Deployed by default |
| Built-in password accounts | Cloudflare OS serves its own username and password login plus signup. This is the upstream default. | Requires deploy script changes |
| Auth Gatekeepers | Gatekeepers that advertise `providesAuth` add "Continue with ..." buttons, alongside or instead of password login. | Requires deploy script changes |

Access mode is the default here because unauthenticated requests never reach application code. `packages/cf-os/src/core/deployment.ts` implements it by setting `CF_ACCESS_ISS` and `CF_ACCESS_AUD` on the Workshop and building the frontend with `VITE_CF_ACCESS_MODE=true`.

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

`pnpm cf-os check` reports which of the last two applies before it deploys anything.

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

Keep deployment-owned Gatekeepers under `packages/`, outside the `cloudflare-os` submodule. `packages/cf-os/src/core/deployment.ts` binds this repository's example as `GATEKEEPER_CUSTOM` and Context as `GATEKEEPER_CONTEXT`, twice each: on the Workshop with the `GatekeeperVendor` entrypoint for RPC, and on the router with no entrypoint, where the binding name is what routes `/gatekeeper/custom` and `/gatekeeper/context` to it. A Gatekeeper that serves HTTP — an OAuth redirect, for instance — needs both.

The example is deployed unless `customGatekeeper.enabled` is `false`, which deploys no Worker for it and binds none; `workers.customGatekeeper` and the display text are then ignored.

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

`npx cf-os@latest update` brings the project up to date with the starter: it merges the starter's `main` (fetched from its URL, so no remote is needed), checks the submodule out at the pin that merge brings, runs `pnpm install`, and writes `.cf-os/update.md`. The brief lists both commit ranges and any conflicts, which git leaves in place, and gives a coding agent the steps to finish and summarise the update, starting from [the operator skill's updating guide](../.agents/skills/cloudflare-os-operator/references/updating.md). The starter's pin has already been reviewed against the starter, so for that path the list below is a check on your own customisations. `--dry-run` lists what would be merged, and `git reset --keep <old HEAD>` (the brief names it) undoes it.

Moving the submodule past the starter's pin is a review of its own. `npx cf-os@latest update --upstream` picks upstream's `main` as the target and stages it without committing; or check out the commit by hand. It first merges the starter's `main`, committed, as plain `update` does, so run that and commit it first to leave the staged change a gitlink-only review. Then:

1. Record the current `cloudflare-os` gitlink for rollback.
2. Update the submodule to the intended upstream commit.
3. Review the Wrangler base-config changes for the Workshop, router and the three ambient Gatekeepers (Context, Scheduler, Web Search), along with the Gatekeeper contracts. `pnpm lint` catches one class of drift for you: `packages/cf-os/src/core/deployment-config.ts` reuses upstream's `WranglerConfig`, so a changed key there is a type error, not a silently dropped one. A new upstream Gatekeeper arrives as [optional](#optional-gatekeepers), even one newly preinstalled (`PREINSTALL` in `cloudflare-os/scripts/release/manifest-lib.ts`), unless the starter's catalog excludes it: one upstream marks not installable, or one that declares KV, R2, service or Artifacts bindings or takes another Worker's name as an input, is never offered, and selecting it by hand fails `pnpm cf-os check` with the reason. To deploy it everywhere and keep the starter on the hosted topology, which is the only way to deploy an excluded one, it needs a Worker and bindings in `packages/cf-os/src/core/deployment.ts` and a row in the naming table in `core/naming.ts`. A selected Gatekeeper the new pin makes undeployable fails `pnpm cf-os check` with the reason.
4. Compare three entries of `cloudflare-os/pnpm-workspace.yaml`'s `catalog:` with this repository's: `capnweb`, `typescript` and `@cloudflare/workers-types`. Only those three have to match. The packages here `link:` to the submodule's rather than sharing a workspace with them. So the submodule's dependencies come from its own lockfile, and this catalog does not govern them. Types still cross the link, though. Each install has its own `capnweb` copy whatever the version, and today only its types cross. Keeping the ranges in step keeps those types compatible, and keeps the two copies from diverging if runtime code ever crosses too.
5. Run `pnpm install`, then `pnpm lint` and `pnpm cf-os check`. The root `postinstall` (`cf-os install`) reinstalls the submodule's workspace from its lockfile. `optimisticRepeatInstall: false` makes it run even when this repository's own lockfile has not changed, which is what a gitlink bump looks like from here. If the hook was skipped (`--ignore-scripts`), `pnpm cf-os install --check` and every build, test and deploy entry point stop and tell you to run `pnpm cf-os install`.
6. Deploy and verify Access, administrator access, storage, configured AI, Context, Scheduler, Web Search, custom observations, a connection through each optional Gatekeeper, and the Error Reporter query surface.
7. If needed, restore the previous gitlink and redeploy, or use [Workers rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) when bindings remain compatible. Neither works across a Durable Object migration: once a pin that adds a `migrations` tag to a Worker's `wrangler.jsonc` has deployed, that Worker can only be repaired forward. Check for new tags in step 3, the Workshop's especially, before deploying.

Do not update the submodule blindly. The deploy derives from upstream configs so incompatible base changes remain visible during review and checks.
