export default {
  run: {
    tasks: {
      build: {
        command: "tsc --noEmit",
        input: [{ auto: true }],
        output: [],
      },
      test: {
        command: "vitest run",
        input: [
          { auto: true },
          { pattern: "!**/node_modules/.vite/**", base: "workspace" },
          { pattern: "!**/node_modules/.vite-temp/**", base: "workspace" },
          { pattern: "!**/.wrangler/**", base: "workspace" },
        ],
        output: [
          { auto: true },
          { pattern: "!**/node_modules/.vite/**", base: "workspace" },
          { pattern: "!**/node_modules/.vite-temp/**", base: "workspace" },
          { pattern: "!**/.wrangler/**", base: "workspace" },
        ],
      },
    },
  },
};
