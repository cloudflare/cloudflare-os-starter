// `cfos init [<dir>] [--template <git-url|path>] [--ref <branch|tag>]`, outside a project
//
// Creates a project: clones the starter with its history and its `cloudflare-os` submodule, renames
// `origin` to `starter` (so starter updates arrive with `git pull starter main`), installs, offers
// the `cf` and Wrangler sign-ins, then hands over to the new project's own `cfos init` to configure
// it. Without a terminal it stops after the install and prints the next commands.
//
// This is the one command a globally installed `cfos` runs itself, so it is on the packed path:
// node builtins and this package's own dependency-free modules only. In particular nothing here may
// reach `@gadgets/scripts`, which a published copy does not have; `pnpm` is spawned directly
// rather than through its `pnpmCommand()` for that reason.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { UsageError, type CommandArgs, type Context } from "../context.ts";
import { delegate, localEntry, type SpawnDelegate } from "../project.ts";

/** The starter `init` clones by default. */
export const DEFAULT_TEMPLATE = "https://github.com/cloudflare/cloudflare-os-starter";

/** The directory offered when none is given. */
export const DEFAULT_DIR = "cloudflare-os";

/** The oldest Node the starter supports: its `engines`. */
const MIN_NODE: [number, number] = [24, 19];

/** The pnpm major the starter's `packageManager` pins. */
const PNPM_MAJOR = 11;

/** One external command, run in `cwd`. `capture` returns its output instead of showing it. */
export type SpawnTool = (
  command: string,
  args: string[],
  options: { cwd: string; capture: boolean; env?: NodeJS.ProcessEnv },
) => { status: number | null; stdout: string; error?: Error };

/** What scaffolding runs against, so tests can record the sequence instead of running it. */
export interface ScaffoldDeps {
  spawn: SpawnTool;
  /** `process.versions.node`. */
  nodeVersion: string;
  /** Hands the new project's `cfos init` the terminal. Resolves to its exit code. */
  configure(entry: string, argv: string[], cwd: string): number;
}

function defaultSpawn(): SpawnTool {
  return (command, args, { cwd, capture, env }) => {
    const result = spawnSync(command, args, {
      cwd,
      env: env ?? process.env,
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      // On Windows, pnpm on PATH is a `.cmd` shim Node will not spawn without a shell. Safe here:
      // every argument this passes pnpm is a fixed word, and paths go in `cwd`, not argv.
      shell: process.platform === "win32" && command === "pnpm",
    });
    return { status: result.status, stdout: result.stdout ?? "", error: result.error };
  };
}

function defaultDeps(): ScaffoldDeps {
  return {
    spawn: defaultSpawn(),
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
    return `${target} is already a project. To configure it: cd into it and run \`pnpm cfos init\`.`;
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

/** Offers the `cf` and Wrangler sign-ins the configure step and the deploy use. */
async function offerSignIns(ctx: Context, deps: ScaffoldDeps, target: string): Promise<void> {
  const prompter = ctx.prompter!;
  const quiet = { ...process.env, CF_QUIET: "1", NO_COLOR: "1" };
  // `auth whoami` exits 0 either way, reporting `authenticated: false` when signed out.
  const cf = deps.spawn("pnpm", ["exec", "cf", "auth", "whoami"], { cwd: target, capture: true, env: quiet });
  let cfSignedIn = false;
  try {
    cfSignedIn = !cf.error && cf.status === 0 && JSON.parse(cf.stdout).authenticated === true;
  } catch {
    cfSignedIn = false;
  }
  if (!cfSignedIn && await prompter.confirm(
    "Sign in to cf? It opens a browser. init uses it to look up your account; you can skip it and type answers instead.",
    true)) {
    deps.spawn("pnpm", ["exec", "cf", "auth", "login"], { cwd: target, capture: false });
  }
  // `wrangler whoami --json` exits non-zero when signed out.
  const wrangler = deps.spawn("pnpm", ["exec", "wrangler", "whoami", "--json"], { cwd: target, capture: true });
  if ((wrangler.error || wrangler.status !== 0) && await prompter.confirm(
    "Sign in to Wrangler? It opens a browser. Wrangler deploys the Workers; you can sign in later.", true)) {
    deps.spawn("pnpm", ["exec", "wrangler", "login"], { cwd: target, capture: false });
  }
}

/** Creates a project from `args`, resolving to the exit code. */
export async function scaffold(args: CommandArgs, ctx: Context, deps: ScaffoldDeps): Promise<number> {
  if (args.values.out) throw new UsageError("--out only applies inside a project, to configure it.");
  const template = (args.values.template as string | undefined) ?? DEFAULT_TEMPLATE;
  const ref = args.values.ref as string | undefined;
  let dir = args.positionals[0];
  if (!dir) {
    if (!ctx.prompter) throw new UsageError("Pass the directory to create the project in: `cfos init <dir>`.");
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
  ctx.out.log(
    "\nThe starter is the `starter` remote: `git pull starter main` brings in its updates. Add your " +
    "own repository as origin: `git remote add origin <url>`.\n");

  const install = deps.spawn("pnpm", ["install"], { cwd: target, capture: false });
  if (install.error || install.status !== 0) {
    throw new Error(`pnpm install failed in ${target}. Its output is above; fix it, then run ` +
      "`pnpm install` and `pnpm cfos init` there.");
  }

  const passOn = [
    ...ctx.flags.account ? ["--account", ctx.flags.account] : [],
    ...ctx.flags.profile ? ["--profile", ctx.flags.profile] : [],
  ];
  if (!ctx.prompter) {
    ctx.out.log(`\nCreated ${target}. Next:\n  cd ${dir}\n  pnpm exec cf auth login\n  pnpm exec wrangler login\n` +
      `  pnpm cfos init${passOn.length ? ` ${passOn.join(" ")}` : ""}`);
    return 0;
  }
  await offerSignIns(ctx, deps, target);
  const entry = localEntry(target);
  if (!existsSync(entry)) {
    ctx.out.log(`\nCreated ${target}, but this starter has no packages/cfos to configure it with. Edit ` +
      "its deployment.jsonc by hand.");
    return 0;
  }
  ctx.out.log(`\nCreated ${target}. Now configuring it.\n`);
  return deps.configure(entry, ["init", ...passOn], target);
}

/** `cfos init`, outside a project. */
export async function run(args: CommandArgs, ctx: Context): Promise<number> {
  return scaffold(args, ctx, defaultDeps());
}
