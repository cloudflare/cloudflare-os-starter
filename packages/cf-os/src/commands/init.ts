// `cf-os init [--out <path>]`, inside a project
//
// Configures the deployment file by asking: which account, then either a new deployment or the
// takeover of an instance the hosted deploy created. Every answer has a default read from the
// account where `cf` can see it (zones, gateways, the signed-in email, the workers.dev subdomain),
// and every step's logic is core/wizard.ts; this file asks and looks things up.
//
// Once the file is complete it offers to deploy, running `cf-os deploy` itself, so a project goes
// from clone to running in one command. It offers the `cf` sign-in up front and Wrangler's before
// the deploy: a project cloned by hand never passed through scaffolding, which used to offer them.
//
// It offers the optional Gatekeepers the submodule's catalog holds (gatekeeper-catalog.ts) beside the
// example custom one. An OAuth Gatekeeper's credentials are asked for, masked, once the deploy is
// agreed to, and travel in memory to `cf-os deploy`, which sets them once every Worker has deployed
// (gatekeeper-secrets.ts); one whose Worker the account already runs is asked about, and its
// secrets set, before the deploy question. Declined, each is left to `cf-os secrets`.
//
// Until the file is written, Esc goes back to the previous question (back.ts). Going back runs the
// questions before it again, with the reads between them, which a cache answers; so nothing is
// created before the last question: the Access step asks both its questions first.
//
// Interactive only. Without a terminal it refuses, pointing at `import` and `access`, which take
// every answer as a flag or from the file. Signed out of `cf`, it still runs: the account-aware
// steps become typed answers, and Access is left for `cf-os access`.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withBack } from "../back.ts";
import { configPath, displayPath, UsageError, type CommandArgs, type Context } from "../context.ts";
import {
  accessEdits,
  createAccess,
  lookupAccess,
  ONE_TIME_PIN_PROVIDER,
  type AccessTarget,
} from "../core/access.ts";
import { CfAuthError, CfError, type CloudflareClient, type CfWorker } from "../core/client.ts";
import { fetchInventory, type FoundGatekeeper } from "../core/discovery.ts";
import { isPlaceholder, placeholderPaths, valueAtPath, type DeploymentEdit } from "../core/edits.ts";
import { publicOrigin } from "../core/deployment.ts";
import type { AiGatewayProvider, DeploymentConfig } from "../core/deployment-config.ts";
import { secretSetup, UNDECLARED_VARS, type GatekeeperCatalog } from "../core/gatekeepers.ts";
import { baseNameProblem, findInstances, gatekeeperWorkerName, WORKER_NAME, workerNames } from "../core/naming.ts";
import {
  adminsProblem,
  CUSTOM_GATEKEEPER_CHOICE,
  defaultCustomGatekeeper,
  defaultHost,
  describeEdits,
  gatekeeperHint,
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
import { loadCatalog } from "../gatekeeper-catalog.ts";
import { askAndSetSecrets, secretsCommand, type PendingSecrets } from "../gatekeeper-secrets.ts";
import type { Prompter } from "../prompt.ts";
import { defaultSpawn, succeeded, type SpawnTool } from "../tools.ts";
import { accountFlag, resolveAccount, type ResolvedAccount } from "./account.ts";
import { discoverInstance, formatReport, pickInstance } from "./import.ts";

const accountIdPattern = /^[a-f\d]{32}$/i;

/** What a printed redirect URI holds in place of a public origin nobody has settled yet. */
const UNKNOWN_ORIGIN = "<PUBLIC_ORIGIN>";

/** Without a terminal, what to run instead. */
export const NO_TERMINAL =
  "cf-os init asks questions, and there is no terminal to ask them at. Without one, take over a " +
  "hosted instance with `pnpm cf-os import <instance> --account <id> --out deployment.jsonc`, or " +
  "edit deployment.jsonc by hand: optional Gatekeepers are entries in `gatekeepers`, and " +
  "`customGatekeeper.enabled: false` drops the example custom one; an MCP portal needs " +
  "`gatekeepers.mcpportal.vars.MCP_PORTAL_URL`. Then `pnpm cf-os access` sets up Access.";

/** What init runs besides `cf` lookups, so tests can record it instead. */
export interface InitDeps {
  /** The sign-ins, Wrangler's status, and `wrangler secret bulk`. */
  spawn: SpawnTool;
  /**
   * `cf-os deploy` against `ctx`, setting `secrets` on their Workers once it has deployed them.
   * Resolves to its exit code.
   */
  deploy(ctx: Context, options?: { secrets?: PendingSecrets[] }): Promise<number>;
  /** The optional Gatekeepers the project at `root` offers. */
  catalog(root: string): Promise<GatekeeperCatalog>;
}

export function defaultDeps(): InitDeps {
  return {
    spawn: defaultSpawn(),
    catalog: loadCatalog,
    deploy: async (ctx, options) => {
      const { run: deploy } = await import("./deploy.ts");
      return deploy({ command: "deploy", values: {}, positionals: [] }, ctx, options);
    },
  };
}

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

/** The client methods that only read, which {@link cachedReads} answers a second time from memory. */
const READ = /^(whoami|list|find|get|workersDevSubdomain)/;

/**
 * `client`, each read answered once per method and arguments, its failure included. Going back a
 * question runs every question before it again, with the reads between them; those then cost no `cf`
 * call. Anything else, a create or its dry run, goes straight through.
 */
function cachedReads(client: CloudflareClient): CloudflareClient {
  const cache = new Map<string, unknown>();
  return new Proxy(client, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof key !== "string" || typeof value !== "function") return value;
      const method = value.bind(target) as (...args: unknown[]) => unknown;
      if (!READ.test(key)) return method;
      return (...args: unknown[]) => {
        const id = `${key} ${JSON.stringify(args)}`;
        if (!cache.has(id)) cache.set(id, method(...args));
        return cache.get(id);
      };
    },
  });
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
      rerun: "pnpm cf-os init --account <id>",
      where,
    });
    if (!account) throw new Error("No account to configure.");
    return account;
  }
  const fromFile = valueAtPath(file, ["accountId"]);
  const flag = accountFlag(ctx);
  if (flag !== undefined) return { id: flag, isNew: true };
  if (typeof fromFile === "string" && accountIdPattern.test(fromFile)) return { id: fromFile, isNew: false };
  const id = await prompter.text("Cloudflare account ID", {
    validate: (value) => accountIdPattern.test(value) ? undefined : "32 hexadecimal characters.",
  });
  return { id, isNew: true };
}

/** The router's address: a hostname in one of the account's zones, or workers.dev. */
async function chooseRoute(session: Session, name: string): Promise<RouteChoice> {
  const { prompter, ctx, account } = session;
  let kind = await prompter.select("Where will people reach it?", [
    { value: "custom" as const, label: "A custom domain", hint: "a hostname in one of your zones" },
    { value: "workersDev" as const, label: "workers.dev", hint: `https://${name}.<subdomain>.workers.dev` },
  ]);
  const zones = kind === "custom"
    ? await lookup(session, "the account's zones", (client) => client.listZones(account.id))
    : null;
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
  const { ctx, client } = session;
  if (!client) {
    ctx.out.log("cf is signed out, so Access was not set up. Sign in, then run `pnpm cf-os access`.");
    return [];
  }
  // Access is the one step `cf-os access` can redo alone, so a failure here leaves it for that rather
  // than losing every other answer: the file is still written, with the access fields left to fill.
  try {
    return await accessEditsFor(session, client, target);
  } catch (error) {
    if (!(error instanceof CfAuthError || error instanceof CfError)) throw error;
    ctx.out.log(`Access was not set up: ${error.message}\nFix that, then run \`pnpm cf-os access\`.`);
    return [];
  }
}

async function accessEditsFor(session: Session, client: CloudflareClient, target: AccessTarget): Promise<DeploymentEdit[]> {
  const { prompter, ctx } = session;
  const found = await lookupAccess(client, target);
  if (found.kind === "no-organization") {
    ctx.out.log(`${found.reason} Skipping Access for now: run \`pnpm cf-os access\` once it exists.`);
    return [];
  }

  const providers = await lookup(session, "identity providers",
    (reader) => reader.listIdentityProviders(target.accountId));
  let addPin = false;
  if (providers && !providers.length) {
    ctx.out.log("Warning: the Zero Trust organization has no identity providers, so nobody could sign in.");
    addPin = await prompter.confirm("Add a One-time PIN provider? Access emails each admin a sign-in code.", true);
  }
  // After the step's last question, so going back never steps over a provider already created.
  const addProvider = async () => {
    if (!addPin) return;
    // Validated first, so a body the API would reject fails before anything is created.
    await client.dryRunCreateIdentityProvider(target.accountId, { ...ONE_TIME_PIN_PROVIDER });
    await client.createIdentityProvider(target.accountId, { ...ONE_TIME_PIN_PROVIDER });
    ctx.out.log("Added the One-time PIN identity provider.");
  };

  if (found.kind === "found") {
    await addProvider();
    ctx.out.log(`Reusing Access application "${found.app.name}", which already covers ${target.host}.`);
    return accessEdits(found.issuer, found.app);
  }
  const { wildcard } = found;
  const choice = await prompter.select(wildcard
    ? `Access application "${wildcard.name}" covers ${target.host} with a wildcard, under a policy of its own.`
    : `No Access application covers ${target.host} yet.`, [
    {
      value: "create" as const,
      label: wildcard ? `Create one for ${target.host}` : "Create the application now",
      hint: `admits ${target.admins.join(", ")}${wildcard ? `, ahead of "${wildcard.name}"` : ""}`,
    },
    ...wildcard
      ? [{ value: "reuse" as const, label: `Use "${wildcard.name}"`, hint: "its policy decides who gets in" }]
      : [],
    { value: "skip" as const, label: "Skip", hint: "run `pnpm cf-os access` later" },
  ]);
  await addProvider();
  if (choice === "skip") return [];
  if (choice === "reuse" && wildcard) {
    ctx.out.log(`Using Access application "${wildcard.name}". Its policy, not access.admins, decides who gets in.`);
    return accessEdits(found.issuer, wildcard);
  }
  const created = await createAccess(client, target, found.issuer);
  ctx.out.log(`Created Access application "${created.app.name}". To admit more people, edit its policy in ` +
    "the Zero Trust dashboard: Access > Applications.");
  return created.edits;
}

/**
 * What a flow ended in: the edits, and the optional Gatekeepers whose Workers the account already
 * runs, which keep their secrets.
 */
interface Configured {
  edits: DeploymentEdit[];
  live: FoundGatekeeper[];
  /**
   * Whether the edits settle the public origin. A takeover whose discovery found none leaves the
   * file's route as it was, the template's example domain included, so no redirect URI can be
   * trusted from it.
   */
  originFound: boolean;
}

/** What a new deployment's flow ended in: its edits, or a switch to taking over instance `n`. */
type NewOutcome = Configured | { takeover: string };

async function newDeployment(session: Session, file: Record<string, unknown>, catalog: GatekeeperCatalog): Promise<NewOutcome> {
  const { prompter, ctx, account } = session;
  const current = valueAtPath(file, ["workers", "router", "name"]);
  let suggested = typeof current === "string" && !isPlaceholder(current) ? current : "cloudflare-os";

  let name: string;
  // Listed once a name is typed, to check it against: undefined until then, null if it failed.
  let workers: CfWorker[] | null | undefined;
  for (;;) {
    name = await prompter.text("Base name: the router Worker's, and the root of every other Worker's", {
      initial: suggested,
      validate: baseNameProblem,
    });
    ctx.out.log(`Workers: ${Object.values(workerNames(name)).join(", ")}`);
    workers ??= await lookup<CfWorker[]>(session, "the account's Workers", (client) => client.listWorkers(account.id));
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
  const listed = gatekeepersIn(file);
  const choice = await askGatekeepers(session, catalog, [
    ...valueAtPath(file, ["customGatekeeper", "enabled"]) === false ? [] : [CUSTOM_GATEKEEPER_CHOICE],
    ...listed,
  ]);
  const customGatekeeper = choice.custom ? await askDisplay(session, file) : null;
  const gatekeepers = await nameGatekeepers(session, workers, name, choice.slugs);

  const answers = {
    accountId: account.id, name, route, admins, aiGateway: { name: gateway, providers }, customGatekeeper,
    gatekeepers, removedGatekeepers: deselected(listed, choice, catalog),
  };
  const edits = [...newDeploymentEdits(answers), ...await askUndeclaredVars(session, file, choice.slugs)];
  edits.push(...await setUpAccess(session, newDeploymentAccessTarget(answers)));
  return { edits, live: [], originFound: true };
}

/** The slugs the file's `gatekeepers` block lists. */
function gatekeepersIn(file: Record<string, unknown>): string[] {
  const block = valueAtPath(file, ["gatekeepers"]);
  return block && typeof block === "object" && !Array.isArray(block) ? Object.keys(block) : [];
}

/**
 * The optional Gatekeepers the account already runs for instance `n`: the `<n>-gk-<slug>` Workers
 * `discovered` for it and, when the file is this deployment's (its `workers.router.name` is `n`, as
 * on a rerun after a deploy), the file's `gatekeepers` entries whose Worker exists, under whatever
 * name it has. A file for another router may be another deployment's in the same account, and
 * binding the Workers it names would deploy over that deployment's Gatekeepers, so its entries are
 * left out. Where the file and discovery name different Workers for one slug, the file may name a
 * Worker renamed by hand, so the operator picks; `passedOver` holds the instance's Worker when it is
 * not picked, which loses its binding as a deselected one does.
 */
async function liveGatekeepers(
  session: Session,
  n: string,
  file: Record<string, unknown>,
  workers: CfWorker[],
  catalog: GatekeeperCatalog,
  discovered: FoundGatekeeper[],
): Promise<{ found: FoundGatekeeper[]; passedOver: FoundGatekeeper[] }> {
  const running = gatekeepersIn(file).flatMap((slug) => {
    const name = valueAtPath(file, ["gatekeepers", slug, "name"]);
    return typeof name === "string" && catalog.offered.some((entry) => entry.slug === slug) &&
        workers.some((worker) => worker.name === name)
      ? [{ slug, name }] : [];
  });
  const router = valueAtPath(file, ["workers", "router", "name"]);
  const fromFile = router === n ? running : [];
  const foreign = running.filter(({ name }) => !discovered.some((gatekeeper) => gatekeeper.name === name));
  if (router !== n && foreign.length) {
    session.ctx.out.log(`The file's workers.router.name is not ${n}, so the Gatekeeper Workers its gatekeepers ` +
      `block names may be another deployment's, and are left alone: ${foreign.map(({ name }) => name).join(", ")}.`);
  }
  const found: FoundGatekeeper[] = [];
  const passedOver: FoundGatekeeper[] = [];
  for (const own of fromFile) {
    const instance = discovered.find(({ slug, name }) => slug === own.slug && name !== own.name);
    if (!instance) {
      found.push(own);
      continue;
    }
    session.ctx.out.log(`The file names ${own.name} as the ${own.slug} Gatekeeper's Worker, but the instance runs ` +
      `${instance.name}. Each holds its own users' connections and OAuth secrets, and the deploy binds only one.`);
    const name = await session.prompter.select(`Which Worker is this deployment's ${own.slug} Gatekeeper?`, [
      { value: instance.name, label: instance.name, hint: "the instance's" },
      { value: own.name, label: own.name, hint: `gatekeepers.${own.slug}.name in the file` },
    ], instance.name);
    found.push({ slug: own.slug, name });
    if (name !== instance.name) passedOver.push(instance);
  }
  return {
    found: [...found, ...discovered.filter(({ slug }) => !found.some((gatekeeper) => gatekeeper.slug === slug))],
    passedOver,
  };
}

/**
 * The example custom Gatekeeper's Worker the account runs for instance `n`, if any: the file's
 * `workers.customGatekeeper.name` when the file is this deployment's (its `workers.router.name` is
 * `n`), else `<n>-gk-custom`. None when that file deploys no custom Gatekeeper, as nothing binds it.
 * Leaving the custom Gatekeeper out unbinds this Worker, with its Durable Object's state.
 */
function liveCustomGatekeeper(file: Record<string, unknown>, n: string, workers: CfWorker[]): string[] {
  const own = valueAtPath(file, ["workers", "router", "name"]) === n;
  if (own && valueAtPath(file, ["customGatekeeper", "enabled"]) === false) return [];
  const name = fileCustomGatekeeper(file, n) ?? workerNames(n).customGatekeeper;
  return workers.some((worker) => worker.name === name) ? [name] : [];
}

/**
 * The custom Gatekeeper's Worker name the file gives instance `n`: its `workers.customGatekeeper.name`
 * when the file is this deployment's (its `workers.router.name` is `n`) and the name is filled in.
 */
function fileCustomGatekeeper(file: Record<string, unknown>, n: string): string | undefined {
  if (valueAtPath(file, ["workers", "router", "name"]) !== n) return undefined;
  const named = valueAtPath(file, ["workers", "customGatekeeper", "name"]);
  return typeof named === "string" && !isPlaceholder(named) ? named : undefined;
}

/** What the Gatekeeper question settled. */
interface GatekeeperChoice {
  /** Whether the example custom Gatekeeper is deployed. */
  custom: boolean;
  /** The optional Gatekeepers chosen, in catalog order. */
  slugs: string[];
}

/**
 * Which Gatekeepers beyond the three always deployed: the example custom one, and whichever optional
 * ones the catalog offers. `initial` is preselected where it names a choice. None at all is an
 * answer.
 */
async function askGatekeepers(session: Session, catalog: GatekeeperCatalog, initial: string[]): Promise<GatekeeperChoice> {
  if (catalog.unavailable) {
    session.ctx.out.log(`The Gatekeeper catalog could not be read, so only the example custom Gatekeeper is offered: ${catalog.unavailable}`);
  }
  const choices = [
    { value: CUSTOM_GATEKEEPER_CHOICE, label: CUSTOM_GATEKEEPER_CHOICE, hint: "the example in packages/custom-gatekeeper" },
    ...catalog.offered.map((entry) => ({ value: entry.slug, label: entry.slug, hint: gatekeeperHint(entry) })),
  ];
  const chosen = await session.prompter.multiselect(
    "Which Gatekeepers? Context, Scheduler and Web Search are always deployed; /admin turns each off.",
    choices, initial.filter((value) => choices.some((choice) => choice.value === value)), { required: false });
  return {
    custom: chosen.includes(CUSTOM_GATEKEEPER_CHOICE),
    slugs: catalog.offered.map((entry) => entry.slug).filter((slug) => chosen.includes(slug)),
  };
}

/**
 * The slugs `listed` in the file that were offered and not chosen, whose entries go. One the catalog
 * does not offer was never a choice, so it stays for `cf-os check` to report.
 */
function deselected(listed: string[], choice: GatekeeperChoice, catalog: GatekeeperCatalog): string[] {
  return listed.filter((slug) => catalog.offered.some((entry) => entry.slug === slug) && !choice.slugs.includes(slug));
}

/**
 * Worker names for the optional Gatekeepers `slugs`: the instance's own Worker when `live` has one,
 * else `<n>-gk-<slug>`, which is asked about only when the account already has a Worker by that name
 * or it is too long to be one.
 */
async function nameGatekeepers(
  session: Session,
  workers: CfWorker[] | null,
  n: string,
  slugs: string[],
  live: FoundGatekeeper[] = [],
): Promise<Record<string, string>> {
  const taken = new Set(workers ? nameCollisions(n, workers, slugs) : []);
  const names: Record<string, string> = {};
  for (const slug of slugs) {
    const found = live.find((gatekeeper) => gatekeeper.slug === slug);
    if (found) {
      names[slug] = found.name;
      continue;
    }
    const name = gatekeeperWorkerName(n, slug);
    const tooLong = baseNameProblem(n, [slug]);
    if (tooLong) session.ctx.out.log(`${name} cannot be the ${slug} Gatekeeper's Worker name. ${tooLong}`);
    names[slug] = taken.has(name) || tooLong
      ? await askNewWorker(session, workers ?? [], `${slug} Gatekeeper Worker name`, name)
      : name;
  }
  return names;
}

/**
 * The {@link UNDECLARED_VARS} the Gatekeepers `slugs` need that the file does not set usably, asked
 * for. One the account already runs is asked too: a deploy replaces its plain vars, and discovery
 * cannot read the value it has. Left empty, the file keeps what it has, for `cf-os check` to warn about.
 */
async function askUndeclaredVars(session: Session, file: Record<string, unknown>, slugs: string[]): Promise<DeploymentEdit[]> {
  const edits: DeploymentEdit[] = [];
  for (const slug of slugs) {
    for (const input of UNDECLARED_VARS[slug] ?? []) {
      const path = ["gatekeepers", slug, "vars", input.name];
      const current = valueAtPath(file, path);
      if (typeof current === "string" && current.trim()) {
        const problem = input.problem(current);
        if (!problem) continue;
        session.ctx.out.log(`${path.join(".")} is ${current}, which the Gatekeeper cannot use. ${problem}`);
      }
      const value = (await session.prompter.text(
        `The ${slug} Gatekeeper's ${input.label} (${path.join(".")}); empty to set it later, the Gatekeeper hidden until then`,
        { validate: (text) => text.trim() ? input.problem(text) : undefined },
      )).trim();
      if (value) edits.push({ path, value });
    }
  }
  return edits;
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

/**
 * The name of a Worker a takeover adds, which the instance does not have yet. One the account
 * already has is this deployment's only if the operator says so (a rerun after a deploy), or if it
 * is `own`, the name this deployment's file already gives it; otherwise deploying would overwrite
 * another application's Worker, so it asks again.
 */
async function askNewWorker(
  session: Session,
  workers: CfWorker[],
  question: string,
  initial: string,
  own?: string,
): Promise<string> {
  const { prompter, ctx } = session;
  for (;;) {
    const name = await prompter.text(question, { initial, validate: workerNameProblem });
    if (name === own || !workers.some((worker) => worker.name === name)) return name;
    ctx.out.log(`Already in the account: ${name}. Deploying would overwrite it.`);
    if (await prompter.confirm(`Is ${name} this deployment's own, to deploy over?`, false)) return name;
    initial = name;
  }
}

async function takeover(
  session: Session,
  file: Record<string, unknown>,
  catalog: GatekeeperCatalog,
  chosen?: string,
): Promise<Configured | null> {
  const { prompter, ctx, account } = session;
  const client = session.client!;
  const instance = chosen ?? await pickInstance(ctx, client, account.id, "pnpm cf-os import --account <id>");
  if (!instance) return null;
  const inventory = await fetchInventory(client, account.id);
  const discovery = discoverInstance(instance, inventory, catalog);
  ctx.out.log(`Hosted instance "${instance}" in account ${account.id}:\n\n${formatReport(instance, discovery)}\n`);
  if (!discovery.matched) {
    ctx.out.log("Nothing matched; nothing to write. Check the instance name against the Worker list.");
    return null;
  }

  const names = workerNames(instance);
  const fileAdmins = valueAtPath(file, ["access", "admins"]);
  const adminDefault = Array.isArray(fileAdmins) && !adminsProblem(fileAdmins.join(","))
    ? fileAdmins.join(", ") : session.email;
  const hasWebsearch = discovery.rows.some((row) => row.path === "workers.websearch.name" && row.found);
  const admins = parseAdmins(await prompter.text("Admin emails, comma-separated (they can open /admin)", {
    initial: adminDefault, validate: adminsProblem,
  }));
  const websearch = hasWebsearch ? undefined : await askNewWorker(session, inventory.workers,
    "Web Search Gatekeeper Worker name (the instance has none; the deploy creates it)", names.websearch);
  const { found, passedOver } = await liveGatekeepers(session, instance, file, inventory.workers, catalog, discovery.foundGatekeepers);
  const choice = await askGatekeepers(session, catalog, [CUSTOM_GATEKEEPER_CHOICE, ...found.map(({ slug }) => slug)]);
  const liveCustom = liveCustomGatekeeper(file, instance, inventory.workers);
  const unbinds = (name: string) => ctx.out.log(`Warning: leaving out ${name} removes its binding, so it ` +
    "disappears from the app along with every user's connection to it. The Worker keeps running; " +
    `\`CLOUDFLARE_ACCOUNT_ID=${account.id} pnpm exec wrangler delete --name ${name}\` removes it.`);
  [...passedOver, ...found.filter(({ slug }) => !choice.slugs.includes(slug))].forEach(({ name }) => unbinds(name));
  if (!choice.custom) liveCustom.forEach(unbinds);
  // A rerun keeps the custom Gatekeeper on the Worker the file names, which holds its users' connections.
  const ownCustom = liveCustom.find((name) => name === fileCustomGatekeeper(file, instance));
  const customWorker = choice.custom
    ? await askNewWorker(session, inventory.workers, "Custom Gatekeeper Worker name",
      ownCustom ?? names.customGatekeeper, ownCustom)
    : undefined;
  if (customWorker) liveCustom.filter((name) => name !== customWorker).forEach(unbinds);
  const errorReporter = await askNewWorker(session, inventory.workers, "Error Reporter Worker name", names.errorReporter);
  const providers = await askProviders(session, file);
  const display = choice.custom ? await askDisplay(session, file) : undefined;
  const live = found.filter(({ slug }) => choice.slugs.includes(slug));
  const answers = {
    admins, websearch, errorReporter, providers,
    customGatekeeper: customWorker && display ? { worker: customWorker, display } : null,
    gatekeepers: await nameGatekeepers(session, inventory.workers, instance, choice.slugs, live),
    removedGatekeepers: deselected(gatekeepersIn(file), choice, catalog),
  };
  // takeoverEdits records the Gatekeepers chosen, found or not; discovery's are only what it found.
  const edits = [
    ...discovery.edits.filter((edit) => edit.path[0] !== "gatekeepers"),
    ...takeoverEdits(answers),
    ...await askUndeclaredVars(session, file, choice.slugs),
  ];
  if (!discovery.edits.some((edit) => edit.path.join(".") === "access.audience")) {
    ctx.out.log("No Access application was found for this instance. After writing, `pnpm cf-os access` " +
      "finds or creates one for its hostname.");
  }
  const originFound = discovery.edits.some((edit) => edit.path.join(".") === "workers.router.route");
  return { edits, live, originFound };
}

/** An optional Gatekeeper the written file selects and the catalog offers. */
interface Selected {
  slug: string;
  worker: string;
  /** Whether the account already runs its Worker, which keeps its secrets. */
  live: boolean;
  /** Whether it reads OAuth secrets. */
  oauth: boolean;
}

/** The optional Gatekeepers `config` selects that `catalog` offers, `live` marking those the account runs. */
function selectedGatekeepers(config: DeploymentConfig, catalog: GatekeeperCatalog, live: FoundGatekeeper[]): Selected[] {
  return Object.entries(config.gatekeepers ?? {}).flatMap(([slug, entry]) => {
    const offered = catalog.offered.find((candidate) => candidate.slug === slug);
    return offered && typeof entry?.name === "string"
      ? [{ slug, worker: entry.name, live: live.some((found) => found.slug === slug), oauth: offered.secrets.length > 0 }]
      : [];
  });
}

/**
 * What a Gatekeeper `selected` lists the account already runs keeps, and what it loses: it keeps the
 * secrets it has, which a deploy leaves alone, but not plain vars set outside
 * `gatekeepers.<slug>.vars`, which a deploy replaces. An OAuth one's redirect URI follows the public
 * origin, so it is printed too, for an instance that moves hostname. Without `originFound`,
 * {@link UNKNOWN_ORIGIN} stands in for the origin, here and in {@link reportSecretsLater}.
 */
function reportLiveGatekeepers(
  ctx: Context,
  config: DeploymentConfig,
  where: string,
  catalog: GatekeeperCatalog,
  selected: Selected[],
  originFound: boolean,
): void {
  const origin = originFound ? publicOrigin(config) : UNKNOWN_ORIGIN;
  if (!originFound && selected.some(({ oauth }) => oauth)) {
    ctx.out.log(`\nNo public origin was found for the instance, so ${UNKNOWN_ORIGIN} stands for it below. ` +
      `Set workers.router.route and publicBaseUrl in ${where}, then register each redirect URI with the ` +
      "real origin in its place.");
  }
  for (const { slug, worker, oauth } of selected.filter(({ live }) => live)) {
    ctx.out.log(`\n${worker} already runs in the account and keeps its secrets: a deploy leaves them as they are. ` +
      "It does replace the Worker's plain vars, with the package's own, BASE_URL and " +
      `gatekeepers.${slug}.vars: copy any the Worker relies on (GITLAB_URL for a self-managed GitLab, ` +
      `MCP_PORTAL_URL for an MCP portal) into gatekeepers.${slug}.vars before deploying.` +
      (oauth
        ? ` Its OAuth app must list ${redirectUri(catalog, slug, worker, origin, config.accountId)} as a ` +
          "redirect URI, which follows the public origin: if the instance moves hostname, add the new one."
        : ""));
  }
}

/** The redirect URI Gatekeeper `slug`'s OAuth app registers (core/gatekeepers.ts `secretSetup`). */
function redirectUri(catalog: GatekeeperCatalog, slug: string, worker: string, origin: string, accountId: string): string {
  const entry = catalog.offered.find((candidate) => candidate.slug === slug)!;
  return secretSetup(entry, slug, worker, origin, accountId).redirectUri;
}

/**
 * For each new OAuth Gatekeeper in `selected`, when nothing is deployed now: one line naming
 * `cf-os secrets`, which sets its credentials once the deploy has created its Worker.
 */
function reportSecretsLater(
  ctx: Context,
  config: DeploymentConfig,
  catalog: GatekeeperCatalog,
  selected: Selected[],
  originFound: boolean,
): void {
  const origin = originFound ? publicOrigin(config) : UNKNOWN_ORIGIN;
  for (const { slug, worker } of selected.filter(({ live, oauth }) => oauth && !live)) {
    ctx.out.log(`\nAfter deploying, \`${secretsCommand(ctx, slug)}\` sets the ${slug} Gatekeeper's OAuth credentials ` +
      `(redirect URI: ${redirectUri(catalog, slug, worker, origin, config.accountId)}).`);
  }
}

/**
 * {@link askAndSetSecrets} for `slugs`, each failure reported with the `cf-os secrets` command that
 * tries again. Resolves to the values entered for a `"deferred"` upload, which never leave memory,
 * and the Gatekeepers whose credentials could not be set, which make init exit 1.
 */
async function askSecrets(
  ctx: Context,
  deps: InitDeps,
  config: DeploymentConfig,
  catalog: GatekeeperCatalog,
  slugs: string[],
  upload: "now" | "deferred",
  originFound: boolean,
): Promise<{ pending: PendingSecrets[]; failed: string[] }> {
  if (!slugs.length) return { pending: [], failed: [] };
  const origin = originFound ? publicOrigin(config) : UNKNOWN_ORIGIN;
  const outcome = await askAndSetSecrets(ctx, { prompter: ctx.prompter, client: await ctx.client(), spawn: deps.spawn },
    { config, catalog, slugs, upload, origin });
  return { pending: outcome.pending, failed: outcome.failed };
}

/**
 * What to do after writing: deploy, or first fill in what is still a placeholder. `cf-os deploy`
 * runs every check `cf-os check` does before it deploys anything, so it is the one next step.
 */
export function nextStep(file: Record<string, unknown>, where: string, configFlag: string): string {
  const left = placeholderPaths(file);
  if (!left.length) return `Next: \`pnpm cf-os deploy${configFlag}\`.`;
  const access = left.filter((path) => path.startsWith("access."));
  const other = left.filter((path) => !path.startsWith("access."));
  return [
    `Still placeholders in ${where}:`,
    ...left.map((path) => `  ${path}`),
    ...access.length ? [`\`pnpm cf-os access${configFlag}\` fills ${access.join(" and ")}.`] : [],
    ...other.length ? [`Fill in ${other.length === 1 ? "that one" : "the rest"} by hand.`] : [],
    `Then: \`pnpm cf-os deploy${configFlag}\`.`,
  ].join("\n");
}

/** The `cf` client when signed in, with the signed-in email; null when signed out or unreachable. */
async function signedIn(ctx: Context): Promise<{ client: CloudflareClient | null; email?: string }> {
  const client = await ctx.client();
  try {
    const who = await client.whoami();
    return { client: who.authenticated ? client : null, email: who.email };
  } catch (error) {
    if (!(error instanceof CfError || error instanceof CfAuthError)) throw error;
    return { client: null };
  }
}

/** `cf auth login`, offered when signed out, for the lookups that supply every default. */
async function offerCfSignIn(ctx: Context, deps: InitDeps): Promise<boolean> {
  if (!await ctx.prompter!.confirm(
    "Sign in to cf? It opens a browser. init uses it to look up your account; you can skip it and type answers instead.",
    true)) return false;
  const profile = ctx.flags.profile ? ["--profile", ctx.flags.profile] : [];
  return succeeded(deps.spawn("pnpm", ["exec", "cf", "auth", "login", ...profile], { cwd: ctx.root, capture: false }));
}

/** `wrangler login`, offered when Wrangler, which does the deploying, is signed out. */
async function offerWranglerSignIn(ctx: Context, deps: InitDeps): Promise<void> {
  // `wrangler whoami --json` exits non-zero when signed out.
  if (succeeded(deps.spawn("pnpm", ["exec", "wrangler", "whoami", "--json"], { cwd: ctx.root, capture: true }))) return;
  if (await ctx.prompter!.confirm("Sign in to Wrangler? It opens a browser. Wrangler deploys the Workers.", true)) {
    deps.spawn("pnpm", ["exec", "wrangler", "login"], { cwd: ctx.root, capture: false });
  }
}

/** `cf-os init`, inside a project. */
export async function run(args: CommandArgs, ctx: Context): Promise<number> {
  return configure(args, ctx, defaultDeps());
}

/**
 * Configures the deployment file, resolving to the exit code. With `offerDeploy`, a complete file
 * ends in the offer to deploy it; `cf-os deploy` turns that off, as it carries on deploying itself.
 */
export async function configure(
  args: CommandArgs,
  ctx: Context,
  deps: InitDeps,
  { offerDeploy = true }: { offerDeploy?: boolean } = {},
): Promise<number> {
  if (args.positionals[0]) {
    throw new UsageError(`You are inside a project already (${ctx.root}), so init configures it. To ` +
      "create another, run `cf-os init <dir>` from outside this one.");
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

  let { client, email } = await signedIn(ctx);
  if (!client && await offerCfSignIn(ctx, deps)) ({ client, email } = await signedIn(ctx));
  if (!client) {
    ctx.out.log("cf is not signed in, so nothing can be looked up in your account: you will type the " +
      "values, and Access is left for later. To sign in first: `pnpm exec cf auth login`.\n");
  }

  const catalog = await deps.catalog(ctx.root);
  const reads = client && cachedReads(client);
  // Every question up to the write, which Esc goes back through.
  const { account, configured } = await withBack(prompter, ctx.out, async (asker, askOut) => {
    const askCtx: Context = { ...ctx, prompter: asker, out: askOut };
    const chosen = await chooseAccount(askCtx, asker, reads, file, where);
    const session: Session = { ctx: askCtx, prompter: asker, client: reads, account: chosen, email };

    // Asked before any lookup: each is a `cf` run, and only the answer says which are needed.
    const mode = reads
      ? await asker.select("What are you setting up?", [
        { value: "new" as const, label: "A new deployment" },
        { value: "takeover" as const, label: "Take over a hosted instance", hint: "one the hosted deploy created" },
      ])
      : "new";

    if (mode === "takeover") return { account: chosen, configured: await takeover(session, file, catalog) };
    const outcome = await newDeployment(session, file, catalog);
    return {
      account: chosen,
      configured: "takeover" in outcome ? await takeover(session, file, catalog, outcome.takeover) : outcome,
    };
  });
  if (!configured) return 1;
  const { edits } = configured;
  if (account.isNew && !edits.some((edit) => edit.path[0] === "accountId")) {
    edits.unshift({ path: ["accountId"], value: account.id });
  }

  const outWhere = displayPath(ctx, outPath);
  ctx.out.log(`\n${outWhere} values:\n${describeEdits(edits)}`);
  await updateDeployment(inPath, edits, outPath);
  const removed = edits.filter((edit) => edit.value === undefined).length;
  ctx.out.log(`\nWrote ${edits.length - removed} values to ${outWhere}` +
    `${removed ? `, removing ${removed} ${removed === 1 ? "entry" : "entries"}` : ""}, comments intact.`);
  if (outPath === inPath) ctx.out.log(`${outWhere} belongs in your repository: commit it.`);

  const written = parseDeployment(await readFile(outPath, "utf8"), outWhere);
  const config = written as unknown as DeploymentConfig;
  const selected = selectedGatekeepers(config, catalog, configured.live);
  const { originFound } = configured;
  reportLiveGatekeepers(ctx, config, outWhere, catalog, selected, originFound);
  const next = nextStep(written, outWhere, outPath === inPath ? "" : ` --config ${outWhere}`);
  // What runs against the written file, and the commands it prints, read the file written.
  const outCtx: Context = { ...ctx, flags: { ...ctx.flags, config: outPath } };
  if (placeholderPaths(written).length || !offerDeploy) {
    reportSecretsLater(outCtx, config, catalog, selected, originFound);
    if (placeholderPaths(written).length) ctx.out.log(next);
    return 0;
  }
  await offerWranglerSignIn(ctx, deps);
  // A Worker the account runs can take its secrets now; a new one only once the deploy creates it.
  const oauth = (live: boolean) => selected.filter((gatekeeper) => gatekeeper.oauth && gatekeeper.live === live)
    .map(({ slug }) => slug);
  const live = await askSecrets(outCtx, deps, config, catalog, oauth(true), "now", originFound);
  if (!await prompter.confirm("Deploy now?", true)) {
    reportSecretsLater(outCtx, config, catalog, selected, originFound);
    ctx.out.log(next);
    return live.failed.length ? 1 : 0;
  }
  const fresh = await askSecrets(outCtx, deps, config, catalog, oauth(false), "deferred", originFound);
  const code = await deps.deploy(outCtx, { secrets: fresh.pending });
  const failed = [...live.failed, ...fresh.failed];
  if (!failed.length) return code;
  // Repeated after the deploy's log, which would otherwise bury each failure's own line.
  for (const slug of failed) {
    ctx.out.log(`\nThe ${slug} Gatekeeper's OAuth credentials were not set: \`${secretsCommand(outCtx, slug)}\` sets them.`);
  }
  return Math.max(code, 1);
}
