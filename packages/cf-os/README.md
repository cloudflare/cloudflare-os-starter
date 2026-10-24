# cf-os

The command line for a self-hosted [Cloudflare OS](https://github.com/cloudflare/cloudflare-os): it scaffolds a project from the [starter](https://github.com/cloudflare/cloudflare-os-starter), configures its `deployment.jsonc`, checks and deploys it, and drives the running instance through its API.

```sh
pnpm cf-os init                  # inside a project: configure it, then offer to deploy
pnpm cf-os check                 # validate, check the account, test, build, dry-run every deploy
pnpm cf-os deploy                # the same, then deploy for real
pnpm cf-os secrets               # set the optional Gatekeepers' OAuth credentials
npx cf-os init my-os             # no clone yet: create one in ./my-os, then the same init
npx cf-os@latest update          # inside a project: merge the starter's latest into it
npx cf-os@latest update --upstream  # any repository pinning Cloudflare OS: stage upstream's main
pnpm cf-os api list-gadgets      # call the running instance's API: here, list its workspaces
```

Inside the starter it is the `packages/cf-os` workspace package, and `pnpm cf-os <command>` runs it: fork or clone the starter, `pnpm install`, then `pnpm cf-os init`. `npx cf-os init` is for when you have not cloned it yet. It clones the starter's `main` branch (`--ref <branch>` and `--template <url|path>` pick another branch or a fork), installs, offers to create a private GitHub repository for it, and runs the project's own `pnpm cf-os init`.

## Commands

| Command | What it does | Account |
| --- | --- | --- |
| `init [<dir>]` | Outside a project: clones the starter into `<dir>` (`origin` renamed to `starter`), installs, offers to create a private GitHub repository with `gh` and push to it (running `gh auth login` first if needed), then configures it. Inside one: offers the `cf` sign-in, configures it as a new deployment or as the takeover of a hosted instance, and, once nothing is left as a placeholder, offers the Wrangler sign-in and to deploy. It asks which Gatekeepers to deploy beside Context, Scheduler and Web Search, preselecting those a taken-over instance runs, and, once you choose to deploy, each new OAuth one's credentials, which the deploy sets. Until the file is written, Esc goes back a question. `--template`, `--ref` and `--out` | Reads; creates the Access application and a One-time PIN provider, sets Gatekeeper secrets, and deploys, only if you choose to |
| `import [<instance>]` | Finds what a hosted-deploy instance runs and prints the `deployment.jsonc` values that redeploy over it, including `gatekeepers.<slug>.name` for each optional Gatekeeper it found. `--out <path>` writes them | Read-only |
| `access [--dry-run]` | Finds or creates the Access application for the router's hostname, and writes `access.issuer` and `access.audience` | Creates one application, unless one already names the hostname. A wildcard one covering it is reported, not reused |
| `secrets [<slug>...]` | Asks for, masked, the OAuth credentials an optional Gatekeeper's Worker lacks (every selected one by default) and sets them with `wrangler secret bulk` on stdin, never argv or a file. Prints the names set as JSON. Never creates a Worker; without a terminal, names the `wrangler secret put` commands | Sets secrets on existing Gatekeeper Workers; never creates one |
| `check` | Validates the file, checks the account has what it names, runs the tests and builds, dry-runs every deploy, and warns, without failing, about optional Gatekeeper secrets not set yet and an unset `MCP_PORTAL_URL` | Read-only |
| `deploy` | The same, then deploys every Worker. No confirmation. On the unconfigured template at a terminal, offers `init` first and then carries on | Deploys |
| `update` | Merges the starter's `main` into the project, fetched from its URL (no remote needed), checks the `cloudflare-os` submodule out at the pin it brings, runs `pnpm install`, and writes `.cf-os/update.md`: both commit ranges, the commits that change the Gatekeeper contract, any conflicts (left to git), and steps for a coding agent to finish and summarise the update, in the order the work usually goes (install and catalog, then Gatekeepers). When the pin moves, the brief also names the diff of upstream's generated [`cf-os api`](#driving-an-instance-cf-os-api) commands (`packages/api-cli/generated`), as a removed or changed command breaks whatever calls it; there is nothing to regenerate. `--upstream` then moves the submodule on to upstream's `main`, staged and not committed, for review, with the merge itself committed. `--to <ref>` does the same for a given commit, tag or branch on `main`: one with green CI, the fix for a broken `main`, a step part of the way, or an older commit, which the brief treats as a rollback. With `--preview`, `--to` also takes an upstream branch or pull request (`pull/796`; `#796` only quoted, as a shell reads the rest of the line after `#` as a comment) that is not on `main`, for a merge request's preview deploy: the brief says to commit it on that branch only, lists any commits the current pin has that the branch lacks, and says to move the pin to `main` before merging. In any other repository that pins Cloudflare OS (no `deployment.jsonc` at its root), it moves the pin alone: `--upstream` is required, nothing is merged, and the brief points at the guide on the starter's `main`. The submodule is the one `.gitmodules` points at upstream with, or `--submodule <path>`. `--ref`, `--template` and `--dry-run` | None |
| `api [public] <command> [<arguments>]...` | Calls the running instance's API, the one its frontend uses, with the pinned `cloudflare-os`'s own CLI: each command calls a method on what the one before returned, so `open-gadget <id> get-chat-history <chatId>` reads a workspace's chat, and `api search "<task>"` finds the command line for a task. See [Driving an instance](#driving-an-instance-cf-os-api) | None: it acts on the instance, as the user it signs in as (on a deployment, an admin) |
| `install [--check]` | Installs the `cloudflare-os` submodule's own workspace; the root `postinstall` runs it | None |

Every command takes `--config <path>` (default: `deployment.jsonc` in the project root; `api` takes its default instance from it), `--account <id>` (the account `init` and `import` use, ahead of the file's `accountId`; `check`, `deploy`, `access` and `secrets` refuse one other than the file's), `--profile <name>` (passed to every `cf` call), and `--help`. It works from any directory inside the project.

Optionally, instead of signing in, set `CLOUDFLARE_API_TOKEN` to a token with Access: Apps and Policies Edit and Access: Organizations, Identity Providers, and Groups Read (Edit, for `init` to add a One-time PIN provider), plus Read on Workers Scripts, Workers KV Storage, Workers R2 Storage, AI Gateway, Zone and DNS.

## Output and prompts

Results meant for scripts are JSON on stdout: `import`'s values, `access`'s issuer and audience, the names of the secrets `secrets` set, the request a `--dry-run` would send, and what `update` did (whether the pin moved and was staged, the merge, the install, the brief's path and anything left to do; it exits 1 when something is left, even with the pin moved). `cf-os api`'s output and exit codes are the pinned CLI's: its result as JSON, and exit 2 for a command that must change before it runs again (it sent nothing, or left a question from the server unanswered after its call was sent). Without a terminal, `update` holds back `pnpm install`'s output and shows only its end, if it fails. Everything else goes to stderr. Exit codes are 0 for success, 1 for failure, and 130 for a cancelled prompt.

Questions are asked only when stdin and stdout are both terminals and `CI` is unset, the same rule `cf` follows. At a terminal, a step waiting on Cloudflare shows a spinner. Every question has a flag or config equivalent. Without a terminal, a missing answer fails and names the flag to pass, and `init` points at `import` and `access` instead, or at editing `deployment.jsonc` by hand: `init`'s Gatekeeper question is the file's `gatekeepers` block and `customGatekeeper.enabled`. `secrets` names the `wrangler secret put` commands, which ask for each value themselves.

## Driving an instance: `cf-os api`

`cf-os api` calls a running instance's [Cap'n Web](https://github.com/cloudflare/capnweb) API, the one its frontend uses, so an agent can list workspaces, read chats, approve actions and open Gatekeeper sessions without a browser. It is the pinned `cloudflare-os`'s own CLI, `cloudflare-os/packages/api-cli`, which `cf-os api` runs with every argument but the global `--config`, `--account` and `--profile`, so its commands, help, output and exit codes are always the pin's. Its README, [`cloudflare-os/packages/api-cli/README.md`](https://github.com/cloudflare/cloudflare-os/blob/main/packages/api-cli/README.md), documents the commands, chaining, arguments, results, `--answer`, `types`, `create-account` and signing in.

```sh
pnpm exec cf-os api search "list chats"   # the commands for a task, whole command lines as JSON (connects to nothing)
pnpm exec cf-os api --help                # the commands, and the default instance or why there is none (connects to nothing)
pnpm exec cf-os api whoami                # who the session signed in as, on the deployment
pnpm exec cf-os api open-gadget <id> get-chat-history <chatId> --dry-run  # the calls, as JSON; connects to nothing
pnpm exec cf-os api whoami --url http://localhost:8787 --username <name>  # another instance: a dev server
```

What the starter adds:

- **The default instance** is the deployment's public origin, from `deployment.jsonc` (or `--config`), when it is an `https://` origin and nothing else, as deploy requires of `publicBaseUrl`. Otherwise (the file is not configured yet, unreadable, names no origin, or names one that is not `https://`) a run that needs an instance fails, exit 2, saying why and to pass `--url <origin>`, which names any other instance.
- **On a deployment, only its admins may use it.** The instance refuses every other sign-in, and every call that signs no one in, with `On this deployment the cf-os CLI is limited to deployment admins (anything goes on a local dev server).` Behind Access, sign in as an admin's identity with `cloudflared access login <origin>`. A local dev server allows anyone.
- **Before it runs**, the pin must have the CLI (a pin from before it moved upstream fails naming `cf-os update`), and the submodule's workspace must be installed for the pin (``Run `pnpm cf-os install`.``). It runs only inside a project, in the project's own copy, so even with `--url` its commands are those of the project's pin, and there is nothing in this repository to regenerate when the pin moves.

## A global `cf-os`

Installed globally (`npm i -g cf-os`), `cf-os` only scaffolds and updates. Inside a project it hands every other command to the project's own copy, so the deploy logic, and `api`'s commands, match the `cloudflare-os` version the project pins, the way a global `cf` defers to a project-local one.

`update` is the exception because it is what brings that copy up to date, so it runs in whichever copy you start. Use `npx cf-os@latest update` to get the newest; `pnpm cf-os update` runs the project's current one. It also runs outside a project: in a repository that pins Cloudflare OS without descending from the starter, `npx cf-os@latest update --upstream` is the whole interface, with nothing added to the repository but the ignored `.cf-os/`.
