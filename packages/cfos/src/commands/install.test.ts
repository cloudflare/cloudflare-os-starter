import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";

import {
  INSTALL_MARKER, INSTALL_SCRIPT, NOT_CHECKED_OUT, SUBMODULE_INSTALL_ARGS, check, clearWorkspaceState,
  install, type SpawnInstall,
} from "./install.ts";

// Run from the repo root, as this package's `test` task does.

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every workspace member's manifest, by directory. */
function memberManifests(): Map<string, Record<string, unknown>> {
  const dirs = [".", ...readdirSync("packages").map(name => join("packages", name))];
  const manifests = new Map<string, Record<string, unknown>>();
  for (const dir of dirs) {
    const path = join(dir, "package.json");
    if (!existsSync(path)) continue;
    const manifest = readJson(path);
    assert.ok(isRecord(manifest), `${path} is not a JSON object`);
    manifests.set(dir, manifest);
  }
  return manifests;
}

function dependencies(manifest: Record<string, unknown>): [string, string][] {
  const found: [string, string][] = [];
  for (const kind of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const block = manifest[kind];
    if (!isRecord(block)) continue;
    for (const [name, spec] of Object.entries(block)) {
      if (typeof spec === "string") found.push([name, spec]);
    }
  }
  return found;
}

/** A temporary repo root with a checked-out `cloudflare-os/` holding `lockfile`. */
function fixtureRoot(t: { after: (fn: () => void) => void }, lockfile = "lockfileVersion: '9.0'\n"): string {
  const root = mkdtempSync(join(tmpdir(), "cfos-install-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "cloudflare-os", "node_modules"), { recursive: true });
  writeFileSync(join(root, "cloudflare-os", "package.json"), "{}");
  writeFileSync(join(root, "cloudflare-os", "pnpm-lock.yaml"), lockfile);
  return root;
}

const NOT_CHECKED_OUT_MESSAGE =
  "cfos install: cloudflare-os/ is empty, so the submodule is not checked out. Every package " +
  "here links into it. Run `git submodule update --init`, then `pnpm cfos install`.";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

test("the root postinstall installs the submodule's workspace through this command", () => {
  const root = readJson("package.json");
  assert.ok(isRecord(root) && isRecord(root.scripts));
  assert.equal(root.scripts.postinstall, "cfos install");
  // The old name, kept for habits and docs.
  assert.equal(root.scripts["install:submodule"], "cfos install");
});

test("the fix every message names runs this command through a root script", async (t) => {
  const root = readJson("package.json");
  assert.ok(isRecord(root) && isRecord(root.scripts));
  assert.equal(INSTALL_SCRIPT, "cfos install");
  // `pnpm cfos install` resolves through the root `cfos` script to this package's bin.
  assert.equal(root.scripts.cfos, "cfos");

  const uninstalled = fixtureRoot(t);
  const stale = fixtureRoot(t);
  writeFileSync(join(stale, "cloudflare-os", INSTALL_MARKER), JSON.stringify({ lockfileSha256: sha256("other") }));
  const empty = mkdtempSync(join(tmpdir(), "cfos-install-root-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const messages = [NOT_CHECKED_OUT];
  for (const result of [check({ root: uninstalled }), check({ root: stale }), check({ root: empty })]) {
    assert.equal(result.ok, false);
    if (!result.ok) messages.push(result.message);
  }
  for (const message of messages) {
    const named = [...message.matchAll(/`pnpm ([^`]+)`/g)].map(match => match[1]);
    assert.deepEqual(named, [INSTALL_SCRIPT], `${message} names ${JSON.stringify(named)}`);
  }
});

test("a repeat root install still runs the postinstall", () => {
  // Otherwise an install after a gitlink bump is "Already up to date" and skips the hook.
  const workspace = readFileSync("pnpm-workspace.yaml", "utf8");
  assert.match(workspace, /^optimisticRepeatInstall: false$/m);
});

test("the submodule's install never rewrites the submodule's lockfile", () => {
  assert.deepEqual(SUBMODULE_INSTALL_ARGS, ["--dir", "cloudflare-os", "install", "--frozen-lockfile"]);
});

test("the command imports only node builtins before the submodule is known to be there", () => {
  const source = readFileSync("packages/cfos/src/commands/install.ts", "utf8");
  // `import type` erases under `verbatimModuleSyntax`, so it loads nothing.
  const staticImports = [...source.matchAll(/^import\b(?!\s+type\b)[^;]*?from\s+"([^"]+)"/gm)].map(match => match[1]);
  assert.ok(staticImports.length > 0);
  assert.deepEqual(staticImports.filter(specifier => !specifier.startsWith("node:")), []);
  const checkSource = source.slice(source.indexOf("export function check("));
  assert.ok(checkSource.length < source.length);
  assert.doesNotMatch(checkSource, /\bimport\(/);
});

test("clearWorkspaceState removes pnpm's state files and nothing else", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cfos-install-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of [".pnpm-workspace-state-v1.json", ".pnpm-workspace-state.json", ".modules.yaml"]) {
    writeFileSync(join(dir, name), "{}");
  }
  assert.deepEqual(
    clearWorkspaceState(dir).toSorted(),
    [".pnpm-workspace-state-v1.json", ".pnpm-workspace-state.json"],
  );
  assert.deepEqual(readdirSync(dir), [".modules.yaml"]);
  assert.deepEqual(clearWorkspaceState(join(dir, "missing")), []);
});

test("install clears the submodule's workspace state before it spawns its install", async (t) => {
  const root = fixtureRoot(t);
  const stateFile = join(root, "cloudflare-os", "node_modules", ".pnpm-workspace-state-v1.json");
  writeFileSync(stateFile, "{}");

  const spawns: { args: string[]; cwd: string; stateFileThere: boolean }[] = [];
  const spawn: SpawnInstall = (_command, args, options) => {
    spawns.push({ args, cwd: options.cwd, stateFileThere: existsSync(stateFile) });
    return { status: 0 };
  };
  assert.equal(await install({ root, spawn }), 0);
  assert.equal(spawns.length, 1);
  const [only] = spawns;
  assert.equal(only.cwd, root);
  assert.deepEqual(only.args.slice(-SUBMODULE_INSTALL_ARGS.length), SUBMODULE_INSTALL_ARGS);
  assert.equal(only.stateFileThere, false, "the submodule's install ran with its workspace state file in place");
});

test("install passes on the install's failure and stops before it without the submodule", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cfos-install-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let spawned = 0;
  const spawn: SpawnInstall = () => {
    spawned += 1;
    return { status: 3 };
  };
  const errors = t.mock.method(console, "error", () => {});
  assert.equal(await install({ root, spawn }), 1);
  assert.equal(spawned, 0, "it ran the submodule's install with no submodule checked out");
  assert.deepEqual(errors.mock.calls.map(call => call.arguments), [[NOT_CHECKED_OUT_MESSAGE]]);
  errors.mock.restore();

  mkdirSync(join(root, "cloudflare-os"));
  writeFileSync(join(root, "cloudflare-os", "package.json"), "{}");
  assert.equal(await install({ root, spawn }), 3);
  assert.equal(await install({ root, spawn: () => ({ status: null, error: new Error("ENOENT") }) }), 1);
});

test("install records the submodule's lockfile once its install succeeds, and only then", async (t) => {
  // A record surviving a failed install would let `--check` pass it.
  const lockfile = "lockfileVersion: '9.0'\nimporters: {}\n";
  const root = fixtureRoot(t, lockfile);
  const marker = join(root, "cloudflare-os", INSTALL_MARKER);

  let markerDuringInstall: boolean | undefined;
  assert.equal(await install({ root, spawn: () => {
    markerDuringInstall = existsSync(marker);
    return { status: 0 };
  } }), 0);
  assert.equal(markerDuringInstall, false);
  assert.deepEqual(readJson(marker), { lockfileSha256: sha256(lockfile) });
  assert.deepEqual(check({ root }), { ok: true });

  for (const spawn of [
    () => ({ status: 3 }),
    () => ({ status: null }),
    () => ({ status: null, error: new Error("ENOENT") }),
  ] satisfies SpawnInstall[]) {
    writeFileSync(marker, JSON.stringify({ lockfileSha256: sha256(lockfile) }));
    assert.notEqual(await install({ root, spawn }), 0);
    assert.equal(existsSync(marker), false, "a failed install left a record matching the lockfile");
    assert.equal(check({ root }).ok, false);
  }
});

test("check names the cause and the fix for every way the submodule's install can be out of step", async (t) => {
  const fix = "Run `pnpm cfos install`.";

  const empty = mkdtempSync(join(tmpdir(), "cfos-install-root-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  mkdirSync(join(empty, "cloudflare-os"));
  assert.deepEqual(check({ root: empty }), { ok: false, message: NOT_CHECKED_OUT_MESSAGE });

  const root = fixtureRoot(t);
  const marker = join(root, "cloudflare-os", INSTALL_MARKER);
  const notInstalled = {
    ok: false,
    message: `cfos install: the submodule's workspace is not installed (no readable cloudflare-os/${INSTALL_MARKER}). ${fix}`,
  };
  assert.deepEqual(check({ root }), notInstalled);
  for (const unreadable of ["", "{", "null", "[]", "{}", '{"lockfileSha256":7}']) {
    writeFileSync(marker, unreadable);
    assert.deepEqual(check({ root }), notInstalled, `accepted a record of ${JSON.stringify(unreadable)}`);
  }

  assert.equal(await install({ root, spawn: () => ({ status: 0 }) }), 0);
  assert.deepEqual(check({ root }), { ok: true });

  // A gitlink bump: the submodule moves, cloudflare-os/node_modules does not.
  writeFileSync(join(root, "cloudflare-os", "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# bumped\n");
  const changed = {
    ok: false,
    message: "cfos install: cloudflare-os/pnpm-lock.yaml has changed since the submodule's workspace was " +
      `installed, so cloudflare-os/node_modules is stale. ${fix}`,
  };
  assert.deepEqual(check({ root }), changed);
  rmSync(join(root, "cloudflare-os", "pnpm-lock.yaml"));
  assert.deepEqual(check({ root }), changed);
});

test("the root entry points that need the submodule's install check it first", () => {
  // `&&` chains, not `pre` scripts, which `ignore-scripts` also skips. `check` and `deploy` reach it
  // through `requireSubmodule()` in commands/deploy.ts instead.
  const root = readJson("package.json");
  assert.ok(isRecord(root) && isRecord(root.scripts));
  const CHECK = "cfos install --check && ";
  for (const name of ["build", "test"]) {
    const script: unknown = root.scripts[name];
    assert.ok(typeof script === "string" && script.startsWith(CHECK), `${name} does not check the submodule's install first`);
  }
  // The one that reaches the check through the others.
  assert.match(String(root.scripts.lint), /pnpm run lint:check && pnpm run build/);
  assert.equal(root.scripts.check, "cfos check");
  assert.equal(root.scripts.deploy, "cfos deploy");
  const deploy = readFileSync("packages/cfos/src/commands/deploy.ts", "utf8");
  assert.ok(deploy.includes("from \"./install.ts\""), "commands/deploy.ts does not run the check");
});

test("the root's cf is the one cfos runs", () => {
  // The root keeps `cf` so `pnpm exec cf auth login`, which every hint names, works there.
  const root = readJson("package.json");
  const cfos = readJson("packages/cfos/package.json");
  assert.ok(isRecord(root) && isRecord(root.devDependencies) && isRecord(cfos) && isRecord(cfos.dependencies));
  assert.equal(root.devDependencies.cf, cfos.dependencies.cf);
  assert.match(String(cfos.dependencies.cf), /^\d/, "cf is pinned exactly, not ranged");
});

test("no submodule package is a workspace member; packages here link to the ones they use", () => {
  const workspace = readFileSync("pnpm-workspace.yaml", "utf8");
  const packagesBlock = workspace.match(/^packages:\n((?:^(?:[ \t].*)?\n)*)/m)?.[1];
  assert.ok(packagesBlock, "pnpm-workspace.yaml has no packages: list");
  const globs = [...packagesBlock.matchAll(/^\s+-\s+'?([^'\s]+)'?/gm)].map(match => match[1]);
  assert.deepEqual(globs, ["packages/*"]);

  const manifests = memberManifests();
  const memberNames = new Set(
    [...manifests.values()].flatMap(manifest => typeof manifest.name === "string" ? [manifest.name] : []));
  for (const [dir, manifest] of manifests) {
    for (const [name, spec] of dependencies(manifest)) {
      if (spec.startsWith("workspace:")) {
        assert.ok(memberNames.has(name), `${dir}/package.json: ${name} is ${spec} but not a member`);
      }
      if (spec.startsWith("link:")) {
        const target = resolve(dir, spec.slice("link:".length));
        const linked = readJson(join(target, "package.json"));
        assert.ok(isRecord(linked), `${dir}/package.json: ${spec} has no package.json`);
        assert.equal(linked.name, name, `${dir}/package.json: ${spec} is not ${name}`);
        const fromSubmodule = relative(resolve("cloudflare-os"), target);
        assert.ok(
          fromSubmodule !== "" && !fromSubmodule.startsWith("..") && !isAbsolute(fromSubmodule),
          `${dir}/package.json: ${name} links outside cloudflare-os/`,
        );
      }
    }
  }
});
