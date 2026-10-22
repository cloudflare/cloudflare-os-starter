// `cf-os api [public] <command> [arguments] [<command> [arguments]]... [options]`
// `cf-os api search "<task>"`
// `cf-os api types [<service>]`
//
// Drives a running Cloudflare OS instance through its Cap'n Web API, the one the browser uses. The
// commands are not written here: they are the generated table (src/api/generated/commands.ts),
// from the pinned upstream's schema of its API
// (packages/api-schema/generated/workshop-api.schema.json), which `pnpm api:generate` rewrites when
// the pin moves. This module reads the instance's address and the sign-in to use, then hands the
// walk to src/api/run.ts, or, for `search`, ranks the table's commands against the task, or, for
// `types`, prints upstream's agent declarations (src/api/types.ts).
//
// main.ts passes every token after `api` through untouched except the global `--config`,
// `--account` and `--profile`, so the flags of each segment are parsed here, against that segment's
// command in the table.

import { accessSync, constants, createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { UsageError, type CommandArgs, type Context } from "../context.ts";
import type { ArgSource } from "../api/codec.ts";
import { table as generatedTable } from "../api/generated/commands.ts";
import {
  commandHelp,
  decodeCalls,
  dryRunChain,
  execute,
  incompleteChain,
  nodeHelp,
  parseInvocation,
  parseSearch,
  parseTypes,
  searchCommands,
  searchHelp,
  untypedHelp,
  type RunIo,
} from "../api/run.ts";
import { connect, defaultSessionDeps, resolveAuth, resolveTarget, type SessionDeps } from "../api/session.ts";
import type { ApiTable } from "../api/table.ts";
import { agentTypes, typesHelp } from "../api/types.ts";

/** Everything `cf-os api` touches besides the context, so tests can stand in for each. */
export interface ApiDeps extends SessionDeps {
  /** The command table: the generated one. */
  table: ApiTable;
  /** Raw stdout: help, NDJSON events and stream bytes. */
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  /** Read for `-` arguments. */
  stdin: NodeJS.ReadableStream;
  /** Calls `listener` on SIGINT; returns the function that stops listening. */
  onInterrupt(listener: () => void): () => void;
}

/** The process's own. */
export function defaultDeps(): ApiDeps {
  return {
    ...defaultSessionDeps(),
    table: generatedTable,
    stdout: process.stdout,
    // Read only for a `-` argument: touching process.stdin sooner would set it up for nothing.
    get stdin() {
      return process.stdin;
    },
    onInterrupt: (listener) => {
      process.on("SIGINT", listener);
      return () => process.off("SIGINT", listener);
    },
  };
}

/** A Node byte stream as a web one of plain `Uint8Array` chunks, the type capnweb sends as bytes. */
function webBytes(stream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return (Readable.toWeb(Readable.from(stream)) as unknown as ReadableStream<Uint8Array | string>).pipeThrough(
    new TransformStream<Uint8Array | string, Uint8Array>({
      transform: (chunk, controller) => controller.enqueue(typeof chunk === "string"
        ? new TextEncoder().encode(chunk)
        : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
    }));
}

/** `cf-os api`. */
export async function run(args: CommandArgs, ctx: Context, deps: ApiDeps = defaultDeps()): Promise<number> {
  const { table } = deps;
  // `types` prints declarations, the result itself, as plain text, as a byte stream's result is
  // written raw: wrapped in JSON, TypeScript would have to be unescaped before it could be read.
  const types = parseTypes(args.positionals);
  if (types) {
    // The declarations outgrow a pipe's buffer, so `| head` closes it mid-write: that EPIPE is the
    // reader being done, not a failure. Any other error is still thrown, as with no listener.
    deps.stdout.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
    deps.stdout.write(types.help ? `${typesHelp()}\n` : agentTypes(types.service));
    return 0;
  }
  // `search` finds commands in the table, before any walk: it connects to nothing.
  const search = parseSearch(args.positionals);
  if (search?.help) {
    deps.stdout.write(`${searchHelp()}\n`);
    return 0;
  }
  if (search) {
    if (!search.query.trim()) throw new UsageError('search needs a task: `cf-os api search "<describe the task>"`.');
    const matches = searchCommands(table, search.query);
    if (matches.length === 0) ctx.out.log("No command matches. `cf-os api --help` lists the first ones.");
    ctx.out.json(matches);
    return 0;
  }
  const invocation = parseInvocation(table, args.positionals);
  if (invocation.help) {
    const target = invocation.help;
    const help = target.kind === "node" ? nodeHelp(table, target.node, invocation.path)
      : target.kind === "command" ? commandHelp(table, target.node, target.name, invocation.path, target.at)
      : untypedHelp(invocation.path);
    deps.stdout.write(`${help}\n`);
    return 0;
  }
  // Nothing to call yet: a usage error, saying that nothing was sent and how to finish the chain.
  if (invocation.end.kind === "node" || invocation.end.kind === "untyped") {
    throw new UsageError(incompleteChain(table, invocation));
  }

  const { flags } = invocation;
  let stdinRead = false;
  const readStdin = async (): Promise<Uint8Array> => {
    stdinRead = true;
    const chunks: Uint8Array[] = [];
    for await (const chunk of deps.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    return new Uint8Array(Buffer.concat(chunks));
  };
  const source: ArgSource = {
    readFile: async (path) => {
      try {
        return new Uint8Array(await readFile(resolve(ctx.cwd, path)));
      } catch (error) {
        throw new UsageError(`could not read @${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}.`);
      }
    },
    readStdin,
  };
  const target = await resolveTarget(flags.url, ctx);
  const auth = resolveAuth(flags, deps.env, target.origin);
  const calls = await decodeCalls(table, invocation, source);
  if (flags.dryRun) {
    ctx.out.json({
      url: target.url,
      auth: auth.username === undefined ? { mode: auth.mode } : { mode: auth.mode, username: auth.username },
      on: invocation.public ? table.public : table.root,
      chain: dryRunChain(calls),
    });
    return 0;
  }

  const io: RunIo = {
    out: ctx.out,
    stdout: deps.stdout,
    openStream: (path) => {
      if (path === "-") {
        if (stdinRead) throw new UsageError("Only one argument can read stdin (-).");
        return webBytes(deps.stdin);
      }
      const file = resolve(ctx.cwd, path);
      try {
        accessSync(file, constants.R_OK);
      } catch (error) {
        throw new UsageError(`could not read ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}.`);
      }
      return webBytes(createReadStream(file));
    },
    outputPath: (path) => resolve(ctx.cwd, path),
    onInterrupt: deps.onInterrupt,
  };
  return execute(table, invocation, calls,
    () => connect(target, auth, { serviceSalt: table.constants.SERVICE_SALT, needsSignIn: !invocation.public }, deps), io);
}
