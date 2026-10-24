// Finding the project a command acts on, from wherever it was run, and handing a command to that
// project's own copy of the CLI.

import type { ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { constants } from "node:os";
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

/**
 * The project's own copy of this CLI, which every command but scaffolding and `update` hands off
 * to. A project scaffolded before the package was renamed has it at `packages/cfos`.
 */
export function localEntry(root: string): string {
  const entry = join(root, "packages", "cf-os", "src", "main.ts");
  const legacy = join(root, "packages", "cfos", "src", "main.ts");
  return !existsSync(entry) && existsSync(legacy) ? legacy : entry;
}

/** Set on a delegated child, so it never delegates again. */
export const DELEGATION_SENTINEL = "CFOS_DELEGATED";

/** The slice of `spawn` delegation uses. */
export type SpawnDelegate = (
  command: string,
  args: string[],
  options: { stdio: "inherit"; env: NodeJS.ProcessEnv; cwd: string },
) => Pick<ChildProcess, "once" | "kill">;

/**
 * Runs `node <entry> <argv>` in `cwd` with the terminal handed over, resolving to its exit code.
 * The dispatcher uses it to reach the project's own copy; scaffolding, to start the new project's
 * `cf-os init`.
 */
export async function delegate(
  entry: string,
  argv: string[],
  { cwd, env, spawn }: { cwd: string; env: NodeJS.ProcessEnv; spawn: SpawnDelegate },
): Promise<number> {
  const child = spawn(process.execPath, [entry, ...argv], {
    stdio: "inherit",
    cwd,
    env: { ...env, [DELEGATION_SENTINEL]: "1" },
  });
  // Kept alive until the child exits, so this process reports its exit code, and the child decides
  // how to stop (a subscription drains, then 130). Both signals are passed on, so one sent to this
  // process alone reaches the child; Ctrl-C, sent to both, then arrives twice, which stops it once
  // all the same.
  const forward = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    return await new Promise<number>((done, failed) => {
      child.once("error", failed);
      child.once("exit", (code, signal) => done(code ?? (signal ? 128 + constants.signals[signal] : 1)));
    });
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
}
