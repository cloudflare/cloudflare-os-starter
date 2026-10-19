// `cf-os check` and `cf-os deploy`
//
// Both validate the deployment file, generate every Worker's `wrangler.prod.jsonc`
// (core/deployment.ts), confirm against the account that what the file names exists
// (core/verify-account.ts), warn about any optional Gatekeeper's secrets not set yet, and build.
// `check` runs the test suites first and dry-runs each deploy; `deploy` deploys for real, with no
// confirmation. The generated configs are removed afterwards either way.
//
// The builds run concurrently (run-tasks.ts), each command's output printed as one block when it
// finishes, and the first failure cancels the rest: the deploy is doomed either way, so there is no
// point waiting out the others. Every build has to pass before anything deploys, so a type error
// cannot leave new Gatekeepers in front of an old Workshop. The Workers then deploy in the waves
// `deployWaves` gives -- every Gatekeeper and the Error Reporter together, then the Workshop, then
// the router -- because a service binding has to name a Worker that already exists. A failed
// deploy cancels nothing: a half-cancelled upload is worse than a slow one, so its siblings finish,
// and only the next wave is held back. With the router last, any failure leaves the previous router
// serving.
//
// Wrangler deploys, not `cf deploy`: `cf deploy` takes no `--config` and works one project per
// directory, so it cannot deploy a set of Workers from generated configs.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolveBinEntry } from "@gadgets/scripts/bin-entry";
import { pnpmCommand } from "../pnpm-command.ts";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { configPath, displayPath, type CommandArgs, type Context } from "../context.ts";
import type { BaseConfigs, BuildCommand, DeploymentConfig } from "../core/deployment-config.ts";
import {
  aiGatewayPlan,
  buildCommands,
  deployOrder,
  deployWaves,
  gatekeeperSlugs,
  gatekeeperWorkerId,
  GENERATED_NAME,
  generateConfigs,
  generatedOutputs,
  PACKAGE_DIRS,
  PlaceholderError,
  publicOrigin,
  validateConfig,
  validateGatekeepers,
  workerDir,
  workerName,
  type PackageKey,
  type WorkerId,
} from "../core/deployment.ts";
import { placeholderPaths } from "../core/edits.ts";
import type { GatekeeperCatalog } from "../core/gatekeepers.ts";
import { gatekeeperSecretWarnings, verifyAccount } from "../core/verify-account.ts";
import { parseDeployment } from "../deployment-file.ts";
import { loadCatalog } from "../gatekeeper-catalog.ts";
import { CancelledError, concurrencyLimit, mapConcurrent, runCaptured } from "../run-tasks.ts";
import { check as checkSubmoduleInstall } from "./install.ts";

// `allowTrailingComma` because wrangler accepts them and upstream uses them: the Scheduler's base
// config closes `build`, `migrations` and `observability` with one. Without the option every such
// comma is a parse *error*, so the deploy refuses a file wrangler itself reads happily.
const jsoncOptions = { allowTrailingComma: true };

async function readJsonc<T>(root: string, path: string): Promise<T> {
  const errors: ParseError[] = [];
  const result = parse(await readFile(path, "utf8"), errors, jsoncOptions) as T;
  if (errors.length) {
    const where = relative(root, path) || path;
    throw new Error(`${where}: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
  }
  return result;
}

/**
 * The base config of every Worker in {@link PACKAGE_DIRS}, read from its package. An optional
 * Gatekeeper's comes with its catalog entry.
 */
async function readBaseConfigs(root: string): Promise<BaseConfigs> {
  const entries = await Promise.all(Object.entries(PACKAGE_DIRS).map(async ([key, dir]) =>
    [key, await readJsonc(root, join(root, dir, "wrangler.jsonc"))] as const));
  return Object.fromEntries(entries) as unknown as BaseConfigs;
}

// Spawned through pnpmCommand rather than as a bare "pnpm": on Windows the pnpm on PATH is a `.cmd`
// shim Node refuses to spawn without a shell, and `shell: true` would re-split argv and break any
// checkout path containing a space. The same goes for the builds below.

/** `pnpm <args>` from the root, with the terminal: the one step that runs alone (`pnpm test`). */
function pnpm(root: string, args: string[]): void {
  const [command, argv] = pnpmCommand(args, process.env);
  const result = spawnSync(command, argv, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed. Its output is above.`);
}

/** One build step, from the root, its output captured. */
function build(ctx: Context, { args, env }: BuildCommand, signal: AbortSignal): Promise<void> {
  const fullEnv = env ? { ...process.env, ...env } : process.env;
  const [command, argv] = pnpmCommand(args, fullEnv);
  return runCaptured(`pnpm ${args.join(" ")}`, command, argv, { cwd: ctx.root, env: fullEnv, signal, log: ctx.out.log });
}

/**
 * `wrangler deploy` for one package, spawned as `node <entry>` when the entry point behind the
 * `.bin` shim can be found. That saves the ~0.33s `pnpm exec` costs per call and sidesteps the
 * Windows `.cmd` shim entirely; when it cannot be resolved, the pnpm path is still there.
 */
function deployWorker(ctx: Context, dir: string, extraArgs: string[]): Promise<void> {
  const cwd = join(ctx.root, dir);
  const args = ["deploy", "--config", GENERATED_NAME, ...extraArgs];
  const label = `${dir}: wrangler ${args.join(" ")}`;
  const entry = resolveBinEntry(cwd, "wrangler");
  const [command, argv]: [string, string[]] = entry
    ? [process.execPath, [entry, ...args]]
    : pnpmCommand(["exec", "wrangler", ...args], process.env);
  return runCaptured(label, command, argv, { cwd, log: ctx.out.log });
}

/**
 * Awaits a {@link mapConcurrent} run and, when it failed, throws one error naming every command that
 * failed by itself; those it cancelled are only fallout. Each failure's output is already printed.
 */
async function settle(tasks: Promise<unknown>): Promise<void> {
  try {
    await tasks;
  } catch (error) {
    const failures = (error instanceof AggregateError ? error.errors : [error])
      .filter((failure) => !(failure instanceof CancelledError));
    if (failures.length === 1) throw failures[0];
    throw new Error((failures as Error[]).map((failure) => failure.message).join("\n"), { cause: error });
  }
}

/** Every chain from `buildCommands`, concurrently. The first failure cancels the rest. */
async function buildAll(ctx: Context, config: DeploymentConfig, catalog: GatekeeperCatalog): Promise<void> {
  const chains = buildCommands(config, catalog);
  const limit = concurrencyLimit();
  ctx.out.log(`\nBuilding ${chains.length} packages, ${Math.min(limit, chains.length)} at a time.`);
  const abort = new AbortController();
  await settle(mapConcurrent(chains, limit, async (chain) => {
    try {
      for (const step of chain) await build(ctx, step, abort.signal);
    } catch (error) {
      abort.abort();
      throw error;
    }
  }, abort.signal));
}

/**
 * Each wave concurrently, the next only once the whole wave has deployed. A failure cancels nothing
 * already running. `--dry-run` uploads nothing for a binding to name, so a check is one wave.
 *
 * The very first deploy runs alone. Wrangler refreshes an expired OAuth sign-in from a single-use
 * refresh token, with no lock: started together, every deploy would spend the same one, and all but
 * the first would fail, or sign wrangler out. Alone, it refreshes once, and the rest read the result.
 */
async function deployAll(
  ctx: Context,
  config: DeploymentConfig,
  catalog: GatekeeperCatalog,
  check: boolean,
): Promise<void> {
  const waves = check ? [deployOrder(config)] : deployWaves(config);
  for (const [index, wave] of waves.entries()) {
    ctx.out.log(`\n${check ? "Dry-running the deploys of" : "Deploying"} ${wave.map((id) => workerName(config, id)).join(", ")}.`);
    const deploy = (id: WorkerId) => deployWorker(ctx, workerDir(id, catalog), check ? ["--dry-run"] : []);
    let rest = wave;
    if (!check && index === 0) {
      await settle(deploy(wave[0]));
      rest = wave.slice(1);
    }
    await settle(mapConcurrent(rest, concurrencyLimit(), deploy));
  }
}

/**
 * The submodule is checked out and its own workspace installed to match its lockfile. The root
 * postinstall does the installing, but `--ignore-scripts` skips it, and a gitlink bump leaves the
 * old install in place until the next `pnpm install` -- either way the build would fail later with
 * an error naming some missing module rather than the fix.
 */
function requireSubmodule(root: string): void {
  if (!existsSync(join(root, "cloudflare-os/package.json"))) {
    throw new Error("CloudflareOS submodule is not initialized. Run git submodule update --init.");
  }
  const installed = checkSubmoduleInstall({ root });
  if (!installed.ok) throw new Error(installed.message);
}

// Said once, up front, rather than discovered when the first chat throws.
function reportAiGateway(ctx: Context, config: DeploymentConfig): void {
  const gateway = aiGatewayPlan(config);
  if (!gateway) {
    ctx.out.log(
      "\naiGateway.enabled is false: this deployment advertises no model catalog, and each user " +
      "supplies their own model API keys. A Workshop migrated from the hosted deploy will show an " +
      "empty model picker -- see docs/migrate-from-hosted.md.");
    return;
  }
  if (!gateway.needsToken) return;
  // CLOUDFLARE_ACCOUNT_ID pins the account the way the deploys themselves are pinned: every
  // generated config carries `account_id`, but `wrangler secret put` takes only `--name`
  ctx.out.log(
    `\nCF_AI_GATEWAY_API_TOKEN is required by this configuration:\n` +
    gateway.tokenReasons.map((reason) => `  - ${reason}`).join("\n") +
    `\nInstall it before deploying:\n  CLOUDFLARE_ACCOUNT_ID=${config.accountId} ` +
    `pnpm exec wrangler secret put CF_AI_GATEWAY_API_TOKEN ` +
    `--name ${config.workers.workshop.name}\n`);
}

/**
 * Warns about each optional Gatekeeper secret not set yet. Never fails: the Worker deploys without
 * them, and only connecting through it waits on them.
 */
async function warnMissingSecrets(ctx: Context, config: DeploymentConfig, catalog: GatekeeperCatalog): Promise<void> {
  for (const warning of await gatekeeperSecretWarnings(await ctx.client(), config, catalog)) {
    ctx.out.log(`\n${warning}`);
  }
}

/**
 * Fails on anything the deployment file names that the account does not have. Before the build, so
 * a wrong AUD tag or KV ID costs seconds rather than a full build, and well before anything deploys.
 * Then warns about missing Gatekeeper secrets, which fail nothing.
 */
async function checkAccount(
  ctx: Context,
  config: DeploymentConfig,
  where: string,
  catalog: GatekeeperCatalog,
): Promise<void> {
  const result = await verifyAccount(await ctx.client(), config, publicOrigin(config));
  if ("skipped" in result) {
    ctx.out.log(`\nSkipped Cloudflare-side checks: ${result.skipped}`);
    return;
  }
  if (result.problems.length) {
    throw new Error(
      `${where} does not match the account:\n` +
      result.problems.map((problem) => `  - ${problem}`).join("\n"));
  }
  ctx.out.log("\nCloudflare-side checks passed: Access application, team domain and storage IDs match.");
  await warnMissingSecrets(ctx, config, catalog);
}

/**
 * The parsed, validated deployment file, its optional Gatekeepers checked against `catalog`. Every
 * validation message names a config path, so the error says which file those paths live in; the
 * original stays as its `cause`.
 */
async function readDeployment(
  ctx: Context,
  path: string,
  where: string,
  catalog: GatekeeperCatalog,
): Promise<DeploymentConfig> {
  const config = await readJsonc<DeploymentConfig>(ctx.root, path);
  try {
    validateConfig(config);
    validateGatekeepers(config, catalog);
    return config;
  } catch (error) {
    throw new Error(`${where}: ${(error as Error).message}`, { cause: error });
  }
}

/** `cf-os check` / `cf-os deploy`. */
export async function run(args: CommandArgs, ctx: Context): Promise<number> {
  const check = args.command === "check";
  const root = ctx.root;
  requireSubmodule(root);
  const path = configPath(ctx);
  const where = displayPath(ctx, path);
  const catalog = await loadCatalog(root);
  let config: DeploymentConfig;
  try {
    config = await readDeployment(ctx, path, where, catalog);
  } catch (error) {
    // An unconfigured file, at a terminal: offer the wizard instead of the bare error, then carry on
    // with the file it wrote. Not a confirmation of anything; it only replaces a failure.
    if (!((error as Error).cause instanceof PlaceholderError && ctx.prompter)) throw error;
    ctx.out.log((error as Error).message);
    if (!await ctx.prompter.confirm(`${where} still has placeholders. Run \`cf-os init\` now?`)) throw error;
    const init = await import("./init.ts");
    const code = await init.configure({ command: "init", values: {}, positionals: [] }, ctx,
      init.defaultDeps(), { offerDeploy: false });
    if (code !== 0) return code;
    // Still placeholders (Access left for later, say): init has just listed them and the fix.
    if (placeholderPaths(parseDeployment(await readFile(path, "utf8"), where)).length) return 1;
    ctx.out.log(`\nContinuing with \`cf-os ${args.command}\`.`);
    config = await readDeployment(ctx, path, where, catalog);
  }
  // The file's IDs, AUD tag and issuer all belong to its account, so a different one cannot simply
  // take its place: refused, as \`cf-os access\` refuses it.
  if (ctx.flags.account && ctx.flags.account.toLowerCase() !== config.accountId.toLowerCase()) {
    throw new Error(`--account ${ctx.flags.account} is not ${where}'s accountId (${config.accountId}).`);
  }
  const generated = generateConfigs(config, await readBaseConfigs(root), catalog);
  reportAiGateway(ctx, config);
  await checkAccount(ctx, config, where, catalog);

  const generatedPath = (id: WorkerId) => join(root, workerDir(id, catalog), GENERATED_NAME);
  // Every package's, not only those generated this time: a Worker turned off since (the Error
  // Reporter, the custom Gatekeeper) may still hold one from a run that never got to clean up.
  const cleanup = [...Object.keys(PACKAGE_DIRS) as PackageKey[], ...gatekeeperSlugs(config).map(gatekeeperWorkerId)]
    .map(generatedPath);
  try {
    for (const [id, generatedConfig] of generatedOutputs(generated)) {
      await writeFile(generatedPath(id), `${JSON.stringify(generatedConfig, null, 2)}\n`);
    }
    if (check) pnpm(root, ["test"]);
    await buildAll(ctx, config, catalog);
    await deployAll(ctx, config, catalog, check);
  } finally {
    // Only once every command has settled: mapConcurrent awaits all it started, failed or not.
    await Promise.all(cleanup.map((file) => rm(file, { force: true })));
  }
  return 0;
}
