// `cfos install [--check]`
//
// Installs the submodule's own workspace (`pnpm --dir cloudflare-os install --frozen-lockfile`).
// This repository's packages `link:` into cloudflare-os/, and pnpm installs nothing for a linked
// directory. The root `postinstall` runs this, but pnpm skips that hook under `--ignore-scripts`, so
// `cfos check` and `cfos deploy` run `check()` as well. Frozen, because the submodule's lockfile
// belongs to the upstream repository.
//
// It deletes pnpm's workspace state file first, which otherwise lets pnpm skip an install that
// would restore a missing link. On success it records cloudflare-os/pnpm-lock.yaml's sha256 in
// INSTALL_MARKER, removed before each install so a failed one leaves no matching record;
// `--check` compares that record with the lockfile, catching a skipped hook after a gitlink bump.
//
// Imports only node builtins statically: it runs before the submodule is checked out, and imports
// the submodule's `pnpmCommand()` only once the submodule is known to be there.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandArgs, Context } from "../context.ts";

export const SUBMODULE_INSTALL_ARGS = ["--dir", "cloudflare-os", "install", "--frozen-lockfile"];

/** The record of the last completed install, relative to cloudflare-os/. */
export const INSTALL_MARKER = "node_modules/.cloudflare-os-starter-install.json";

interface InstallRecord {
  lockfileSha256: string;
}

function lockfileSha256(submoduleDir: string): string {
  return createHash("sha256").update(readFileSync(join(submoduleDir, "pnpm-lock.yaml"))).digest("hex");
}

/**
 * The command every fix names, run as `pnpm <this>`: through pnpm, it has the `npm_execpath`
 * `pnpmCommand()` needs to spawn pnpm on Windows.
 */
export const INSTALL_SCRIPT = "cfos install";

/** What both modes print without the submodule. */
export const NOT_CHECKED_OUT =
  "cfos install: cloudflare-os/ is empty, so the submodule is not checked out. Every package " +
  `here links into it. Run \`git submodule update --init\`, then \`pnpm ${INSTALL_SCRIPT}\`.`;

/** pnpm's workspace state file, `.pnpm-workspace-state-v1.json` in pnpm 11. Versioned by pnpm. */
const WORKSPACE_STATE_FILE = /^\.pnpm-workspace-state.*\.json$/;

/** Delete pnpm's workspace state file(s) in `nodeModulesDir`, so the next install relinks. */
export function clearWorkspaceState(nodeModulesDir: string): string[] {
  if (!existsSync(nodeModulesDir)) return [];
  const stale = readdirSync(nodeModulesDir).filter(name => WORKSPACE_STATE_FILE.test(name));
  for (const name of stale) rmSync(join(nodeModulesDir, name), { force: true });
  return stale;
}

/** The slice of `spawnSync` this uses, so a test can stand in for the install. */
export type SpawnInstall = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: "inherit" },
) => { status: number | null; error?: Error };

/** Install the submodule's workspace under `root`, resolving to the exit code. */
export async function install(
  { root, spawn = spawnSync }: { root: string; spawn?: SpawnInstall },
): Promise<number> {
  const submoduleDir = join(root, "cloudflare-os");
  if (!existsSync(join(submoduleDir, "package.json"))) {
    console.error(NOT_CHECKED_OUT);
    return 1;
  }
  console.error(`cfos install: installing cloudflare-os/'s workspace too (pnpm ${SUBMODULE_INSTALL_ARGS.join(" ")})`);
  clearWorkspaceState(join(submoduleDir, "node_modules"));
  rmSync(join(submoduleDir, INSTALL_MARKER), { force: true });
  const { pnpmCommand } = await import("@gadgets/scripts/pnpm-command");
  const [command, args] = pnpmCommand(SUBMODULE_INSTALL_ARGS);
  const result = spawn(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) {
    console.error(`cfos install: could not run pnpm: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) return result.status ?? 1;
  const record: InstallRecord = { lockfileSha256: lockfileSha256(submoduleDir) };
  writeFileSync(join(submoduleDir, INSTALL_MARKER), `${JSON.stringify(record, null, 2)}\n`);
  return 0;
}

/** Whether the submodule's install matches cloudflare-os/pnpm-lock.yaml. Reads files only. */
export function check({ root }: { root: string }): { ok: true } | { ok: false; message: string } {
  const submoduleDir = join(root, "cloudflare-os");
  const fix = `Run \`pnpm ${INSTALL_SCRIPT}\`.`;
  if (!existsSync(join(submoduleDir, "package.json"))) {
    return { ok: false, message: NOT_CHECKED_OUT };
  }
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(join(submoduleDir, INSTALL_MARKER), "utf8"));
  } catch {
    // Missing or not JSON.
    record = undefined;
  }
  const installed = typeof record === "object" && record !== null && "lockfileSha256" in record
    ? record.lockfileSha256 : undefined;
  if (typeof installed !== "string") {
    return {
      ok: false,
      message: `cfos install: the submodule's workspace is not installed (no readable cloudflare-os/${INSTALL_MARKER}). ${fix}`,
    };
  }
  let current: string | undefined;
  try {
    current = lockfileSha256(submoduleDir);
  } catch {
    current = undefined;
  }
  if (installed !== current) {
    return {
      ok: false,
      message: "cfos install: cloudflare-os/pnpm-lock.yaml has changed since the submodule's workspace was " +
        `installed, so cloudflare-os/node_modules is stale. ${fix}`,
    };
  }
  return { ok: true };
}

/** `cfos install [--check]`. */
export async function run(args: CommandArgs, ctx: Context): Promise<number> {
  if (!args.values.check) return install({ root: ctx.root });
  const result = check({ root: ctx.root });
  if (!result.ok) ctx.out.log(result.message);
  return result.ok ? 0 : 1;
}
