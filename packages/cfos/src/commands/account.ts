// Which account a command acts on, in `cf`'s order: `--account`, then the deployment file's
// `accountId`, then -- at a terminal -- a picker over every account `cf` can reach. Never `cf`'s own
// per-directory account cache, which would make the answer depend on where the command was run.

import type { Context } from "../context.ts";
import type { CfAccount, CloudflareClient } from "../core/client.ts";
import { valueAtPath } from "../core/edits.ts";

const accountIdPattern = /^[a-f\d]{32}$/i;

/** The resolved account. */
export interface ResolvedAccount {
  id: string;
  /** Known only when it came from the account list. */
  name?: string;
  /** Whether it is new to the deployment file, and so belongs in what gets written. */
  isNew: boolean;
}

/** Accounts as an aligned `id  name` list. */
export function formatAccounts(accounts: CfAccount[]): string {
  return accounts.map((account) => `  ${account.id}  ${account.name}`).join("\n");
}

/**
 * Resolves the account for `file`. Null when it cannot without help: the candidates have been
 * printed, with `rerun` (the command to run again, `--account <id>` included) as the next step.
 */
export async function resolveAccount(
  ctx: Context,
  client: CloudflareClient,
  file: Record<string, unknown>,
  { question, rerun, where }: { question: string; rerun: string; where: string },
): Promise<ResolvedAccount | null> {
  const flag = ctx.flags.account;
  if (flag !== undefined) {
    if (!accountIdPattern.test(flag)) throw new Error(`--account must be a 32-hex account ID, not "${flag}".`);
    return { id: flag, isNew: true };
  }
  const fromFile = valueAtPath(file, ["accountId"]);
  if (typeof fromFile === "string" && accountIdPattern.test(fromFile)) return { id: fromFile, isNew: false };

  const accounts = await client.listAccounts();
  if (accounts.length === 1) {
    ctx.out.log(`Using ${accounts[0].name} (${accounts[0].id}), the only account cf can reach.\n`);
    return { ...accounts[0], isNew: true };
  }
  if (accounts.length && ctx.prompter) {
    const id = await ctx.prompter.select(
      question, accounts.map((account) => ({ value: account.id, label: account.name, hint: account.id })));
    return { id, name: accounts.find((account) => account.id === id)?.name, isNew: true };
  }
  ctx.out.log(accounts.length
    ? `${where} has no accountId yet. Pick the account:\n\n${formatAccounts(accounts)}\n\nThen: ${rerun}`
    : "cf can reach no accounts. Check `pnpm exec cf auth whoami`.");
  return null;
}
