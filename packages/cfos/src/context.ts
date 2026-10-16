// What every command is handed by the dispatcher (main.ts), so commands take no ambient state and
// tests can run them with a scripted prompter, a fake client, and captured output.
//
// Output follows `cf`'s convention (packages/cli/src/lib/output.ts): the machine-readable result is
// JSON on stdout, and everything meant for a person -- progress, tables, hints -- goes to stderr, so
// `cfos import N | jq` works.

import { isAbsolute, relative, resolve } from "node:path";
import type { CloudflareClient } from "./core/client.ts";
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
