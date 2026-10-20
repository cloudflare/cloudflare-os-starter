// `cf-os init [<dir>] [--template <git-url|path>] [--ref <branch|tag>]`, outside a project
//
// Creates a project: clones the starter with its history and its `cloudflare-os` submodule, renames
// `origin` to `starter` (leaving `origin` for the project's own repository), installs, offers
// to create a private GitHub repository for it with `gh` and push there, then hands over to the new
// project's own `cf-os init` to configure and deploy it. Without a terminal it stops after the
// install and prints the next commands.
//
// Private, and created rather than forked: a fork of the public starter has to stay public.
//
// This is the one command a globally installed `cf-os` runs itself, so it is on the packed path:
// node builtins and this package's own dependency-free modules only. In particular nothing here may
// reach `@gadgets/scripts`, which a published copy does not have; `pnpm` is spawned directly
// rather than through its `pnpmCommand()` for that reason.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { UsageError, type CommandArgs, type Context } from "../context.ts";
import { delegate, localEntry, type SpawnDelegate } from "../project.ts";
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
  configure(entry: string, argv: string[], cwd: string): number;
}

function defaultDeps(): ScaffoldDeps {
  return {
    spawn: defaultSpawn(),
    capture: defaultCapture(),
    nodeVersion: process.versions.node,
    configure: (entry, argv, cwd) => delegate(entry, argv, { cwd, env: process.env, spawn: spawnSync as SpawnDelegate }),
  };
}

/** Why `target` cannot be created into, or undefined when it can. */
function targetProblem(target: string): string | undefined {
  if (!existsSync(target)) return undefined;
  if (!statSync(target).isDirectory()) return `${target} exists and is not a directory.`;
  if (readdirSync(target).length === 0) return undefined;
  if (existsSync(join(target, "deployment.jsonc"))) {
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

/** Creates a project from `args`, resolving to the exit code. */
export async function scaffold(args: CommandArgs, ctx: Context, deps: ScaffoldDeps): Promise<number> {
  if (args.values.out) throw new UsageError("--out only applies inside a project, to configure it.");
  const template = (args.values.template as string | undefined) ?? DEFAULT_TEMPLATE;
  const ref = args.values.ref as string | undefined;
  let dir = args.positionals[0];
  if (!dir) {
    if (!ctx.prompter) throw new UsageError("Pass the directory to create the project in: `cf-os init <dir>`.");
    dir = await ctx.prompter.text("Where should the project go?", {
      initial: DEFAULT_DIR,
      validate: (value) => targetProblem(resolve(ctx.cwd, value)),
    });
  }
  const target = resolve(ctx.cwd, dir);
  const problem = targetProblem(target);
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
    throw new Error(`pnpm install failed in ${target}. Its output is above; fix it, then run ` +
      "`pnpm install` and `pnpm cf-os init` there.");
  }

  const passOn = [
    ...ctx.flags.account ? ["--account", ctx.flags.account] : [],
    ...ctx.flags.profile ? ["--profile", ctx.flags.profile] : [],
  ];
  if (!ctx.prompter) {
    ctx.out.log(`\nCreated ${target}. Next, keep it in a private GitHub repository, then configure and ` +
      `deploy it:\n  cd ${dir}\n  ${repositoryCommand(target)}\n` +
      `  pnpm cf-os init${passOn.length ? ` ${passOn.join(" ")}` : ""}`);
    return 0;
  }
  await offerRepository(ctx, deps, target, login!);
  const entry = localEntry(target);
  if (!existsSync(entry)) {
    ctx.out.log(`\nCreated ${target}, but this starter has no packages/cf-os to configure it with. Edit ` +
      "its deployment.jsonc by hand.");
    return 0;
  }
  ctx.out.log(`\nCreated ${target}. Now configuring it.\n`);
  return deps.configure(entry, ["init", ...passOn], target);
}

/** `cf-os init`, outside a project. */
export async function run(args: CommandArgs, ctx: Context): Promise<number> {
  return scaffold(args, ctx, defaultDeps());
}
