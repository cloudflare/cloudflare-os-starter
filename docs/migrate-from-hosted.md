# Migrating from the hosted deploy

The [hosted flow](https://os.cloudflare.app/deploy) installs the same upstream release into your
account without this repository. Ejecting to the starter means taking over that deployment.

The whole migration is **redeploy over the workers that already exist, and rebind the
resources they already use.**

Most of it is found for you: section 2's `pnpm cfos init` reads the account and fills
`deployment.jsonc` in. Read the rest anyway, before running `pnpm cfos deploy`. It explains what
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
leaving `resources.*` as `null` is the trap in section 3.

## 2. Find what the instance runs

Find your hosted instance name — call it `N` — in the wizard, or read it off the worker list in the
[dashboard](https://dash.cloudflare.com/). The hosted flow names everything after it. Then, signed
in with `pnpm exec cf auth login`:

```sh
pnpm cfos init                 # choose "Take over a hosted instance"
git diff deployment.jsonc
pnpm cfos check
```

`init` asks which account, then which of the hosted instances it finds there, and looks up each of
the Workers, storage, AI Gateway and Access values in sections 3–7 under the hosted flow's names. It
prints a found/missing table, then asks for the values no lookup can supply, with defaults:
`access.admins` (the email `cf` is signed in as), a Web Search Worker name if the instance has none,
and names for the two Workers the hosted flow does not have (`N-gk-custom`, `N-errors`). It writes
everything into `deployment.jsonc`, leaving the comments alone; `--out <path>` writes a copy
instead. It never guesses: anything it did not find stays as it was in the file and is listed as
missing. It also lists any other `N-gk-*` Worker, a Gatekeeper the wizard installed that this
starter will not bind (section 8). Choosing **A new deployment** with the instance's name switches
to the takeover rather than overwriting it.

The lookup on its own is `pnpm cfos import`. It never prompts outside a terminal, so it scripts:

```sh
pnpm cfos import N --account <account-id>                          # prints the values as JSON
pnpm cfos import N --account <account-id> --out deployment.jsonc   # writes them into the file
```

It only reads from the account. With no `--account` and no `accountId` in the file, it asks which
of the accounts `cf` can reach to search, and with no `N`, which instance; outside a terminal, or
in CI, it lists them and stops instead. Without `--out` it prints the values as JSON on stdout (the
report goes to stderr) and ends with the full command to re-run with `--out`. It leaves
`access.admins` and the two new Worker names for you to fill in.

`pnpm cfos check` then confirms, against the account, the AUD tag, the team domain, and every KV
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
| `N` | The public URL | `workers.router.name` |

The Gatekeeper suffixes are the hosted flow's choice, not the starter's; the naming table in
`packages/cfos/src/core/naming.ts` is where this repository records them. Without it, confirm them against
`pnpm exec cf workers list` or the dashboard worker list rather than assuming the pattern. An
instance deployed before Web Search shipped has no `N-gk-websearch`. Name it yourself, and the
deploy creates it. The starter also deploys two
Workers the hosted flow does not: the example custom Gatekeeper and the Error Reporter. Give those
new names; nothing depends on them yet.

```jsonc
"workers": {
  // Hosted instances run on workers.dev; section 4 has the custom-domain form.
  "router": { "name": "N", "route": { "workersDev": true } },
  "workshop": { "name": "N-backend" },
  "context": { "name": "N-gk-context" },
  "scheduler": { "name": "N-gk-scheduler" },
  "websearch": { "name": "N-gk-websearch" },
  "customGatekeeper": { "name": "N-gk-custom" },
  "errorReporter": { "name": "N-errors" }
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
instead, so the boundary stays where the data is:

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

`pnpm cfos check` requires that value to be the router's own workers.dev origin —
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
it finds the gateway, and `pnpm cfos check` fails if the named gateway is not in the account
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

Web Search does not use `N-ai`. It searches through the account's `default` gateway, fixed upstream,
which Cloudflare creates on first use.

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
  one is always yours to supply; `pnpm cfos init` asks, offering the email `cf` is signed in as.

`pnpm cfos check` confirms the application with that AUD exists and covers the router's hostname, and
that the issuer is this account's team. Do not run `pnpm cfos access` for a migration: it would find
and reuse this same application, so it adds nothing, and the lookup already wrote both values.

The application already covers the hostname the router answers on, so keeping the URL keeps Access
working untouched. Only if you are moving the instance to a new hostname do you have to extend the
application to cover it — before deploying, and along with `context.sharingDomain` from section 3.

## 8. What you lose

- **The wizard link.** The hosted deploy sets a `DEPLOY_URL` var that renders a "manage this
  deployment" link. The starter does not set it, so the link disappears. This is not a regression to
  work around: the hosted wizard refuses to redeploy over its own workers once you have taken them
  over, which is the whole reason to eject.
- **Gatekeepers you installed through the wizard.** The starter deploys the three ambient ones,
  Context, Scheduler and Web Search, plus whatever is in `packages/`. The lookup lists the others it
  finds. Any *other* Gatekeeper the wizard
  installed keeps running as its own Worker, but the generated configs no longer carry its
  `GATEKEEPER_*` service binding, so it disappears from the app. Port it into `packages/` and add
  the binding in `packages/cfos/src/core/deployment.ts` — to the Workshop for its vendor RPC, and to the router if it
  serves HTTP under `/gatekeeper/<name>` — or delete the orphaned Worker.

## 9. Verify

Beyond the [standard checks](../README.md#4-verify-the-deployment):

1. Sign in as an existing user and confirm the identity is recognised, not re-created.
2. Open the model picker. It must list models — an empty picker means section 5 was skipped.
3. Open a gadget that existed before the migration, and confirm its history is intact.
4. Open the Context library and confirm its collections are still listed.
5. Confirm schedules made before the migration are still listed, and that a new one fires.
6. Send one message to confirm inference actually routes.
7. Ask an agent to search the web, and confirm results come back.

If the model picker is empty or the app looks freshly installed, **stop before writing anything**.
Both are binding problems, not data loss: compare the deployed Worker names and resource IDs against
sections 3 and 4 rather than re-provisioning. Running `pnpm cfos import N` again is a quick way to see
what the account holds next to what you deployed.
