# Migrating from the hosted deploy

The [hosted flow](https://os.cloudflare.app/deploy) installs the same upstream release into your
account without this repository. Ejecting to the starter means taking over that deployment.

The whole migration is **redeploy over the workers that already exist, and rebind the
resources they already use.**

Most of it is found for you: section 2's `pnpm cf-os init` reads the account and fills
`deployment.jsonc` in. Read the rest anyway, before running `pnpm cf-os deploy`. It explains what
each value protects, and what to do when the lookup cannot find one. Sections 3 and 4 are the ones that
lose data if they are wrong.

The starter's pinned release should be the same as or newer than the one your instance is running,
so migrating is a version upgrade as well as a move. That means the usual upgrade caveats apply:
upstream changes can be breaking, and a newer release can carry Durable Object migrations that run
against your existing data the first time you deploy. If you want the full gate before touching
production — compatibility review, migration plan, rollback matrix — it is in
[Upgrade and rollback](../.agents/skills/cloudflare-os-operator/references/upgrade-and-rollback.md).
Do not deploy a pin *older* than what the instance runs; downgrade the code and the storage stays
migrated.

## 1. What carries over, and why

Nothing is stored *in* a Worker. Your users, gadgets, workspaces and settings live in SQLite
Durable Objects belonging to the **backend Worker's script identity**, and DO namespaces are scoped
to that identity.

So:

- Redeploying over the same script name is an in-place version update. The DOs are the same DOs and
  the data is still there.
- Deploying under a different name creates a *new* script with empty DO namespaces. The old data is
  not lost, but nothing reads it any more, and the app looks freshly installed.

KV and R2 work the same way, except that the binding names the resource explicitly — which is why
leaving `resources.*` as `null` is the trap in section 4.

## 2. Find what the instance runs

Find your hosted instance name — call it `N` — in the wizard, or read it off the worker list in the
[dashboard](https://dash.cloudflare.com/). The hosted flow names everything after it. Then, with
`cf` signed in (`init` offers the sign-in if it is not):

```sh
pnpm cf-os init                # choose "Take over a hosted instance"; answer no to "Deploy now?"
git diff deployment.jsonc
pnpm cf-os check
```

`init` asks which account, then which of the hosted instances it finds there, and looks up each of
the Workers, storage, AI Gateway and Access values in sections 3–7 under the hosted flow's names. It
prints a found/missing table, then asks for the values no lookup can supply, with defaults:
`access.admins` (the email `cf` is signed in as), a Web Search Worker name if the instance has none,
which Gatekeepers to deploy beyond Context, Scheduler and Web Search, names for the two Workers the
hosted flow does not have (`N-gk-custom`, `N-errors`), the model providers to advertise, and the
example custom Gatekeeper's name and message. The Gatekeeper question preselects the example custom
Gatekeeper and every optional Gatekeeper the wizard installed that the starter can deploy (an
`N-gk-github`, say), plus any the file's `gatekeepers` already names whose Worker the account runs
(a rerun after a deploy), under the file's name. It takes the file's entries only when its
`workers.router.name` is `N`: a file written for another deployment in the same account names that
deployment's Gatekeeper Workers, which it lists and leaves alone. Where the instance's own file names
a different Worker for a Gatekeeper than its `N-gk-<slug>`, it asks which one to bind, defaulting to
the instance's. Leaving one out, or picking
the file's Worker over the instance's, warns that it loses its binding (section 8). Leaving out the
custom one skips its name and message, and warns the same way when the account runs its Worker
(`N-gk-custom`, or the name in the instance's own file, on a rerun after a deploy). Keeping it on a
rerun defaults its Worker name to the one the instance's own file gives, when the account runs it,
and naming another Worker warns that this one loses its binding. It writes everything into `deployment.jsonc`, leaving the
comments alone; `--out <path>` writes a copy instead. It never guesses: anything it did not find
stays as it was in the file and is listed as missing. It also lists, with the reason, any other
`N-gk-*` Worker: a second install of one Gatekeeper, or one the starter cannot deploy (section 8).
It ends by listing anything still a placeholder, or, when nothing is, by offering to deploy. Say no the first time: a takeover deploys over your data, so
review the diff and run `pnpm cf-os check` first, then `pnpm cf-os deploy`. Choosing **A new deployment** with the instance's name switches
to the takeover rather than overwriting it.

The lookup on its own is `pnpm cf-os import`. It never prompts outside a terminal, so it scripts:

```sh
pnpm cf-os import N --account <account-id>                          # prints the values as JSON
pnpm cf-os import N --account <account-id> --out deployment.jsonc   # writes them into the file
```

It only reads from the account. With no `--account` and no `accountId` in the file, it asks which
of the accounts `cf` can reach to search, and with no `N`, which instance; outside a terminal, or
in CI, it lists them and stops instead. Without `--out` it prints the values as JSON on stdout (the
report goes to stderr) and ends with the full command to re-run with `--out`. The values include
`gatekeepers.<slug>.name` for each optional Gatekeeper it found that the starter can deploy. A
file whose `workers.router.name` is not `N` may be another deployment's, so the Gatekeeper Workers
its `gatekeepers` block names are left alone: the report lists the entries it did not find for `N`,
and `--out` removes them rather than bind that deployment's Workers to this one. It
leaves `access.admins`, the two new Worker names and the custom Gatekeeper's text for you to fill
in, or `customGatekeeper.enabled: false` to deploy no custom Gatekeeper.

`pnpm cf-os check` then confirms, against the account, the AUD tag, the team domain, and every KV
namespace, R2 bucket and AI Gateway the file now names. That catches a wrong value before anything
deploys.

Review the diff against the sections below. They explain what each value protects, and they give
the manual lookup for anything reported missing.

## 3. Match the Worker names exactly

| Hosted Worker | What it holds | `deployment.jsonc` |
| --- | --- | --- |
| `N-backend` | **All user data** (Durable Objects) | `workers.workshop.name` |
| `N-gk-context` | Context collections | `workers.context.name` |
| `N-gk-scheduler` | Scheduled and recurring work | `workers.scheduler.name` |
| `N-gk-websearch` | Nothing; stateless web search | `workers.websearch.name` |
| `N-gk-<slug>`, such as `N-gk-github` | Users' connections to that service | `gatekeepers.<slug>.name` |
| `N` | The public URL | `workers.router.name` |

The Gatekeeper suffixes are the hosted flow's choice, not the starter's; the naming table in
`packages/cf-os/src/core/naming.ts` is where this repository records them. Without it, confirm them against
`pnpm exec cf workers list` or the dashboard worker list rather than assuming the pattern. An
instance deployed before Web Search shipped has no `N-gk-websearch`. Name it yourself, and the
deploy creates it. Its users finished onboarding before Web Search existed, so none of them has it
until it is set to enabled in `/admin` or they turn it on from the Gatekeepers page. The starter also deploys two
Workers the hosted flow does not: the example custom Gatekeeper and the Error Reporter. Give those
new names; nothing depends on them yet. The custom Gatekeeper is optional:
`customGatekeeper.enabled: false` deploys none.

Optional Gatekeepers the wizard installed, GitHub or Slack say, are `N-gk-<slug>` Workers. Each one
the starter can deploy goes in `gatekeepers` under the same Worker name, which the lookup writes and
`init` preselects; their users' connections live in their Durable Objects, as user data lives in the
backend's. A deploy over them keeps the OAuth secrets they already hold, but replaces their plain
vars wholesale (section 6) with the package's own, `BASE_URL` and `gatekeepers.<slug>.vars`. A var
set on the hosted Worker, such as `GITLAB_URL` for a self-managed GitLab or `MCP_PORTAL_URL` for an
MCP portal, is lost unless you copy it from the Worker's settings in the dashboard into
`gatekeepers.<slug>.vars` before deploying; the lookup and `init` remind you, as they cannot read
it. With that done, on the same URL they need no setup. Their OAuth redirect URI, `<public origin>/gatekeeper/<slug>/oauth`, follows the
public origin, though: move the instance to a new hostname and each provider's OAuth app has to
list the new URI too, or connecting fails at the provider. `init` prints each one's URI. See
[Optional Gatekeepers](customization.md#optional-gatekeepers).

```jsonc
"workers": {
  // Hosted instances run on workers.dev; section 5 has the custom-domain form.
  "router": { "name": "N", "route": { "workersDev": true } },
  "workshop": { "name": "N-backend" },
  "context": { "name": "N-gk-context" },
  "scheduler": { "name": "N-gk-scheduler" },
  "websearch": { "name": "N-gk-websearch" },
  "customGatekeeper": { "name": "N-gk-custom" },
  "errorReporter": { "name": "N-errors" }
},
"gatekeepers": {
  "github": { "name": "N-gk-github" }
}
```

Context, Scheduler and Web Search are all there because upstream marks them ambient and the hosted
flow preinstalls them on every instance. Point them at the existing Workers and existing schedules and
collections keep working; give either a new name and the app comes up with an empty library or an
empty schedule list, while the originals keep running as Workers nothing is bound to.

## 4. Reuse the storage

`resources.*` and `context.kvNamespaceId` default to `null`, which asks Wrangler to **provision new,
empty** namespaces. On a fresh install that is what you want. On a migration it is data loss in
everything but name: the deploy succeeds, and the app comes up with no blueprints, no avatars and no
Context collections.

The hosted flow names each resource after the instance and the binding:

```jsonc
"context": {
  "sharingDomain": null,
  "kvNamespaceId": "<id of N-context-collections>"
},
"resources": {
  "blueprintsKvNamespaceId": "<id of N-blueprints>",
  "avatarsKvNamespaceId": "<id of N-avatars>",
  "blueprintContentBucket": "N-blueprint-content"
}
```

KV bindings take the namespace **ID**, not the name. The lookup resolves each title to its ID; by
hand, list them with `pnpm exec cf kv namespaces list` (or `pnpm exec wrangler kv namespace list`).
R2 takes the bucket name as-is (`pnpm exec cf r2 buckets list`).

The Scheduler needs nothing here. Its state is entirely in its own Durable Objects, so section 3's
name is the whole of it. Web Search keeps no state worth migrating.

### The second trap: the Context sharing boundary

Right KV, wrong boundary, and the collections are still invisible. `context.sharingDomain` isolates
Context data, and the hosted flow sets it to the instance's **public origin** — the router's URL,
scheme included, such as `https://N.<subdomain>.workers.dev`.

`sharingDomain: null` reproduces that: the deploy derives it from the public origin, exactly as
hosted does. So the boundary survives as long as the origin does, which makes it one more reason to
keep the URL in [section 5](#5-your-url).

If you *do* move the instance to a new hostname, the derived value changes with it. Pin the old one
instead, so the boundary stays where the data is (and register each carried-over Gatekeeper's new
redirect URI with its OAuth app, as section 3 says):

```jsonc
"context": { "sharingDomain": "https://N.<subdomain>.workers.dev" }
```

`publicBaseUrl` is the other half of this. It is the origin both `sharingDomain` and
`PUBLIC_BASE_URL` derive from: leave it `null` on a custom domain and the deploy takes the domain,
but on a `workers.dev` route it must be set explicitly — nothing in `deployment.jsonc` knows your
account's workers.dev subdomain. The lookup takes it from the hostname the Access application
protects, or else from the router Worker's own workers.dev address. By hand, it is the hosted
instance's exact URL, no trailing slash:

```jsonc
"publicBaseUrl": "https://N.<subdomain>.workers.dev"
```

`pnpm cf-os check` requires that value to be the router's own workers.dev origin —
`https://<workers.router.name>.<subdomain>.workers.dev` — because on this route there is no custom
domain to check it against, and a typo would quietly become both `PUBLIC_BASE_URL` and the Context
boundary.

## 5. Your URL

The starter deploys the same topology as the hosted flow, router included, so the public origin is a
Worker named `N` in both. Either route type preserves the URL:

| Hosted URL | `deployment.jsonc` |
| --- | --- |
| `https://N.<subdomain>.workers.dev` | `"router": { "name": "N", "route": { "workersDev": true } }`, plus `publicBaseUrl` set to that URL |
| A custom domain you already moved it to | `"router": { "name": "N", "route": { "customDomain": "os.example.com" } }` |

Redeploying over `N` is an in-place version update, like every other Worker here. There is no
router to strip a domain from and no router to delete, and the Access application keeps covering
the hostname it already covered.

## 6. AI Gateway — the one that silently empties the model picker

**Do not leave `aiGateway.enabled` at `false`.** `wrangler deploy` replaces a Worker's `vars`
wholesale, so the `CF_AI_GATEWAY*` variables the hosted deploy set are gone the moment you deploy
without your own. With `CF_AI_GATEWAY` unset, `getAiGatewayConfig()` returns `null`, the backend
drops out of gateway mode, and `listModels()` returns only each user's own BYOK models — of which a
freshly migrated instance has none. The result is a deployment that looks healthy and offers no
models at all.

Point it at the gateway the hosted flow already created for you, `N-ai`. The lookup does this when
it finds the gateway, and `pnpm cf-os check` fails if the named gateway is not in the account
(`pnpm exec cf ai-gateway gateways list`):

```jsonc
"aiGateway": {
  "enabled": true,
  "name": "N-ai",
  "accountId": null,
  "providers": ["cloudflare"]
}
```

- `accountId: null` keeps the gateway in your own account, which is what lets the Workshop reach it
  over the `WORKERS_AI` binding. **No `CF_AI_GATEWAY_API_TOKEN` is needed.**
- Add `"anthropic"` or `"openai"` to `providers` if you entered BYOK keys in the wizard. Those keys
  live in the gateway's own Secrets Store, not in the Worker, so they survive the migration and keep
  working.
- Adding `"google"` does require a token — see
  [AI models](customization.md#ai-models).

Web Search searches through `N-ai` too, as the hosted deploy has it do: the deploy sets the
Workshop's gateway as its `CF_AI_GATEWAY`. Searches need AI Gateway credits on the account or a
Ceramic key on that gateway: see [Workers and routing](customization.md#workers-and-routing).

## 7. Cloudflare Access

The hosted flow created a self-hosted Access application named `Cloudflare OS <instance> <fp8>`,
using the one-time-PIN identity provider. Reuse it rather than making a new one, so existing users
keep signing in the same way:

- `access.issuer`: your team origin, `https://<team>.cloudflareaccess.com`. The lookup reads it from
  the account's Zero Trust organization (`pnpm exec cf zero-trust organization get`, `auth_domain`).
- `access.audience`: that application's existing AUD tag. The lookup finds the application by name.
  If two match, it leaves the choice to you. By hand:
  `pnpm exec cf zero-trust access applications list --search "Cloudflare OS N"`, then the `aud`
  field.
- `access.admins`: the admin email you gave the wizard. Nothing in the account records it, so this
  one is always yours to supply; `pnpm cf-os init` asks, offering the email `cf` is signed in as.

`pnpm cf-os check` confirms the application with that AUD exists and covers the router's hostname, and
that the issuer is this account's team. Do not run `pnpm cf-os access` for a migration: it would find
and reuse this same application, so it adds nothing, and the lookup already wrote both values.

The application already covers the hostname the router answers on, so keeping the URL keeps Access
working untouched. Only if you are moving the instance to a new hostname do you have to extend the
application to cover it — before deploying, along with `context.sharingDomain` from section 4 and
each optional Gatekeeper's redirect URI from section 3.

## 8. What you lose

- **The wizard link.** The hosted deploy sets a `DEPLOY_URL` var that renders a "manage this
  deployment" link. The starter does not set it, so the link disappears. This is not a regression to
  work around: the hosted wizard refuses to redeploy over its own workers once you have taken them
  over, which is the whole reason to eject.
- **Some Gatekeepers you installed through the wizard.** The optional Gatekeepers the starter can
  deploy carry over (section 3). Two kinds do not, and the lookup lists each with the reason:
  - a **repeat install**, such as `N-gk-google2` beside `N-gk-google`: the starter deploys one
    Worker per Gatekeeper package;
  - an **unknown** one: a Gatekeeper the pinned submodule does not have, or one the starter cannot
    deploy (upstream marks Email not installable, for one).

  Either keeps running as its own Worker, but the generated configs no longer carry its
  `GATEKEEPER_*` service binding, so it disappears from the app, and its users' connections with
  it. The same happens to an optional Gatekeeper you leave out at the Gatekeeper question, or whose
  `N-gk-<slug>` Worker you pass over for the one the file names, and to a running custom
  Gatekeeper you leave out. Delete an orphaned Worker with
  `CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler delete --name <worker>` once nobody needs
  what it held; the CLI never deletes Workers.

## 9. Verify

Beyond the [standard checks](../README.md#4-verify-the-deployment):

1. Sign in as an existing user and confirm the identity is recognised, not re-created.
2. Open the model picker. It must list models — an empty picker means section 6 was skipped.
3. Open a gadget that existed before the migration, and confirm its history is intact.
4. Open the Context library and confirm its collections are still listed.
5. Confirm schedules made before the migration are still listed, and that a new one fires.
6. Send one message to confirm inference actually routes.
7. Turn Web Search on for your user (section 3), then ask an agent to search the web, and confirm
   results come back.
8. For each optional Gatekeeper carried over, confirm a connection made before the migration still
   works.

If the model picker is empty or the app looks freshly installed, **stop before writing anything**.
Both are binding problems, not data loss: compare the deployed Worker names and resource IDs against
sections 3 and 4 rather than re-provisioning. Running `pnpm cf-os import N` again is a quick way to see
what the account holds next to what you deployed.
