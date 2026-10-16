// `cfos import [<instance>] [--account <id>] [--config <path>] [--out <path>]`
//
// Takes over an instance created by the hosted deploy: finds what it already runs in the account
// (core/discovery.ts), and prints the `deployment.jsonc` values that redeploy over it -- the
// fragment as JSON on stdout, the found/missing report on stderr. Missing an account or an instance
// name, it asks at a terminal, and otherwise lists the candidates and stops, so the choice is always
// the operator's. Read-only against Cloudflare; `--out <path>` writes the values into a local copy
// of the config, comments intact (pass `--config`'s path to update it in place).

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { configPath, displayPath, UsageError, type CommandArgs, type Context } from "../context.ts";
import type { CloudflareClient } from "../core/client.ts";
import { discover, fetchInventory, type Discovery } from "../core/discovery.ts";
import { editsAsFragment } from "../core/edits.ts";
import { findInstances, WORKER_NAME } from "../core/naming.ts";
import { parseDeployment, updateDeployment } from "../deployment-file.ts";
import { resolveAccount } from "./account.ts";

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
    "Not part of the hosted deploy, so not discoverable -- set these by hand (`cfos init` asks):",
    "  access.admins              the admin emails (the wizard's admin email, at least)",
    `  workers.customGatekeeper   a new name, e.g. "${n}-gk-custom"`,
    `  workers.errorReporter      a new name, e.g. "${n}-errors"`,
    "  aiGateway.providers        add anthropic/openai if you stored keys on the gateway",
    "  customGatekeeper.*         the name and message the example custom Gatekeeper shows agents",
  );
  if (discovery.orphanedGatekeepers.length) {
    lines.push(
      "",
      "Wizard-installed Gatekeepers the starter does not deploy. They keep running, but lose their",
      "binding and disappear from the app (docs/migrate-from-hosted.md, section 8):",
      ...discovery.orphanedGatekeepers.map((name) => `  ${name}`),
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

/** `cfos import`. */
export async function run(args: CommandArgs, ctx: Context): Promise<number> {
  let instance: string | undefined = args.positionals[0];
  checkInstanceName(instance);
  const out = args.values.out as string | undefined;
  const inPath = configPath(ctx);
  const where = displayPath(ctx, inPath);
  const file = parseDeployment(await readFile(inPath, "utf8"), where);
  const client = await ctx.client();

  const account = await resolveAccount(ctx, client, file, {
    question: "Which account is the hosted instance in?",
    rerun: ["pnpm cfos import", instance, "--account <id>"].filter(Boolean).join(" "),
    where,
  });
  if (!account) return 1;
  const accountFlag = account.isNew ? `--account ${account.id}` : "";

  instance ??= await pickInstance(ctx, client, account.id,
    ["pnpm cfos import <instance>", accountFlag].filter(Boolean).join(" ")) ?? undefined;
  if (!instance) return 1;

  const discovery = discover(instance, await fetchInventory(client, account.id));
  if (account.isNew) discovery.edits.unshift({ path: ["accountId"], value: account.id });

  ctx.out.log(`Hosted instance "${instance}" in account ${account.id}:\n`);
  ctx.out.log(formatReport(instance, discovery));
  if (!discovery.edits.length) {
    ctx.out.log("\nNothing matched; nothing to write. Check the instance name against the Worker list.");
    return 1;
  }
  ctx.out.json(editsAsFragment(discovery.edits));
  if (out) {
    const outPath = resolve(ctx.cwd, out);
    const outWhere = displayPath(ctx, outPath);
    await updateDeployment(inPath, discovery.edits, outPath);
    ctx.out.log(`\nWrote ${discovery.edits.length} values to ${outWhere} (local file only; nothing in ` +
      `the account changed). Review it${outPath === inPath ? ` with \`git diff ${outWhere}\`` : ""}, ` +
      "fill in what is listed above, then run `pnpm cfos deploy`.");
  } else {
    // The whole command, so a choice made at a prompt does not have to be made again.
    const rerun = ["pnpm cfos import", instance, accountFlag,
      ctx.flags.config ? `--config ${ctx.flags.config}` : "", `--out ${where}`];
    ctx.out.log(`\nNothing written; the values are on stdout. To fill them into ${where}:\n  ` +
      rerun.filter(Boolean).join(" "));
  }
  return 0;
}
