// `cf-os access [--dry-run] [--config <path>]`
//
// Puts Cloudflare Access in front of a deployment: finds or creates the self-hosted Access
// application for the router's hostname (core/access.ts), then writes `access.issuer` and
// `access.audience` into the deployment file. Prints `{ issuer, audience }` as JSON on stdout.
//
// `--dry-run` still reads the account (that is how it knows whether to create anything), but changes
// nothing: a create is only validated, its request printed on stdout, and the file is not written.

import { readFile } from "node:fs/promises";
import { cachedReads, prefetch } from "../cached-reads.ts";
import { configPath, displayPath, type CommandArgs, type Context } from "../context.ts";
import { accessTarget, setupAccess } from "../core/access.ts";
import { parseDeployment, updateDeployment } from "../deployment-file.ts";
import { waitOn } from "../prompt.ts";

/** `cf-os access`. */
export async function run(args: CommandArgs, ctx: Context): Promise<number> {
  const dryRun = args.values["dry-run"] === true;
  const path = configPath(ctx);
  const where = displayPath(ctx, path);
  const target = accessTarget(parseDeployment(await readFile(path, "utf8"), where), where);
  if (ctx.flags.account && ctx.flags.account.toLowerCase() !== target.accountId.toLowerCase()) {
    throw new Error(`--account ${ctx.flags.account} is not ${where}'s accountId (${target.accountId}).`);
  }

  // The applications are listed while the organization is read, rather than once it is in: the
  // lookup takes both from the cache. The organization first, so that a sign-in whose first `cf` call
  // goes alone (cf-client.ts) still reads it first, which can end the run before the applications matter.
  const { quiet: client } = cachedReads(await ctx.client());
  prefetch(client.getOrganization(target.accountId));
  prefetch(client.listAccessApps(target.accountId));
  const result = await waitOn(ctx.prompter,
    dryRun ? "Looking up Access in the account" : "Finding or creating the Access application",
    () => setupAccess(client, target, { dryRun }));
  if (result.kind !== "reused" && result.wildcard) {
    // Once the dedicated one exists, Access applies it ahead of the wildcard: using the wildcard then
    // means deleting it first.
    ctx.out.log(`Access application "${result.wildcard.name}" covers ${target.host} with a wildcard, under a policy of ` +
      `its own. A dedicated one naming ${target.host} takes precedence over it, admitting only access.admins. ` +
      (result.kind === "dry-run"
        ? `To use the wildcard's policy instead, create nothing and set access.audience to its AUD, ${result.wildcard.aud}.`
        : `To use the wildcard's policy instead, delete "${result.app.name}" in the Zero Trust dashboard, then set ` +
          `access.audience to the wildcard's AUD, ${result.wildcard.aud}.`));
  }
  if (result.kind === "dry-run") {
    ctx.out.log(`No Access application ${result.wildcard ? "names" : "covers"} ${target.host}. The request that ` +
      `would create one is on stdout. Then access.issuer would be ${result.issuer}. Dry run: nothing created, ` +
      "nothing written.");
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
    ctx.out.log(`Wrote access.issuer and access.audience to ${where}. Run \`pnpm cf-os deploy\` next.`);
  }
  ctx.out.json({ issuer: result.edits[0].value, audience: result.edits[1].value });
  return 0;
}
