import { defineConfig } from 'vite-plus'

/**
 * Repo-wide toolchain config, ported from the submodule's own `vite.config.ts` so a contributor
 * moving between the two repositories meets the same ruleset.
 *
 * Lint only. There is deliberately no `run.tasks` block here: Vite+ creates a task for every
 * package from a workspace-root task definition, including the root package itself, and the root
 * has no sources for one to act on. Per-package tasks live in each package's own `vite.config.ts`.
 */
export default defineConfig({
  check: {
    // The tree has never been formatted with oxfmt, so `vp check` would report every file. `vp fmt`
    // still works if invoked directly.
    fmt: false,
  },
  lint: {
    categories: {
      correctness: 'error',
      suspicious: 'error',
    },
    plugins: ['typescript', 'unicorn', 'oxc', 'import'],
    // Upstream's local rules, loaded from the submodule so the two repositories share one
    // implementation of each.
    jsPlugins: ['./cloudflare-os/scripts/oxlint-plugin.ts'],
    options: {
      // Type-aware linting is intentionally off, as upstream. `tsc` is what enforces type safety
      // here, through each package's `build` task (`pnpm build`), the `cfos` CLI's included.
      typeAware: false,
    },
    env: {
      es2024: true,
    },
    rules: {
      // Exported API declaration documentation is surfaced by TypeScript in IDE hovers only when it
      // uses JSDoc syntax. Ordinary implementation comments stay `//`.
      'gadgets/prefer-jsdoc': 'error',

      // False positives: gatekeepers import `.txt` files as bundled text assets, which the import
      // resolver reports as "no default export".
      'import/default': 'off',

      // Side-effect imports are used deliberately (the `cloudflare:workers` runtime registration).
      'import/no-unassigned-import': 'off',

      // Comment-only reference modules are kept intentionally (`src/types.d.ts`).
      'unicorn/no-empty-file': 'off',

      // Conflicts with the convention of prefixing intentionally-unused bindings with `_`.
      'no-underscore-dangle': 'off',

      // Do not require churny `_` prefixes on unused callback/interface parameters or catch
      // bindings, but still flag unused imports and local variables.
      'no-unused-vars': [
        'error',
        {
          args: 'none',
          caughtErrors: 'none',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      // Genuine improvements, but churny for an initial rollout. Visible as warnings.
      'no-shadow': 'warn',
      'typescript/no-this-alias': 'warn',
      'typescript/no-extraneous-class': 'warn',
      'unicorn/consistent-function-scoping': 'warn',
    },
    ignorePatterns: [
      // The submodule lints itself, with its own config and its own per-directory overrides.
      // Linting it from here would report findings nobody in this repository can fix.
      'cloudflare-os/**',
      '**/dist/**',
      '**/generated/**',
      '**/*.gen.ts',
      '**/node_modules/**',
      '**/.wrangler/**',
      '**/worker-configuration.d.ts',
    ],
    overrides: [
      {
        // Cloudflare Workers backends: worker/service-worker global scope. `packages/cfos` is a Node
        // CLI and is overridden back below.
        files: ['packages/*/src/**/*.ts'],
        env: {
          serviceworker: true,
          es2024: true,
        },
      },
      {
        // Mirrors upstream: declarations the agent receives as verbatim text (through the string
        // module beside each), so nothing resolves their imports for it.
        files: ['packages/*/src/*types.d.ts'],
        rules: {
          'gadgets/self-contained-agent-types': 'error',
        },
      },
      {
        files: ['**/*.test.ts', '**/vitest.config.ts', 'packages/*/__tests__/**/*.ts'],
        plugins: ['typescript', 'unicorn', 'oxc', 'import', 'vitest'],
        env: {
          vitest: true,
          es2024: true,
        },
      },
      {
        // The `cfos` CLI runs under Node, not in a Worker. Ordered after the `packages/*/src/**`
        // override above so this env wins over its service-worker one.
        files: ['packages/cfos/**/*.ts'],
        env: {
          serviceworker: false,
          node: true,
          es2024: true,
        },
      },
      {
        // The CLI's tests run under `node --test`, not vitest, so they must not pick up the vitest
        // override above (which would supply vitest globals and drop `env: node`). Ordered last so
        // it wins over that entry.
        files: ['packages/cfos/**/*.test.ts'],
        plugins: ['typescript', 'unicorn', 'oxc', 'import'],
        env: {
          node: true,
          es2024: true,
        },
      },
    ],
  },
})
