// `cf-os import [<instance>] [--account <id>] [--config <path>] [--out <path>]`
//
// Takes over an instance created by the hosted deploy: finds what it already runs in the account
// (core/discovery.ts), and prints the `deployment.jsonc` values that redeploy over it -- the
// fragment as JSON on stdout, the found/missing report on stderr. Missing an account or an instance
// name, it asks at a terminal, and otherwise lists the candidates and stops, so the choice is always
// the operator's. Read-only against Cloudflare; `--out <path>` writes the values into a local copy
// of the config, comments intact (pass `--config`'s path to update it in place).
//
// Each read is made once per run (cached-reads.ts). At a terminal, a step waiting on a read shows a
// spinner, and while "Which hosted instance?" is open the rest of the account is read in the
// background.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cachedReads, INVENTORY_LABEL } from "../cached-reads.ts";
import { configPath, displayPath, UsageError, type CommandArgs, type Context } from "../context.ts";
import type { CloudflareClient } from "../core/client.ts";
import { discover, fetchInventory, type Discovery, type Inventory } from "../core/discovery.ts";
import { editsAsFragment, valueAtPath, type DeploymentEdit } from "../core/edits.ts";
import type { GatekeeperCatalog } from "../core/gatekeepers.ts";
import { findInstances, WORKER_NAME } from "../core/naming.ts";
import { parseDeployment, updateDeployment } from "../deployment-file.ts";
import { loadCatalog } from "../gatekeeper-catalog.ts";
import { waitOn } from "../prompt.ts";
import { resolveAccount } from "./account.ts";

/**
 * {@link discover} against the submodule's Gatekeeper catalog, saying so when there is none: every
 * optional Gatekeeper then reads as not deployable.
 */
export function discoverInstance(n: string, inventory: Inventory, catalog: GatekeeperCatalog): Discovery {
  const discovery = discover(n, inventory, catalog.offered.map((entry) => entry.slug), catalog.excluded);
  if (catalog.unavailable && discovery.orphanedGatekeepers.length) {
    discovery.notes.push(`The Gatekeeper catalog could not be read, so no optional Gatekeeper is deployable: ${catalog.unavailable}`);
  }
  return discovery;
}

/**
 * The file's `gatekeepers` entries to remove when the file is not instance `n`'s: its
 * `workers.router.name` is another, so it may be another deployment's in the same account, and
 * binding the Workers it names would deploy over that deployment's Gatekeepers (`cf-os init`'s
 * takeover leaves them out too). Slugs `discovery` found for `n` stay, as its edits rename them to
 * the instance's own Workers. Each removal comes with a note naming the Worker left alone.
 */
export function foreignGatekeepers(
  file: Record<string, unknown>,
  n: string,
  discovery: Discovery,
): { removals: DeploymentEdit[]; note?: string } {
  const block = valueAtPath(file, ["gatekeepers"]);
  if (valueAtPath(file, ["workers", "router", "name"]) === n || !block || typeof block !== "object" ||
      Array.isArray(block)) {
    return { removals: [] };
  }
  const slugs = Object.keys(block).filter((slug) => !discovery.foundGatekeepers.some((found) => found.slug === slug));
  if (!slugs.length) return { removals: [] };
  const listed = slugs.map((slug) => {
    const name = valueAtPath(block, [slug, "name"]);
    return `gatekeepers.${slug}${typeof name === "string" ? ` (${name})` : ""}`;
  });
  return {
    removals: slugs.map((slug) => ({ path: ["gatekeepers", slug], value: undefined })),
    note: `The file's workers.router.name is not ${n}, so the Gatekeeper Workers its gatekeepers block names ` +
      `may be another deployment's, and are left alone. --out removes their entries: ${listed.join(", ")}.`,
  };
}

/** The human-readable report: a found/missing table, then what is left to do by hand. */
export function formatReport(n: string, discovery: Discovery): string {
  const lines: string[] = [];
  const width = Math.max(...discovery.rows.map((row) => row.label.length));
  for (const row of discovery.rows) {
    const status = row.found === null ? "missing" : "found  ";
    const detail = row.found ?? `looked for ${row.expected}`;
    lines.push(`  ${status}  ${row.label.padEnd(width)}  ${detail}  -> ${row.path}` +
      (row.note ? `\n           ${"".padEnd(width)}  (${row.note})` : ""));
  }
  lines.push(
    "",
    "Not part of the hosted deploy, so not discoverable -- set these by hand (`cf-os init` asks):",
    "  access.admins              the admin emails (the wizard's admin email, at least)",
    `  workers.customGatekeeper   a new name, e.g. "${n}-gk-custom"`,
    `  workers.errorReporter      a new name, e.g. "${n}-errors"`,
    "  aiGateway.providers        add anthropic/openai if you stored keys on the gateway",
    "  customGatekeeper.*         the name and message the example custom Gatekeeper shows agents;",
    "                             customGatekeeper.enabled: false deploys none, and needs neither",
  );
  if (discovery.orphanedGatekeepers.length) {
    const nameWidth = Math.max(...discovery.orphanedGatekeepers.map((gatekeeper) => gatekeeper.name.length));
    lines.push(
      "",
      "Gatekeepers not deployable by the starter. They keep running, but lose their binding and",
      "disappear from the app (docs/migrate-from-hosted.md, section 8):",
      ...discovery.orphanedGatekeepers.map(({ name, reason }) => `  ${name.padEnd(nameWidth)}  ${reason}`),
    );
  }
  if (discovery.notes.length) lines.push("", ...discovery.notes.map((note) => `Note: ${note}`));
  return lines.join("\n");
}

/**
 * The hosted instance to take over: asked for at a terminal, else listed. Null when it could not be
 * chosen here; what to run next has been printed.
 */
export async function pickInstance(
  ctx: Context,
  client: CloudflareClient,
  accountId: string,
  rerun: string,
): Promise<string | null> {
  const instances = findInstances(await client.listWorkers(accountId));
  if (!instances.length) {
    ctx.out.log(`No hosted instances in account ${accountId}: no Worker N has a sibling named like ` +
      "its Workshop. If the instance is in another account, pass --account.");
    return null;
  }
  if (!ctx.prompter) {
    ctx.out.log(`Hosted instances in account ${accountId}:\n\n${instances.map((n) => `  ${n}`).join("\n")}` +
      `\n\nThen: ${rerun}`);
    return null;
  }
  return ctx.prompter.select("Which hosted instance?", instances.map((n) => ({ value: n, label: n })));
}

/** Why `instance` cannot be an instance name, as a usage error. */
export function checkInstanceName(instance: string | undefined): void {
  if (instance !== undefined && !WORKER_NAME.test(instance)) {
    throw new UsageError(`"${instance}" is not a Worker name. The instance name is the router Worker's.`);
  }
}

/** `cf-os import`, against the catalog `catalog` reads from the project at its root. */
export async function run(
  args: CommandArgs,
  ctx: Context,
  catalog: (root: string) => Promise<GatekeeperCatalog> = loadCatalog,
): Promise<number> {
  let instance: string | undefined = args.positionals[0];
  checkInstanceName(instance);
  const out = args.values.out as string | undefined;
  const inPath = configPath(ctx);
  const where = displayPath(ctx, inPath);
  const file = parseDeployment(await readFile(inPath, "utf8"), where);
  const cache = cachedReads(await ctx.client());
  const { quiet, pending } = cache;
  const client = cache.loud(ctx.prompter);

  const account = await resolveAccount(ctx, client, file, {
    question: "Which account is the hosted instance in?",
    rerun: ["pnpm cf-os import", instance, "--account <id>"].filter(Boolean).join(" "),
    where,
  });
  if (!account) return 1;
  const accountFlag = account.isNew ? `--account ${account.id}` : "";

  // While "Which hosted instance?" is open, the rest of what discovery reads, once there is an
  // instance to ask about. The read that fails is reported where fetchInventory below awaits it.
  if (!instance && ctx.prompter) {
    const id = account.id;
    quiet.listWorkers(id)
      .then((workers) => findInstances(workers).length ? fetchInventory(quiet, id) : undefined)
      .catch(() => {});
  }
  instance ??= await pickInstance(ctx, client, account.id,
    ["pnpm cf-os import <instance>", accountFlag].filter(Boolean).join(" ")) ?? undefined;
  if (!instance) return 1;

  // One spinner for the six reads, so it clears when fetchInventory settles, on its first failure
  // too, though later reads are still in flight. fetchInventory starts or reuses every read
  // synchronously, so `pending` already covers them all.
  const reading = fetchInventory(quiet, account.id);
  const inventory = await (pending() ? waitOn(ctx.prompter, INVENTORY_LABEL, () => reading) : reading);
  const discovery = discoverInstance(instance, inventory, await catalog(ctx.root));
  const { removals, note } = foreignGatekeepers(file, instance, discovery);
  if (note) discovery.notes.push(note);

  ctx.out.log(`Hosted instance "${instance}" in account ${account.id}:\n`);
  ctx.out.log(formatReport(instance, discovery));
  if (!discovery.matched) {
    ctx.out.log(`\nNo hosted instance "${instance}" here: it has no router and Workshop Workers. Nothing to ` +
      "write. Check the instance name against the Worker list.");
    return 1;
  }
  if (account.isNew) discovery.edits.unshift({ path: ["accountId"], value: account.id });
  ctx.out.json(editsAsFragment(discovery.edits));
  if (out) {
    const outPath = resolve(ctx.cwd, out);
    const outWhere = displayPath(ctx, outPath);
    await updateDeployment(inPath, [...discovery.edits, ...removals], outPath);
    const removed = removals.length
      ? `, removing ${removals.length} gatekeepers ${removals.length === 1 ? "entry" : "entries"}` : "";
    ctx.out.log(`\nWrote ${discovery.edits.length} values to ${outWhere}${removed} (local file only; nothing in ` +
      `the account changed). Review it${outPath === inPath ? ` with \`git diff ${outWhere}\`` : ""}, ` +
      "fill in what is listed above, then run `pnpm cf-os deploy`.");
  } else {
    // The whole command, so a choice made at a prompt does not have to be made again.
    const rerun = ["pnpm cf-os import", instance, accountFlag,
      ctx.flags.config ? `--config ${ctx.flags.config}` : "", `--out ${where}`];
    ctx.out.log(`\nNothing written; the values are on stdout. To fill them into ${where}:\n  ` +
      rerun.filter(Boolean).join(" "));
  }
  return 0;
}
