# Updating From The Starter

`npx cf-os@latest update` merges the starter's `main` into the project, checks the `cloudflare-os` submodule out at the pin that merge brings, installs, and writes `.cf-os/update.md`: both commit ranges, what conflicted, and the steps to finish. In a repository that pins Cloudflare OS without being a starter project, `npx cf-os@latest update --upstream` moves the pin alone. This reference is the checklist the brief's steps point at. Work through it against the ranges in the brief, then report to the operator.

## Which Path You Are On

- **Default: the starter's pin.** The starter has already adapted `packages/cf-os` and its shared code to that pin. The work is mostly merge conflicts in files the operator owns (`deployment.jsonc`, branding, docs they edited), plus the operator's own Gatekeepers, such as `packages/custom-gatekeeper`, which the starter cannot adapt for them.
- **`--upstream`: upstream's `main`, staged and not committed,** on top of the starter merge, which is committed. The starter has not seen this pin yet, so everything below may apply to `packages/cf-os` itself as well. Follow [upgrade-and-rollback.md](upgrade-and-rollback.md) before committing the pin.
- **Not a starter project: the pin alone.** A repository with its own config generation, build and deploy scripts that pins Cloudflare OS as a submodule, wherever it keeps it. There is no starter merge, only upstream's `main`, staged and not committed. The generic sections below apply as written. Sections marked *(starter)* describe the starter's own machinery (`generateConfigs()`, `PACKAGE_DIRS`, the new-Gatekeeper list, `buildCommands()`): map each onto this repository's equivalent. Follow [upgrade-and-rollback.md](upgrade-and-rollback.md) the same way before committing the pin.

## Most Updates Need Nothing Beyond The Merge: Prove It

Check the upstream range for each of the following. When none of them touches this repository, say so in the summary, and say which you checked:

- Gatekeeper contract changes.
- Base Wrangler config changes for the Workers the starter deploys.
- Catalog changes to the versions this repository has to match.
- A new preinstalled Gatekeeper or Worker.
- Build tooling changes.
- Renamed paths, packages or variables.

## Gatekeeper Contract Changes

The most common real work. The operator's Gatekeepers implement upstream's Gatekeeper RPC contract (`@gadgets/workshop-shared/gatekeeper`) and use its helpers. Upstream changes to it take several forms: a newly required method, a new parameter, a renamed field, or a new rule, such as what a Gatekeeper's types file may import.

Migrate every implementation and its tests in one pass, not the first one that fails. `pnpm lint`'s type-check and the tests catch most of it. They do not catch a non-class named export from a Worker's main module: that breaks Worker startup, and only shows once the Worker runs.

## Catalog Alignment

`capnweb`, `typescript` and `@cloudflare/workers-types` in this repository's catalog must match `cloudflare-os/pnpm-workspace.yaml`, because their types cross the `link:` into the submodule. Mirror the Wrangler and Vitest pool versions too, for the packages here that use them.

A dependency's new major can need code changes as well as a version bump, such as a `capnweb` release changing how callbacks cross RPC. After Wrangler or workers-types bumps, regenerate each package's `worker-configuration.d.ts` with `pnpm exec wrangler types`.

## Base Wrangler Configs And Vars *(starter)*

`generateConfigs()` (`packages/cf-os/src/core/deployment.ts`) rebuilds sections of upstream's base configs rather than copying them. Read the range's diffs of the base configs, and of each Worker's `src/env.d.ts`, for:

- New required vars. Some fail closed at runtime, not at deploy.
- Renamed vars.
- Vars a Worker reads that no base config declares, in `env.d.ts` or as `env.X ?? <default>` in its code. Upstream's deploy service sets these itself, so `generateConfigs()` has to as well, and nothing fails without them: Web Search's `CF_AI_GATEWAY` silently falls back to `default`.
- New bindings.
- Routes that need adding to lists the starter overrides, such as `assets.run_worker_first`.
- Optional Gatekeepers' configs are upstream's plus the common block, their `vars` and `BASE_URL`; a var upstream's deploy service starts setting for them goes in `generateConfigs()`, and a new `var` input fails `check` until `gatekeepers.<slug>.vars` sets it (`init` does not ask).
- A change in how upstream produces its configs.

`pnpm cf-os check` generates and validates the configs, so it is the test for this section.

## A New Upstream Gatekeeper Or Worker *(starter)*

The starter's own Workers are a fixed set; upstream's other Gatekeepers come from the catalog (`packages/cf-os/src/gatekeeper-catalog.ts`), so a new one, even a new `PREINSTALL`, arrives as optional unless the catalog excludes it, which `check` reports. Say which in the summary. Making one built-in, to keep the hosted topology or deploy an excluded one, needs all of:

- A `PACKAGE_DIRS` entry.
- Bindings to it from the Workshop and the router in `generateConfigs()`.
- A build step in `buildCommands()`.
- A place in `deployWaves()`.
- A row in `packages/cf-os/src/core/naming.ts`.
- A `workers` entry in `deployment.jsonc`, and in the template the starter ships.
- Any secrets it requires.
- Provisioning for any storage it declares, as `deployment.ts` does for Context's KV.

The naming row also makes its slug a built-in one, so a deployment that had selected it under `gatekeepers` fails `check` until the entry moves to `workers`.

A selected Gatekeeper the new pin excludes fails `check` on `gatekeepers.<slug>` with the reason. Report it to the operator, and do not work around it in `deployment.jsonc`.

A `gatekeeper-*` package without a `wrangler.jsonc` is a library, not a Worker.

## Build Tooling *(starter)*

Watch for upstream turning a package's `build` script into a Vite+ task, or changing the shape of its vite-plus config. A task and a script with the same name break the task graph. A filter that matches nothing exits 0, so the deploy ships the old bundle. Check that `buildCommands()` still rebuilds every package from source. An optional Gatekeeper is built in one step, `vp run -F <package name> --no-cache build`, which relies on its `build` task depending on `build:configurator` (`cloudflare-os/scripts/gatekeeper-configurator-vite-config.ts`); if that dependency goes, it needs its own step.

## Renames

Grep this repository for every path, package name and environment variable the upstream diff renames. A package renamed by the merge can leave its untracked `node_modules/` and `dist/` behind in the old directory; delete those.

## Process

- Pin only commits on upstream's `main`, ideally with its CI green. If upstream `main` is broken (a bad lockfile, say), take the commit that fixes it. `update --to <commit>` pins a given commit on `main`, and refuses one that is not.
- Several updates in a row, to pick up an upstream fix, are normal. A repository far behind can go in steps the same way, with `--to` an intermediate commit, so each migration stays small.
- To preview an upstream branch or pull request in a merge request's preview deploy, `update --to <branch|pull/N> --preview` stages it. Commit it on the merge request's branch only, and move the pin to the merged commit on `main` before merging. If the branch left `main` before the current pin, the brief lists what the preview leaves out: rebase the upstream branch rather than undo this repository's changes.
- Rolling back is `update --to <older commit>`: the brief lists the commits that leave and points at [upgrade-and-rollback.md](upgrade-and-rollback.md)'s Rollback Matrix.
- Keep fixes in their own commits after the merge commit, so the update itself stays reviewable.
- Finish with `pnpm lint` and `pnpm cf-os check`, or, outside a starter project, the repository's own lint, tests and build. Deploy only once the operator approves.
