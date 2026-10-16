import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scriptedPrompter, testContext, type Step } from "../test-support.ts";
import { DEFAULT_TEMPLATE, scaffold, type ScaffoldDeps } from "./scaffold.ts";

/** One recorded external command. */
interface Ran {
  command: string;
  args: string[];
  cwd: string;
}

/** What the recording tools report: by `<command> <first args>`, a status and output. */
type Replies = Record<string, { status?: number; stdout?: string; error?: boolean }>;

/**
 * Deps that record every command. A successful `git clone` lays out what a clone of the starter
 * would -- `.git`, `deployment.jsonc`, the CLI's own entry -- so later steps see a real project.
 */
function recording(replies: Replies = {}, nodeVersion = "24.19.0") {
  const ran: Ran[] = [];
  const configured: { entry: string; argv: string[]; cwd: string }[] = [];
  const deps: ScaffoldDeps = {
    nodeVersion,
    spawn: (command, args, { cwd }) => {
      ran.push({ command, args, cwd });
      const key = Object.keys(replies)
        .filter((candidate) => `${command} ${args.join(" ")}`.startsWith(candidate))
        .toSorted((a, b) => b.length - a.length)[0];
      const reply = key ? replies[key] : {};
      if (reply.error) return { status: null, stdout: "", error: new Error("ENOENT") };
      const status = reply.status ?? 0;
      if (command === "git" && args[0] === "clone" && status === 0) {
        const target = args.at(-1)!;
        mkdirSync(join(target, ".git"), { recursive: true });
        mkdirSync(join(target, "packages", "cfos", "src"), { recursive: true });
        writeFileSync(join(target, "deployment.jsonc"), "{}");
        writeFileSync(join(target, "packages", "cfos", "src", "main.ts"), "");
      }
      return { status, stdout: reply.stdout ?? (command === "pnpm" && args[0] === "--version" ? "11.17.0\n" : "") };
    },
    configure: (entry, argv, cwd) => {
      configured.push({ entry, argv, cwd });
      return 0;
    },
  };
  return { deps, ran, configured, commands: () => ran.map((entry) => [entry.command, ...entry.args].join(" ")) };
}

function workdir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "cfos-scaffold-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function scaffolding(
  t: { after: (fn: () => void) => void },
  { dir = "my-os", values = {}, replies, script, nodeVersion, flags }:
    { dir?: string; values?: Record<string, string>; replies?: Replies; script?: Step[]; nodeVersion?: string; flags?: object } = {},
) {
  const cwd = workdir(t);
  const tools = recording(replies, nodeVersion);
  const prompter = script ? scriptedPrompter(script) : null;
  const harness = testContext({ root: cwd, prompter, flags });
  const code = await scaffold({ command: "init", values, positionals: dir ? [dir] : [] }, harness.ctx, tools.deps);
  if (prompter) assert.deepEqual(prompter.remaining(), [], "the script was not used up");
  return { code, cwd, target: join(cwd, dir), ...tools, ...harness };
}

test("clones with the submodule, renames origin, installs, and stops without a terminal", async (t) => {
  const { code, target, commands, ran, configured, stderr } = await scaffolding(t);
  assert.equal(code, 0);
  assert.deepEqual(commands(), [
    "git --version",
    "pnpm --version",
    `git clone --recurse-submodules --shallow-submodules ${DEFAULT_TEMPLATE} ${target}`,
    "git remote rename origin starter",
    "pnpm install",
  ]);
  assert.deepEqual(ran.slice(3).map((entry) => entry.cwd), [target, target]);
  assert.deepEqual(configured, [], "configured without a terminal to ask at");
  assert.match(stderr(), /git pull starter main/);
  assert.match(stderr(), /Next:\n {2}cd my-os\n.*\n.*\n {2}pnpm cfos init$/);
});

test("clones the given template and ref", async (t) => {
  const { commands, target } = await scaffolding(t, { values: { template: "/src/fork", ref: "my-branch" } });
  assert.ok(commands().includes(
    `git clone --recurse-submodules --shallow-submodules --branch my-branch /src/fork ${target}`));
});

test("fetches the submodule in full when the server refuses a shallow fetch", async (t) => {
  // The superproject cloned; only the shallow submodule fetch failed.
  const cwd = workdir(t);
  const target = join(cwd, "my-os");
  const tools = recording();
  const inner = tools.deps.spawn;
  let first = true;
  tools.deps.spawn = (command, args, options) => {
    if (command === "git" && args[0] === "clone" && first) {
      first = false;
      inner(command, args, options);
      tools.ran.at(-1)!.args = args;
      return { status: 128, stdout: "" };
    }
    return inner(command, args, options);
  };
  const harness = testContext({ root: cwd });
  assert.equal(await scaffold({ command: "init", values: {}, positionals: ["my-os"] }, harness.ctx, tools.deps), 0);
  assert.deepEqual(tools.commands().slice(2, 4), [
    `git clone --recurse-submodules --shallow-submodules ${DEFAULT_TEMPLATE} ${target}`,
    "git submodule update --init --recursive",
  ]);
});

test("clones again without --shallow-submodules when nothing was cloned", async (t) => {
  const { code, commands, target } = await scaffolding(t, {
    replies: { "git clone --recurse-submodules --shallow-submodules": { status: 128 } },
  });
  assert.equal(code, 0);
  assert.deepEqual(commands().slice(2, 4), [
    `git clone --recurse-submodules --shallow-submodules ${DEFAULT_TEMPLATE} ${target}`,
    `git clone --recurse-submodules ${DEFAULT_TEMPLATE} ${target}`,
  ]);
});

test("at a terminal, offers both sign-ins, then hands over to the new project's init", async (t) => {
  const { code, target, commands, configured } = await scaffolding(t, {
    replies: {
      "pnpm exec cf auth whoami": { stdout: '{"authenticated":false,"error":"Not logged in"}' },
      "pnpm exec wrangler whoami --json": { status: 1 },
    },
    script: [["Sign in to cf?", true], ["Sign in to Wrangler?", true]],
    flags: { profile: "work" },
  });
  assert.equal(code, 0);
  assert.deepEqual(commands().slice(5), [
    "pnpm exec cf auth whoami",
    "pnpm exec cf auth login",
    "pnpm exec wrangler whoami --json",
    "pnpm exec wrangler login",
  ]);
  assert.deepEqual(configured, [{
    entry: join(target, "packages", "cfos", "src", "main.ts"),
    argv: ["init", "--profile", "work"],
    cwd: target,
  }]);
});

test("offers no sign-in that is not needed, and takes no for an answer", async (t) => {
  const signedIn = await scaffolding(t, {
    replies: { "pnpm exec cf auth whoami": { stdout: '{"authenticated":true}' } },
    script: [],
  });
  assert.deepEqual(signedIn.commands().slice(5), ["pnpm exec cf auth whoami", "pnpm exec wrangler whoami --json"]);
  const declined = await scaffolding(t, {
    replies: {
      "pnpm exec cf auth whoami": { stdout: '{"authenticated":false}' },
      "pnpm exec wrangler whoami --json": { status: 1 },
    },
    script: [["Sign in to cf?", false], ["Sign in to Wrangler?", false]],
  });
  assert.ok(!declined.commands().some((command) => command.endsWith("login")));
  assert.equal(declined.configured.length, 1);
});

test("asks where to create the project at a terminal", async (t) => {
  const { code, cwd, commands } = await scaffolding(t, {
    dir: "",
    // Wrangler reads as signed in: its whoami exits 0 here.
    script: [["Where should the project go?", "chosen"], ["Sign in to cf?", false]],
  });
  assert.equal(code, 0);
  assert.ok(commands().some((command) => command.endsWith(join(cwd, "chosen"))));
});

test("refuses a directory that is not empty, before running anything", async (t) => {
  const cwd = workdir(t);
  mkdirSync(join(cwd, "busy"));
  writeFileSync(join(cwd, "busy", "notes.txt"), "mine");
  const tools = recording();
  const harness = testContext({ root: cwd });
  await assert.rejects(
    scaffold({ command: "init", values: {}, positionals: ["busy"] }, harness.ctx, tools.deps),
    /busy is not empty/);
  assert.deepEqual(tools.ran, []);
  // An empty one is fine.
  mkdirSync(join(cwd, "empty"));
  assert.equal(await scaffold({ command: "init", values: {}, positionals: ["empty"] }, harness.ctx, tools.deps), 0);
});

test("reports every missing tool with its fix, and clones nothing", async (t) => {
  const { code, commands, stderr } = await scaffolding(t, {
    replies: { "git --version": { error: true }, "pnpm --version": { error: true } },
    nodeVersion: "22.12.0",
  });
  assert.equal(code, 1);
  assert.deepEqual(commands(), ["git --version", "pnpm --version"]);
  assert.match(stderr(), /git is not installed/);
  assert.match(stderr(), /Node 24\.19 or later is required; this is 22\.12\.0/);
  assert.match(stderr(), /pnpm is not installed\. Run `corepack enable`/);
});

test("refuses the wrong pnpm major", async (t) => {
  const { code, stderr } = await scaffolding(t, { replies: { "pnpm --version": { stdout: "10.4.1\n" } } });
  assert.equal(code, 1);
  assert.match(stderr(), /pnpm 11 is required; this is 10\.4\.1/);
});

test("without a terminal, needs the directory as an argument", async (t) => {
  await assert.rejects(scaffolding(t, { dir: "" }), /cfos init <dir>/);
});
