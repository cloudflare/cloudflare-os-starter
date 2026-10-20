// `CloudflareClient` (core/client.ts) over the `cf` CLI, Cloudflare's OpenAPI-generated CLI: run one
// command, parse the JSON it prints, and turn its failures into messages that name the fix.
//
// `cf` prints the API's `result` itself, already unwrapped from the `{ success, result }` envelope,
// on stdout; errors go to stderr as a boxed `APIError`/`Error` block. `--dry-run` prints the request
// it would make, as JSON, instead of making it. With stdout captured it never prompts.
//
// It authenticates on its own, separately from wrangler: `CLOUDFLARE_API_TOKEN` when set, else the
// OAuth profile `cf auth login` writes (`--profile` picks another). The account comes from
// `CLOUDFLARE_ACCOUNT_ID`, which every account-scoped call sets explicitly, so neither an ambient
// value nor `cf`'s per-directory account cache can point it at another account.

import { spawn as spawnChild, type ChildProcessByStdio } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { resolveBinEntry } from "@gadgets/scripts/bin-entry";
import { pnpmCommand } from "./pnpm-command.ts";
import {
  CfAuthError,
  CfError,
  CfUnavailableError,
  workersDevSubdomainOf,
  type CfAccessApp,
  type CfAccount,
  type CfAiGateway,
  type CfDnsRecord,
  type CfIdentityProvider,
  type CfKvNamespace,
  type CfOrganization,
  type CfWhoami,
  type CfWorker,
  type CfZone,
  type CloudflareClient,
} from "./core/client.ts";

/** This package's directory, whose own `node_modules` holds the `cf` it depends on. */
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** What to do about a `cf` that is not signed in, or whose token lacks a permission. */
export const CF_AUTH_HINT =
  "run `pnpm exec cf auth login`, or set CLOUDFLARE_API_TOKEN to a token with Access: Apps and " +
  "Policies Edit, Access: Organizations, Identity Providers, and Groups Edit, Workers Scripts Read, Workers KV Storage Read, Workers R2 Storage Read, " +
  "AI Gateway Read, Zone Read and DNS Read";

/**
 * Runs one `cf` process to completion: its exit status and UTF-8 output, or the error that kept it
 * from running. A type of its own so tests can stand in canned output for the CLI.
 */
export type SpawnCf = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }>;

/**
 * {@link SpawnCf} on `spawn`: asynchronous, so a spinner can animate and other reads run beside it.
 * stdin is empty: `cf` never prompts here. A `cf` still running when this process exits is left to
 * finish, never killed, and off Windows runs in a process group of its own, out of reach of a
 * terminal's Ctrl-C: it may be refreshing a single-use token ({@link firstAlone}).
 */
const spawnProcess: SpawnCf = (command, args, { cwd, env }) => new Promise((finish) => {
  let stdout = "";
  let stderr = "";
  let settled = false;
  let child: ChildProcessByStdio<null, Readable, Readable>;
  // A failed spawn emits `error` and may still emit `close`; the first one decides.
  const settle = (result: Awaited<ReturnType<SpawnCf>>) => {
    if (settled) return;
    settled = true;
    finish(result);
  };
  try {
    child = spawnChild(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  } catch (error) {
    settle({ status: null, stdout, stderr, error: error as Error });
    return;
  }
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => stdout += chunk);
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr += chunk);
  child.on("error", (error) => settle({ status: null, stdout, stderr, error }));
  child.on("close", (status) => settle({ status, stdout, stderr }));
});

/**
 * `spawn`, sending the first call of every burst alone: a call made while none is running goes at
 * once, and those made while it runs wait for it to settle, then run together. On an OAuth sign-in,
 * `cf` refreshes an expired access token by itself, without a lock, and Cloudflare's refresh token
 * is single-use: `cf` processes started together on an expired token would each spend it, and all
 * but the first would fail or sign `cf` out. The token can expire at any point of a run, so the gate
 * closes again whenever no call is running. With `CLOUDFLARE_API_TOKEN` set nothing waits.
 */
export function firstAlone(spawn: SpawnCf): SpawnCf {
  let inFlight = 0;
  let lead: Promise<void> | undefined;
  const run: SpawnCf = (command, args, options) => {
    inFlight++;
    const result = spawn(command, args, options);
    const done = () => {
      inFlight--;
    };
    result.then(done, done);
    return result;
  };
  return (command, args, options) => {
    if (options.env.CLOUDFLARE_API_TOKEN) return spawn(command, args, options);
    if (lead) return lead.then(() => run(command, args, options));
    if (inFlight > 0) return run(command, args, options);
    const result = run(command, args, options);
    const clear = () => {
      lead = undefined;
    };
    lead = result.then(clear, clear);
    return result;
  };
}

/** {@link SpawnCf} on `spawn`, the first `cf` call of every burst alone ({@link firstAlone}). */
export const spawnCf: SpawnCf = firstAlone(spawnProcess);

/** How to reach `cf`, and which account it acts on. */
export interface CfOptions {
  /**
   * Cloudflare account the call is pinned to. `null` only for account-less commands
   * (`accounts list`, `auth whoami`), and then any ambient `CLOUDFLARE_ACCOUNT_ID` is dropped.
   */
  accountId: string | null;
  /** `cf --profile`: which saved sign-in to use. */
  profile?: string;
  /** Directory to run `cf` in. */
  cwd?: string;
  /** Stand-in for spawning `cf`, for tests. */
  spawn?: SpawnCf;
}

/**
 * The two ways `cf` reports missing credentials: no token at all (its own check, before any request)
 * and the API's authentication codes. 9106/9109 are "missing or invalid token"; 10000 is the API's
 * "Authentication error", which is also what a valid token lacking the route's permission gets.
 */
const AUTH_FAILURE = /No authentication token found|Authentication (?:failed|error)|\[(?:9106|9109|10000)\]/i;

/**
 * The API's code for a Worker the account does not have, which `cf` prints in brackets ahead of the
 * API's message ("[10007] This Worker does not exist on your account."). Wrangler reads the same
 * code as its `WORKER_NOT_FOUND_ERR_CODE`.
 */
const WORKER_NOT_FOUND = /\[10007\]/;

/** The boxed error `cf` writes to stderr, flattened to one line. */
function errorText(stderr: string): string {
  return stderr
    .split("\n")
    .map((line) => line.replace(/^[\s│┌└─]+/, "").trim())
    .filter(Boolean)
    .join(" ");
}

function spawnArgs(args: string[]): [string, string[]] {
  const entry = resolveBinEntry(packageDir, "cf");
  return entry ? [process.execPath, [entry, ...args]] : pnpmCommand(["exec", "cf", ...args]);
}

/**
 * Runs `cf <args>` and returns its parsed JSON output.
 *
 * Throws {@link CfAuthError} when the failure is credentials, so callers can tell "not signed in"
 * apart from a real API error, {@link CfUnavailableError} when `cf` will not run, and
 * {@link CfError} for everything else.
 */
export async function cfJson<T>(
  args: string[],
  { accountId, profile, cwd = process.cwd(), spawn = spawnCf }: CfOptions,
): Promise<T> {
  const argv = profile ? [...args, "--profile", profile] : args;
  const [command, commandArgs] = spawnArgs(argv);
  const env: NodeJS.ProcessEnv = { ...process.env, CF_QUIET: "1", NO_COLOR: "1" };
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  else delete env.CLOUDFLARE_ACCOUNT_ID;
  const result = await spawn(command, commandArgs, { cwd, env });
  const label = `cf ${args.join(" ")}`;
  if (result.error) throw new CfUnavailableError(`${label}: could not run cf: ${result.error.message}`);
  if (result.status !== 0) {
    const message = errorText(result.stderr) || `exited with status ${result.status}`;
    if (AUTH_FAILURE.test(result.stderr)) {
      throw new CfAuthError(`${label}: ${message} -- ${CF_AUTH_HINT}.`);
    }
    throw new CfError(`${label}: ${message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new CfError(`${label}: printed something other than JSON: ${result.stdout.slice(0, 200)}`);
  }
  // Defensive: beta.17 prints the bare result, but the API's envelope is what a raw passthrough
  // would print, and nothing in it is useful here.
  if (parsed && typeof parsed === "object" && "success" in parsed && "result" in parsed) {
    return parsed.result as T;
  }
  return parsed as T;
}

/** Items per page for {@link cfList}, unless a list command takes fewer. */
const PER_PAGE = 100;

/** The page-size ceiling of `accounts list` and `zones list`. */
const ACCOUNTS_AND_ZONES_PER_PAGE = 50;

/**
 * Every item of a paged `cf ... list`, fetched `perPage` at a time. A single call returns the API's
 * default page (10 Workers, for one; `zones list` prints no `result_info` to page by either), which
 * on a busy account silently misses what it is looking for. `perPage` must be within the endpoint's
 * ceiling: a page the API caps below it would read as the last. Pages are fetched one after another:
 * whether there is a next one is known only from the size of this one.
 */
export async function cfList<T>(args: string[], options: CfOptions, perPage = PER_PAGE): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await cfJson<T[]>([...args, "--page", String(page), "--per-page", String(perPage)], options);
    if (!Array.isArray(batch)) {
      throw new CfError(`cf ${args.join(" ")}: expected a JSON array, got ${typeof batch}`);
    }
    items.push(...batch);
    if (batch.length < perPage) return items;
  }
}

/** R2's page-size ceiling. */
const R2_PER_PAGE = 1000;

/**
 * Every R2 bucket name in the account. R2 pages by cursor rather than page number, and `cf` prints
 * no cursor, so this pages by name instead: buckets come back in lexicographic order, and
 * `--start-after` the last one fetches the next page. Unpaged, the API returns 20.
 */
export async function listR2Buckets(options: CfOptions): Promise<string[]> {
  const names: string[] = [];
  for (;;) {
    const args = ["r2", "buckets", "list", "--per-page", String(R2_PER_PAGE)];
    if (names.length) args.push("--start-after", names.at(-1)!);
    const batch = ((await cfJson<{ buckets?: { name: string }[] }>(args, options)).buckets ?? [])
      .map((bucket) => bucket.name);
    names.push(...batch);
    if (batch.length < R2_PER_PAGE) return names;
  }
}

/** A {@link CloudflareClient} that runs `cf` for every call. */
export function cfClient(
  { profile, cwd, spawn }: { profile?: string; cwd?: string; spawn?: SpawnCf } = {},
): CloudflareClient {
  const on = (accountId: string | null): CfOptions => ({ accountId, profile, cwd, spawn });
  const listWorkers = (accountId: string) => cfList<CfWorker>(["workers", "list"], on(accountId));
  return {
    async whoami() {
      // Exits 0 either way, with `authenticated: false` when signed out.
      const result = await cfJson<CfWhoami>(["auth", "whoami"], on(null));
      return { authenticated: result.authenticated === true, email: result.email };
    },
    async listAccounts() {
      return cfList<CfAccount>(["accounts", "list"], on(null), ACCOUNTS_AND_ZONES_PER_PAGE);
    },
    async listWorkers(accountId) {
      return listWorkers(accountId);
    },
    async listWorkerSecrets(accountId, worker) {
      // One unpaged list of `{ name, type }`; `--script-name` is `--worker`'s alias.
      let secrets: { name: string }[];
      try {
        secrets = await cfJson<{ name: string }[]>(["workers", "secrets", "list", "--script-name", worker], on(accountId));
      } catch (error) {
        if (error instanceof CfError && !(error instanceof CfUnavailableError) && WORKER_NOT_FOUND.test(error.message)) {
          return null;
        }
        throw error;
      }
      if (!Array.isArray(secrets)) {
        throw new CfError(`cf workers secrets list --script-name ${worker}: expected a JSON array, got ${typeof secrets}`);
      }
      return secrets.map((secret) => secret.name);
    },
    async workersDevSubdomain(accountId) {
      // `cf` has no command for it; every Worker's record carries it.
      return workersDevSubdomainOf(await listWorkers(accountId));
    },
    async listKvNamespaces(accountId) {
      return cfList<CfKvNamespace>(["kv", "namespaces", "list"], on(accountId));
    },
    async listR2Buckets(accountId) {
      return listR2Buckets(on(accountId));
    },
    async listAiGateways(accountId) {
      return cfList<CfAiGateway>(["ai-gateway", "gateways", "list"], on(accountId));
    },
    async listZones(accountId) {
      // `zones list` is not account-scoped by CLOUDFLARE_ACCOUNT_ID: it lists every zone the
      // credentials reach, so filter explicitly.
      return cfList<CfZone>(["zones", "list", "--status", "active", "--account-id", accountId], on(accountId),
        ACCOUNTS_AND_ZONES_PER_PAGE);
    },
    async findDnsRecords(accountId, zone, name) {
      return cfList<CfDnsRecord>(["dns", "records", "list", "--zone", zone, "--name-exact", name], on(accountId));
    },
    async getOrganization(accountId) {
      return cfJson<CfOrganization>(["zero-trust", "organization", "get"], on(accountId));
    },
    async listAccessApps(accountId) {
      return cfList<CfAccessApp>(["zero-trust", "access", "applications", "list"], on(accountId));
    },
    async createAccessApp(accountId, body) {
      // `create` takes only `--body`.
      return cfJson<CfAccessApp>(
        ["zero-trust", "access", "applications", "create", "--body", JSON.stringify(body)], on(accountId));
    },
    async dryRunCreateAccessApp(accountId, body) {
      return cfJson<unknown>(
        ["zero-trust", "access", "applications", "create", "--body", JSON.stringify(body), "--dry-run"],
        on(accountId));
    },
    async listIdentityProviders(accountId) {
      return cfList<CfIdentityProvider>(["zero-trust", "identity-providers", "list"], on(accountId));
    },
    async createIdentityProvider(accountId, body) {
      return cfJson<CfIdentityProvider>(
        ["zero-trust", "identity-providers", "create", "--body", JSON.stringify(body)], on(accountId));
    },
    async dryRunCreateIdentityProvider(accountId, body) {
      return cfJson<unknown>(
        ["zero-trust", "identity-providers", "create", "--body", JSON.stringify(body), "--dry-run"],
        on(accountId));
    },
  };
}
