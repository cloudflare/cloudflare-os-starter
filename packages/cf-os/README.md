# cf-os

The command line for a self-hosted [Cloudflare OS](https://github.com/cloudflare/cloudflare-os): it scaffolds a project from the [starter](https://github.com/cloudflare/cloudflare-os-starter), configures its `deployment.jsonc`, and checks and deploys it.

```sh
pnpm cf-os init                  # inside a project: configure it, then offer to deploy
pnpm cf-os check                 # validate, check the account, test, build, dry-run every deploy
pnpm cf-os deploy                # the same, then deploy for real
npx cf-os init my-os             # no clone yet: create one in ./my-os, then the same init
npx cf-os@latest update          # inside a project: merge the starter's latest into it
npx cf-os@latest update --upstream  # any repository pinning Cloudflare OS: stage upstream's main
```

Inside the starter it is the `packages/cf-os` workspace package, and `pnpm cf-os <command>` runs it: fork or clone the starter, `pnpm install`, then `pnpm cf-os init`. `npx cf-os init` is for when you have not cloned it yet. It clones the starter's `main` branch (`--ref <branch>` and `--template <url|path>` pick another branch or a fork), installs, offers to create a private GitHub repository for it, and runs the project's own `pnpm cf-os init`.

## Commands

| Command | What it does | Account |
| --- | --- | --- |
| `init [<dir>]` | Outside a project: clones the starter into `<dir>` (`origin` renamed to `starter`), installs, offers to create a private GitHub repository with `gh` and push to it (running `gh auth login` first if needed), then configures it. Inside one: offers the `cf` sign-in, configures it as a new deployment or as the takeover of a hosted instance, and, once nothing is left as a placeholder, offers the Wrangler sign-in and to deploy. It asks which Gatekeepers to deploy beside Context, Scheduler and Web Search: the example custom one, and any of the optional Gatekeepers the `cloudflare-os` submodule offers (GitHub, Slack, ...), preselecting those a taken-over instance already runs, by the hosted flow's names or, when the file's `workers.router.name` is the instance, by the file's own, and asking which to bind where the two name different Workers. For each new one that needs OAuth credentials it prints upstream's setup steps, the redirect URI and the `wrangler secret put` commands; for one the instance already runs, which keeps its secrets but not plain vars set outside `gatekeepers.<slug>.vars`, the redirect URI its OAuth app must list, which moves with the public origin. A takeover that finds no public origin prints `<PUBLIC_ORIGIN>` in its place. `--template`, `--ref` and `--out` | Reads; creates the Access application and a One-time PIN provider, and deploys, only if you choose to |
| `import [<instance>]` | Finds what a hosted-deploy instance runs and prints the `deployment.jsonc` values that redeploy over it, including `gatekeepers.<slug>.name` for each optional Gatekeeper the starter can deploy; the report lists, with the reason, the `<instance>-gk-*` Workers it cannot (a second install of one, or one the submodule does not offer), and notes that a deploy replaces the found ones' plain vars, which it cannot read, so any set on them go into `gatekeepers.<slug>.vars`. `--out <path>` writes them; into a file whose `workers.router.name` is another, it also removes the `gatekeepers` entries it did not find for the instance, which may be another deployment's, and lists them | Read-only |
| `access [--dry-run]` | Finds or creates the Access application for the router's hostname, and writes `access.issuer` and `access.audience` | Creates one application, unless one already names the hostname. A wildcard one covering it is reported, not reused |
| `check` | Validates the file (each selected optional Gatekeeper against the submodule's catalog), checks the account has what it names, runs the tests and builds, and dry-runs every deploy. Warns, without failing, when an optional Gatekeeper's Worker lacks one of its OAuth secrets, or is not deployed yet, with the `wrangler secret put` command and the redirect URI; `deploy` warns the same way before its build | Read-only |
| `deploy` | The same, then deploys every Worker. No confirmation. On the unconfigured template at a terminal, offers `init` first and then carries on | Deploys |
| `update` | Merges the starter's `main` into the project, fetched from its URL (no remote needed), checks the `cloudflare-os` submodule out at the pin it brings, runs `pnpm install`, and writes `.cf-os/update.md`: both commit ranges, the commits that change the Gatekeeper contract, any conflicts (left to git), and steps for a coding agent to finish and summarise the update, in the order the work usually goes (install and catalog, then Gatekeepers). `--upstream` then moves the submodule on to upstream's `main`, staged and not committed, for review, with the merge itself committed. `--to <ref>` does the same for a given commit, tag or branch on `main`: one with green CI, the fix for a broken `main`, a step part of the way, or an older commit, which the brief treats as a rollback. With `--preview`, `--to` also takes an upstream branch or pull request (`pull/796`; `#796` only quoted, as a shell reads the rest of the line after `#` as a comment) that is not on `main`, for a merge request's preview deploy: the brief says to commit it on that branch only, lists any commits the current pin has that the branch lacks, and says to move the pin to `main` before merging. In any other repository that pins Cloudflare OS (no `deployment.jsonc` at its root), it moves the pin alone: `--upstream` is required, nothing is merged, and the brief points at the guide on the starter's `main`. The submodule is the one `.gitmodules` points at upstream with, or `--submodule <path>`. `--ref`, `--template` and `--dry-run` | None |
| `install [--check]` | Installs the `cloudflare-os` submodule's own workspace; the root `postinstall` runs it | None |

Every command takes `--config <path>` (default: `deployment.jsonc` in the project root), `--account <id>` (the account `init` and `import` use, ahead of the file's `accountId`; `check`, `deploy` and `access` refuse one other than the file's), `--profile <name>` (passed to every `cf` call), and `--help`. It works from any directory inside the project.

Optionally, instead of signing in, set `CLOUDFLARE_API_TOKEN` to a token with Access: Apps and Policies Edit and Access: Organizations, Identity Providers, and Groups Read (Edit, for `init` to add a One-time PIN provider), plus Read on Workers Scripts, Workers KV Storage, Workers R2 Storage, AI Gateway, Zone and DNS.

## Output and prompts

Results meant for scripts are JSON on stdout: `import`'s values, `access`'s issuer and audience, the request a `--dry-run` would send, and what `update` did (whether the pin moved and was staged, the merge, the install, the brief's path and anything left to do; it exits 1 when something is left, even with the pin moved). Without a terminal, `update` holds back `pnpm install`'s output and shows only its end, if it fails. Everything else goes to stderr. Exit codes are 0 for success, 1 for failure, and 130 for a cancelled prompt.

Questions are asked only when stdin and stdout are both terminals and `CI` is unset, the same rule `cf` follows. Every question has a flag or config equivalent. Without a terminal, a missing answer fails and names the flag to pass, and `init` points at `import` and `access` instead, or at editing `deployment.jsonc` by hand: `init`'s Gatekeeper question is the file's `gatekeepers` block and `customGatekeeper.enabled`.

## A global `cf-os`

Installed globally (`npm i -g cf-os`), `cf-os` only scaffolds and updates. Inside a project it hands every other command to the project's own copy, so the deploy logic matches the `cloudflare-os` version the project pins, the way a global `cf` defers to a project-local one.

`update` is the exception because it is what brings that copy up to date, so it runs in whichever copy you start. Use `npx cf-os@latest update` to get the newest; `pnpm cf-os update` runs the project's current one. It also runs outside a project: in a repository that pins Cloudflare OS without descending from the starter, `npx cf-os@latest update --upstream` is the whole interface, with nothing added to the repository but the ignored `.cf-os/`.
