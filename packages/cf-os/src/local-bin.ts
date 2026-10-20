// A dependency's CLI (`cf`, `wrangler`), for a SpawnTool to run from the project root: `node <entry>`
// when the entry point behind its `.bin` shim can be found, which saves the ~0.33 s a `pnpm exec`
// costs per call, as `wrangler deploy` does in deploy.ts. Otherwise `pnpm exec`, which SpawnTool runs
// through a shell on Windows.
//
// The resolver is upstream's (`@gadgets/scripts`), loaded only when called, as gatekeeper-catalog.ts
// loads the catalog: the commands importing this still load, and refuse or fail as they would,
// without the submodule checked out, where the `pnpm exec` path stands in.

/** `[command, args]` running `bin` with `args`, as installed in `root`'s `node_modules`. */
export async function localBin(root: string, bin: string, args: string[]): Promise<[string, string[]]> {
  const entry = await import("@gadgets/scripts/bin-entry")
    .then(({ resolveBinEntry }) => resolveBinEntry(root, bin), () => null);
  return entry ? [process.execPath, [entry, ...args]] : ["pnpm", ["exec", bin, ...args]];
}
