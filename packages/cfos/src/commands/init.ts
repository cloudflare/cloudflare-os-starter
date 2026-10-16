// `cfos init [--out <path>]`, inside a project
//
// Configures the deployment file by asking: which account, then either a new deployment or the
// takeover of an instance the hosted deploy created. Every answer has a default read from the
// account where `cf` can see it (zones, gateways, the signed-in email, the workers.dev subdomain),
// and every step's logic is core/wizard.ts; this file asks and looks things up.
//
// Interactive only. Without a terminal it refuses, pointing at `import` and `access`, which take
// every answer as a flag or from the file. Signed out of `cf`, it still runs: the account-aware
// steps become typed answers, and Access is left for `cfos access`.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { configPath, displayPath, UsageError, type CommandArgs, type Context } from "../context.ts";
import {
  accessEdits,
  createAccess,
  lookupAccess,
  ONE_TIME_PIN_PROVIDER,
  type AccessTarget,
} from "../core/access.ts";
import { CfAuthError, CfError, type CloudflareClient, type CfWorker } from "../core/client.ts";
import { discover, fetchInventory } from "../core/discovery.ts";
import { editsAsFragment, isPlaceholder, placeholderPaths, valueAtPath, type DeploymentEdit } from "../core/edits.ts";
import type { AiGatewayProvider } from "../core/deployment-config.ts";
import { baseNameProblem, findInstances, WORKER_NAME, workerNames } from "../core/naming.ts";
import {
  adminsProblem,
  defaultCustomGatekeeper,
  defaultHost,
  gatewayChoices,
  hostnameProblem,
  hostProblem,
  nameCollisions,
  newDeploymentAccessTarget,
  newDeploymentEdits,
  parseAdmins,
  PROVIDER_HINTS,
  PROVIDERS,
  subdomainProblem,
  takeoverEdits,
  type RouteChoice,
} from "../core/wizard.ts";
import { parseDeployment, updateDeployment } from "../deployment-file.ts";
import type { Prompter } from "../prompt.ts";
import { resolveAccount, type ResolvedAccount } from "./account.ts";
import { formatReport, pickInstance } from "./import.ts";

const accountIdPattern = /^[a-f\d]{32}$/i;

/** Without a terminal, what to run instead. */
export const NO_TERMINAL =
  "cfos init asks questions, and there is no terminal to ask them at. Without one, take over a " +
  "hosted instance with `pnpm cfos import <instance> --account <id> --out deployment.jsonc`, or " +
  "edit deployment.jsonc by hand; then `pnpm cfos access` sets up Access.";

/** What init knows about the account, and how to ask about it. */
interface Session {
  ctx: Context;
  prompter: Prompter;
  /** Null when `cf` is signed out: nothing can be looked up, so everything is typed. */
  client: CloudflareClient | null;
  account: ResolvedAccount;
  /** The signed-in email, the default admin. */
  email?: string;
}

/**
 * A read that informs a default, not one the wizard depends on: null, with a line saying so, when it
 * fails. A token can lack the one permission a step needs (Zone Read, say) and still serve the rest.
 */
async function lookup<T>(session: Session, what: string, read: (client: CloudflareClient) => Promise<T>): Promise<T | null> {
  if (!session.client) return null;
  try {
    return await read(session.client);
  } catch (error) {
    if (!(error instanceof CfAuthError || error instanceof CfError)) throw error;
    session.ctx.out.log(`Could not list ${what}, so you will type it: ${(error as Error).message}`);
    return null;
  }
}

function workerNameProblem(name: string): string | undefined {
  return WORKER_NAME.test(name) ? undefined : "Use lowercase letters, numbers and hyphens.";
}

/** The account: `--account`, the file's, the only one, a picker -- or, signed out, typed. */
async function chooseAccount(
  ctx: Context,
  prompter: Prompter,
  client: CloudflareClient | null,
  file: Record<string, unknown>,
  where: string,
): Promise<ResolvedAccount> {
  if (client) {
    const account = await resolveAccount(ctx, client, file, {
      question: "Which account?",
      rerun: "pnpm cfos init --account <id>",
      where,
    });
    if (!account) throw new Error("No account to configure.");
    return account;
  }
  const fromFile = valueAtPath(file, ["accountId"]);
  if (ctx.flags.account) return { id: ctx.flags.account, isNew: true };
  if (typeof fromFile === "string" && accountIdPattern.test(fromFile)) return { id: fromFile, isNew: false };
  const id = await prompter.text("Cloudflare account ID", {
    validate: (value) => accountIdPattern.test(value) ? undefined : "32 hexadecimal characters.",
  });
  return { id, isNew: true };
}

/** The router's address: a hostname in one of the account's zones, or workers.dev. */
async function chooseRoute(session: Session, name: string): Promise<RouteChoice> {
  const { prompter, ctx, account } = session;
  const zones = await lookup(session, "the account's zones", (client) => client.listZones(account.id));
  let kind = await prompter.select("Where will people reach it?", [
    { value: "custom" as const, label: "A custom domain", hint: "a hostname in one of your zones" },
    { value: "workersDev" as const, label: "workers.dev", hint: `https://${name}.<subdomain>.workers.dev` },
  ]);
  if (kind === "custom" && zones && !zones.length) {
    ctx.out.log("The account has no active zones, and a custom domain has to be in one. Using workers.dev.");
    kind = "workersDev";
  }

  if (kind === "workersDev") {
    const subdomain = await lookup(session, "the account's Workers",
      (client) => client.workersDevSubdomain(account.id));
    if (subdomain) {
      ctx.out.log(`It will answer on https://${name}.${subdomain}.workers.dev.`);
      return { workersDevSubdomain: subdomain };
    }
    ctx.out.log(
      "The account's workers.dev subdomain could not be read off an existing Worker. It is shown in " +
      `the dashboard: https://dash.cloudflare.com/${account.id}/workers-and-pages (Subdomain).`);
    return {
      workersDevSubdomain: await prompter.text("workers.dev subdomain", { validate: subdomainProblem }),
    };
  }

  for (;;) {
    let host: string;
    let zone: string | undefined;
    if (zones?.length) {
      const zoneId = await prompter.select("Which zone?", zones.map((candidate) => ({
        value: candidate.id, label: candidate.name,
      })));
      const zoneName = zones.find((candidate) => candidate.id === zoneId)!.name;
      zone = zoneId;
      host = await prompter.text("Hostname", {
        initial: defaultHost(zoneName),
        validate: (value) => hostProblem(value, zoneName),
      });
    } else {
      host = await prompter.text("Hostname (in an active zone of this account)", { validate: hostnameProblem });
    }
    const records = zone
      ? await lookup(session, `DNS records for ${host}`, (client) => client.findDnsRecords(account.id, zone, host))
      : null;
    if (!records?.length) return { customDomain: host };
    ctx.out.log(
      `Warning: ${host} already has a DNS record (${records.map((record) => record.type ?? "?").join(", ")}). ` +
      "A Worker custom domain needs the hostname free; the deploy fails while that record exists.");
    if (!await prompter.confirm("Pick a different hostname?", true)) return { customDomain: host };
  }
}

/**
 * The Access step: reuse an application already covering the host, or offer to create one. Also
 * makes sure somebody can sign in at all. Returns the edits for issuer and audience, or none.
 */
async function setUpAccess(session: Session, target: AccessTarget): Promise<DeploymentEdit[]> {
  const { prompter, ctx, client } = session;
  if (!client) {
    ctx.out.log("cf is signed out, so Access was not set up. Sign in, then run `pnpm cfos access`.");
    return [];
  }
  const found = await lookupAccess(client, target);
  if (found.kind === "no-organization") {
    ctx.out.log(`${found.reason} Skipping Access for now: run \`pnpm cfos access\` once it exists.`);
    return [];
  }

  const providers = await lookup(session, "identity providers",
    (reader) => reader.listIdentityProviders(target.accountId));
  if (providers && !providers.length) {
    ctx.out.log("Warning: the Zero Trust organization has no identity providers, so nobody could sign in.");
    if (await prompter.confirm("Add a One-time PIN provider? Access emails each admin a sign-in code.", true)) {
      // Validated first, so a body the API would reject fails before anything is created.
      await client.dryRunCreateIdentityProvider(target.accountId, { ...ONE_TIME_PIN_PROVIDER });
      await client.createIdentityProvider(target.accountId, { ...ONE_TIME_PIN_PROVIDER });
      ctx.out.log("Added the One-time PIN identity provider.");
    }
  }

  if (found.kind === "found") {
    ctx.out.log(`Reusing Access application "${found.app.name}", which already covers ${target.host}.`);
    return accessEdits(found.issuer, found.app);
  }
  const choice = await prompter.select(`No Access application covers ${target.host} yet.`, [
    { value: "create" as const, label: "Create the application now", hint: `admits ${target.admins.join(", ")}` },
    { value: "skip" as const, label: "Skip", hint: "run `pnpm cfos access` later" },
  ]);
  if (choice === "skip") return [];
  const created = await createAccess(client, target, found.issuer);
  ctx.out.log(`Created Access application "${created.app.name}". To admit more people, edit its policy in ` +
    "the Zero Trust dashboard: Access > Applications.");
  return created.edits;
}

/** What a new deployment's flow ended in: its edits, or a switch to taking over instance `n`. */
type NewOutcome = { edits: DeploymentEdit[] } | { takeover: string };

async function newDeployment(session: Session, file: Record<string, unknown>): Promise<NewOutcome> {
  const { prompter, ctx, account } = session;
  const workers = await lookup<CfWorker[]>(session, "the account's Workers", (client) => client.listWorkers(account.id));
  const current = valueAtPath(file, ["workers", "router", "name"]);
  let suggested = typeof current === "string" && !isPlaceholder(current) ? current : "cloudflare-os";

  let name: string;
  for (;;) {
    name = await prompter.text("Base name: the router Worker's, and the root of every other Worker's", {
      initial: suggested,
      validate: baseNameProblem,
    });
    ctx.out.log(`Workers: ${Object.values(workerNames(name)).join(", ")}`);
    const taken = workers ? nameCollisions(name, workers) : [];
    if (!taken.length) break;
    ctx.out.log(`Already in the account: ${taken.join(", ")}. Deploying would overwrite them.`);
    if (workers && findInstances(workers).includes(name)) {
      const choice = await prompter.select(`"${name}" looks like a hosted instance.`, [
        { value: "takeover" as const, label: "It is mine: take it over", hint: "keeps its data" },
        { value: "rename" as const, label: "Pick another name" },
      ]);
      if (choice === "takeover") return { takeover: name };
    }
    suggested = `${name}-2`;
  }

  const route = await chooseRoute(session, name);
  const admins = parseAdmins(await prompter.text("Admin emails, comma-separated (they can open /admin)", {
    initial: session.email,
    validate: adminsProblem,
  }));

  const gateways = await lookup(session, "the account's AI Gateways", (client) => client.listAiGateways(account.id));
  const gateway = await prompter.select("Which AI Gateway serves the model catalog?",
    gatewayChoices(gateways ?? []).map((id) => ({
      value: id, label: id, ...(id === "default" ? { hint: "created on first use" } : {}),
    })), "default");
  const providers = await askProviders(session, file);
  const customGatekeeper = await askDisplay(session, file);

  const answers = { accountId: account.id, name, route, admins, aiGateway: { name: gateway, providers }, customGatekeeper };
  const edits = newDeploymentEdits(answers);
  edits.push(...await setUpAccess(session, newDeploymentAccessTarget(answers)));
  return { edits };
}

/** The model providers to advertise; the file's own choice is the default when it has one. */
async function askProviders(session: Session, file: Record<string, unknown>): Promise<AiGatewayProvider[]> {
  const current = valueAtPath(file, ["aiGateway", "providers"]);
  const initial = Array.isArray(current) && current.length &&
      current.every((provider) => PROVIDERS.includes(provider as AiGatewayProvider))
    ? current as AiGatewayProvider[] : ["cloudflare" as const];
  return session.prompter.multiselect("Which model providers?",
    PROVIDERS.map((provider) => ({ value: provider, label: provider, hint: PROVIDER_HINTS[provider] })),
    initial);
}

/** The example custom Gatekeeper's text: the file's own when set, else defaulted from the account's name. */
async function askDisplay(session: Session, file: Record<string, unknown>): Promise<{ name: string; message: string }> {
  const { prompter, account } = session;
  const accountName = account.name ?? (await lookup(session, "accounts",
    (client) => client.listAccounts()))?.find((candidate) => candidate.id === account.id)?.name;
  const fallback = defaultCustomGatekeeper(accountName);
  const current = (key: "name" | "message") => {
    const value = valueAtPath(file, ["customGatekeeper", key]);
    return typeof value === "string" && value && !isPlaceholder(value) ? value : undefined;
  };
  const name = await prompter.text("Organization name the example custom Gatekeeper shows agents",
    { initial: current("name") ?? fallback.name });
  const message = await prompter.text("What it tells agents",
    { initial: current("message") ?? defaultCustomGatekeeper(name).message });
  return { name, message };
}

async function takeover(session: Session, file: Record<string, unknown>, chosen?: string): Promise<DeploymentEdit[] | null> {
  const { prompter, ctx, account } = session;
  const client = session.client!;
  const instance = chosen ?? await pickInstance(ctx, client, account.id, "pnpm cfos import --account <id>");
  if (!instance) return null;
  const discovery = discover(instance, await fetchInventory(client, account.id));
  ctx.out.log(`Hosted instance "${instance}" in account ${account.id}:\n\n${formatReport(instance, discovery)}\n`);
  if (!discovery.edits.length) {
    ctx.out.log("Nothing matched; nothing to write. Check the instance name against the Worker list.");
    return null;
  }

  const names = workerNames(instance);
  const fileAdmins = valueAtPath(file, ["access", "admins"]);
  const adminDefault = Array.isArray(fileAdmins) && !adminsProblem(fileAdmins.join(","))
    ? fileAdmins.join(", ") : session.email;
  const hasWebsearch = discovery.rows.some((row) => row.path === "workers.websearch.name" && row.found);
  const answers = {
    admins: parseAdmins(await prompter.text("Admin emails, comma-separated (they can open /admin)", {
      initial: adminDefault, validate: adminsProblem,
    })),
    websearch: hasWebsearch ? undefined : await prompter.text(
      "Web Search Gatekeeper Worker name (the instance has none; the deploy creates it)",
      { initial: names.websearch, validate: workerNameProblem }),
    customGatekeeper: await prompter.text("Custom Gatekeeper Worker name",
      { initial: names.customGatekeeper, validate: workerNameProblem }),
    errorReporter: await prompter.text("Error Reporter Worker name",
      { initial: names.errorReporter, validate: workerNameProblem }),
    providers: await askProviders(session, file),
    display: await askDisplay(session, file),
  };
  const edits = [...discovery.edits, ...takeoverEdits(answers)];
  if (!discovery.edits.some((edit) => edit.path.join(".") === "access.audience")) {
    ctx.out.log("No Access application was found for this instance. After writing, `pnpm cfos access` " +
      "finds or creates one for its hostname.");
  }
  return edits;
}

/**
 * What to do after writing: deploy, or first fill in what is still a placeholder. `cfos deploy`
 * runs every check `cfos check` does before it deploys anything, so it is the one next step.
 */
export function nextStep(file: Record<string, unknown>, where: string, configFlag: string): string {
  const left = placeholderPaths(file);
  if (!left.length) return `Next: \`pnpm cfos deploy${configFlag}\`.`;
  const access = left.filter((path) => path.startsWith("access."));
  const other = left.filter((path) => !path.startsWith("access."));
  return [
    `Still placeholders in ${where}:`,
    ...left.map((path) => `  ${path}`),
    ...access.length ? [`\`pnpm cfos access${configFlag}\` fills ${access.join(" and ")}.`] : [],
    ...other.length ? [`Fill in ${other.length === 1 ? "that one" : "the rest"} by hand.`] : [],
    `Then: \`pnpm cfos deploy${configFlag}\`.`,
  ].join("\n");
}

/** `cfos init`, inside a project. */
export async function run(args: CommandArgs, ctx: Context): Promise<number> {
  if (args.positionals[0]) {
    throw new UsageError(`You are inside a project already (${ctx.root}), so init configures it. To ` +
      "create another, run `cfos init <dir>` from outside this one.");
  }
  if (args.values.template || args.values.ref) {
    throw new UsageError("--template and --ref only apply when creating a project.");
  }
  if (!ctx.prompter) {
    ctx.out.log(NO_TERMINAL);
    return 1;
  }
  const prompter = ctx.prompter;
  const inPath = configPath(ctx);
  const where = displayPath(ctx, inPath);
  const out = args.values.out as string | undefined;
  const outPath = out ? resolve(ctx.cwd, out) : inPath;
  const file = parseDeployment(await readFile(inPath, "utf8"), where);

  let client: CloudflareClient | null = await ctx.client();
  let email: string | undefined;
  try {
    const who = await client.whoami();
    email = who.email;
    if (!who.authenticated) client = null;
  } catch (error) {
    if (!(error instanceof CfError || error instanceof CfAuthError)) throw error;
    client = null;
  }
  if (!client) {
    ctx.out.log("cf is not signed in, so nothing can be looked up in your account: you will type the " +
      "values, and Access is left for later. To sign in first: `pnpm exec cf auth login`.\n");
  }

  const account = await chooseAccount(ctx, prompter, client, file, where);
  const session: Session = { ctx, prompter, client, account, email };

  let instances: string[] = [];
  if (client) {
    instances = findInstances(await lookup(session, "the account's Workers",
      (reader) => reader.listWorkers(account.id)) ?? []);
  }
  const mode = client
    ? await prompter.select("What are you setting up?", [
      { value: "new" as const, label: "A new deployment" },
      {
        value: "takeover" as const, label: "Take over a hosted instance",
        hint: `${instances.length} in this account`,
      },
    ])
    : "new";

  let edits: DeploymentEdit[] | null;
  if (mode === "takeover") {
    edits = await takeover(session, file);
  } else {
    const outcome = await newDeployment(session, file);
    edits = "takeover" in outcome ? await takeover(session, file, outcome.takeover) : outcome.edits;
  }
  if (!edits) return 1;
  if (account.isNew && !edits.some((edit) => edit.path[0] === "accountId")) {
    edits.unshift({ path: ["accountId"], value: account.id });
  }

  const outWhere = displayPath(ctx, outPath);
  ctx.out.log(`\n${outWhere} values:\n${JSON.stringify(editsAsFragment(edits), null, 2)}`);
  await updateDeployment(inPath, edits, outPath);
  ctx.out.log(`\nWrote ${edits.length} values to ${outWhere}, comments intact.`);
  ctx.out.log(nextStep(parseDeployment(await readFile(outPath, "utf8"), outWhere),
    outWhere, outPath === inPath ? "" : ` --config ${outWhere}`));
  return 0;
}
