// An optional Gatekeeper's OAuth credentials, from the terminal to its Worker. Each value is asked
// for masked, held in memory only, and handed to `wrangler secret bulk` on its stdin: never in argv,
// a file, a log or stdout. `init` and `cf-os secrets` ask (askAndSetSecrets); `deploy` uploads what
// init asked for once its deploy has finished (uploadSecrets).
//
// Two things about `wrangler secret bulk` (wrangler's `secretBulkCommand`) shape this. On a Worker
// the account does not have, it creates a placeholder Worker to hold the secrets, without asking
// when its stdin is not a terminal, as here: so nothing is uploaded to a Worker not first seen to
// exist. And its exit code proves nothing: input it cannot parse is reported and exits 0, so every
// upload is confirmed by listing the Worker's secrets again.
//
// I/O, beside cf-client.ts. Only lazily loaded commands import it.

import { resolve } from "node:path";
import { configPath, displayPath, type Context } from "./context.ts";
import { CfAuthError, CfError, type CloudflareClient } from "./core/client.ts";
import type { DeploymentConfig } from "./core/deployment-config.ts";
import { publicOrigin } from "./core/deployment.ts";
import { secretSetup, type GatekeeperCatalog } from "./core/gatekeepers.ts";
import { prose } from "./core/verify-account.ts";
import type { Prompter } from "./prompt.ts";
import { succeeded, type SpawnTool } from "./tools.ts";

/** What {@link askAndSetSecrets} and {@link uploadSecrets} run besides the context. */
export interface SecretsDeps {
  /** Null without a terminal: nothing is asked, and the `wrangler secret put` commands come back instead. */
  prompter: Prompter | null;
  /** Reads which secrets a Worker has, and whether it exists. */
  client: CloudflareClient;
  /** Runs `wrangler secret bulk`. */
  spawn: SpawnTool;
}

/** Values entered for one Gatekeeper's Worker, not uploaded yet. */
export interface PendingSecrets {
  /** The Gatekeeper's slug. */
  gatekeeper: string;
  worker: string;
  /** By secret name. Never printed, logged or written. */
  values: Record<string, string>;
}

/** One Gatekeeper's secrets, set and seen on its Worker. Names only. */
export interface SetSecrets {
  /** The Gatekeeper's slug. */
  gatekeeper: string;
  worker: string;
  secrets: string[];
}

/** What {@link askAndSetSecrets} did, by Gatekeeper slug. */
export interface SecretsOutcome {
  /** Uploaded and confirmed (`upload: "now"`). */
  set: SetSecrets[];
  /** Entered, for the caller to upload once the deploy has finished (`upload: "deferred"`). */
  pending: PendingSecrets[];
  /** Had every secret already: nothing asked. */
  complete: string[];
  /** No Worker yet (`upload: "now"`): nothing asked or uploaded. */
  undeployed: string[];
  /** Left for later at the prompt. */
  later: string[];
  /** Without a terminal: the `wrangler secret put` commands for what is missing. */
  manual: { gatekeeper: string; worker: string; commands: string[] }[];
  /** Its lookup or upload failed, as reported with the `cf-os secrets` command that tries again. */
  failed: string[];
}

/**
 * An upload that failed or did not take: what {@link putWorkerSecrets} and {@link uploadSecrets}
 * throw, so a caller can tell it from a failed prompt or a bug.
 */
export class SecretUploadError extends Error {}

/**
 * ` --config <path>` when `ctx`'s deployment file is not the project's deployment.jsonc, else empty:
 * what a printed `cf-os` command needs to read the same file.
 */
export function configFlag(ctx: Context): string {
  const path = configPath(ctx);
  return path === resolve(ctx.root, "deployment.jsonc") ? "" : ` --config ${displayPath(ctx, path)}`;
}

/** The `cf-os secrets` command that sets Gatekeeper `slug`'s credentials, against `ctx`'s deployment file. */
export function secretsCommand(ctx: Context, slug: string): string {
  return `pnpm cf-os secrets ${slug}${configFlag(ctx)}`;
}

/** `error`'s message, ending with the `cf-os secrets` command that tries Gatekeeper `slug` again. */
export function withRetry(ctx: Context, error: Error, slug: string): string {
  const retry = `\`${secretsCommand(ctx, slug)}\``;
  return error.message.includes(retry) ? error.message : `${error.message} ${retry} tries again.`;
}

/**
 * Sets `values` on Worker `worker` in `accountId` with `wrangler secret bulk`, the JSON on its stdin.
 * Wrangler's output goes to stderr. Throws a {@link SecretUploadError} when it fails. The caller
 * makes sure the Worker exists.
 */
export function putWorkerSecrets(
  spawn: SpawnTool,
  root: string,
  accountId: string,
  worker: string,
  values: Record<string, string>,
): void {
  const result = spawn("pnpm", ["exec", "wrangler", "secret", "bulk", "--name", worker], {
    cwd: root,
    capture: false,
    // Wrangler logs each API request, body and all, to its debug log file and with WRANGLER_LOG=debug
    // to the console, leaving the body out only while WRANGLER_LOG_SANITIZE is on: so it is on here,
    // whatever the shell says.
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_LOG_SANITIZE: "true" },
    input: JSON.stringify(values),
  });
  if (!succeeded(result)) {
    throw new SecretUploadError(`\`wrangler secret bulk --name ${worker}\` failed` +
      (result.error ? `: ${result.error.message}` : ". Its output is above."));
  }
}

/**
 * Uploads `pending` with {@link putWorkerSecrets}, then lists the Worker's secrets to confirm every
 * name is there. Throws a {@link SecretUploadError}, naming `cf-os secrets` to try again, when one
 * is not.
 */
export async function uploadSecrets(
  ctx: Context,
  deps: Pick<SecretsDeps, "client" | "spawn">,
  accountId: string,
  { gatekeeper, worker, values }: PendingSecrets,
): Promise<SetSecrets> {
  const names = Object.keys(values);
  ctx.out.log(`\nSetting ${prose(names, "and")} on ${worker}.`);
  putWorkerSecrets(deps.spawn, ctx.root, accountId, worker, values);
  const present = await deps.client.listWorkerSecrets(accountId, worker);
  const absent = names.filter((name) => !present?.includes(name));
  if (absent.length) {
    throw new SecretUploadError(`Wrangler finished, but ${worker} has no ${prose(absent, "or")}. ` +
      `\`${secretsCommand(ctx, gatekeeper)}\` tries again.`);
  }
  ctx.out.log(`Set ${prose(names, "and")} on ${worker}.`);
  return { gatekeeper, worker, secrets: names };
}

/**
 * For each of `slugs` whose catalog entry reads secrets and whose Worker lacks one: prints upstream's
 * setup steps and the redirect URI (core/gatekeepers.ts `secretSetup`), asks whether to enter the
 * values now, and asks for each missing one, masked. With `upload: "now"` they are uploaded at once,
 * and a Worker not deployed yet is skipped, as nothing may be uploaded to it. With `"deferred"` they
 * are returned for the caller to upload after the deploy that creates the Worker.
 *
 * One Gatekeeper's failed lookup or upload is reported, with the `cf-os secrets` command that tries
 * again, and the rest are still asked about: what was set before it stays in the outcome.
 *
 * `origin` is the public origin the redirect URI is on: `publicOrigin(config)` unless given.
 */
export async function askAndSetSecrets(
  ctx: Context,
  deps: SecretsDeps,
  { config, catalog, slugs, upload, origin = publicOrigin(config) }: {
    config: DeploymentConfig;
    catalog: GatekeeperCatalog;
    slugs: string[];
    upload: "now" | "deferred";
    origin?: string;
  },
): Promise<SecretsOutcome> {
  const outcome: SecretsOutcome = { set: [], pending: [], complete: [], undeployed: [], later: [], manual: [], failed: [] };
  for (const slug of slugs) {
    try {
      await askAndSetOne(ctx, deps, { config, catalog, slug, upload, origin }, outcome);
    } catch (error) {
      if (!(error instanceof SecretUploadError || error instanceof CfError || error instanceof CfAuthError)) throw error;
      ctx.out.log(`\nThe ${slug} Gatekeeper's OAuth credentials were not set: ${withRetry(ctx, error, slug)}`);
      outcome.failed.push(slug);
    }
  }
  return outcome;
}

/** {@link askAndSetSecrets} for Gatekeeper `slug`, recording what it did in `outcome`. */
async function askAndSetOne(
  ctx: Context,
  deps: SecretsDeps,
  { config, catalog, slug, upload, origin }: {
    config: DeploymentConfig;
    catalog: GatekeeperCatalog;
    slug: string;
    upload: "now" | "deferred";
    origin: string;
  },
  outcome: SecretsOutcome,
): Promise<void> {
  const worker = config.gatekeepers?.[slug]?.name;
  const entry = catalog.offered.find((gatekeeper) => gatekeeper.slug === slug);
  if (!worker || !entry?.secrets.length) return;
  const present = await deps.client.listWorkerSecrets(config.accountId, worker);
  const missing = entry.secrets.filter(({ name }) => !present?.includes(name));
  if (!missing.length) {
    outcome.complete.push(slug);
    return;
  }
  if (present === null && upload === "now") {
    ctx.out.log(`\n${worker} is not deployed yet; deploy first (\`pnpm cf-os deploy${configFlag(ctx)}\`), then ` +
      `\`${secretsCommand(ctx, slug)}\` sets the ${slug} Gatekeeper's ${prose(missing.map(({ name }) => name), "and")}.`);
    outcome.undeployed.push(slug);
    return;
  }
  const setup = secretSetup(entry, slug, worker, origin, config.accountId);
  ctx.out.log(`\nThe ${slug} Gatekeeper (${worker}) needs an OAuth app before anyone can connect it:\n` +
    setup.lines.map((line) => `  ${line}`).join("\n"));
  if (!deps.prompter) {
    outcome.manual.push({
      gatekeeper: slug,
      worker,
      commands: setup.commands.filter(({ name }) => missing.some((input) => input.name === name))
        .map(({ command }) => command),
    });
    return;
  }
  const when = await deps.prompter.select(`Set the ${slug} Gatekeeper's OAuth credentials now?`, [
    { value: "now" as const, label: "Enter them now" },
    { value: "later" as const, label: `Later — ${secretsCommand(ctx, slug)}` },
  ], "now");
  if (when === "later") {
    outcome.later.push(slug);
    return;
  }
  const values: Record<string, string> = {};
  for (const { name, label, help } of missing) {
    const value = await deps.prompter.password(`${label} (${name})${help ? `. ${help}` : ""}`, {
      validate: (answer) => answer.trim() ? undefined : `${name} cannot be empty. Paste it, or press Ctrl-C to stop.`,
    });
    values[name] = value.trim();
  }
  const pending = { gatekeeper: slug, worker, values };
  if (upload === "deferred") outcome.pending.push(pending);
  else outcome.set.push(await uploadSecrets(ctx, deps, config.accountId, pending));
}
