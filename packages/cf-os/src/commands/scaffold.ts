// `cf-os init [<dir>] [--template <git-url|path>] [--ref <branch|tag>] [--take-over <instance>
//   [--router <name>] [--backend <name>] [--release <id>] [--commit <sha>]]`, outside a project
//
// Creates a project: clones the starter with its history and its `cloudflare-os` submodule, renames
// `origin` to `starter` (leaving `origin` for the project's own repository), installs, offers
// to create a private GitHub repository for it with `gh` and push there, then hands over to the new
// project's own `cf-os init` to configure and deploy it. Without a terminal it stops after the
// install and prints the next commands.
//
// With `--take-over`, the project is created to take over an instance of the hosted deploy, which is
// the command the hosted deploy flow prints: the new project's `cf-os init` is handed the instance
// and every flag that describes it, and carries the take-over out. Without a terminal, the command
// printed is `cf-os import` with those same flags, which asks nothing, and the exit code is 1, as
// the take-over asked for was not carried out. Either moves the project's Cloudflare OS pin forward
// to the release the instance runs, which needs a checkout with nothing uncommitted. A project just
// cloned is one: cloning and renaming a remote change no tracked file, and an install that did
// change one would have the move refused, saying so, not skipped.
//
// Private, and created rather than forked: a fork of the public starter has to stay public.
//
// This is the one command a globally installed `cf-os` runs itself, so it is on the packed path:
// node builtins and this package's own dependency-free modules only. In particular nothing here may
// reach `@gadgets/scripts`, which a published copy does not have; `pnpm` is spawned directly
// rather than through its `pnpmCommand()` for that reason.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  takeoverArgs,
  takeoverFlags,
  takeOverInstance,
  UsageError,
  type CommandArgs,
  type Context,
  type TakeoverFlags,
} from "../context.ts";
import { delegate, localEntry } from "../project.ts";
import { waitOn } from "../prompt.ts";
import { defaultCapture, defaultSpawn, succeeded, type CaptureTool, type SpawnTool, type ToolResult } from "../tools.ts";

/** The starter `init` clones by default. */
export const DEFAULT_TEMPLATE = "https://github.com/cloudflare/cloudflare-os-starter";

/** Cloudflare OS itself, which the starter pins as its `cloudflare-os` submodule. */
export const UPSTREAM = "https://github.com/cloudflare/cloudflare-os";

/** The directory offered when none is given. */
export const DEFAULT_DIR = "cloudflare-os";

/** The oldest Node the starter supports: its `engines`. */
const MIN_NODE: [number, number] = [24, 19];

/** The pnpm major the starter's `packageManager` pins. */
const PNPM_MAJOR = 11;

/** What scaffolding runs against, so tests can record the sequence instead of running it. */
export interface ScaffoldDeps {
  spawn: SpawnTool;
  /** The GitHub CLI's sign-in check. */
  capture: CaptureTool;
  /** `process.versions.node`. */
  nodeVersion: string;
  /** Hands the new project's `cf-os init` the terminal. Resolves to its exit code. */
  configure(entry: string, argv: string[], cwd: string): Promise<number>;
}

function defaultDeps(): ScaffoldDeps {
  return {
    spawn: defaultSpawn(),
    capture: defaultCapture(),
    nodeVersion: process.versions.node,
    configure: (entry, argv, cwd) => delegate(entry, argv, { cwd, env: process.env, spawn }),
  };
}

/**
 * Why `target` cannot be created into, or undefined when it can. For a project that is already
 * there, what to run in it instead: the take-over `takeOver` asks for with every flag it was given,
 * as when the command the hosted deploy flow prints is run a second time, or plain `init`.
 */
function targetProblem(target: string, takeOver?: TakeOverCommand): string | undefined {
  if (!existsSync(target)) return undefined;
  if (!statSync(target).isDirectory()) return `${target} exists and is not a directory.`;
  if (readdirSync(target).length === 0) return undefined;
  if (existsSync(join(target, "deployment.jsonc"))) {
    if (takeOver) {
      // `--config` named a file as seen from outside the project, so it is not handed on.
      const inProject = { ...takeOver, config: undefined };
      return `${target} is already a project, so nothing was created. To take ${takeOver.instance} over from it: cd ` +
        `into it and run \`${initCommand(inProject)}\` (without a terminal: \`${importCommand(inProject, "deployment.jsonc")}\`).`;
    }
    return `${target} is already a project. To configure it: cd into it and run \`pnpm cf-os init\`.`;
  }
  return `${target} is not empty. Pick a new directory, or an empty one.`;
}

/** Each missing or outdated tool, with its fix. */
export function preflight(cwd: string, deps: ScaffoldDeps): string[] {
  const problems: string[] = [];
  const git = deps.spawn("git", ["--version"], { cwd, capture: true });
  if (git.error || git.status !== 0) {
    problems.push("git is not installed. Install it: https://git-scm.com/downloads");
  }
  const [major = 0, minor = 0] = deps.nodeVersion.split(".").map(Number);
  if (major < MIN_NODE[0] || major === MIN_NODE[0] && minor < MIN_NODE[1]) {
    problems.push(`Node ${MIN_NODE.join(".")} or later is required; this is ${deps.nodeVersion}. ` +
      "Install it: https://nodejs.org");
  }
  const pnpm = deps.spawn("pnpm", ["--version"], { cwd, capture: true });
  if (pnpm.error || pnpm.status !== 0) {
    problems.push("pnpm is not installed. Run `corepack enable` (corepack ships with Node), then try again.");
  } else if (Number(pnpm.stdout.trim().split(".")[0]) !== PNPM_MAJOR) {
    problems.push(`pnpm ${PNPM_MAJOR} is required; this is ${pnpm.stdout.trim()}. Run \`corepack enable\`, ` +
      `or install pnpm ${PNPM_MAJOR}: https://pnpm.io/installation`);
  }
  return problems;
}

/** Clones `template` into `target`, submodule included. Throws when it cannot. */
function clone(ctx: Context, deps: ScaffoldDeps, template: string, target: string, ref?: string): void {
  const branch = ref ? ["--branch", ref] : [];
  const shallow = deps.spawn("git",
    ["clone", "--recurse-submodules", "--shallow-submodules", ...branch, template, target],
    { cwd: ctx.cwd, capture: false });
  if (!shallow.error && shallow.status === 0) return;

  // A server can refuse a shallow fetch of the pinned submodule commit. The superproject is usually
  // there by then, so only the submodule is fetched again, in full.
  if (existsSync(join(target, ".git"))) {
    ctx.out.log("\nRetrying the submodule without --shallow-submodules.");
    const submodule = deps.spawn("git", ["submodule", "update", "--init", "--recursive"],
      { cwd: target, capture: false });
    if (!submodule.error && submodule.status === 0) return;
    throw new Error("Could not check out the cloudflare-os submodule. Its output is above.");
  }
  ctx.out.log("\nRetrying without --shallow-submodules.");
  const full = deps.spawn("git", ["clone", "--recurse-submodules", ...branch, template, target],
    { cwd: ctx.cwd, capture: false });
  if (full.error) throw new Error(`Could not run git: ${full.error.message}`);
  if (full.status !== 0) throw new Error(`git clone ${template} failed. Its output is above.`);
}

/** A GitHub repository name, as `gh` takes it. */
const REPOSITORY = /^[A-Za-z\d][A-Za-z\d-]*\/[A-Za-z\d._-]+$/;

/** How to push the project to a repository of your own without `gh`. */
const MANUAL_REPOSITORY =
  "To keep the project in a repository of your own, create an empty private one, then run " +
  "`git remote add origin <url>` and `git push -u origin HEAD` in the project.";

/** What {@link offerRepository} runs, for when nobody is there to be offered it. */
function repositoryCommand(target: string): string {
  return `gh repo create <owner>/${basename(target)} --private --source . --remote origin --push`;
}

/**
 * The GitHub CLI's active account's login on stdout, or nothing when it cannot be used. Not
 * `gh auth status`: that fails when any stored account's token is stale, even with a working active one.
 */
function githubLogin(deps: ScaffoldDeps, target: string, signal?: AbortSignal): Promise<ToolResult> {
  return deps.capture("gh", ["api", "user", "-q", ".login"], { cwd: target, signal });
}

/**
 * Offers to create a private GitHub repository for the project and push it there, as `origin`.
 * Never fails the scaffold: without `gh`, declined, or failed, it says how to do it by hand. `login`
 * is {@link githubLogin}, started earlier.
 */
async function offerRepository(ctx: Context, deps: ScaffoldDeps, target: string, login: Promise<ToolResult>): Promise<void> {
  const prompter = ctx.prompter!;
  const whoami = (check: () => Promise<ToolResult>) => waitOn(ctx.prompter, "Checking the GitHub CLI's sign-in", check);
  const user = await whoami(() => login);
  if (user.error) {
    ctx.out.log(`\n${MANUAL_REPOSITORY}`);
    return;
  }
  if (!await prompter.confirm("Create a private GitHub repository for this project and push it?", true)) {
    ctx.out.log(`\n${MANUAL_REPOSITORY}`);
    return;
  }
  let owner = succeeded(user) ? user.stdout.trim() : "";
  // Signed out, `gh auth login` asks its own questions and opens a browser; then check it took.
  if (!owner) {
    ctx.out.log("\nThe GitHub CLI is not signed in. Signing in with `gh auth login`.\n");
    deps.spawn("gh", ["auth", "login"], { cwd: target, capture: false });
    const after = await whoami(() => githubLogin(deps, target));
    owner = succeeded(after) ? after.stdout.trim() : "";
    if (!owner) {
      ctx.out.log(`\nThe GitHub CLI still cannot reach your account, so no repository was created. Later, ` +
        `run \`gh auth login\` and \`${repositoryCommand(target)}\` in the project. Or: ${MANUAL_REPOSITORY}`);
      return;
    }
  }
  const name = await prompter.text("Repository (owner/name)", {
    initial: `${owner}/${basename(target)}`,
    validate: (value) => REPOSITORY.test(value) ? undefined : "Use owner/name, such as octocat/my-os.",
  });
  const created = deps.spawn("gh",
    ["repo", "create", name, "--private", "--source", ".", "--remote", "origin", "--push"],
    { cwd: target, capture: false });
  if (!succeeded(created)) {
    ctx.out.log(`\nCould not create ${name}` +
      `${created.error ? `: ${created.error.message}` : "; gh's output is above"}. The project is unaffected. ` +
      MANUAL_REPOSITORY);
    return;
  }
  ctx.out.log(`\nPushed the project to https://github.com/${name}, its origin remote. Starter updates still ` +
    "arrive with `npx cf-os@latest update`.");
}

/** A take-over as a command line gives it: the instance, and everything said about it and where to find it. */
export interface TakeOverCommand {
  /** The instance to take over. */
  instance: string;
  /** What `--router`, `--backend`, `--release` and `--commit` gave. */
  flags: TakeoverFlags;
  /** `--account`, when given. */
  account?: string;
  /** `--profile`, when given. */
  profile?: string;
  /** `--config`, when given, as it was typed. */
  config?: string;
}

/**
 * {@link TakeOverCommand} as the arguments after a command's name and the instance: `--account`,
 * then the take-over's own flags in the order the hosted deploy flow prints them, then `--profile`.
 */
function handedOn({ flags, account, profile }: TakeOverCommand): string[] {
  return [
    ...account ? ["--account", account] : [],
    ...takeoverArgs(flags),
    ...profile ? ["--profile", profile] : [],
  ];
}

/**
 * The command that carries `takeOver` out with nobody to ask: `cf-os import`, run in the project,
 * with every flag the take-over was given, writing into `out`. It moves the project's Cloudflare OS
 * pin forward to the release the instance runs, then writes what it found.
 */
export function importCommand(takeOver: TakeOverCommand, out: string): string {
  return [
    "pnpm cf-os import", takeOver.instance, ...handedOn(takeOver),
    ...takeOver.config ? ["--config", takeOver.config] : [],
    "--out", out,
  ].join(" ");
}

/**
 * The command that carries `takeOver` out at a terminal: `cf-os init --take-over`, run in the
 * project, with every flag the take-over was given, and `--out` when `out` names a file to write
 * other than the one read.
 */
export function initCommand(takeOver: TakeOverCommand, out?: string): string {
  return [
    "pnpm cf-os init --take-over", takeOver.instance, ...handedOn(takeOver),
    ...takeOver.config ? ["--config", takeOver.config] : [],
    ...out ? ["--out", out] : [],
  ].join(" ");
}

/** A Cloudflare account ID, as `--account` takes it. */
const ACCOUNT_ID = /^[a-f\d]{32}$/i;

/** What the take-over flags are for, said when one is given without `--take-over`. */
const FLAGS_NEED_TAKE_OVER =
  "--router, --backend, --release and --commit describe the hosted instance to take over: pass --take-over <instance> with them.";

/**
 * The take-over `values` ask for, each value checked to be of the form its flag takes, `--account`
 * among `given` included; undefined when `--take-over` was not given. A flag that describes an
 * instance, given without one, is a {@link UsageError}, as is a value of the wrong form: both before
 * anything is cloned or read.
 */
export function takeOverOf(values: CommandArgs["values"], given: Context["flags"]): TakeOverCommand | undefined {
  const instance = takeOverInstance(values);
  const flags = takeoverFlags(values);
  if (instance === undefined) {
    if (takeoverArgs(flags).length) throw new UsageError(FLAGS_NEED_TAKE_OVER);
    return undefined;
  }
  if (given.account !== undefined && !ACCOUNT_ID.test(given.account)) {
    throw new UsageError(`--account must be a 32-hex account ID, not "${given.account}".`);
  }
  return { instance, flags, account: given.account, profile: given.profile, config: given.config };
}

/** Creates a project from `args`, resolving to the exit code. */
export async function scaffold(args: CommandArgs, ctx: Context, deps: ScaffoldDeps): Promise<number> {
  if (args.values.out) throw new UsageError("--out only applies inside a project, to configure it.");
  const takeOver = takeOverOf(args.values, ctx.flags);
  const template = (args.values.template as string | undefined) ?? DEFAULT_TEMPLATE;
  const ref = args.values.ref as string | undefined;
  let dir = args.positionals[0];
  if (!dir) {
    if (!ctx.prompter) throw new UsageError("Pass the directory to create the project in: `cf-os init <dir>`.");
    dir = await ctx.prompter.text("Where should the project go?", {
      initial: DEFAULT_DIR,
      validate: (value) => targetProblem(resolve(ctx.cwd, value), takeOver),
    });
  }
  const target = resolve(ctx.cwd, dir);
  const problem = targetProblem(target, takeOver);
  if (problem) throw new Error(problem);

  const missing = preflight(ctx.cwd, deps);
  if (missing.length) {
    ctx.out.log(`Cannot create a project yet:\n${missing.map((line) => `  - ${line}`).join("\n")}`);
    return 1;
  }

  ctx.out.log(`Cloning ${template}${ref ? ` (${ref})` : ""} into ${target}.\n`);
  clone(ctx, deps, template, target, ref);

  const rename = deps.spawn("git", ["remote", "rename", "origin", "starter"], { cwd: target, capture: true });
  if (rename.error || rename.status !== 0) throw new Error("Could not rename the origin remote to starter.");
  ctx.out.log("\nThe starter is the `starter` remote. `npx cf-os@latest update` brings in its updates.\n");

  // Read while the install runs, for the repository offered after it at a terminal.
  const stopLoginCheck = new AbortController();
  const login = ctx.prompter ? githubLogin(deps, target, stopLoginCheck.signal) : undefined;
  const install = deps.spawn("pnpm", ["install"], { cwd: target, capture: false });
  if (install.error || install.status !== 0) {
    stopLoginCheck.abort();
    // The take-over the command was for, with its flags: plain `init` does not find an instance under names of its own.
    const next = takeOver ? initCommand({ ...takeOver, config: undefined }) : "pnpm cf-os init";
    throw new Error(`pnpm install failed in ${target}. Its output is above; fix it, then run ` +
      `\`pnpm install\` and \`${next}\` there.`);
  }

  // What the new project's own `cf-os init` is handed: the take-over with every flag it was given, or
  // the account and the sign-in alone.
  const passOn = takeOver
    ? ["--take-over", takeOver.instance, ...handedOn(takeOver)]
    : [
      ...ctx.flags.account ? ["--account", ctx.flags.account] : [],
      ...ctx.flags.profile ? ["--profile", ctx.flags.profile] : [],
    ];
  if (!ctx.prompter) {
    if (takeOver) {
      // `--config` named a file outside the project that is being created, so it is not handed on.
      const inProject = { ...takeOver, config: undefined };
      ctx.out.log(`\nCreated ${target}, but ${takeOver.instance} was not taken over: that asks questions, and there is ` +
        "no terminal to ask them at. Next, keep the project in a private GitHub repository, then take over " +
        `${takeOver.instance} from it:\n  cd ${dir}\n  ${repositoryCommand(target)}\n` +
        `  ${importCommand(inProject, "deployment.jsonc")}\n` +
        `The last moves the project's cloudflare-os pin forward to the release ${takeOver.instance} runs, staged and ` +
        "not committed, then writes what it found into deployment.jsonc, asking nothing. At a terminal, " +
        `\`${initCommand(inProject)}\` does the same and asks for the rest.`);
      // The project is there, the take-over the command was for is not: not a success to script on.
      return 1;
    }
    ctx.out.log(`\nCreated ${target}. Next, keep it in a private GitHub repository, then configure and ` +
      `deploy it:\n  cd ${dir}\n  ${repositoryCommand(target)}\n` +
      `  pnpm cf-os init${passOn.length ? ` ${passOn.join(" ")}` : ""}`);
    return 0;
  }
  await offerRepository(ctx, deps, target, login!);
  const entry = localEntry(target);
  if (!existsSync(entry)) {
    if (takeOver) {
      ctx.out.log(`\nCreated ${target}, but this starter has no packages/cf-os to take ${takeOver.instance} over ` +
        "with, so nothing was taken over. Clone a starter that has it.");
      return 1;
    }
    ctx.out.log(`\nCreated ${target}, but this starter has no packages/cf-os to configure it with. Edit ` +
      "its deployment.jsonc by hand.");
    return 0;
  }
  ctx.out.log(takeOver
    ? `\nCreated ${target}. Now taking over ${takeOver.instance} from it.\n`
    : `\nCreated ${target}. Now configuring it.\n`);
  return deps.configure(entry, ["init", ...passOn], target);
}

/** `cf-os init`, outside a project. */
export async function run(args: CommandArgs, ctx: Context): Promise<number> {
  return scaffold(args, ctx, defaultDeps());
}
