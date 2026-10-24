// Vite+ tasks for the `cf-os` CLI: `build` type-checks it (nothing is emitted; `node` runs the
// sources), and `test` runs its `node --test` suites.
//
// `test` is upstream's `@gadgets/scripts` test task (cloudflare-os/scripts/vite.config.ts), copied:
// `node --test` rather than vitest, so only the watchdog part of the shared vitest task applies.
// `cwd: '../..'` because several suites are repository-wide guards rather than unit tests of this
// directory -- they read the root manifests, `pnpm-workspace.yaml`, the base Wrangler configs under
// `cloudflare-os/` and `packages/` -- and name those paths from the repository root.

import { TESTS_WITH_TIMEOUT_ENV, withTestTimeout } from '@gadgets/scripts/vitest-task'

export default {
  run: {
    tasks: {
      build: {
        command: 'tsc -p tsconfig.json',
        cache: {
          // Listed, not left to `{ auto: true }` alone: vp's automatic tracking does not see what tsc
          // (tsgo) reads, so with auto alone a type error replays the last cached pass. The types it
          // reads from elsewhere are upstream's scripts (the type-only `manifest-lib` import) and
          // dependencies, whose versions the lockfile pins.
          input: [
            { auto: true },
            { pattern: 'src/**/*.ts', base: 'package' },
            { pattern: '{package.json,tsconfig*.json,vite.config.ts}', base: 'package' },
            { pattern: '{tsconfig.json,pnpm-lock.yaml}', base: 'workspace' },
            { pattern: 'cloudflare-os/scripts/**/*.ts', base: 'workspace' },
          ],
          output: [],
        },
      },
      test: {
        command: withTestTimeout("node --test 'packages/cf-os/src/**/*.test.ts'"),
        cwd: '../..',
        cache: {
          env: TESTS_WITH_TIMEOUT_ENV,
          // Workspace-wide, matching `cwd`: a guard that stopped seeing a file it asserts about would
          // cache-hit its way to a stale pass. Every fixture the suites write goes under the OS temp
          // directory, so none of them writes its own input.
          input: [
            { auto: true },
            { pattern: '!**/node_modules/.vite/**', base: 'workspace' },
            { pattern: '!**/node_modules/.vite-temp/**', base: 'workspace' },
            { pattern: '!**/.wrangler/**', base: 'workspace' },
          ],
          output: [],
        },
      },
    },
  },
}
