import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cli, type CliDeps } from "./main.ts";
import { DELEGATION_SENTINEL, type SpawnDelegate } from "./project.ts";
import { scratchProject, TEMPLATE } from "./test-support.ts";

const SRC = dirname(fileURLToPath(import.meta.url));
const MAIN = join(SRC, "main.ts");

/** Runs `cfos <argv>` in-process, capturing stderr lines, stdout writes and any delegation. */
async function run(
  t: { mock: { method: typeof test.mock.method } },
  argv: string[],
  { cwd, env = {}, self = MAIN, status = 0 }: { cwd: string; env?: NodeJS.ProcessEnv; self?: string; status?: number },
) {
  const log: string[] = [];
  const stdout: string[] = [];
  const spawned: { args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = [];
  const spawn: SpawnDelegate = (_command, args, options) => {
    spawned.push({ args, env: options.env, cwd: options.cwd });
    return { status };
  };
  const write = t.mock.method(process.stdout, "write", (chunk: string) => {
    stdout.push(chunk);
    return true;
  });
  const deps: CliDeps = {
    cwd, env, self, spawn, prompter: null,
    out: { json: (data) => stdout.push(JSON.stringify(data)), log: (text) => log.push(text) },
  };
  try {
    return { code: await cli(argv, deps), log: log.join("\n"), stdout: stdout.join(""), spawned };
  } finally {
    write.mock.restore();
  }
}

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "cfos-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A scratch project with its own copy of the CLI (an empty stand-in). */
function projectWithLocalCopy(t: Parameters<typeof scratchProject>[0]): { root: string; local: string } {
  const root = scratchProject(t, TEMPLATE);
  const local = join(root, "packages", "cfos", "src", "main.ts");
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(local, "");
  return { root, local };
}

test("prints usage and fails on no command or an unknown one", async (t) => {
  const cwd = tempDir(t);
  const none = await run(t, [], { cwd });
  assert.equal(none.code, 1);
  assert.match(none.log, /Usage: cfos <command>/);
  const unknown = await run(t, ["frobnicate"], { cwd });
  assert.equal(unknown.code, 1);
  assert.match(unknown.log, /Unknown command "frobnicate"/);
  const bad = await run(t, ["import", "--nope"], { cwd });
  assert.equal(bad.code, 1);
  assert.match(bad.log, /Unknown option '--nope'[\s\S]*Usage: cfos import/);
});

test("prints each command's help on stdout, anywhere", async (t) => {
  const cwd = tempDir(t);
  for (const name of ["init", "import", "access", "check", "deploy", "install"]) {
    const { code, stdout } = await run(t, [name, "--help"], { cwd });
    assert.equal(code, 0, name);
    assert.match(stdout, new RegExp(`^Usage: cfos ${name}\\b`), name);
    assert.match(stdout, /--profile <name>/, name);
  }
  const { code, stdout } = await run(t, ["--help"], { cwd });
  assert.equal(code, 0);
  assert.match(stdout, /Commands:\n {2}init/);
});

test("outside a project, only init runs", async (t) => {
  const cwd = tempDir(t);
  for (const name of ["import", "access", "check", "deploy", "install"]) {
    const { code, log } = await run(t, [name], { cwd });
    assert.equal(code, 1, name);
    assert.match(log, /Run `cfos init <dir>` to create one/, name);
  }
  // init scaffolds -- which, with no terminal, needs the directory.
  const { code, log } = await run(t, ["init"], { cwd });
  assert.equal(code, 1);
  assert.match(log, /cfos init <dir>/);
});

test("hands every command to the project's own copy, from any subdirectory", async (t) => {
  const { root, local } = projectWithLocalCopy(t);
  mkdirSync(join(root, "docs"));
  const { code, spawned } = await run(t, ["check", "--account", "x"], { cwd: join(root, "docs"), status: 7 });
  assert.equal(code, 7, "the child's exit code passes through");
  assert.deepEqual(spawned.map((entry) => entry.args), [[local, "check", "--account", "x"]]);
  assert.equal(spawned[0].env[DELEGATION_SENTINEL], "1");
  assert.equal(spawned[0].cwd, join(root, "docs"));
});

test("does not delegate to itself, or from a delegated child", async (t) => {
  const { root, local } = projectWithLocalCopy(t);
  const itself = await run(t, ["install", "--check"], { cwd: root, self: local });
  assert.deepEqual(itself.spawned, []);
  const child = await run(t, ["install", "--check"], { cwd: root, env: { [DELEGATION_SENTINEL]: "1" } });
  assert.deepEqual(child.spawned, []);
  assert.match(child.log, /submodule is not checked out/);
});

test("refuses a project that predates the CLI rather than run commands for it", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const { code, log, spawned } = await run(t, ["check"], { cwd: root });
  assert.equal(code, 1);
  assert.match(log, /predates the cfos CLI/);
  assert.deepEqual(spawned, []);
});

test("install runs, and says what to do, with no submodule checked out", (t) => {
  // A real process: what matters is that nothing on the install path imports the submodule.
  const root = scratchProject(t, TEMPLATE);
  const result = spawnSync(process.execPath, [MAIN, "install"], {
    cwd: root, encoding: "utf8", env: { ...process.env, [DELEGATION_SENTINEL]: "1" },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /cfos install: cloudflare-os\/ is empty, so the submodule is not checked out/);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find/);
});

/** A module's imports: static ones (`import type` excluded: erased) and literal dynamic ones. */
function importsOf(file: string): { static: string[]; dynamic: string[] } {
  const source = readFileSync(file, "utf8");
  return {
    static: [...source.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]),
    dynamic: [...source.matchAll(/\bimport\("([^"]+)"\)/g)].map((match) => match[1]),
  };
}

/** Every module reachable from `entries` by static imports alone, and the packages they import. */
function staticClosure(entries: string[]): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of importsOf(file).static) {
      if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
      else packages.add(specifier);
    }
  }
  return { files, packages };
}

test("the packed path never reaches @gadgets/scripts", () => {
  // A published copy runs dispatch, delegation and scaffolding only, and lacks the `link:` package.
  const { files, packages } = staticClosure([MAIN, join(SRC, "commands", "scaffold.ts")]);
  const reached = [...packages].filter((name) => name.startsWith("@gadgets/"));
  assert.deepEqual(reached, [], `reachable from ${[...files].map((file) => relative(SRC, file)).join(", ")}`);
  // And it really is lazy: no command module is pulled in statically.
  assert.deepEqual([...files].map((file) => relative(SRC, file)).filter((file) => file.startsWith("commands/")),
    ["commands/scaffold.ts"]);
  assert.deepEqual([...packages].filter((name) => !name.startsWith("node:")), ["@clack/prompts"]);
});

test("the core is pure: no CLI shell, no cf subprocess, no prompts", () => {
  const core = join(SRC, "core");
  for (const name of readdirSync(core).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))) {
    const { static: imports, dynamic } = importsOf(join(core, name));
    const source = readFileSync(join(core, name), "utf8");
    const typeOnly = [...source.matchAll(/^import\s+type\b[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
    for (const specifier of [...imports, ...dynamic, ...typeOnly]) {
      assert.doesNotMatch(specifier, /^\.\.\/|^node:child_process$|^@clack\//, `core/${name} imports ${specifier}`);
      // Values only from the core itself; upstream's declarations as types only.
      if (!specifier.startsWith("./")) {
        assert.ok(typeOnly.includes(specifier) && specifier.startsWith("@gadgets/scripts/"),
          `core/${name} imports ${specifier}`);
      }
    }
  }
});
