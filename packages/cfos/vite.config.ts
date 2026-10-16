// Vite+ tasks for the `cfos` CLI: `build` type-checks it (nothing is emitted; `node` runs the
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
        // Reads only: `noEmit`, so the automatic inputs are the whole fingerprint.
        cache: { input: [{ auto: true }], output: [] },
      },
      test: {
        command: withTestTimeout("node --test 'packages/cfos/src/**/*.test.ts'"),
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
