// `cf-os secrets [<slug>...] [--config <path>]`
//
// Asks for and sets the OAuth credentials the optional Gatekeepers' Workers lack
// (gatekeeper-secrets.ts). Never creates a Worker: one not deployed yet fails the run.

import { readFile } from "node:fs/promises";
import { configPath, displayPath, type CommandArgs, type Context } from "../context.ts";
import type { DeploymentConfig } from "../core/deployment-config.ts";
import { gatekeeperSlugs, validateConfig, validateGatekeepers } from "../core/deployment.ts";
import type { GatekeeperCatalog } from "../core/gatekeepers.ts";
import { parseDeployment } from "../deployment-file.ts";
import { loadCatalog } from "../gatekeeper-catalog.ts";
import { askAndSetSecrets } from "../gatekeeper-secrets.ts";
import { defaultSpawn, type SpawnTool } from "../tools.ts";

/** What `cf-os secrets` runs besides `cf` lookups, so tests can record it instead. */
export interface SecretsCommandDeps {
  /** `wrangler secret bulk`. */
  spawn: SpawnTool;
  /** The optional Gatekeepers the project at `root` offers. */
  catalog(root: string): Promise<GatekeeperCatalog>;
}

/** `cf-os secrets`. */
export async function run(args: CommandArgs, ctx: Context): Promise<number> {
  return setSecrets(args, ctx, { spawn: defaultSpawn(), catalog: loadCatalog });
}

/** {@link run}, against `deps`. */
export async function setSecrets(args: CommandArgs, ctx: Context, deps: SecretsCommandDeps): Promise<number> {
  const path = configPath(ctx);
  const where = displayPath(ctx, path);
  const catalog = await deps.catalog(ctx.root);
  const config = parseDeployment(await readFile(path, "utf8"), where) as unknown as DeploymentConfig;
  try {
    validateConfig(config);
    validateGatekeepers(config, catalog);
  } catch (error) {
    throw new Error(`${where}: ${(error as Error).message}`, { cause: error });
  }
  if (ctx.flags.account && ctx.flags.account.toLowerCase() !== config.accountId.toLowerCase()) {
    throw new Error(`--account ${ctx.flags.account} is not ${where}'s accountId (${config.accountId}).`);
  }

  const available = gatekeeperSlugs(config)
    .filter((slug) => catalog.offered.find((gatekeeper) => gatekeeper.slug === slug)?.secrets.length);
  const unknown = args.positionals.filter((slug) => !available.includes(slug));
  if (unknown.length) {
    throw new Error(`Not an optional Gatekeeper ${where} selects that reads secrets: ${unknown.join(", ")}. ` +
      `Available: ${available.join(", ") || "none"}.`);
  }
  const slugs = args.positionals.length ? [...new Set(args.positionals)] : available;
  if (!slugs.length) {
    ctx.out.log(`No optional Gatekeeper in ${where} reads secrets, so there is nothing to set.`);
    ctx.out.json({ set: [] });
    return 0;
  }

  const outcome = await askAndSetSecrets(ctx, { prompter: ctx.prompter, client: await ctx.client(), spawn: deps.spawn },
    { config, catalog, slugs, upload: "now" });
  for (const slug of outcome.complete) {
    ctx.out.log(`\n${config.gatekeepers![slug].name} already has every secret the ${slug} Gatekeeper reads.`);
  }
  if (outcome.manual.length) {
    throw new Error("There is no terminal to ask for the values at. Set each with Wrangler, which asks for it:\n" +
      outcome.manual.flatMap(({ commands }) => commands).map((command) => `  ${command}`).join("\n"));
  }
  ctx.out.json({ set: outcome.set });
  return outcome.undeployed.length || outcome.failed.length ? 1 : 0;
}
