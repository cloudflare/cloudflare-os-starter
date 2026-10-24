# Cloudflare OS Starter Upgrade And Rollback

Read the current checkout and current Cloudflare documentation before using this reference. Upgrade and rollback support changes over time.

## Upgrade Gate

Never advance the `cloudflare-os` submodule to a moving branch or an assumed latest release.

1. Record the current parent commit and full submodule gitlink.
2. Select an explicit full target commit from an approved source.
3. Prove the target commit's provenance and review release history plus the complete old-to-new diff.
4. Keep the parent and submodule worktrees clean except for the intentional gitlink/wrapper compatibility changes.
5. Retain the old gitlink, configs, Worker deployment IDs, resource identities, and compatibility notes.

`npx cf-os@latest update --upstream` selects upstream `main`'s exact SHA as the target, checks it out and stages it without committing. In a starter project it first merges the starter's `main`, committed, as a plain `update` does, and stages the pin on top: run plain `npx cf-os@latest update` and commit it first to keep the `--upstream` change a gitlink-only review. The selection is step 2's only: the rest of this gate, and the compatibility review below, still apply before the pin is committed. The brief it writes (`.cf-os/update.md`) records the old and new SHAs and the commit range for steps 1 and 3. [updating.md](updating.md) lists what an upstream range usually needs in this repository.

If using a mirror, prove the exact commit exists without changing the active checkout first. Use a temporary clone or fetch the exact full SHA from the approved mirror where supported, inspect the commit object, and compare it to the intended source. Do not alter `.gitmodules` or check out a nearby branch head as a test.

## Compatibility Review

Audit the old-to-new change for:

- Authentication and authorization behavior.
- Shared RPC APIs and Gatekeeper contracts.
- Durable Object classes, migration tags, and storage schemas.
- Workshop, Router, and Gatekeeper Wrangler base configs, including any Gatekeeper newly added to upstream's `PREINSTALL` (`cloudflare-os/scripts/release/manifest-lib.ts`). A new one arrives as optional unless the catalog excludes it; see `references/updating.md`. Either way, report it.
- Required vars, secrets, service bindings, KV, R2, assets, compatibility flags, and migrations.
- AI transport, providers, billing, and logging.
- Error reporting and frontend reporting.
- Dependencies, lockfiles, build commands, and generated artifacts.
- The submodule's `capnweb`, `typescript` and `@cloudflare/workers-types` catalog versions, and its build scripts vs Vite+ tasks.

Inspect every base-config section that `generateConfigs()` (`packages/cf-os/src/core/deployment.ts`) replaces or reconstructs. New upstream fields can otherwise be silently dropped. Generate and review sanitized old/new derived-config diffs, but never commit or hand-edit generated Wrangler files.

Two of those deserve their own step, because both fail quietly:

- **Types across the `link:` boundary.** The starter's packages depend on the submodule's (`@gadgets/workshop-shared`, `@gadgets/error-reporting`, `@gadgets/scripts`) through `link:`, not as workspace members. So the submodule's dependencies come from its own lockfile, and the starter's catalog does not govern them. Only the versions whose types cross the link have to agree: `capnweb`, `typescript` and `@cloudflare/workers-types`. A differing `capnweb` resolves a second copy, and a stub minted by one copy is unserialisable by the other's session. A deduped dev machine hides that, while the two separate installs in CI do not. Compare those three with `cloudflare-os/pnpm-workspace.yaml` as part of the gitlink change.
- **Build scripts becoming Vite+ tasks.** `buildCommands()` (`packages/cf-os/src/core/deployment.ts`) reaches every build through `vp run --no-cache <task>`, which runs scripts and tasks alike, because `pnpm --filter` cannot see a task. If an upstream package converts its `build` script to a task, or its `build` script starts spawning a nested cached `vp run` of its own, check that `buildCommands()` still rebuilds from source rather than replaying an archived artifact. `packages/cf-os/src/core/deployment.test.ts` asserts the flag but cannot see a nested invocation.

Update only the gitlink unless a specific reviewed wrapper compatibility change is required. Run `pnpm install`. Its `postinstall` (`cf-os install`) reinstalls `cloudflare-os/` from the submodule's lockfile (frozen), and `optimisticRepeatInstall: false` makes it run even though the starter's own lockfile is unchanged. Then run `pnpm lint`, `pnpm cf-os check`, plus the relevant upstream tests and type checks. Every build, test and deploy entry point runs `cf-os install --check` first, so a skipped hook stops them with the fix rather than a missing-module error.

## Migration Plan

Any Durable Object class, migration, or storage-schema change requires specialist review and a written plan containing:

```text
old and new migration tags/classes:
additive, destructive, or irreversible changes:
old code reading new state:
new code reading old state:
deployment order and mixed-version window:
production-shaped rehearsal:
backup/export feasibility:
post-migration validation:
forward-repair plan:
rollback restrictions:
```

An empty staging Durable Object does not prove existing production data will migrate correctly. Use representative, non-sensitive data and explicitly record any production-only uncertainty. Do not claim rollback across a migration until current Cloudflare constraints and the exact migration path prove it.

## Isolated Evaluation

A separate worktree prevents generated-file races; it does not isolate deployed infrastructure.

Use independently named evaluation Workers, a separate protected route/Access application, non-production KV/R2 resources, a distinct Context sharing domain, isolated Gatekeeper accounts/data, and a separate AI/observability cost and privacy policy. Never point an upgrade rehearsal at production storage merely to make it realistic.

Verify Access, `/admin`, existing-data behavior with representative fixtures, AI mode, Context, Gatekeepers, Reporter, logs, and every service binding before requesting production approval.

## Production Upgrade

1. Inventory current version IDs and bindings for every affected Worker.
2. Prove downstream changes remain compatible with the old Workshop during the non-atomic deployment window.
3. For breaking contracts, use parallel Worker identities and a controlled binding switch.
4. Present the complete mutation summary and rollback matrix.
5. Obtain explicit approval.
6. Run the current checkout's deployment command once.
7. Record each successful stage and stop on first failure.
8. Run the full live verification before widening Access or declaring success.

## Rollback Matrix

For every changed Worker, record:

```text
Worker and current/previous deployment IDs:
dependent and depending services:
binding/config changes:
secret changes:
migration/storage constraints:
data written by the new version:
rollback or forward-repair action:
operation order:
validation evidence:
```

Worker version rollback does not restore Access policies, DNS, bindings, secrets, provisioned resources, KV/R2 data, or all Durable Object changes.

- Prefer restoring the complete known-good wrapper configuration and pinned submodule, then redeploying a compatible stack when contracts or bindings changed.
- Use targeted Worker version rollback only when code and current bindings/storage remain compatible.
- Never delete or downgrade storage as an automatic rollback step.
- A partially completed first deployment needs safe completion or separately approved teardown, not a fictional rollback.
- If migration or data changes make rollback unsafe, contain exposure and execute the reviewed forward-repair plan.
- Repeat the complete Access, binding, storage, Gatekeeper, AI, Reporter, and observability verification after any recovery.

## Current Documentation

Retrieve current guidance rather than relying on remembered behavior:

- Access applications: `https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/`
- Access policies: `https://developers.cloudflare.com/cloudflare-one/access-controls/policies/`
- Custom domains: `https://developers.cloudflare.com/workers/configuration/routing/custom-domains/`
- workers.dev routes: `https://developers.cloudflare.com/workers/configuration/routing/workers-dev/`
- Preview URLs: `https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/`
- Wrangler profiles and account selection: `https://developers.cloudflare.com/workers/wrangler/profiles/`
- Wrangler automatic provisioning: `https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning`
- Worker secrets: `https://developers.cloudflare.com/workers/configuration/secrets/`
- AI Gateway authentication: `https://developers.cloudflare.com/ai-gateway/configuration/authentication/`
- AI Gateway observability: `https://developers.cloudflare.com/ai-gateway/observability/`
- Workers observability: `https://developers.cloudflare.com/workers/observability/`
- Worker rollback: `https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/`
