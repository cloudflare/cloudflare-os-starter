import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cli, finish, invocationDir, type CliDeps } from "./main.ts";
import { DELEGATION_SENTINEL, type SpawnDelegate } from "./project.ts";
import { scratchProject, TEMPLATE } from "./test-support.ts";

const SRC = dirname(fileURLToPath(import.meta.url));
const MAIN = join(SRC, "main.ts");

/** Runs `cf-os <argv>` in-process, capturing stderr lines, stdout writes and any delegation. */
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
  const dir = mkdtempSync(join(tmpdir(), "cf-os-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A scratch project with its own copy of the CLI (an empty stand-in), installed. */
function projectWithLocalCopy(
  t: Parameters<typeof scratchProject>[0],
  dir = "cf-os",
): { root: string; local: string } {
  const root = scratchProject(t, TEMPLATE);
  const local = join(root, "packages", dir, "src", "main.ts");
  mkdirSync(dirname(local), { recursive: true });
  mkdirSync(join(root, "packages", dir, "node_modules"));
  writeFileSync(local, "");
  return { root, local };
}

test("prints usage and fails on no command or an unknown one", async (t) => {
  const cwd = tempDir(t);
  const none = await run(t, [], { cwd });
  assert.equal(none.code, 1);
  assert.match(none.log, /Usage: cf-os <command>/);
  const unknown = await run(t, ["frobnicate"], { cwd });
  assert.equal(unknown.code, 1);
  assert.match(unknown.log, /Unknown command "frobnicate"/);
  const bad = await run(t, ["import", "--nope"], { cwd });
  assert.equal(bad.code, 1);
  assert.match(bad.log, /Unknown option '--nope'[\s\S]*Usage: cf-os import/);
});

test("prints each command's help on stdout, anywhere", async (t) => {
  const cwd = tempDir(t);
  for (const name of ["init", "import", "access", "secrets", "check", "deploy", "update", "install"]) {
    const { code, stdout } = await run(t, [name, "--help"], { cwd });
    assert.equal(code, 0, name);
    assert.match(stdout, new RegExp(`^Usage: cf-os ${name}\\b`), name);
    assert.match(stdout, /--profile <name>/, name);
  }
  const { code, stdout } = await run(t, ["--help"], { cwd });
  assert.equal(code, 0);
  assert.match(stdout, /Commands:\n {2}init/);
});

test("outside a project, only init and update run", async (t) => {
  const cwd = tempDir(t);
  for (const name of ["import", "access", "secrets", "check", "deploy", "install"]) {
    const { code, log } = await run(t, [name], { cwd });
    assert.equal(code, 1, name);
    assert.match(log, /Run `cf-os init <dir>` to create one/, name);
  }
  // update moves the pin of any repository that has one, so it is the command that refuses here.
  const updated = await run(t, ["update", "--upstream"], { cwd });
  assert.equal(updated.code, 1);
  assert.match(updated.log, /Update failed\. .* is not a git checkout/);
  assert.doesNotMatch(updated.log, /Not in a Cloudflare OS project/);
  // init scaffolds -- which, with no terminal, needs the directory.
  const { code, log } = await run(t, ["init"], { cwd });
  assert.equal(code, 1);
  assert.match(log, /cf-os init <dir>/);
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

test("hands off to a copy at packages/cfos, where projects from before the rename keep it", async (t) => {
  const { root, local: legacy } = projectWithLocalCopy(t, "cfos");
  const { spawned } = await run(t, ["check"], { cwd: root });
  assert.deepEqual(spawned.map((entry) => entry.args), [[legacy, "check"]]);
});

test("hands off what only the project's copy may know: other commands, options and help", async (t) => {
  const { root, local } = projectWithLocalCopy(t);
  for (const argv of [["frobnicate"], ["check", "--newer-option"], ["deploy", "--help"]]) {
    const { code, spawned, log } = await run(t, argv, { cwd: root });
    assert.equal(code, 0, argv.join(" "));
    assert.deepEqual(spawned.map((entry) => entry.args), [[local, ...argv]]);
    assert.equal(log, "");
  }
});

test("says to install a project whose dependencies are not, rather than crash in its copy", async (t) => {
  const { root } = projectWithLocalCopy(t);
  rmSync(join(root, "packages", "cf-os", "node_modules"), { recursive: true });
  const { code, log, spawned } = await run(t, ["check"], { cwd: root });
  assert.equal(code, 1);
  assert.match(log, /is not installed yet: run `pnpm install` there/);
  assert.deepEqual(spawned, []);
});

test("resolves paths from where a package-manager script was started, when that is below it", () => {
  const root = join(tmpdir(), "project");
  const docs = join(root, "docs");
  assert.equal(invocationDir(root, { npm_lifecycle_event: "cf-os", INIT_CWD: docs }), docs);
  assert.equal(invocationDir(root, { INIT_CWD: docs }), root, "not started by a script");
  assert.equal(invocationDir(root, { npm_lifecycle_event: "cf-os", INIT_CWD: tmpdir() }), root, "above it");
  assert.equal(invocationDir(root, { npm_lifecycle_event: "cf-os", INIT_CWD: root }), root);
});

test("runs update in the copy that was started, even with the project's own present", async (t) => {
  const { root } = projectWithLocalCopy(t);
  // A scratch project is no git checkout, so the update itself stops at once -- here, not in a child.
  const { code, log, spawned } = await run(t, ["update", "--dry-run"], { cwd: root });
  assert.deepEqual(spawned, []);
  assert.equal(code, 1);
  assert.match(log, /Update failed\. .* is not a git checkout/);
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
  assert.match(log, /predates the cf-os CLI\. Bring it up to date with `npx cf-os@latest update`/);
  assert.deepEqual(spawned, []);
});

test("install runs, and says what to do, with no submodule checked out", (t) => {
  // A real process: what matters is that nothing on the install path imports the submodule.
  const root = scratchProject(t, TEMPLATE);
  const result = spawnSync(process.execPath, [MAIN, "install"], {
    cwd: root, encoding: "utf8", env: { ...process.env, [DELEGATION_SENTINEL]: "1" },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /cf-os install: cloudflare-os\/ is empty, so the submodule is not checked out/);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find/);
});

test("a cancelled or failed run exits once its output has flushed; a successful one leaves the exit to the event loop", async (t) => {
  const before = process.exitCode;
  t.after(() => {
    process.exitCode = before;
  });
  const order: string[] = [];
  // Each stream reports its write done a turn of the event loop later, as a pipe does. The test
  // runner's own output, on stdout too, is not finish's, and goes through.
  const writes = (["stdout", "stderr"] as const).map((name) => {
    const write = process[name].write.bind(process[name]) as (chunk: string, done?: () => void) => boolean;
    return t.mock.method(process[name], "write", (chunk: string, done?: () => void) => {
      if (chunk !== "") return write(chunk, done);
      order.push(`${name} write`);
      setImmediate(() => {
        order.push(`${name} flushed`);
        done?.();
      });
      return true;
    });
  });
  const exits: number[] = [];
  await finish(130, (code) => {
    order.push("exit");
    exits.push(code);
  });
  assert.deepEqual(exits, [130]);
  assert.deepEqual(order, ["stdout write", "stderr write", "stdout flushed", "stderr flushed", "exit"]);
  assert.equal(process.exitCode, before, "set the exit code it exits with");

  // A failed run exits the same way, so the reads still running beside the failed one end with it.
  order.length = 0;
  await finish(1, (code) => {
    order.push("exit");
    exits.push(code);
  });
  for (const write of writes) write.mock.restore();
  assert.deepEqual(exits, [130, 1]);
  assert.deepEqual(order, ["stdout write", "stderr write", "stdout flushed", "stderr flushed", "exit"]);

  await finish(0, (code) => exits.push(code));
  assert.deepEqual(exits, [130, 1]);
  assert.equal(process.exitCode, 0);
});

test("a failed run ends the cf reads still running beside it, rather than waiting on them", () => {
  // A cf child that would run for 20 s, then a failure: the process exits at once, and takes the child with it.
  const script = `
    import { spawnCf } from ${JSON.stringify(join(SRC, "cf-client.ts"))};
    import { finish } from ${JSON.stringify(MAIN)};
    const env = { ...process.env, CLOUDFLARE_API_TOKEN: "unused" };
    spawnCf(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { cwd: process.cwd(), env });
    await finish(1);
  `;
  const started = Date.now();
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(Date.now() - started < 10000, `exited after ${Date.now() - started} ms`);
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
  // A published copy runs dispatch, delegation, scaffolding and update only, and lacks the `link:`
  // package.
  const { files, packages } = staticClosure([MAIN, join(SRC, "commands", "scaffold.ts"), join(SRC, "commands", "update.ts")]);
  const reached = [...packages].filter((name) => name.startsWith("@gadgets/"));
  assert.deepEqual(reached, [], `reachable from ${[...files].map((file) => relative(SRC, file)).join(", ")}`);
  // And it really is lazy: no command module is pulled in statically. Slashes, for Windows paths.
  assert.deepEqual([...files].map((file) => relative(SRC, file).replaceAll("\\", "/"))
    .filter((file) => file.startsWith("commands/")).toSorted(),
    ["commands/scaffold.ts", "commands/update.ts"]);
  assert.deepEqual([...packages].filter((name) => !name.startsWith("node:")), ["@clack/prompts"]);
  // What a global install gets is exactly that: everything else is the project copy's, from its own install.
  const manifest = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies), ["@clack/prompts"]);
});

test("init and secrets load without the submodule, to refuse or fail as they would", () => {
  // Checked out without it, @gadgets/scripts resolves to nothing: those that read upstream load it
  // lazily (gatekeeper-catalog.ts, local-bin.ts, cf-client.ts through the context's client).
  for (const command of ["init", "secrets"]) {
    const { files, packages } = staticClosure([join(SRC, "commands", `${command}.ts`)]);
    const reached = [...packages].filter((name) => name.startsWith("@gadgets/"));
    assert.deepEqual(reached, [], `${command}: reachable from ${[...files].map((file) => relative(SRC, file)).join(", ")}`);
  }
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
