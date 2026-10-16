// Vite+ per-package settings. `vitest.config.ts` beside this file is vitest's own config (vitest
// prefers it over this one); this file exists only to declare the `build` and `test` tasks that
// `vp run` executes.
//
// Both are tasks rather than package.json scripts because each reads a path it also writes, and vp
// declines to cache such a task: `tsc` emits into `dist/`, which automatic tracking otherwise counts
// as an input of the same package, and every `vitest run` rewrites its scratch paths and reads them
// back on the next run. vp forbids a task and a script sharing a name, so the `build` and `test`
// scripts are gone -- `vp run -F custom-gatekeeper <task>` is what replaces them.
//
// `test` is upstream's shared task (`@gadgets/scripts/vitest-task`, linked from the submodule): the
// vitest and wrangler scratch exclusions, the hang watchdog, and the env it fingerprints. See
// cloudflare-os/scripts/vitest-task-vite-config.ts for the full accounting of each path.
import { withVitestTask } from '@gadgets/scripts/vitest-task'

// This package's own `tsc` output. Package-relative, not workspace-wide: a sibling's `dist/` may be
// a real input via its `exports`.
const ownDist = { pattern: '!dist/**', base: 'package' } as const

// The capnweb-validate build tree wrangler writes. Derived from tracked sources, so dropping it from
// the fingerprint loses nothing.
const wranglerScratch = { pattern: '!**/.wrangler/**', base: 'workspace' } as const

export default withVitestTask(
  {
    run: {
      tasks: {
        build: {
          command: 'tsc',
          // Under `cache` since vite-plus 1.0 (voidzero-dev/vite-task#749).
          cache: {
            input: [{ auto: true }, ownDist, wranglerScratch],
            output: ['dist/**'],
          },
        },
      },
    },
  },
  'vitest run',
)
