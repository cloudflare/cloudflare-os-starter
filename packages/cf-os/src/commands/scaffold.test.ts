import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cfClient } from "../cf-client.ts";
import { UsageError, type GlobalFlags } from "../context.ts";
import { parseDeployment, valueAtPath } from "../deployment-file.ts";
import { FAKE_ACCOUNT, fakeCf } from "../fake-cf.ts";
import { parseCommandLine } from "../main.ts";
import {
  DEFAULT,
  hostedAccountLive,
  scriptedPrompter,
  TEMPLATE,
  testCatalog,
  testContext,
  type Step,
} from "../test-support.ts";
import { configure, type InitDeps } from "./init.ts";
import { DEFAULT_TEMPLATE, importCommand, initCommand, scaffold, UPSTREAM, type ScaffoldDeps } from "./scaffold.ts";
import { BRIEF, movePin } from "./update.ts";

/** One recorded external command. */
interface Ran {
  command: string;
  args: string[];
  cwd: string;
}

/** What the recording tools report: by `<command> <first args>`, a status and output. */
type Replies = Record<string, { status?: number; stdout?: string; error?: boolean }>;

/**
 * Deps that record every command, the captured status reads through `spawn` as well, so a test
 * standing in for `spawn` covers them too. A successful `git clone` lays out what a clone of the starter
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
        mkdirSync(join(target, "packages", "cf-os", "src"), { recursive: true });
        writeFileSync(join(target, "deployment.jsonc"), "{}");
        writeFileSync(join(target, "packages", "cf-os", "src", "main.ts"), "");
      }
      return { status, stdout: reply.stdout ?? (command === "pnpm" && args[0] === "--version" ? "11.17.0\n" : "") };
    },
    capture: async (command, args, { cwd, env }) => deps.spawn(command, args, { cwd, env, capture: true }),
    configure: async (entry, argv, cwd) => {
      configured.push({ entry, argv, cwd });
      return 0;
    },
  };
  return { deps, ran, configured, commands: () => ran.map((entry) => [entry.command, ...entry.args].join(" ")) };
}

function workdir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "cf-os-scaffold-"));
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
  assert.match(stderr(), /npx cf-os@latest update/);
  assert.match(stderr(), /\n {2}cd my-os\n {2}gh repo create <owner>\/my-os --private --source \. --remote origin --push\n {2}pnpm cf-os init$/);
  assert.ok(!commands().some((command) => command.startsWith("gh ")), "ran gh without a terminal");
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

/** `gh`, signed in as "me". */
const GH: Replies = { "gh api user": { stdout: "me\n" } };

test("at a terminal, creates a private repository, then hands over to the new project's init", async (t) => {
  const { code, target, commands, ran, configured, stderr } = await scaffolding(t, {
    replies: GH,
    script: [["Create a private GitHub repository", true], ["Repository (owner/name)", DEFAULT]],
    flags: { profile: "work" },
  });
  assert.equal(code, 0);
  assert.deepEqual(commands().slice(4), [
    "gh api user -q .login",
    "pnpm install",
    "gh repo create me/my-os --private --source . --remote origin --push",
  ]);
  assert.ok(ran.slice(5).every((entry) => entry.cwd === target));
  assert.match(stderr(), /https:\/\/github\.com\/me\/my-os/);
  assert.deepEqual(configured, [{
    entry: join(target, "packages", "cf-os", "src", "main.ts"),
    argv: ["init", "--profile", "work"],
    cwd: target,
  }]);
});

test("without gh, says how to add a repository by hand, and asks nothing", async (t) => {
  const { commands, configured, stderr } = await scaffolding(t, { replies: { "gh api user": { error: true } }, script: [] });
  assert.deepEqual(commands().slice(4), ["gh api user -q .login", "pnpm install"]);
  assert.match(stderr(), /git remote add origin <url>/);
  assert.equal(configured.length, 1);
});

test("with gh signed out, signs in once asked, then creates the repository", async (t) => {
  const cwd = workdir(t);
  const tools = recording(GH);
  const inner = tools.deps.spawn;
  let signedIn = false;
  tools.deps.spawn = (command, args, options) => {
    const result = inner(command, args, options);
    if (command === "gh" && args.join(" ") === "auth login") signedIn = true;
    if (command === "gh" && args[0] === "api" && !signedIn) return { status: 1, stdout: "" };
    return result;
  };
  const prompter = scriptedPrompter([["Create a private GitHub repository", true], ["Repository (owner/name)", DEFAULT]]);
  const harness = testContext({ root: cwd, prompter });
  assert.equal(await scaffold({ command: "init", values: {}, positionals: ["my-os"] }, harness.ctx, tools.deps), 0);
  assert.deepEqual(prompter.remaining(), []);
  assert.deepEqual(tools.commands().slice(4), [
    "gh api user -q .login",
    "pnpm install",
    "gh auth login",
    "gh api user -q .login",
    "gh repo create me/my-os --private --source . --remote origin --push",
  ]);
  // Each check shows it is waiting on gh.
  assert.deepEqual(prompter.waited, ["Checking the GitHub CLI's sign-in", "Checking the GitHub CLI's sign-in"]);
});

test("checks gh's sign-in as it is, at a terminal that draws no spinner", async (t) => {
  const cwd = workdir(t);
  const tools = recording(GH);
  const { busy: _busy, ...prompter } = scriptedPrompter([["Create a private GitHub repository", false]]);
  const harness = testContext({ root: cwd, prompter });
  assert.equal(await scaffold({ command: "init", values: {}, positionals: ["my-os"] }, harness.ctx, tools.deps), 0);
  assert.deepEqual(prompter.remaining(), []);
  assert.deepEqual(tools.commands().slice(4), ["gh api user -q .login", "pnpm install"]);
});

test("when the gh sign-in does not take, says how to finish later, and carries on to init", async (t) => {
  const { commands, configured, stderr } = await scaffolding(t, {
    replies: { "gh api user": { status: 1 } },
    script: [["Create a private GitHub repository", true]],
  });
  assert.deepEqual(commands().slice(4), ["gh api user -q .login", "pnpm install", "gh auth login", "gh api user -q .login"]);
  assert.match(stderr(), /still cannot reach your account[\s\S]*gh repo create <owner>\/my-os/);
  assert.equal(configured.length, 1);
});

test("declined, signs nobody in to gh", async (t) => {
  const { commands } = await scaffolding(t, {
    replies: { "gh api user": { status: 1 } },
    script: [["Create a private GitHub repository", false]],
  });
  assert.deepEqual(commands().slice(4), ["gh api user -q .login", "pnpm install"]);
});

test("takes no for an answer", async (t) => {
  const { commands, configured, stderr } = await scaffolding(t, {
    replies: GH,
    script: [["Create a private GitHub repository", false]],
  });
  assert.ok(!commands().some((command) => command.startsWith("gh repo create")));
  assert.match(stderr(), /git remote add origin <url>/);
  assert.equal(configured.length, 1);
});

test("carries on to init when the repository cannot be created", async (t) => {
  const { code, configured, stderr } = await scaffolding(t, {
    replies: { ...GH, "gh repo create": { status: 1 } },
    script: [["Create a private GitHub repository", true], ["Repository (owner/name)", "me/taken"]],
  });
  assert.equal(code, 0);
  assert.match(stderr(), /Could not create me\/taken; gh's output is above/);
  assert.equal(configured.length, 1);
});

test("asks where to create the project at a terminal", async (t) => {
  const { code, cwd, commands } = await scaffolding(t, {
    dir: "",
    script: [["Where should the project go?", "chosen"], ["Create a private GitHub repository", false]],
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
  await assert.rejects(scaffolding(t, { dir: "" }), /cf-os init <dir>/);
});

test("checks gh's sign-in while the install runs, and stops the check when the install fails", async (t) => {
  const cwd = workdir(t);
  const tools = recording({ ...GH, "pnpm install": { status: 1 } });
  const signals: (AbortSignal | undefined)[] = [];
  const capture = tools.deps.capture;
  tools.deps.capture = (command, args, options) => {
    signals.push(options.signal);
    return capture(command, args, options);
  };
  const harness = testContext({ root: cwd, prompter: scriptedPrompter([]) });
  await assert.rejects(scaffold({ command: "init", values: {}, positionals: ["my-os"] }, harness.ctx, tools.deps),
    /pnpm install failed/);
  assert.deepEqual(tools.commands().slice(4), ["gh api user -q .login", "pnpm install"]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, true);
});

// The commands the hosted deploy flow prints for a deployment it cannot or should not update: the
// two main.test.ts parses, which are a contract with the deploy service's own test
// (packages/deploy/src/tests/take-over.test.ts in the gadgets-internal repository). Here: what
// scaffolding does with every flag of each.
const TAKE_OVER_DEFAULT_NAMES =
  "npx cf-os@latest init cloudflareos --take-over cloudflareos --account 0123456789abcdef0123456789abcdef --release r004945-6c8d301 --commit 6c8d301dcfef4e8fdff41a3db5fe3f8bb82f8e2d";
const TAKE_OVER_CUSTOM_NAMES =
  "npx cf-os@latest init moss --take-over moss --account 0123456789abcdef0123456789abcdef --router moss-os --backend moss-api --release r004945-6c8d301 --commit 6c8d301dcfef4e8fdff41a3db5fe3f8bb82f8e2d";

/**
 * A printed command line as the dispatcher hands it to scaffolding: the directory, the command's
 * values, and the global flags among them.
 */
function printed(line: string): { dir: string; values: Record<string, string>; flags: GlobalFlags } {
  const { command, values, positionals } = parseCommandLine(line.split(" ").slice(2));
  assert.equal(command, "init");
  const text = Object.fromEntries(Object.entries(values).flatMap(([name, value]) => typeof value === "string" ? [[name, value]] : []));
  return { dir: positionals[0], values: text, flags: { account: text.account, profile: text.profile, config: text.config } };
}

/** At a terminal, with no repository wanted: straight on to the new project's init. */
const NO_REPOSITORY: Step[] = [["Create a private GitHub repository", false]];

test("hands the new project's init the take-over the deploy flow's command asks for, flag for flag", async (t) => {
  const defaults = await scaffolding(t, { ...printed(TAKE_OVER_DEFAULT_NAMES), script: NO_REPOSITORY });
  assert.equal(defaults.code, 0);
  assert.deepEqual(defaults.configured, [{
    entry: join(defaults.target, "packages", "cf-os", "src", "main.ts"),
    argv: [
      "init", "--take-over", "cloudflareos", "--account", "0123456789abcdef0123456789abcdef",
      "--release", "r004945-6c8d301", "--commit", "6c8d301dcfef4e8fdff41a3db5fe3f8bb82f8e2d",
    ],
    cwd: defaults.target,
  }]);
  assert.equal(defaults.target, join(defaults.cwd, "cloudflareos"));
  assert.match(defaults.stderr(), /Created \S+\/cloudflareos\. Now taking over cloudflareos from it\./);

  const custom = await scaffolding(t, { ...printed(TAKE_OVER_CUSTOM_NAMES), script: NO_REPOSITORY });
  assert.equal(custom.code, 0);
  assert.deepEqual(custom.configured.map(({ argv }) => argv), [[
    "init", "--take-over", "moss", "--account", "0123456789abcdef0123456789abcdef", "--router", "moss-os", "--backend", "moss-api",
    "--release", "r004945-6c8d301", "--commit", "6c8d301dcfef4e8fdff41a3db5fe3f8bb82f8e2d",
  ]]);
  // What it hands on is the command line again, from --take-over on: nothing dropped, nothing reordered.
  assert.equal(custom.configured[0].argv.slice(1).join(" "), TAKE_OVER_CUSTOM_NAMES.slice(TAKE_OVER_CUSTOM_NAMES.indexOf("--take-over")));
  assert.equal(defaults.configured[0].argv.slice(1).join(" "), TAKE_OVER_DEFAULT_NAMES.slice(TAKE_OVER_DEFAULT_NAMES.indexOf("--take-over")));
  // And the project's own dispatcher takes it as its init's take-over.
  assert.deepEqual(parseCommandLine(custom.configured[0].argv), {
    command: "init", positionals: [], values: { ...printed(TAKE_OVER_CUSTOM_NAMES).values },
  });

  // The flags the deploy flow leaves out are left out, and the sign-in is handed on with the rest.
  const bare = await scaffolding(t, { values: { "take-over": "acme" }, flags: { profile: "work" }, script: NO_REPOSITORY });
  assert.deepEqual(bare.configured.map(({ argv }) => argv), [["init", "--take-over", "acme", "--profile", "work"]]);
});

test("run again over the project it created, names the take-over to run inside it, with every flag", async (t) => {
  // The deploy flow's command a second time, as after the first run's take-over stopped: the directory is a project by then.
  const cwd = workdir(t);
  mkdirSync(join(cwd, "moss"));
  writeFileSync(join(cwd, "moss", "deployment.jsonc"), "{}\n");
  const tools = recording();
  const { dir, values, flags } = printed(TAKE_OVER_CUSTOM_NAMES);
  const inProject = TAKE_OVER_CUSTOM_NAMES.slice(TAKE_OVER_CUSTOM_NAMES.indexOf("--take-over"));
  for (const prompter of [null, scriptedPrompter([])]) {
    const harness = testContext({ root: cwd, flags, prompter });
    await assert.rejects(scaffold({ command: "init", values, positionals: [dir] }, harness.ctx, tools.deps), (error: Error) => {
      assert.equal(error.message,
        `${join(cwd, "moss")} is already a project, so nothing was created. To take moss over from it: cd into it and run ` +
        `\`pnpm cf-os init ${inProject}\` (without a terminal: \`pnpm cf-os import moss ${inProject.slice("--take-over moss ".length)} ` +
        "--out deployment.jsonc`).");
      return true;
    });
  }
  assert.deepEqual(tools.ran, []);
  // With no take-over asked for, plain init is the command.
  await assert.rejects(scaffold({ command: "init", values: {}, positionals: ["moss"] }, testContext({ root: cwd }).ctx, tools.deps),
    /moss is already a project\. To configure it: cd into it and run `pnpm cf-os init`\.$/);
});

test("an install that fails names the take-over to run once it is fixed, with every flag", async (t) => {
  const cwd = workdir(t);
  const tools = recording({ ...GH, "pnpm install": { status: 1 } });
  const { dir, values, flags } = printed(TAKE_OVER_CUSTOM_NAMES);
  const harness = testContext({ root: cwd, flags, prompter: scriptedPrompter([]) });
  await assert.rejects(scaffold({ command: "init", values, positionals: [dir] }, harness.ctx, tools.deps), (error: Error) => {
    assert.ok(error.message.endsWith("fix it, then run `pnpm install` and `pnpm cf-os init " +
      `${TAKE_OVER_CUSTOM_NAMES.slice(TAKE_OVER_CUSTOM_NAMES.indexOf("--take-over"))}\` there.`), error.message);
    return true;
  });
});

test("without a terminal, prints the import command that takes the instance over, with every flag, and exits 1", async (t) => {
  const { code, target, commands, configured, stderr } = await scaffolding(t, printed(TAKE_OVER_CUSTOM_NAMES));
  // The project was created, the take-over the command was for was not: a script must not read that as done.
  assert.equal(code, 1);
  assert.ok(existsSync(join(target, "deployment.jsonc")));
  assert.match(stderr(), /Created \S+\/moss, but moss was not taken over: that asks questions, and there is no terminal to ask them at\./);
  assert.deepEqual(configured, [], "configured without a terminal to ask at");
  assert.equal(commands().at(-1), "pnpm install");
  const command = "pnpm cf-os import moss --account 0123456789abcdef0123456789abcdef --router moss-os --backend moss-api " +
    "--release r004945-6c8d301 --commit 6c8d301dcfef4e8fdff41a3db5fe3f8bb82f8e2d --out deployment.jsonc";
  assert.ok(stderr().includes("then take over moss from it:\n  cd moss\n" +
    `  gh repo create <owner>/moss --private --source . --remote origin --push\n  ${command}\n`), stderr());
  assert.match(stderr(), /The last moves the project's cloudflare-os pin forward to the release moss runs, staged and not committed, then writes/);
  assert.ok(stderr().endsWith("At a terminal, `pnpm cf-os init --take-over moss --account 0123456789abcdef0123456789abcdef --router moss-os " +
    "--backend moss-api --release r004945-6c8d301 --commit 6c8d301dcfef4e8fdff41a3db5fe3f8bb82f8e2d` does the same and asks for the rest."));
  // The printed command is one `import` takes: its instance, and every one of those flags.
  assert.deepEqual(parseCommandLine(command.split(" ").slice(2)), {
    command: "import", positionals: ["moss"], values: {
      account: "0123456789abcdef0123456789abcdef", router: "moss-os", backend: "moss-api", release: "r004945-6c8d301",
      commit: "6c8d301dcfef4e8fdff41a3db5fe3f8bb82f8e2d", out: "deployment.jsonc",
    },
  });
  assert.equal(importCommand({ instance: "acme", flags: {}, profile: "work", config: "staging.jsonc" }, "staging.jsonc"),
    "pnpm cf-os import acme --profile work --config staging.jsonc --out staging.jsonc");
  // The terminal's counterpart carries the same flags, and --out only where one was given.
  const takeOver = { instance: "moss", flags: { router: "moss-os", backend: "moss-api" }, account: FAKE_ACCOUNT, profile: "work", config: "staging.jsonc" };
  assert.equal(initCommand(takeOver, "filled.jsonc"),
    `pnpm cf-os init --take-over moss --account ${FAKE_ACCOUNT} --router moss-os --backend moss-api --profile work --config staging.jsonc --out filled.jsonc`);
  assert.equal(initCommand({ instance: "acme", flags: {} }), "pnpm cf-os init --take-over acme");

  // Without --take-over, a project created with nobody to ask is the whole of what was asked for.
  const plain = await scaffolding(t);
  assert.equal(plain.code, 0);
});

test("refuses a take-over it cannot hand on, before anything is cloned", async (t) => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ commit: "6c8d301dcfef4e8fdff41a3db5fe3f8bb82f8e2d" }, /--router, --backend, --release and --commit describe the hosted instance to take over: pass --take-over <instance> with them\./],
    [{ "take-over": "moss", commit: "6c8d301" }, /--commit "6c8d301" is not a full commit SHA: all 40 hex digits/],
    [{ "take-over": "moss", release: "r004945/6c8d301" }, /--release "r004945\/6c8d301" is not a release id/],
    [{ "take-over": "Moss OS" }, /--take-over "Moss OS" is not an instance name/],
    [{ "take-over": "moss", router: "moss_os" }, /--router "moss_os" is not a Worker name/],
  ];
  for (const script of [undefined, []]) {
    for (const [values, message] of cases) {
      const cwd = workdir(t);
      const tools = recording();
      const harness = testContext({ root: cwd, prompter: script ? scriptedPrompter(script) : null });
      await assert.rejects(scaffold({ command: "init", values, positionals: ["my-os"] }, harness.ctx, tools.deps),
        (error) => error instanceof UsageError && message.test(error.message), JSON.stringify(values));
      assert.deepEqual(tools.ran, []);
      assert.equal(existsSync(join(cwd, "my-os")), false);
    }
    // The account the instance is in is part of the take-over: one that is no account ID is not cloned with.
    const cwd = workdir(t);
    const tools = recording();
    const harness = testContext({ root: cwd, prompter: script ? scriptedPrompter(script) : null, flags: { account: "acme-production" } });
    await assert.rejects(scaffold({ command: "init", values: { "take-over": "moss" }, positionals: ["my-os"] }, harness.ctx, tools.deps),
      (error) => error instanceof UsageError && /--account must be a 32-hex account ID, not "acme-production"\./.test(error.message));
    assert.deepEqual(tools.ran, []);
    assert.equal(existsSync(join(cwd, "my-os")), false);
  }
});

test("a starter with no CLI of its own cannot carry a take-over out, and says so", async (t) => {
  const cwd = workdir(t);
  const tools = recording();
  const inner = tools.deps.spawn;
  tools.deps.spawn = (command, args, options) => {
    const result = inner(command, args, options);
    if (command === "git" && args[0] === "clone") rmSync(join(args.at(-1)!, "packages"), { recursive: true });
    return result;
  };
  const harness = testContext({ root: cwd, prompter: scriptedPrompter(NO_REPOSITORY) });
  assert.equal(await scaffold({ command: "init", values: { "take-over": "acme" }, positionals: ["my-os"] }, harness.ctx, tools.deps), 1);
  assert.deepEqual(tools.configured, []);
  assert.match(harness.stderr(), /this starter has no packages\/cf-os to take acme over with, so nothing was taken over/);
});

// Against git itself: throwaway repositories under the temporary directory. An upstream of four
// commits, a starter pinning the third, and the project scaffolding clones from it, in which the new
// project's init runs in-process, moving the pin with `movePin` over the same git.

test("against git: a project just scaffolded is a clean checkout, so its init moves the pin for the take-over and writes the file", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cf-os-scaffold-git-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: base, GIT_CONFIG_GLOBAL: join(base, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
    // A submodule cloned from a local path, which git otherwise refuses.
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always",
  };
  const git = (cwd: string, args: string[], date?: string): string => {
    const result = spawnSync("git", args, {
      cwd, encoding: "utf8", env: date ? { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : env,
    });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };

  // Upstream: four commits on main, a day apart, each fetched by its SHA as GitHub allows.
  const upstream = join(base, "upstream");
  mkdirSync(upstream);
  git(upstream, ["init", "-q", "-b", "main"]);
  git(upstream, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const shas: Record<string, string> = {};
  for (const [index, name] of ["one", "two", "three", "four"].entries()) {
    writeFileSync(join(upstream, "file.txt"), `${name}\n`);
    git(upstream, ["add", "file.txt"]);
    git(upstream, ["commit", "-q", "-m", name], `2026-03-0${index + 1}T00:00:00Z`);
    shas[name] = git(upstream, ["rev-parse", "HEAD"]);
  }
  const url = `file://${upstream}`;

  // The starter: the deployment file, the CLI's own entry, and upstream pinned at its third commit.
  const starter = join(base, "starter");
  mkdirSync(join(starter, "packages", "cf-os", "src"), { recursive: true });
  git(starter, ["init", "-q", "-b", "main"]);
  writeFileSync(join(starter, "deployment.jsonc"), TEMPLATE);
  writeFileSync(join(starter, "package.json"), "{}\n");
  writeFileSync(join(starter, ".gitignore"), ".cf-os/\nnode_modules/\n");
  writeFileSync(join(starter, "packages", "cf-os", "src", "main.ts"), "");
  git(starter, ["submodule", "add", "-q", url, "cloudflare-os"]);
  git(join(starter, "cloudflare-os"), ["checkout", "-q", "--detach", shas.three]);
  git(starter, ["add", "-A"]);
  git(starter, ["commit", "-q", "-m", "Starter"]);

  // git for real, upstream's URL replaced by the local one; pnpm and gh recorded, not run.
  const ran: string[] = [];
  const strayed: string[] = [];
  const tool = (command: string, args: string[], cwd: string) => {
    const line = [command, ...args].join(" ");
    ran.push(line);
    if (command === "gh") return { status: null, stdout: "", error: new Error("ENOENT") };
    if (command !== "git") return { status: 0, stdout: command === "pnpm" && args[0] === "--version" ? "11.17.0\n" : "" };
    const local = args.map((arg) => arg === UPSTREAM ? url : arg);
    // Anything else that names a remote would be the published starter's, or upstream's by another spelling.
    if (local.some((arg) => /github\.com|^https?:|^git@|^ssh:/.test(arg))) {
      strayed.push(line);
      return { status: 1, stdout: "" };
    }
    const result = spawnSync("git", local, { cwd, env, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
  };

  // The instance runs the release built from upstream's fourth commit, one past the starter's pin.
  const release = `r004945-${shas.four.slice(0, 7)}`;
  const hosted = hostedAccountLive(Object.fromEntries(
    ["acme", "acme-backend", "acme-gk-context", "acme-gk-scheduler", "acme-gk-github"].map((name) => [name, { release }])));
  const cf = fakeCf({ ...hosted, "auth whoami": { authenticated: true, email: "me@example.com" } });
  const move = `Move cloudflare-os ${shas.three.slice(0, 7)} → ${shas.four.slice(0, 7)} (1 commit)? acme runs release ${release}, which ` +
    "this project's pin is behind: deployed as it is, it would put older code over storage the instance has already migrated, " +
    "which cannot be undone. The move is staged, not committed, and merges nothing of the starter.";
  const prompter = scriptedPrompter([
    [move, true],
    ["Admin emails", DEFAULT],
    ["Web Search Gatekeeper Worker name", DEFAULT],
    ["Which Gatekeepers?", []],
    ["Error Reporter Worker name", DEFAULT],
    ["Which model providers?", DEFAULT],
    ["Deploy now?", false],
  ]);
  const handed: string[][] = [];
  const projectLog: string[] = [];
  const projectState: string[] = [];
  const deps: ScaffoldDeps = {
    nodeVersion: "24.19.0",
    spawn: (command, args, { cwd }) => tool(command, args, cwd),
    capture: async (command, args, { cwd }) => tool(command, args, cwd),
    // The new project's own `cf-os init`, in this process: its dispatcher's parse, then the command.
    configure: async (_entry, argv, cwd) => {
      handed.push(argv);
      // As scaffolding leaves it: nothing uncommitted, which is what a pin move asks of a checkout, and
      // the submodule a shallow clone, as `--shallow-submodules` makes it.
      projectState.push(git(cwd, ["status", "--porcelain"]));
      projectState.push(git(join(cwd, "cloudflare-os"), ["rev-parse", "--is-shallow-repository"]));
      const { values, positionals } = parseCommandLine(argv);
      const harness = testContext({
        root: cwd, client: cfClient({ spawn: cf.spawn }), prompter, flags: { account: String(values.account) },
      });
      const initDeps: InitDeps = {
        spawn: (command, args, options) => tool(command, args, options.cwd),
        capture: async (command, args, options) => tool(command, args, options.cwd),
        deploy: async () => 0,
        catalog: async () => testCatalog(),
        pin: (to, ctx, options) => movePin(to, ctx, options, {
          spawn: (command, args, { cwd: directory }) => tool(command, args, directory), now: () => new Date("2026-11-02T12:00:00Z"),
        }),
      };
      const code = await configure({ command: "init", values, positionals }, harness.ctx, initDeps);
      projectLog.push(harness.stderr());
      return code;
    },
  };

  const outer = testContext({ root: base, prompter, flags: { account: FAKE_ACCOUNT } });
  const values = { "take-over": "acme", release, commit: shas.four, template: starter };
  assert.equal(await scaffold({ command: "init", values, positionals: ["project"] }, outer.ctx, deps), 0, `${outer.stderr()}\n${projectLog.join("\n")}`);
  assert.deepEqual(prompter.remaining(), [], "the script was not used up");
  assert.deepEqual(strayed, [], "a command named a remote other than the local starter and upstream");
  assert.deepEqual(handed, [["init", "--take-over", "acme", "--account", FAKE_ACCOUNT, "--release", release, "--commit", shas.four]]);
  assert.deepEqual(projectState, ["", "true"]);

  const project = join(base, "project");
  // The pin alone moved: checked out and staged, the commit left as the starter made it, with the brief written.
  assert.equal(git(project, ["rev-parse", "HEAD"]), git(starter, ["rev-parse", "HEAD"]));
  assert.equal(git(project, ["rev-parse", "HEAD:cloudflare-os"]), shas.three);
  assert.equal(git(project, ["rev-parse", ":cloudflare-os"]), shas.four);
  assert.equal(git(join(project, "cloudflare-os"), ["rev-parse", "HEAD"]), shas.four);
  assert.deepEqual(git(project, ["status", "--porcelain"]).split("\n").map((line) => line.trimEnd()).toSorted(),
    [" M deployment.jsonc", "M  cloudflare-os"]);
  assert.equal(git(project, ["remote"]), "starter");
  assert.match(readFileSync(join(project, BRIEF), "utf8"), /Only the pin moved: the starter was not merged/);
  // Nothing of the starter was fetched or merged after the clone: the project's own git ran no fetch, merge or pull.
  assert.deepEqual(ran.filter((line) => /^git (fetch|merge|pull) /.test(line)), []);
  // Installed once by scaffolding, and once more by the move, for the pin it checked out.
  assert.deepEqual(ran.filter((line) => /^pnpm (--version|install)/.test(line)), ["pnpm --version", "pnpm install", "pnpm install"]);
  // Then the takeover, written into the project's file.
  const file = parseDeployment(readFileSync(join(project, "deployment.jsonc"), "utf8"));
  assert.equal(valueAtPath(file, ["accountId"]), FAKE_ACCOUNT);
  assert.equal(valueAtPath(file, ["workers", "workshop", "name"]), "acme-backend");
  assert.match(projectLog.join("\n"), new RegExp(`Release ${release} was built from cloudflare-os commit ${shas.four}, which --commit names\\.`));
  assert.match(projectLog.join("\n"), new RegExp(`Moved the cloudflare-os pin from ${shas.three} forward to it by 1 commit, staged and not committed`));
});
