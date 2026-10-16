// `cfos access [--dry-run] [--config <path>]`
//
// Puts Cloudflare Access in front of a deployment: finds or creates the self-hosted Access
// application for the router's hostname (core/access.ts), then writes `access.issuer` and
// `access.audience` into the deployment file. Prints `{ issuer, audience }` as JSON on stdout.
//
// `--dry-run` still reads the account (that is how it knows whether to create anything), but changes
// nothing: a create is only validated, its request printed on stdout, and the file is not written.

import { readFile } from "node:fs/promises";
import { configPath, displayPath, type CommandArgs, type Context } from "../context.ts";
import { accessTarget, setupAccess } from "../core/access.ts";
import { parseDeployment, updateDeployment } from "../deployment-file.ts";

/** `cfos access`. */
export async function run(args: CommandArgs, ctx: Context): Promise<number> {
  const dryRun = args.values["dry-run"] === true;
  const path = configPath(ctx);
  const where = displayPath(ctx, path);
  const target = accessTarget(parseDeployment(await readFile(path, "utf8"), where), where);
  if (ctx.flags.account && ctx.flags.account.toLowerCase() !== target.accountId.toLowerCase()) {
    throw new Error(`--account ${ctx.flags.account} is not ${where}'s accountId (${target.accountId}).`);
  }

  const result = await setupAccess(await ctx.client(), target, { dryRun });
  if (result.kind === "dry-run") {
    ctx.out.log(`No Access application covers ${target.host}. The request that would create one is on ` +
      `stdout. Then access.issuer would be ${result.issuer}. Dry run: nothing created, nothing written.`);
    ctx.out.json(result.request);
    return 0;
  }
  if (result.kind === "reused") {
    ctx.out.log(`Reusing Access application "${result.app.name}", which already covers ${target.host}.`);
  } else {
    ctx.out.log(
      `Created Access application "${result.app.name}" for ${target.host}, admitting ` +
      `${target.admins.join(", ")}.\nTo admit more people (an email domain, an identity-provider ` +
      "group), edit its policy in the Zero Trust dashboard: Access > Applications.");
  }
  if (dryRun) {
    ctx.out.log(`Dry run: ${where} not written.`);
  } else {
    await updateDeployment(path, result.edits);
    ctx.out.log(`Wrote access.issuer and access.audience to ${where}. Run \`pnpm cfos check\` next.`);
  }
  ctx.out.json({ issuer: result.edits[0].value, audience: result.edits[1].value });
  return 0;
}
