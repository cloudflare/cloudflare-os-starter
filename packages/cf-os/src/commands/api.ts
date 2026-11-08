// `cf-os api [public] <command> [arguments] [<command> [arguments]]... [options]`
//
// Drives a running Cloudflare OS instance through its API by running the pinned cloudflare-os's own
// CLI, `packages/api-cli`, as its README's "Running it from another repository" lays out:
// `node cloudflare-os/packages/api-cli/src/main.ts api <tokens>`, spawned and never imported, with
// this process's stdio and the directory the command was typed in, so its commands, help, output and
// exit codes are the pin's. Its command table is the pin's to generate and is not committed there,
// so each run first spawns the pin's generator with `--if-stale`, which writes it in the submodule
// when the pin's API is not the one it was written for.
//
// What the starter adds is the default instance: the deployment's public origin as `CFOS_API_URL`,
// or, when there is none to use, `CFOS_API_URL_UNAVAILABLE`, a message saying why and naming
// `--url`. The other variable is deleted, so one inherited from the shell cannot win.
//
// main.ts passes every token after `api` through untouched except the global `--config`,
// `--account` and `--profile`, which no command of the CLI takes.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { configPath, displayPath, type CommandArgs, type Context } from "../context.ts";
import type { DeploymentConfig } from "../core/deployment-config.ts";
import { publicOrigin } from "../core/deployment.ts";
import { parseDeployment } from "../deployment-file.ts";
import { exitCodeOf } from "../project.ts";
import { check as installed, NOT_CHECKED_OUT } from "./install.ts";

/** The CLI's entry, relative to the project root. */
export const API_CLI_ENTRY = join("cloudflare-os", "packages", "api-cli", "src", "main.ts");

/** What generates the CLI's command table from the pin's API, relative to the project root. */
export const API_GENERATOR = join("cloudflare-os", "packages", "api-schema", "scripts", "generate.ts");

/** The instance a run without `--url` calls, or why there is none: a complete message naming `--url`. */
export type DefaultInstance = { url: string } | { unavailable: string };

/**
 * The deployment file's public origin (honouring `--config`), held to what deploy holds
 * `publicBaseUrl` to: an `https://` origin and nothing else. `ws://` and a plain-text Access token are
 * for an explicit `--url`, so any other origin is a reason instead.
 */
export async function defaultInstance(ctx: Context): Promise<DefaultInstance> {
  const path = configPath(ctx);
  const where = displayPath(ctx, path);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return {
      unavailable: `could not read ${where} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}): ` +
        "pass --url <origin>, or --config <path>.",
    };
  }
  let config: DeploymentConfig;
  try {
    config = parseDeployment(text, where) as unknown as DeploymentConfig;
  } catch (error) {
    return { unavailable: `${(error as Error).message.replace(/\.$/, "")}: fix it, or pass --url <origin>.` };
  }
  const route = config.workers?.router?.route;
  // Unvalidated, as deploy's checks are not run here: publicOrigin needs a string or nothing.
  if (config.publicBaseUrl && typeof config.publicBaseUrl !== "string") {
    return { unavailable: `${where}'s publicBaseUrl is not a string: fix publicBaseUrl, or pass --url <origin>.` };
  }
  if (!config.publicBaseUrl && !route?.customDomain) {
    return { unavailable: `${where} names no public origin (publicBaseUrl or workers.router.route.customDomain): pass --url <origin>.` };
  }
  const origin = publicOrigin(config);
  if (origin.includes("<")) return { unavailable: `${where} is not configured yet (${origin}): pass --url <origin>.` };
  let parsed: URL | undefined;
  try {
    parsed = new URL(origin);
  } catch {
    parsed = undefined;
  }
  if (parsed?.protocol !== "https:" || parsed.origin !== origin) {
    return { unavailable: `${where}'s public origin, ${origin}, is not an https:// origin: fix publicBaseUrl, or pass --url <origin>.` };
  }
  return { url: origin };
}

/** `env` for the CLI: exactly one of `CFOS_API_URL` and `CFOS_API_URL_UNAVAILABLE`, from `instance`. */
export function childEnv(env: NodeJS.ProcessEnv, instance: DefaultInstance): NodeJS.ProcessEnv {
  const { CFOS_API_URL: _url, CFOS_API_URL_UNAVAILABLE: _unavailable, ...rest } = env;
  return "url" in instance ? { ...rest, CFOS_API_URL: instance.url } : { ...rest, CFOS_API_URL_UNAVAILABLE: instance.unavailable };
}

/** What `cf-os api` runs against besides the context. */
export interface ApiDeps {
  /** Inherited by the CLI, but for the two variables {@link childEnv} sets. */
  env: NodeJS.ProcessEnv;
}

/**
 * `cf-os api`: resolves to the CLI's exit code (0, 1, 2 and 130 among them), to the generator's
 * when it fails, or to 1 when neither can run.
 */
export async function run(args: CommandArgs, ctx: Context, deps: ApiDeps = { env: process.env }): Promise<number> {
  const entry = join(ctx.root, API_CLI_ENTRY);
  if (!existsSync(entry)) {
    ctx.out.log(!existsSync(join(ctx.root, "cloudflare-os", "package.json")) ? NOT_CHECKED_OUT
      : `The cloudflare-os pin predates \`cf-os api\` upstream: it has no ${API_CLI_ENTRY}. ` +
        "Move the pin on with `cf-os update` (`npx cf-os@latest update`).");
    return 1;
  }
  // Without the submodule's install the CLI cannot load capnweb, nor the generator TypeScript, and
  // every run, `--help` included, would die with ERR_MODULE_NOT_FOUND.
  const install = installed({ root: ctx.root });
  if (!install.ok) {
    ctx.out.log(install.message);
    return 1;
  }
  // The generator is given no stdin, which the CLI may read (`-`), and with --if-stale it prints
  // nothing on stdout, so that stays the CLI's alone. It explains a failure itself, on stderr.
  const generated = await exitCodeOf(spawn(process.execPath, [join(ctx.root, API_GENERATOR), "--if-stale"], {
    stdio: ["ignore", "inherit", "inherit"], cwd: ctx.cwd, env: deps.env,
  }));
  if (generated !== 0) return generated;
  const env = childEnv(deps.env, await defaultInstance(ctx));
  return exitCodeOf(spawn(process.execPath, [entry, "api", ...args.positionals], { stdio: "inherit", cwd: ctx.cwd, env }));
}
