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

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
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
  "Policies Edit, Workers Scripts Read, Workers KV Storage Read, Workers R2 Storage Read, " +
  "AI Gateway Read, Zone Read and DNS Read";

/** The slice of `spawnSync` this uses, so tests can stand in canned output for the CLI. */
export type SpawnCf = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; encoding: "utf8" },
) => { status: number | null; stdout: string; stderr: string; error?: Error };

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
  /** Stand-in for `spawnSync`, for tests. */
  spawn?: SpawnCf;
}

/**
 * The two ways `cf` reports missing credentials: no token at all (its own check, before any request)
 * and the API's authentication codes. 9106/9109 are "missing or invalid token"; 10000 is the API's
 * "Authentication error", which is also what a valid token lacking the route's permission gets.
 */
const AUTH_FAILURE = /No authentication token found|Authentication (?:failed|error)|\[(?:9106|9109|10000)\]/i;

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
export function cfJson<T>(
  args: string[],
  { accountId, profile, cwd = process.cwd(), spawn = spawnSync }: CfOptions,
): T {
  const argv = profile ? [...args, "--profile", profile] : args;
  const [command, commandArgs] = spawnArgs(argv);
  const env: NodeJS.ProcessEnv = { ...process.env, CF_QUIET: "1", NO_COLOR: "1" };
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  else delete env.CLOUDFLARE_ACCOUNT_ID;
  const result = spawn(command, commandArgs, { cwd, env, encoding: "utf8" });
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

/** Items per page for {@link cfList}. The largest every list command used here accepts. */
const PER_PAGE = 100;

/**
 * Every item of a paged `cf ... list`, fetched page by page. A single call returns the API's default
 * page (10 Workers, for one; `zones list` prints no `result_info` to page by either), which on a
 * busy account silently misses what it is looking for.
 */
export function cfList<T>(args: string[], options: CfOptions): T[] {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const batch = cfJson<T[]>([...args, "--page", String(page), "--per-page", String(PER_PAGE)], options);
    if (!Array.isArray(batch)) {
      throw new CfError(`cf ${args.join(" ")}: expected a JSON array, got ${typeof batch}`);
    }
    items.push(...batch);
    if (batch.length < PER_PAGE) return items;
  }
}

/** R2's page-size ceiling. */
const R2_PER_PAGE = 1000;

/**
 * Every R2 bucket name in the account. R2 pages by cursor rather than page number, and `cf` prints
 * no cursor, so this pages by name instead: buckets come back in lexicographic order, and
 * `--start-after` the last one fetches the next page. Unpaged, the API returns 20.
 */
export function listR2Buckets(options: CfOptions): string[] {
  const names: string[] = [];
  for (;;) {
    const args = ["r2", "buckets", "list", "--per-page", String(R2_PER_PAGE)];
    if (names.length) args.push("--start-after", names.at(-1)!);
    const batch = (cfJson<{ buckets?: { name: string }[] }>(args, options).buckets ?? [])
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
      const result = cfJson<CfWhoami>(["auth", "whoami"], on(null));
      return { authenticated: result.authenticated === true, email: result.email };
    },
    async listAccounts() {
      return cfList<CfAccount>(["accounts", "list"], on(null));
    },
    async listWorkers(accountId) {
      return listWorkers(accountId);
    },
    async workersDevSubdomain(accountId) {
      // `cf` has no command for it; every Worker's record carries it.
      return workersDevSubdomainOf(listWorkers(accountId));
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
      return cfList<CfZone>(["zones", "list", "--status", "active", "--account-id", accountId], on(accountId));
    },
    async findDnsRecords(accountId, zone, name) {
      return cfList<CfDnsRecord>(["dns", "records", "list", "--zone", zone, "--name-exact", name], on(accountId));
    },
    async getOrganization(accountId) {
      return cfJson<CfOrganization>(["zero-trust", "organization", "get"], on(accountId));
    },
    async listAccessApps(accountId, filter = {}) {
      const args = ["zero-trust", "access", "applications", "list"];
      if (filter.domain) args.push("--domain", filter.domain, "--exact");
      if (filter.aud) args.push("--aud", filter.aud);
      return cfList<CfAccessApp>(args, on(accountId));
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
