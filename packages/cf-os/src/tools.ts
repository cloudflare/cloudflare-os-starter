// The external tools scaffolding and init hand the terminal to, or read a status from: git, pnpm,
// gh, wrangler, `cf auth login`. One command at a time, behind types tests can record against: a
// tool handed the terminal runs synchronously, and a status read runs asynchronously, so a spinner
// can turn while it waits.
//
// On the packed path (scaffolding imports it), so node builtins only: see main.ts.

import { spawn, spawnSync } from "node:child_process";

/** How a tool ran: its exit status and output, or the error that kept it from running. */
export interface ToolResult {
  status: number | null;
  stdout: string;
  stderr?: string;
  error?: Error;
}

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
) => ToolResult;

/**
 * One external command, run in `cwd` with its output captured and nothing on its stdin, resolving
 * once it exits: a status read (`wrangler whoami`, `gh api user`) the event loop keeps turning
 * through. `signal` stops waiting on one started ahead that turns out not to be needed: it resolves
 * at once, and the command is left to finish on its own without holding this process open. Not
 * killed: a sign-in check may be refreshing a single-use OAuth token, and one cut off mid-refresh
 * would leave the CLI signed out. For the same reason it runs, off Windows, in a process group of its
 * own, out of reach of the SIGINT a terminal's Ctrl-C sends while a sign-in holds the terminal, as
 * `cf` does (cf-client.ts).
 */
export type CaptureTool = (
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<ToolResult>;

/** Whether a tool ran and exited 0. */
export function succeeded(result: ToolResult): boolean {
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
      shell: needsShell(command),
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
  };
}

/**
 * On Windows, pnpm on PATH is a `.cmd` shim Node will not spawn without a shell. Safe here: every
 * argument passed to pnpm is a fixed word or the person's own `--profile`, and paths go in `cwd`,
 * not argv.
 */
function needsShell(command: string): boolean {
  return process.platform === "win32" && command === "pnpm";
}

/** {@link CaptureTool} on `spawn`. */
export function defaultCapture(): CaptureTool {
  return (command, args, { cwd, env, signal }) => new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    // A failed spawn emits `error` and may still emit `close`; the first one decides.
    const settle = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, args, { cwd, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"],
        shell: needsShell(command), detached: process.platform !== "win32" });
    } catch (error) {
      settle({ status: null, stdout, stderr, error: error as Error });
      return;
    }
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => stdout += chunk);
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr += chunk);
    child.on("error", (error) => settle({ status: null, stdout, stderr, error }));
    child.on("close", (status) => settle({ status, stdout, stderr }));
    const detach = () => {
      child.unref();
      child.stdout.destroy();
      child.stderr.destroy();
      settle({ status: null, stdout, stderr, error: new Error(`${command} ${args.join(" ")}: no longer waited on`) });
    };
    if (signal?.aborted) detach();
    else signal?.addEventListener("abort", detach, { once: true });
  });
}
