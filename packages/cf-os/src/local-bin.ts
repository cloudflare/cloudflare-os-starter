// A dependency's CLI (`cf`, `wrangler`), for a SpawnTool to run from the project root: `node <entry>`
// when the entry point behind its `.bin` shim can be found, which saves the ~0.33 s a `pnpm exec`
// costs per call, as `wrangler deploy` does in deploy.ts. Otherwise `pnpm exec`, through
// pnpmCommand() (pnpm-command.ts), which spawns pnpm on Windows without a shell.
//
// Both are upstream's (`@gadgets/scripts`), loaded only when called, as gatekeeper-catalog.ts loads
// the catalog: the commands importing this still load, and refuse or fail as they would, without the
// submodule checked out. A bare `pnpm exec` stands in then, which SpawnTool runs through a shell on
// Windows.

/** `[command, args]` running `bin` with `args`, as installed in `root`'s `node_modules`. */
export async function localBin(root: string, bin: string, args: string[]): Promise<[string, string[]]> {
  const upstream = await Promise.all([import("@gadgets/scripts/bin-entry"), import("./pnpm-command.ts")])
    .catch(() => null);
  if (!upstream) return ["pnpm", ["exec", bin, ...args]];
  const [{ resolveBinEntry }, { pnpmCommand }] = upstream;
  const entry = resolveBinEntry(root, bin);
  return entry ? [process.execPath, [entry, ...args]] : pnpmCommand(["exec", bin, ...args]);
}
