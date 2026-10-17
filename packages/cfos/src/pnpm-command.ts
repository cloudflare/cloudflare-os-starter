// pnpm, spawned without a shell on Windows even when pnpm did not start this process.
//
// Upstream's pnpmCommand (cloudflare-os/scripts/pnpm-command.ts) runs pnpm's JS entry with node,
// found through `npm_execpath`, because Node will not spawn the `pnpm.cmd` shim on PATH without a
// shell. Only `pnpm run` sets that variable to pnpm: under `npx cf-os init` it names
// npm's CLI, so upstream falls back to a bare `pnpm` and every build failed with `spawn pnpm
// ENOENT`. This then looks for the entry where the shim itself runs it from, beside the `pnpm.cmd`
// on PATH: npm's global layout or Corepack's.

import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { pnpmCommand as upstreamPnpmCommand } from "@gadgets/scripts/pnpm-command";

/** Where a `pnpm.cmd` shim's own directory keeps the JS entry it runs, most likely first. */
const SHIM_ENTRIES = [
  ["node_modules", "pnpm", "bin", "pnpm.mjs"],
  ["node_modules", "pnpm", "bin", "pnpm.cjs"],
  ["node_modules", "corepack", "dist", "pnpm.js"],
];

/**
 * `[command, args]` for running pnpm with `args`: upstream's answer, except on Windows when that is
 * a bare `pnpm` and the entry behind a `pnpm.cmd` shim can be found. With neither, the bare `pnpm`
 * stands, which still works for a standalone `pnpm.exe`.
 *
 * `env`, `platform` and `exists` are parameters only so the Windows branch stays testable elsewhere.
 */
export function pnpmCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): [string, string[]] {
  const command = upstreamPnpmCommand(args, env, platform);
  if (platform !== "win32" || command[0] !== "pnpm") return command;
  const entry = shimEntry(env, exists);
  return entry ? [process.execPath, [entry, ...args]] : command;
}

/**
 * The JS entry beside the `pnpm.cmd` a shell would run, if it is in a known place. PATH is walked
 * in order, and the first directory holding any pnpm decides: a bare `pnpm` already resolves to a
 * `pnpm.com` or `pnpm.exe` without a shell, so one of those there stands, and only a `pnpm.cmd`
 * reached first needs its entry found. Skipping past an executable to a later shim could run a
 * different pnpm.
 */
function shimEntry(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | undefined {
  // Windows environment names are case-insensitive, and Node keeps whichever case it found: `Path`.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const dirs = (pathKey ? env[pathKey] ?? "" : "").split(win32.delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (exists(win32.join(dir, "pnpm.com")) || exists(win32.join(dir, "pnpm.exe"))) return undefined;
    if (exists(win32.join(dir, "pnpm.cmd"))) {
      return SHIM_ENTRIES.map((parts) => win32.join(dir, ...parts)).find((entry) => exists(entry));
    }
  }
  return undefined;
}
