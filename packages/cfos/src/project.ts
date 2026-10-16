// Finding the project a command acts on, from wherever it was run, and handing a command to that
// project's own copy of the CLI.

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The nearest ancestor of `from` (itself included) that is a Cloudflare OS project: it holds
 * `deployment.jsonc` and a `cloudflare-os/` directory, checked out or not. Null outside one.
 */
export function findProjectRoot(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "deployment.jsonc")) && isDirectory(join(dir, "cloudflare-os"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The project's own copy of this CLI, which every command but scaffolding hands off to. */
export function localEntry(root: string): string {
  return join(root, "packages", "cfos", "src", "main.ts");
}

/** Set on a delegated child, so it never delegates again. */
export const DELEGATION_SENTINEL = "CFOS_DELEGATED";

/** The slice of `spawnSync` delegation uses. */
export type SpawnDelegate = (
  command: string,
  args: string[],
  options: { stdio: "inherit"; env: NodeJS.ProcessEnv; cwd: string },
) => { status: number | null; signal?: NodeJS.Signals | null; error?: Error };

/**
 * Runs `node <entry> <argv>` in `cwd` with the terminal handed over, resolving to its exit code.
 * The dispatcher uses it to reach the project's own copy; scaffolding, to start the new project's
 * `cfos init`.
 */
export function delegate(
  entry: string,
  argv: string[],
  { cwd, env, spawn }: { cwd: string; env: NodeJS.ProcessEnv; spawn: SpawnDelegate },
): number {
  const result = spawn(process.execPath, [entry, ...argv], {
    stdio: "inherit",
    cwd,
    env: { ...env, [DELEGATION_SENTINEL]: "1" },
  });
  if (result.error) throw result.error;
  if (result.signal === "SIGINT") return 130;
  return result.status ?? 1;
}
