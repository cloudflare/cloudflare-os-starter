// What every command is handed by the dispatcher (main.ts), so commands take no ambient state and
// tests can run them with a scripted prompter, a fake client, and captured output.
//
// Output follows `cf`'s convention (packages/cli/src/lib/output.ts): the machine-readable result is
// JSON on stdout, and everything meant for a person -- progress, tables, hints -- goes to stderr, so
// `cf-os import N | jq` works.

import { isAbsolute, relative, resolve } from "node:path";
import type { CloudflareClient } from "./core/client.ts";
import { FULL_COMMIT, RELEASE_ID } from "./core/hosted-release.ts";
import { WORKER_NAME } from "./core/naming.ts";
import type { Prompter } from "./prompt.ts";

/** Where a command writes. */
export interface Output {
  /** The command's result, as JSON on stdout. */
  json(data: unknown): void;
  /** A line for the person running it, on stderr. */
  log(text: string): void;
}

/** The process's own stdout and stderr. */
export function consoleOutput(): Output {
  return {
    json: (data) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`),
    log: (text) => process.stderr.write(`${text}\n`),
  };
}

/** Flags every command takes. */
export interface GlobalFlags {
  /** `--config`: the deployment file, instead of `<root>/deployment.jsonc`. */
  config?: string;
  /** `--account`: the account, ahead of `deployment.jsonc`'s `accountId`. */
  account?: string;
  /** `--profile`: the `cf` sign-in to use, passed to every `cf` call. */
  profile?: string;
}

/** One command's world. */
export interface Context {
  /** The project root: the directory holding `deployment.jsonc` and `cloudflare-os/`. */
  root: string;
  /** Where the command was run, which relative paths in flags resolve against. */
  cwd: string;
  flags: GlobalFlags;
  /** Null when nobody is at a terminal to answer. */
  prompter: Prompter | null;
  out: Output;
  /** The Cloudflare client, created on first use: the `install` path must not load it. */
  client(): Promise<CloudflareClient>;
}

/** The deployment file a command reads: `--config`, else the project's own. */
export function configPath(ctx: Context): string {
  return ctx.flags.config ? resolve(ctx.cwd, ctx.flags.config) : resolve(ctx.root, "deployment.jsonc");
}

/** `path` for messages: relative to where the command was run when it is inside it, else absolute. */
export function displayPath(ctx: Context, path: string): string {
  const fromCwd = relative(ctx.cwd, path);
  return !fromCwd || fromCwd.startsWith("..") || isAbsolute(fromCwd) ? resolve(path) : fromCwd;
}

/** A command's own parsed arguments. */
export interface CommandArgs {
  /** The command's name, for modules serving two (`check` and `deploy`). */
  command: string;
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

/** What a command module exports. */
export interface CommandModule {
  run(args: CommandArgs, ctx: Context): Promise<number>;
}

/** A failure of how the command was invoked: printed with the command's usage, exit 1. */
export class UsageError extends Error {}

/**
 * What a take-over of a hosted instance is told beyond the instance's name, on `init` and `import`
 * alike: the flags of the command the hosted deploy flow prints.
 */
export interface TakeoverFlags {
  /** `--router`: the router Worker's name, where it is not the instance's. */
  router?: string;
  /** `--backend`: the backend Worker's name, where it is not `<instance>-backend`. */
  backend?: string;
  /** `--release`: the release the command was made for. */
  release?: string;
  /** `--commit`: the cloudflare-os commit that release was built from, all 40 hex digits. */
  commit?: string;
  /**
   * `--pdf-renderer`: the Worker name to deploy the PDF renderer as, answering the question a takeover
   * asks where a Worker stands under the renderer's name that nothing shows is this deployment's. A
   * Worker by that name is the operator's to deploy over.
   */
  "pdf-renderer"?: string;
}

/** The {@link TakeoverFlags}, in the order a printed command gives them. */
export const TAKEOVER_FLAGS = ["router", "backend", "release", "commit", "pdf-renderer"] as const satisfies readonly (keyof TakeoverFlags)[];

/** What each of {@link TAKEOVER_FLAGS} must look like, and how a value that does not is described. */
const TAKEOVER_FLAG_FORMS: Record<keyof TakeoverFlags, { pattern: RegExp; expected: string }> = {
  router: { pattern: WORKER_NAME, expected: "a Worker name: lowercase letters, digits and inner hyphens, at most 63 characters" },
  backend: { pattern: WORKER_NAME, expected: "a Worker name: lowercase letters, digits and inner hyphens, at most 63 characters" },
  release: { pattern: RELEASE_ID, expected: "a release id, such as r004945-6c8d301: copy it from the deploy flow" },
  commit: { pattern: FULL_COMMIT, expected: "a full commit SHA: all 40 hex digits" },
  "pdf-renderer": { pattern: WORKER_NAME, expected: "a Worker name: lowercase letters, digits and inner hyphens, at most 63 characters" },
};

/** The option `name` of `values` as text; undefined when it was not given. */
function textOption(values: CommandArgs["values"], name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * The {@link TakeoverFlags} among a command's parsed `values`, each checked to be of the form its
 * flag takes. One that is not is a {@link UsageError} naming the flag, before anything is read.
 */
export function takeoverFlags(values: CommandArgs["values"]): TakeoverFlags {
  const flags: TakeoverFlags = {};
  for (const name of TAKEOVER_FLAGS) {
    const value = textOption(values, name);
    if (value === undefined) continue;
    const { pattern, expected } = TAKEOVER_FLAG_FORMS[name];
    if (!pattern.test(value)) throw new UsageError(`--${name} ${JSON.stringify(value)} is not ${expected}.`);
    flags[name] = value;
  }
  if (flags.router !== undefined && flags.router === flags.backend) {
    throw new UsageError(`--router and --backend both name Worker ${flags.router}: an instance has one of each, under two names.`);
  }
  return flags;
}

/**
 * `init`'s `--take-over <instance>`, checked to be a name an instance can have; undefined when it
 * was not given. One that is not is a {@link UsageError}.
 */
export function takeOverInstance(values: CommandArgs["values"]): string | undefined {
  const instance = textOption(values, "take-over");
  if (instance !== undefined && !WORKER_NAME.test(instance)) {
    throw new UsageError(`--take-over ${JSON.stringify(instance)} is not an instance name: lowercase letters, digits and ` +
      "inner hyphens, at most 63 characters.");
  }
  return instance;
}

/**
 * `flags` as command-line arguments, in {@link TAKEOVER_FLAGS}' order: what a command hands on to
 * the one that carries out the take-over, and what a printed command repeats so a flag given once
 * is not lost. Every value has passed {@link takeoverFlags}, so none needs quoting for a shell.
 */
export function takeoverArgs(flags: TakeoverFlags): string[] {
  return TAKEOVER_FLAGS.flatMap((name) => flags[name] === undefined ? [] : [`--${name}`, flags[name]]);
}
