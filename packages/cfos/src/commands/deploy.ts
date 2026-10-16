// `cfos check` and `cfos deploy`
//
// Both validate the deployment file, generate every Worker's `wrangler.prod.jsonc`
// (core/deployment.ts), confirm against the account that what the file names exists
// (core/verify-account.ts), and build. `check` then runs the test suites and dry-runs each deploy;
// `deploy` deploys for real, with no confirmation. The generated configs are removed afterwards
// either way.
//
// Wrangler deploys, not `cf deploy`: `cf deploy` takes no `--config` and works one project per
// directory, so it cannot deploy seven Workers from generated configs.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolveBinEntry } from "@gadgets/scripts/bin-entry";
import { pnpmCommand } from "@gadgets/scripts/pnpm-command";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { configPath, displayPath, type CommandArgs, type Context } from "../context.ts";
import type { BaseConfigs, DeploymentConfig } from "../core/deployment-config.ts";
import {
  aiGatewayPlan,
  buildCommands,
  deployOrder,
  GENERATED_NAME,
  generateConfigs,
  PACKAGE_DIRS,
  PlaceholderError,
  publicOrigin,
  validateConfig,
  type PackageKey,
} from "../core/deployment.ts";
import { verifyAccount } from "../core/verify-account.ts";
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

/** Every Worker's upstream base config, read from its package. */
async function readBaseConfigs(root: string): Promise<BaseConfigs> {
  const entries = await Promise.all(Object.entries(PACKAGE_DIRS).map(async ([key, dir]) =>
    [key, await readJsonc(root, join(root, dir, "wrangler.jsonc"))] as const));
  return Object.fromEntries(entries) as unknown as BaseConfigs;
}

function runCommand(
  root: string,
  command: string,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  label: string,
): void {
  const result = spawnSync(command, argv, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const where = relative(root, cwd) || ".";
    throw new Error(`${where}: ${label} failed. Its output is above.`);
  }
}

// Spawned through pnpmCommand rather than as a bare "pnpm": on Windows the pnpm on PATH is a `.cmd`
// shim Node refuses to spawn without a shell, and `shell: true` would re-split argv and break any
// checkout path containing a space.
function pnpm(root: string, args: string[], cwd = root, env: NodeJS.ProcessEnv = process.env): void {
  const [command, argv] = pnpmCommand(args, env);
  runCommand(root, command, argv, cwd, env, `pnpm ${args.join(" ")}`);
}

/**
 * `wrangler deploy` for one package, spawned as `node <entry>` when the entry point behind the
 * `.bin` shim can be found. That saves the ~0.33s `pnpm exec` costs per call and sidesteps the
 * Windows `.cmd` shim entirely; when it cannot be resolved, the pnpm path is still there.
 */
function deployWorker(root: string, dir: string, extraArgs: string[]): void {
  const cwd = join(root, dir);
  const args = ["deploy", "--config", GENERATED_NAME, ...extraArgs];
  const entry = resolveBinEntry(cwd, "wrangler");
  if (entry) {
    runCommand(root, process.execPath, [entry, ...args], cwd, process.env, `wrangler ${args.join(" ")}`);
  } else {
    pnpm(root, ["exec", "wrangler", ...args], cwd);
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
 * Fails on anything the deployment file names that the account does not have. Before the build, so
 * a wrong AUD tag or KV ID costs seconds rather than a full build, and well before anything deploys.
 */
async function checkAccount(ctx: Context, config: DeploymentConfig, where: string): Promise<void> {
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
}

/**
 * The parsed, validated deployment file. Every `validateConfig` message names a config path, so the
 * error says which file those paths live in; the original stays as its `cause`.
 */
async function readDeployment(ctx: Context, path: string, where: string): Promise<DeploymentConfig> {
  const config = await readJsonc<DeploymentConfig>(ctx.root, path);
  try {
    return validateConfig(config);
  } catch (error) {
    throw new Error(`${where}: ${(error as Error).message}`, { cause: error });
  }
}

/** `cfos check` / `cfos deploy`. */
export async function run(args: CommandArgs, ctx: Context): Promise<number> {
  const check = args.command === "check";
  const root = ctx.root;
  requireSubmodule(root);
  const path = configPath(ctx);
  const where = displayPath(ctx, path);
  let config: DeploymentConfig;
  try {
    config = await readDeployment(ctx, path, where);
  } catch (error) {
    // An unconfigured file, at a terminal: offer the wizard instead of the bare error. Not a
    // confirmation of anything; it only replaces a failure.
    if ((error as Error).cause instanceof PlaceholderError && ctx.prompter) {
      ctx.out.log((error as Error).message);
      if (await ctx.prompter.confirm(`${where} still has placeholders. Run \`cfos init\` now?`)) {
        const init = await import("./init.ts");
        const code = await init.run({ command: "init", values: {}, positionals: [] }, ctx);
        if (code === 0) ctx.out.log(`\nThen run \`pnpm cfos ${args.command}\` again.`);
        return code;
      }
    }
    throw error;
  }
  const generated = generateConfigs(config, await readBaseConfigs(root));
  reportAiGateway(ctx, config);
  await checkAccount(ctx, config, where);

  const generatedPaths = Object.fromEntries(Object.entries(PACKAGE_DIRS)
    .map(([key, dir]) => [key, join(root, dir, GENERATED_NAME)])) as Record<PackageKey, string>;
  try {
    for (const [key, generatedConfig] of Object.entries(generated)) {
      await writeFile(generatedPaths[key as PackageKey], `${JSON.stringify(generatedConfig, null, 2)}\n`);
    }
    if (check) pnpm(root, ["test"]);
    for (const { args: buildArgs, env } of buildCommands(config)) {
      pnpm(root, buildArgs, root, env ? { ...process.env, ...env } : process.env);
    }
    const deployArgs = check ? ["--dry-run"] : [];
    for (const key of deployOrder(config)) deployWorker(root, PACKAGE_DIRS[key], deployArgs);
  } finally {
    await Promise.all(Object.values(generatedPaths).map((generatedPath) => rm(generatedPath, { force: true })));
  }
  return 0;
}
