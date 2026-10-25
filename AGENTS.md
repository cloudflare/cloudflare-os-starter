This repository deploys a self-hosted [Cloudflare OS](https://github.com/cloudflare/cloudflare-os): up to seven Workers, plus any optional Gatekeepers a deployment selects, configured by `deployment.jsonc` and built from the pinned `cloudflare-os` submodule.

* `cloudflare-os/`: upstream, pinned by the gitlink. Never edit it here; it changes only by moving the pin.
* `packages/cf-os`: the `cf-os` CLI (`pnpm cf-os <command>`), which configures, checks, deploys and updates the project. `src/core` is pure logic; Cloudflare API calls go through `src/cf-client.ts`.
* `pnpm exec cf-os api ...` drives a running instance through its API; start with `pnpm exec cf-os api search "<task>"`, which prints the matching commands as whole command lines (`--dry-run` connects to nothing). A command that returns a capability is chained with the next on one line (`open-workspace <id> list-chats`); exit 2 means the command must change before it runs again (nothing was sent, or the server asked a question it did not `--answer`, after its call was sent); `cf-os api types [<service>]` prints the API as TypeScript declarations. It runs the pin's own CLI, `cloudflare-os/packages/api-cli` (its README documents the commands; a pin without it fails naming `cf-os update`), so the commands are the pin's: there is nothing to generate or regenerate here. By default it calls the deployment's public origin (`--url` for another instance), and on a deployment only its admins may use it.
* `packages/custom-gatekeeper`, `packages/error-reporter`: this repository's own Workers.
* `.agents/skills/cloudflare-os-operator`: load it for anything touching a deployment: Access, `deployment.jsonc`, deploys, migrations, rollback.

Updating is always `cf-os update`, never a hand-moved gitlink or a hand-merged starter:

* `npx cf-os@latest update` merges the starter's `main` and checks out the pin it brings.
* `--upstream` (upstream's `main`) or `--to <commit|tag|branch>` stages a newer pin, uncommitted, for review; `--preview --to <branch|pull/N>` pins one for a preview only. In the starter repository itself there is no starter to merge, so `pnpm cf-os update --upstream` is the whole step.
* `--dry-run` first shows both commit ranges. Then carry out `.cf-os/update.md` and its checklist, `references/updating.md`, before committing the pin.

Checks:

* `pnpm lint` (lint, type-check, build) and `pnpm test` before pushing. `pnpm cf-os check` generates every Worker's config and dry-runs each deploy.
* `cf-os` tests are `node:test`: `node --test packages/cf-os/src/<file>.test.ts`. The Workers' tests run on Vitest.
* `pnpm cf-os deploy` deploys for real, with no confirmation: only when the operator asks.

IMPORTANT: This repository uses pnpm, not npm. The one exception is `npx cf-os@latest`, which fetches the newest published CLI.

IMPORTANT: A global or `npx` `cf-os` runs `main.ts`, `commands/scaffold.ts` and `commands/update.ts` from the published package, without the submodule. Nothing they import statically may reach `@gadgets/*`; `main.test.ts` checks it.

IMPORTANT: Results meant for scripts go to stdout as JSON; everything else, a spawned tool's output included, goes to stderr. Every prompt has a flag or config equivalent, and without a terminal a missing answer fails naming it.

Comments say what the code is and why, not what changed. A behaviour change updates the docs that describe it (`packages/cf-os/README.md`, `docs/`, the operator skill) in the same commit.
