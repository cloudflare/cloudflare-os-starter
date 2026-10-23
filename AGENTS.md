This repository deploys a self-hosted [Cloudflare OS](https://github.com/cloudflare/cloudflare-os): up to seven Workers, plus any optional Gatekeepers a deployment selects, configured by `deployment.jsonc` and built from the pinned `cloudflare-os` submodule.

* `cloudflare-os/`: upstream, pinned by the gitlink. Never edit it here; it changes only by moving the pin.
* `packages/cf-os`: the `cf-os` CLI (`pnpm cf-os <command>`), which configures, checks, deploys and updates the project. `src/core` is pure logic; Cloudflare API calls go through `src/cf-client.ts`.
* `pnpm exec cf-os api ...` drives a running instance through its API; start with `pnpm exec cf-os api search "<task>"`, which prints the matching commands as whole command lines (`--dry-run` connects to nothing). A command that returns a capability is chained with the next on one line (`open-gadget <id> list-chats`); exit 2 means nothing was sent; `cf-os api types [<service>]` prints the API as TypeScript declarations. Its commands are generated from the pin's `packages/api-schema` (cloudflare/cloudflare-os#860; an older pin fails naming it) into `packages/cf-os/src/api/generated`: never edit them; `cf-os update` regenerates them, and after moving the pin any other way run `pnpm api:generate`.
* Local demo instance (this branch only): `cloudflare-os`'s `pnpm dev-server` on `http://localhost:8787`. Sign in as a user with `pnpm exec cf-os api --url http://localhost:8787 --username <name> <command>...`; every account's password is in `CFOS_API_PASSWORD`. Accounts: `admin` (a deployment admin: `get-admin-api ...`, passing `get-admin-api --options '{"via":"cli"}'` so the audit log says the CLI), `alice` and `bob` (ordinary users). To act as someone, sign in as them; accounts cannot be created through the CLI. An admin opens another user's workspace only through `get-admin-api inspect-workspace <id> <reason>`, which is audited; content needs `--options '{"access":"full"}'` on that call.
* `packages/custom-gatekeeper`, `packages/error-reporter`: this repository's own Workers.
* `.agents/skills/cloudflare-os-operator`: load it for anything touching a deployment: Access, `deployment.jsonc`, deploys, migrations, rollback.

Updating is always `cf-os update`, never a hand-moved gitlink or a hand-merged starter:

* `npx cf-os@latest update` merges the starter's `main` and checks out the pin it brings.
* `--upstream` (upstream's `main`) or `--to <commit|tag|branch>` stages a newer pin, uncommitted, for review; `--preview --to <branch|pull/N>` pins one for a preview only. In the starter repository itself there is no starter to merge, so `pnpm cf-os update --upstream` is the whole step.
* `--dry-run` first shows both commit ranges. Then carry out `.cf-os/update.md` and its checklist, `references/updating.md`, before committing the pin.

Checks:

* `pnpm lint` (lint, type-check, build, and `api:check`: the generated API files match the pin) and `pnpm test` before pushing. `pnpm cf-os check` generates every Worker's config and dry-runs each deploy.
* `cf-os` tests are `node:test`: `node --test packages/cf-os/src/<file>.test.ts`. The Workers' tests run on Vitest.
* `pnpm cf-os deploy` deploys for real, with no confirmation: only when the operator asks.

IMPORTANT: This repository uses pnpm, not npm. The one exception is `npx cf-os@latest`, which fetches the newest published CLI.

IMPORTANT: A global or `npx` `cf-os` runs `main.ts`, `commands/scaffold.ts` and `commands/update.ts` from the published package, without the submodule. Nothing they import statically may reach `@gadgets/*`; `main.test.ts` checks it.

IMPORTANT: Results meant for scripts go to stdout as JSON; everything else, a spawned tool's output included, goes to stderr. Every prompt has a flag or config equivalent, and without a terminal a missing answer fails naming it.

Comments say what the code is and why, not what changed. A behaviour change updates the docs that describe it (`packages/cf-os/README.md`, `docs/`, the operator skill) in the same commit.
