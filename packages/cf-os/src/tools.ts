// The external tools scaffolding and init hand the terminal to, or read a status from: git, pnpm,
// gh, wrangler, `cf auth login`. One command at a time, behind a type tests can record against.
//
// On the packed path (scaffolding imports it), so node builtins only: see main.ts.

import { spawnSync } from "node:child_process";

/**
 * One external command, run in `cwd`. `capture` returns its output instead of showing it. Shown, its
 * stdout goes to stderr with the rest: stdout carries only a command's results (`update`'s JSON).
 * `input` is written to its stdin, which is then a pipe rather than the terminal: how a secret
 * reaches a tool without passing through its argv or a file.
 */
export type SpawnTool = (
  command: string,
  args: string[],
  options: { cwd: string; capture: boolean; env?: NodeJS.ProcessEnv; input?: string },
) => { status: number | null; stdout: string; stderr?: string; error?: Error };

/** Whether a tool ran and exited 0. */
export function succeeded(result: ReturnType<SpawnTool>): boolean {
  return !result.error && result.status === 0;
}

/** {@link SpawnTool} on `spawnSync`. */
export function defaultSpawn(): SpawnTool {
  return (command, args, { cwd, capture, env, input }) => {
    const stdin = input === undefined ? capture ? "ignore" : "inherit" : "pipe";
    const result = spawnSync(command, args, {
      cwd,
      env: env ?? process.env,
      encoding: "utf8",
      input,
      stdio: capture ? [stdin, "pipe", "pipe"] : [stdin, 2, "inherit"],
      // On Windows, pnpm on PATH is a `.cmd` shim Node will not spawn without a shell. Safe here:
      // every argument passed to pnpm is a fixed word or the person's own `--profile`, and paths go
      // in `cwd`, not argv.
      shell: process.platform === "win32" && command === "pnpm",
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
  };
}
