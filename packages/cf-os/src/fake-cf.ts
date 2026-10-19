// A stand-in for the `cf` CLI, for the `node --test` suites: answers each command from canned data,
// paginating list commands the way the real CLI does, and records every call.

import type { SpawnCf } from "./cf-client.ts";

/** A failure: exits non-zero with `fail` on stderr, the way `cf` reports an API error. */
export interface FakeFailure {
  fail: string;
  status?: number;
}

/** Data to print as JSON. */
export type FakeData = object | string | number | boolean | null;

/** A canned reply, or a function of the full argument list producing one. */
export type FakeReply = FakeData | FakeFailure | ((args: string[]) => FakeData | FakeFailure);

/** One recorded call. */
export interface FakeCall {
  /** The arguments, `--profile <name>` removed. */
  args: string[];
  /** The `--profile` it was given, if any. */
  profile?: string;
  env: NodeJS.ProcessEnv;
}

function isFailure(reply: unknown): reply is FakeFailure {
  return typeof reply === "object" && reply !== null && "fail" in reply;
}

/** `cf`'s arguments, whichever way `cfJson` spawned it (`node <entry>` or `pnpm exec cf`), minus `--profile`. */
function cfArgs(command: string, argv: string[]): string[] {
  const args = command === "pnpm" && argv[0] === "exec" && argv[1] === "cf" ? argv.slice(2) : argv.slice(1);
  const profile = args.indexOf("--profile");
  return profile < 0 ? args : [...args.slice(0, profile), ...args.slice(profile + 2)];
}

/** The value after `flag` in `args`, if any. */
export function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * A fake `cf`. `replies` is keyed by the command words before the first flag
 * (`"workers list"`), or a function of the full argument list for anything finer. An array reply
 * to a call carrying `--page`/`--per-page` is served one page at a time; `{ fail }` exits 1 with
 * that text on stderr; a command with no reply fails the way an unknown one would.
 */
export function fakeCf(
  replies: Record<string, FakeReply>,
): { spawn: SpawnCf; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const spawn: SpawnCf = (command, argv, options) => {
    const args = cfArgs(command, argv);
    calls.push({ args, profile: flag(argv, "--profile"), env: options.env });
    const firstFlag = args.findIndex((arg) => arg.startsWith("-"));
    const key = (firstFlag < 0 ? args : args.slice(0, firstFlag)).join(" ");
    const entry = replies[key];
    if (entry === undefined) {
      return { status: 1, stdout: "", stderr: `┌ Error\n│ Unknown command: cf ${key}\n└\n` };
    }
    let reply = typeof entry === "function" ? entry(args) : entry;
    if (isFailure(reply)) {
      return { status: reply.status ?? 1, stdout: "", stderr: `\n┌ APIError\n│ ${reply.fail}\n└\n` };
    }
    const page = flag(args, "--page");
    const perPage = flag(args, "--per-page");
    if (Array.isArray(reply) && page && perPage) {
      const start = (Number(page) - 1) * Number(perPage);
      reply = reply.slice(start, start + Number(perPage));
    }
    return { status: 0, stdout: JSON.stringify(reply), stderr: "" };
  };
  return { spawn, calls };
}

/** What `cf` prints to stderr, inside its box, for a Worker the account does not have. */
export const WORKER_NOT_FOUND_FAILURE =
  "[10007] This Worker does not exist on your account.\n│ 404 Not Found · HTTP /accounts/<account-id>/workers/scripts/<worker>/secrets";

/**
 * A `workers secrets list` reply from secret names by Worker name, printed as the API's
 * `{ name, type }` list. A Worker missing from `secrets` fails the way `cf` does for one the account
 * does not have.
 */
export function workerSecretsReply(secrets: Record<string, string[]>): FakeReply {
  return (args) => {
    const worker = flag(args, "--script-name") ?? "";
    return Object.hasOwn(secrets, worker)
      ? secrets[worker].map((name) => ({ name, type: "secret_text" }))
      : { fail: WORKER_NOT_FOUND_FAILURE };
  };
}

/** The account every fake fixture belongs to. */
export const FAKE_ACCOUNT = "0123456789abcdef0123456789abcdef";
