// Vite+ per-package settings. See packages/custom-gatekeeper/vite.config.ts for why `build` and
// `test` are tasks rather than package.json scripts, and what each exclusion buys.
import { withVitestTask } from '@gadgets/scripts/vitest-task'

const ownDist = { pattern: '!dist/**', base: 'package' } as const

const wranglerScratch = { pattern: '!**/.wrangler/**', base: 'workspace' } as const

export default withVitestTask(
  {
    run: {
      tasks: {
        build: {
          command: 'tsc',
          cache: {
            input: [{ auto: true }, ownDist, wranglerScratch],
            output: ['dist/**'],
          },
        },
      },
    },
  },
  // Narrower than `vitest run`: `src/index.ts` is a Worker entrypoint with no test of its own.
  'vitest run src/format.test.ts',
)
