# Migrating from the hosted deploy

The [hosted flow](https://os.cloudflare.app/deploy) installs the same upstream release into your
account without this repository. Ejecting to the starter means taking over that deployment.

The whole migration is **redeploy over the workers that already exist, at a version no older than
the one they run, and rebind the resources they already use.**

One command does most of it. It reads the instance in your account, moves this project's
`cloudflare-os` pin forward to the release the instance runs, and fills `deployment.jsonc` in:

```sh
npx cf-os@latest init my-os --take-over N --account <account-id>
```

Section 2 has its forms and what each step does. Read the rest anyway, before running
`pnpm cf-os deploy`. It explains what each value protects, and what to do when the lookup cannot
find one. Sections 3, 4 and 5 are the ones that lose data if they are wrong.

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
leaving `resources.*` as `null` is the trap in section 5.

The data is also only as old as the code that last wrote it. A release can carry Durable Object
migrations, which run against your existing data the first time it deploys and are not undone by
deploying older code afterwards. That is why the version matters as much as the names: section 3.

## 2. Take the instance over

Find your hosted instance name — call it `N` — in the hosted flow, or read it off the worker list in
the [dashboard](https://dash.cloudflare.com/). The hosted flow names everything after it. For a
deployment it does not update itself, the hosted flow prints the whole command, with what it knows
of the instance filled in; copy it from there when you can.

With no project yet:

```sh
npx cf-os@latest init my-os --take-over N --account <account-id> \
  --release r004945-6c8d301 --commit <the 40 hex digits of that release's commit>
```

It creates the project in `./my-os` as `npx cf-os init my-os` does (clone, install, the offer of a
private GitHub repository), then carries on into the takeover inside it, with every flag handed on.
Run a second time, once `./my-os` is there, it creates nothing and prints the command to run inside
the project instead, with the same flags: the form below.

In a project you already have, `cf` signed in (`init` offers the sign-in if it is not):

```sh
pnpm cf-os init --take-over N --account <account-id>     # at a terminal: asks for the rest
git diff deployment.jsonc
pnpm cf-os check
```

`pnpm cf-os init` on its own gets to the same place by its questions: choose **Take over a hosted
instance**, then the instance. Choosing **A new deployment** with the instance's name switches to
the takeover rather than overwriting it. A project created before `cf-os` 0.3.0 does not have these
flags in its own copy yet; `npx cf-os@latest update` brings them.

| Flag | What it says |
| --- | --- |
| `--take-over <instance>` | The instance to take over. `init` only; `import` takes the instance as its argument |
| `--account <id>` | The account it is in |
| `--router <name>`, `--backend <name>` | Its router and backend Workers, when they are not `N` and `N-backend` (section 4) |
| `--release <id>` | The release it runs, as the hosted flow names it (section 3) |
| `--commit <sha>` | The `cloudflare-os` commit that release was built from, all 40 hex digits (section 3) |

Whichever way it starts, a takeover does these in order, and stops with nothing written at the
first that fails:

1. **Reads the instance**: the account's Workers, storage, AI Gateways and Access applications, then
   what each of the instance's Workers runs. It checks that the Workers are one instance's and that
   the instance is the one named (section 4).
2. **Settles the pin**: which release the instance runs, which commit that is, and whether this
   project's pin is behind it. A pin behind is moved forward, after a confirmation at the terminal
   (section 3).
3. **Matches what it found** against the Gatekeepers the submodule offers at that pin, and prints a
   found/missing table and its notes.
4. **Asks for what no lookup supplies**, with defaults: a Web Search Worker name if the instance has
   none, which Gatekeepers to deploy beyond Context, Scheduler and Web Search (it preselects those
   the instance runs), names for the two Workers the hosted flow does not have (`N-gk-custom`,
   `N-errors`), and the example custom Gatekeeper's name and message. The admins and the model
   providers are asked too, offering what the instance's backend has.
5. **Writes `deployment.jsonc`**, leaving the comments alone; `--out <path>` writes a copy instead.
   It never guesses: anything it did not find stays as it was in the file and is listed as missing.

It ends by listing anything still a placeholder, or, when nothing is, by offering to deploy. Say no
the first time: a takeover deploys over your data, so review the diff and run `pnpm cf-os check`
first, then `pnpm cf-os deploy`.

### Without a terminal: `import`

`init` asks questions, so it needs a terminal. The lookup on its own is `pnpm cf-os import`, which
takes the same flags, never prompts outside a terminal, and so scripts:

```sh
pnpm cf-os import N --account <account-id>                          # reports; changes nothing
pnpm cf-os import N --account <account-id> --out deployment.jsonc   # moves the pin, then writes
```

Without `--out` it is read-only. It prints what the instance's Workers run, the release and its
commit, this project's pin and whether that pin is behind, then the values as JSON on stdout (the
report goes to stderr), and ends with the full command to re-run with `--out`. No file is written
and the pin does not move; to compare the two commits it fetches upstream's history into the
submodule's own repository, which changes nothing checked out but needs the network, and in a
project just created can download the whole of upstream's history. An instance whose Workers name no
commit stops the report as it stops a takeover, exit 1, until `--commit` is passed (section 3). Beside the values, the JSON has two
keys that are no part of the file: `release` (`id`, `commit`, `pin`, `behind`, `moved`, and whether
the commit came from `--commit` or from the release id) and `handEdited` (section 8).

With `--out` it moves the pin forward first, without asking, then writes the values, and prints the
JSON once the file is written. The path is checked before anything is read: a directory that is not
there stops the run with nothing moved. It leaves the two new Worker names and the custom
Gatekeeper's text for you to fill in, or `customGatekeeper.enabled: false` to deploy no custom
Gatekeeper. Written over a file that described another deployment (another router, or another
account), it removes what was that deployment's and not found on this instance: its `gatekeepers`
entries, its push identity, and the Worker names it gave the built-in Gatekeepers, the custom
Gatekeeper and the Error Reporter, which go back to placeholders. Each is said in the report.

With no `--account` and no `accountId` in the file, it asks which of the accounts `cf` can reach to
search, and with no `N`, which instance; outside a terminal, or in CI, it lists them and stops
instead. Run without a terminal, `init --take-over` stops and prints the `import` command that
carries the same flags; `npx cf-os@latest init <dir> --take-over` creates the project, prints that
command, and exits 1, as the takeover it was asked for is still to do.

### What is found, and what is not

| Found, and written | Where it is read |
| --- | --- |
| The router and backend Worker names | By name, or `--router` and `--backend` |
| The Context, Scheduler, Web Search and optional Gatekeeper Workers | The backend's `GATEKEEPER_<SLUG>` service bindings |
| The KV namespaces, the R2 bucket, the AI Gateway | By the names the hosted flow gives them after `N` |
| The Access application's AUD, and the team domain | The application named `Cloudflare OS N ...`; the Zero Trust organization |
| The admins, the model providers, the public origin | The backend's `ADMINS`, `CF_AI_GATEWAY_PROVIDERS` and `PUBLIC_BASE_URL` |
| The push identity | Four of the backend's variables (section 8) |

Not found by any lookup, because the hosted flow has no such thing, so always yours to supply:

- `workers.customGatekeeper.name` and `workers.errorReporter.name`: new names for the two Workers
  the hosted flow does not deploy.
- `customGatekeeper.*`: the name and message the example custom Gatekeeper shows agents, or
  `customGatekeeper.enabled: false`.
- An optional Gatekeeper's own plain vars, such as `GITLAB_URL` or `MCP_PORTAL_URL` (section 4).

`access.admins` and `aiGateway.providers` join that list only for a backend that carries no `ADMINS`
or `CF_AI_GATEWAY_PROVIDERS`; the report says which.

`pnpm cf-os check` then confirms, against the account, the AUD tag, the team domain, and every KV
namespace, R2 bucket and AI Gateway the file now names, and that no Worker it would deploy over has
storage ahead of the pin (section 3). That catches a wrong value before anything deploys.

## 3. The release and the pin

The starter pins one `cloudflare-os` commit. The hosted flow installs releases built from upstream
more often than the starter moves its pin, so a project just created can pin an **older** commit
than the instance runs. Deploying it would put older code over storage the newer release has already
migrated. For Durable Object migrations that cannot be undone: there is no rolling the storage back,
and no later deploy repairs it.

So a takeover works out the commit the instance runs and never leaves the project behind it.

### Which release the instance runs

The hosted flow marks every Worker version it uploads, and a release id is
`r<run number>-<first seven digits of the commit>`, such as `r004945-6c8d301`. For each Worker of
the instance, the live version is read in this order:

1. its version annotations: a tag the hosted flow wrote, and a message naming the release;
2. its `CLOUDFLARE_OS_RELEASE_ID` variable;
3. on the backend only, `releaseId` in its `CLOUDFLARE_OS_DEPLOYMENT` variable.

The report lists each Worker with the release it names and where that was read. Then:

- **One release across the Workers** is the instance's.
- **Mixed releases** (an update that stopped part of the way) count as the newest: the highest run
  number wins, since storage follows the newest code deployed over it.
- **Ids that cannot be ordered** stop the takeover: two that differ where one is not of the
  `r<run>-<sha7>` form (a staging or hand-built release), or that share a run number. Nothing says
  which is newer, so it asks for `--commit` instead of guessing.

### Which commit that is

- With `--commit`, that commit, all 40 hex digits. The hosted flow's command carries it.
- Without it, the seven digits the release id ends in, resolved to a full commit in upstream's
  history.
- An id with no commit in it stops with `could not determine the commit; pass --commit, or copy the
  command from the deploy flow`.

A `--commit` is not taken on trust. The takeover stops when it is not the commit `--release` ends
in, and when the account shows the instance somewhere else than the command says: a Worker
reporting a higher run number than `--release`, or an id that cannot be ordered against it. That is
an instance updated after the command was printed, and the message says so: `the instance moved to
<release> since this command was made; get a fresh one from the deploy flow`. Given with no
`--release`, a `--commit` that is not the commit of the release the instance's Workers report is
refused too: take the instance over at its own release, then move on with `pnpm cf-os update`.

Nor are the flags the last word where the Workers themselves say otherwise. A `--release` no Worker
reports, with a run number above them all, would read as the newest release whatever commit came
with it; so would a `--commit` given for a hand-built release beside a CI one, or because one
Worker's newer release names no commit. Wherever the newest release a Worker reports that names a
commit names another than the one to pin, the pin is held against that commit too, in upstream's
commit graph: where the takeover would leave the pin must be at or past it. A newer report that
names no commit (a version known by its tag's run number alone, an id with no commit in it) does not
stand in for the commit the other Workers name. A pin that would be behind it, or that cannot be
placed against it, stops the takeover and the read-only report alike, with nothing moved: get a
fresh command from the hosted flow, or leave `--release` and `--commit` out to take the instance
over at the release its Workers report.

### Moving the pin

The project's pin is compared with that commit in upstream's commit graph, never by dates or names:

| The pin is | What happens |
| --- | --- |
| Behind the commit | It is moved forward to it: `init` asks first, `import --out` does not |
| At the commit | Nothing moves. Deploying is the release the instance already runs |
| Past the commit | Nothing moves: `the project is already at or past the instance's release; deploying is an upgrade` |
| On another line of history (a preview pin), or not comparable | The takeover stops; the read-only report says it could not tell |

The commit has to be on upstream's `main`, as every commit a takeover pins is. A release built from
another branch stops the takeover the same way (`is not on upstream's main`): update the instance,
through the hosted flow, to a release built from `main` first.

A pin is never moved back. The move is the one `pnpm cf-os update --to <commit>` makes, of the pin
alone: the submodule checked out at the commit, the pin **staged and not committed**, `pnpm install`
run, and `.cf-os/update.md` written with the commit range and what to check before committing. The
starter is never merged by a takeover. Review the move and commit it with `deployment.jsonc`.

It happens before anything is written and before the Gatekeeper catalog is read, so what is matched
and written is what the deploy will build. It needs a checkout with nothing uncommitted, as `update`
does, which a project just created is. When it cannot be made (uncommitted changes, a submodule not
checked out, a declined confirmation), the takeover stops, says the project is not safe to deploy
over the instance yet, and writes nothing, not even `.cf-os/update.md`. Deal with what it names and
run the takeover again: that moves the pin alone. Where it is safe to, it also prints the exact
`pnpm cf-os update --to <sha>`. That is the command-line `update`, which merges the starter's `main`
as well as moving the pin: at a terminal it asks first, and without one, as an agent runs it, it
merges unasked.

A run that had already read the project at the old pin stops once the pin has moved, with nothing
written, and names the command to run again, which reads everything at the new pin. That is
`pnpm cf-os deploy` on an unconfigured project, which starts `init` itself, and an `init` that
reached the takeover by going back from a new deployment's Gatekeeper question.

Since the pin moved without the starter, the starter's own code in the project is still the one
written for the old pin. `pnpm cf-os check` says whether it builds and passes at the new one;
`.cf-os/update.md` has the steps when it does not.

An upgrade is still an upgrade. A pin past the instance's release, or a release newer than the one
you tested, can carry breaking changes and migrations of its own. The full gate — compatibility
review, migration plan, rollback matrix — is in
[Upgrade and rollback](../.agents/skills/cloudflare-os-operator/references/upgrade-and-rollback.md).

### The last check: `check` and `deploy`

A project can end up pinned behind the account by other roads: a takeover's stop ignored, a pin
rolled back, an old checkout. So `pnpm cf-os check` and `pnpm cf-os deploy` look once more, before
anything is built or deployed. Each Worker about to be deployed over is read, and the run is
refused when its live Durable Object migration tag is not among the migration tags of this project's
configuration for it, or, where the account reports no tag, when it stores Durable Objects of a
class no migration in that configuration creates. The refusal names the Worker and what was found,
and the fix: `pnpm cf-os update --to <commit>` with the commit those Workers run or a newer one, or
a fresh takeover command from the hosted flow, which moves the pin forward only. The commit is left
for you to supply. Where the refused Workers' live versions are the hosted flow's and name one
release, the refusal names it and its commit beside the command; pass that commit only if the pin
is behind it, since `update --to` an older commit moves the pin back, and a Worker can be refused
for other reasons than a pin behind (a Worker name that belongs to another deployment, a class added
by hand).

This check reads the account through `cf`. Signed out, `check` says it was skipped and carries on,
and `deploy` refuses: Wrangler uploads over newer storage with no more than a warning. Sign in with
`pnpm exec cf auth login`, or set `CLOUDFLARE_API_TOKEN` to a token with Workers Scripts Read.

It compares migrations and nothing else, so it is the last guard and not the first: a newer release
that added no migration passes it. The takeover's own comparison of commits is what keeps the pin
from going behind.

## 4. Match the Worker names exactly

| Hosted Worker | Named, by default | What it holds | `deployment.jsonc` |
| --- | --- | --- | --- |
| Backend | `N-backend` | **All user data** (Durable Objects) | `workers.workshop.name` |
| Context | `N-gk-context` | Context collections | `workers.context.name` |
| Scheduler | `N-gk-scheduler` | Scheduled and recurring work | `workers.scheduler.name` |
| Web Search | `N-gk-websearch` | Nothing; stateless web search | `workers.websearch.name` |
| Optional Gatekeeper | `N-gk-<slug>`, such as `N-gk-github` | Users' connections to that service | `gatekeepers.<slug>.name` |
| Router | `N` | The public URL | `workers.router.name` |

### An instance under names of its own

The hosted flow lets you choose the router's and the backend's names. An instance deployed that way
is not found by name, and is not in the list `init` and `import` offer: nothing in a list of Worker
names says which two belong together. Name both:

```sh
pnpm cf-os init --take-over N --account <account-id> --router <router-worker> --backend <backend-worker>
```

`N` is still the instance's name, because everything else is named after it: the storage, the AI
Gateway, the Access application. So the name is not taken from the two Workers' names. Before
anything is matched, the takeover holds it against what the backend carries: the Access application
its `CF_ACCESS_AUD` is the audience of, which the hosted flow names `Cloudflare OS N ...`; failing
that, the Gatekeeper Workers it binds, named `N-gk-<slug>`; failing that, its `CF_AI_GATEWAY`, named
`N-ai`. A name those contradict, or that nothing confirms, stops the takeover, saying which instance
the Workers do name. Matching them under the wrong name would pair your Workers with another
deployment's storage, or with none.

The gateway is the weakest of the three, since it is the one a hand points at another instance's.
Where it is all that names `N`, and the account also has Workers called `N` and `N-backend` that are
not the two you named, the takeover stops as well: those two are instance `N` by name, and a gateway
alone does not show yours are. An Access application named the hosted flow's way that the backend's
`CF_ACCESS_AUD` is the audience of settles it.

The two Workers are checked to belong together as well: the router must reach the backend through
its service binding, neither may also be one of the instance's Gatekeepers, and all of them must be
one installation's. A router and a backend from two deployments stop the takeover.

### Gatekeepers are found by binding

The backend binds each of its Gatekeepers as a service binding named `GATEKEEPER_<SLUG>`, and that
binding, not the Worker's name, is what the hosted flow itself goes by. So the Context, Scheduler,
Web Search and optional Gatekeeper Workers are the ones the backend binds, whatever they are called,
and a renamed one is found. A Worker that is only named like the instance's (`N-gk-something`)
without being bound is no part of it: the report says so and leaves it alone.

An instance deployed before Web Search shipped has no Web Search Worker. Name it yourself, and the
deploy creates it. Its users finished onboarding before Web Search existed, so none of them has it
until it is set to enabled in `/admin` or they turn it on from the Gatekeepers page. The starter
also deploys two Workers the hosted flow does not: the example custom Gatekeeper and the Error
Reporter. Give those new names, or set `customGatekeeper.enabled: false` to deploy no custom
Gatekeeper; nothing depends on them yet.

Each optional Gatekeeper the hosted flow installed that the starter can deploy goes in
`gatekeepers` under its Worker's name, which the lookup writes. A deploy keeps its OAuth secrets but
replaces its plain vars, so copy any set on the hosted Worker (`GITLAB_URL`, `MCP_PORTAL_URL`) into
`gatekeepers.<slug>.vars`. Its OAuth redirect URI follows the public origin, so a new hostname has
to be added to each provider's OAuth app. See
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

By hand, confirm the names against `pnpm exec cf workers list` or the dashboard worker list rather
than assuming the pattern; the naming table in `packages/cf-os/src/core/naming.ts` is where this
repository records the hosted flow's.

## 5. Reuse the storage, and keep the URL

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

The Scheduler needs nothing here. Its state is entirely in its own Durable Objects, so section 4's
name is the whole of it. Web Search keeps no state worth migrating.

### The second trap: the Context sharing boundary

Right KV, wrong boundary, and the collections are still invisible. `context.sharingDomain` isolates
Context data, and the hosted flow sets it to the instance's **public origin** — the router's URL,
scheme included, such as `https://N.<subdomain>.workers.dev`.

`sharingDomain: null` reproduces that: the deploy derives it from the public origin, exactly as
hosted does. So the boundary survives as long as the origin does, which makes it one more reason to
keep the URL.

If you *do* move the instance to a new hostname, the derived value changes with it. Pin the old one
instead, so the boundary stays where the data is:

```jsonc
"context": { "sharingDomain": "https://N.<subdomain>.workers.dev" }
```

`publicBaseUrl` is the other half of this. It is the origin both `sharingDomain` and
`PUBLIC_BASE_URL` derive from: leave it `null` on a custom domain and the deploy takes the domain,
but on a `workers.dev` route it must be set explicitly — nothing in `deployment.jsonc` knows your
account's workers.dev subdomain. The lookup reads it; it does not guess it. The backend's own
`PUBLIC_BASE_URL` comes first, as where the instance itself says users reach it; failing that, the
hostname the Access application protects, or else the router Worker's own workers.dev address. The
report says which it used, and notes any two that disagree. By hand, it is the hosted instance's
exact URL, no trailing slash:

```jsonc
"publicBaseUrl": "https://N.<subdomain>.workers.dev"
```

`pnpm cf-os check` requires that value to be the router's own workers.dev origin —
`https://<workers.router.name>.<subdomain>.workers.dev` — because on this route there is no custom
domain to check it against, and a typo would quietly become both `PUBLIC_BASE_URL` and the Context
boundary.

### Your URL

The starter deploys the same topology as the hosted flow, router included, so the public origin is
the same router Worker in both. Either route type preserves the URL:

| Hosted URL | `deployment.jsonc` |
| --- | --- |
| `https://N.<subdomain>.workers.dev` | `"router": { "name": "N", "route": { "workersDev": true } }`, plus `publicBaseUrl` set to that URL |
| A custom domain you already moved it to | `"router": { "name": "N", "route": { "customDomain": "os.example.com" } }` |

Redeploying over the router is an in-place version update, like every other Worker here. There is no
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
- `providers` is the backend's own `CF_AI_GATEWAY_PROVIDERS`, so the providers you chose in the
  hosted flow carry over. Their keys live in the gateway's own Secrets Store, not in the Worker, so
  they survive the migration and keep working. A backend that carries no such variable leaves the
  list to you: add `"anthropic"` or `"openai"` if you stored keys on the gateway.
- A provider the backend advertises that the starter does not serve is written and noted, and
  `pnpm cf-os check` refuses the list until it is taken out.
- Adding `"google"` does require a token — see
  [AI models](customization.md#ai-models).

The gateway holds the provider keys, so one the backend points at under another name
(`CF_AI_GATEWAY`) is noted, not settled for you: check `aiGateway.name` before deploying.

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
- `access.admins`: the admins the instance has, read from the backend's `ADMINS` variable. `init`
  offers them as the answer to its admin question. On a backend that carries none, the list is yours
  to supply, and `init` offers the email `cf` is signed in as.

`pnpm cf-os check` confirms the application with that AUD exists and covers the router's hostname, and
that the issuer is this account's team. Do not run `pnpm cf-os access` for a migration: it would find
and reuse this same application, so it adds nothing, and the lookup already wrote both values.

The application already covers the hostname the router answers on, so keeping the URL keeps Access
working untouched. Only if you are moving the instance to a new hostname do you have to extend the
application to cover it — before deploying, along with `context.sharingDomain` from section 5 and
each optional Gatekeeper's redirect URI from section 4.

## 8. What changes, and what you lose

### Updates come from this repository

The hosted flow describes its install to the backend in a `CLOUDFLARE_OS_DEPLOYMENT` variable, which
is what makes `/admin` show an **Updates** tab offering newer releases through the hosted flow. A
takeover does not carry it over, on purpose: once this project deploys, the Updates tab goes away,
and updates are `npx cf-os@latest update` and a deploy from here. This is not a regression to work
around. A version you choose and review is the reason to eject, and two things deploying over the
same Workers would undo each other.

### Push notifications are kept, with two limits

Push notifications to phones and browsers go through a notification service the hosted flow
registered the instance with. The instance's identity there is four variables on the backend and
one secret, and a deploy sends a Worker only the variables in its config, so dropping them would
stop push. The takeover carries the identity over:

```jsonc
"pushIdentity": {
  "serviceUrl": "https://...",   // NOTIFICATION_SERVICE_URL
  "installId": "...",            // CFOS_INSTALL_ID
  "keyId": "...",                // CFOS_INSTALL_KEY_ID
  "webPushPublicKey": "..."      // NOTIFICATION_WEB_PUSH_PUBLIC_KEY; null offers no browser push
}
```

Every deploy sends those four again. The key that signs with them is the secret
`CFOS_INSTALL_PRIVATE_KEY` on the backend Worker, and the CLI never reads, writes or deletes it: a
deploy leaves a Worker's secrets in place, so the key stays bound as long as the Worker keeps its
name. It is never in `deployment.jsonc`, and a key added to the block is refused. The block is all
or nothing: `null` is a deployment without push, whose notifications reach open browser tabs only.
An instance that never had a push identity stays that way, and the report says so. The identity
belongs to the one installation: `pnpm cf-os init` setting up **A new deployment** over a file that
holds one sets the block to `null`, unless the new deployment is the same Workshop Worker in the same
account and that Worker may still be there to hold the key. A new deployment's name is one no Worker
in the account has, so that is only where the account's Workers could not be listed.

Two things only the hosted flow can do, so a taken-over deployment cannot:

- **Replace the key.** The secret is set by the hosted flow and there is no command here that
  rotates it. Deleting the backend Worker, or deploying under another name, loses it.
- **Refresh the registered origin.** The registration names the origin the instance had when the
  hosted flow made it. Move the instance to a new hostname and the registration still names the old
  one.

### Changes made by hand

A Worker whose live version is not one the hosted flow uploaded was changed by hand since: edited in
the dashboard, say, or deployed with Wrangler. The report lists each under **Workers
changed by hand**, with what the account says of that version (its id, the client that created it,
what triggered it, when), and the JSON has them as `handEdited`. A deploy replaces each of these
Workers' code, vars and bindings with the project's, so a change made by hand must go into
`deployment.jsonc` or the source first, or it is lost.

### Some Gatekeepers you installed through the hosted flow

The optional Gatekeepers the starter can deploy carry over (section 4). Two kinds do not, and the
lookup lists each with the reason:

- a **repeat install**, such as `N-gk-google2` beside `N-gk-google`: the starter deploys one
  Worker per Gatekeeper package;
- an **unknown** one: a Gatekeeper the pinned submodule does not have, or one the starter cannot
  deploy (upstream marks Email not installable, for one).

Either keeps running unbound, and disappears from the app with its users' connections; so does
one you leave out at the Gatekeeper question. Delete an orphaned Worker with
`CLOUDFLARE_ACCOUNT_ID=<account-id> pnpm exec wrangler delete --name <worker>` once nobody needs
it.

## 9. Verify

Beyond the [standard checks](../README.md#4-verify-the-deployment):

1. Sign in as an existing user and confirm the identity is recognised, not re-created.
   From a terminal, as an administrator, `pnpm cf-os api whoami` signs in through Access as you, and
   `pnpm cf-os api list-workspaces` should list the workspaces you had before the migration.
2. Open the model picker. It must list models — an empty picker means section 6 was skipped.
3. Open a gadget that existed before the migration, and confirm its history is intact.
4. Open the Context library and confirm its collections are still listed.
5. Confirm schedules made before the migration are still listed, and that a new one fires.
6. Send one message to confirm inference actually routes.
7. Turn Web Search on for your user (section 4), then ask an agent to search the web, and confirm
   results come back.
8. For each optional Gatekeeper carried over, confirm a connection made before the migration still
   works.
9. If the instance had push notifications, confirm one still arrives on a device that was
   subscribed before the migration.
10. Open `/admin` and confirm the Updates tab is gone (section 8).

If the model picker is empty or the app looks freshly installed, **stop before writing anything**.
Both are binding problems, not data loss: compare the deployed Worker names and resource IDs against
sections 4 and 5 rather than re-provisioning. `pnpm cf-os import N` shows what the account holds
next to what you deployed. Once this project has deployed, its Workers name no release, so give it
the commit they were deployed from, which is the commit the submodule is checked out at unless the
pin has moved since (a pin staged and not yet committed included):
`pnpm cf-os import N --commit $(git -C cloudflare-os rev-parse HEAD)`.
