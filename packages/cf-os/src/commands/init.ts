// `cf-os init [--out <path>] [--take-over <instance> [--router <name>] [--backend <name>]
//   [--release <id>] [--commit <sha>]]`, inside a project
//
// Configures the deployment file by asking: which account, then either a new deployment or the
// takeover of an instance the hosted deploy created. Every answer has a default read from the
// account where `cf` can see it (zones, gateways, the signed-in email, the workers.dev subdomain),
// and every step's logic is core/wizard.ts; this file asks and looks things up.
//
// `--take-over <instance>` is the takeover without the two questions that lead to it, with what the
// hosted deploy flow knows of the instance as flags: the command that flow prints.
//
// A takeover, however it was chosen, is let through one gate before it asks anything about the
// instance (`admitInstance`): the instance's Workers are read and checked to be one instance's, and
// the project's Cloudflare OS pin is held against the commit the instance's release was built from.
// A pin behind it would deploy older code over storage the instance has already migrated, so it is
// moved forward first, confirmed at the terminal, as `cf-os import --out` moves it; a pin that cannot
// be moved stops the takeover with nothing written. The Gatekeeper catalog is read from the submodule
// only after that, at the pin the deploy will build.
//
// A move changes the submodule under a process that may have read it already: the catalog a new
// deployment's question read before Esc led to a takeover, or what `cf-os deploy` read before it
// handed over to this wizard. The module that reads the catalog stays loaded as the old pin had it,
// and a caller goes on with the configs it read, so such a run stops once the pin has moved, with
// nothing written, and says what to run again: a fresh process reads everything at the new pin.
//
// Once the file is complete it offers to deploy, running `cf-os deploy` itself, so a project goes
// from clone to running in one command. It offers the `cf` sign-in up front and Wrangler's before
// the deploy: a project cloned by hand never passed through scaffolding, which used to offer them.
//
// It offers the catalog's optional Gatekeepers (gatekeeper-catalog.ts), and their OAuth credentials,
// held in memory for `cf-os deploy` to set (gatekeeper-secrets.ts).
//
// Until the file is written, Esc goes back a question (back.ts), replaying the reads from a cache;
// so nothing is created before the last question. The pin move is the one thing done before it: it
// is made once per instance and never replayed, and its question is the terminal's own, which Esc
// cancels.
//
// Interactive only. Without a terminal it refuses, pointing at `import` and `access`, which take
// every answer as a flag or from the file; with `--take-over`, it names the `import` command that
// carries the same flags. Signed out of `cf`, it still runs: the account-aware steps become typed
// answers, and Access is left for `cf-os access`. A takeover reads the account, so it needs the
// sign-in.

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withBack } from "../back.ts";
import { cachedReads, LABELS, prefetch } from "../cached-reads.ts";
import { configPath, displayPath, UsageError, type CommandArgs, type Context, type TakeoverFlags } from "../context.ts";
import {
  accessEdits,
  createAccess,
  lookupAccess,
  ONE_TIME_PIN_PROVIDER,
  type AccessTarget,
} from "../core/access.ts";
import { CfAuthError, CfError, type CloudflareClient, type CfWorker, workersDevSubdomainOf } from "../core/client.ts";
import { fetchInventory, type FoundGatekeeper } from "../core/discovery.ts";
import { isPlaceholder, placeholderPaths, valueAtPath, type DeploymentEdit } from "../core/edits.ts";
import { publicOrigin } from "../core/deployment.ts";
import type { AiGatewayProvider, DeploymentConfig } from "../core/deployment-config.ts";
import { bindsPdfRenderer, secretSetup, UNDECLARED_VARS, type GatekeeperCatalog } from "../core/gatekeepers.ts";
import { decideCommit } from "../core/hosted-release.ts";
import {
  baseNameProblem,
  CUSTOM_NAMES_HINT,
  findInstances,
  gatekeeperWorkerName,
  WORKER_NAME,
  workerNames,
} from "../core/naming.ts";
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
  offeredAdmins,
  offeredProviders,
  parseAdmins,
  pinMoveReason,
  PROVIDER_HINTS,
  PROVIDERS,
  strayPushIdentity,
  subdomainProblem,
  takeoverEdits,
  type RouteChoice,
} from "../core/wizard.ts";
import { parseDeployment, updateDeployment } from "../deployment-file.ts";
import { loadCatalog } from "../gatekeeper-catalog.ts";
import { askAndSetSecrets, readSecretsAhead, secretsCommand, type PendingSecrets } from "../gatekeeper-secrets.ts";
import { localBin } from "../local-bin.ts";
import { type Prompter, waitOn } from "../prompt.ts";
import { defaultCapture, defaultSpawn, succeeded, type CaptureTool, type SpawnTool, type ToolResult } from "../tools.ts";
import { accountFlag, resolveAccount, type ResolvedAccount } from "./account.ts";
import {
  checkOutPath,
  discoverInstance,
  fileIsInstance,
  foreignPushIdentity,
  foreignRenderer,
  formatInstance,
  formatReport,
  inspectInstance,
  instanceRefusal,
  pickInstance,
  settlePin,
  type Inspection,
  type PinMover,
  type PinOutcome,
} from "./import.ts";
import { importCommand, initCommand, takeOverOf } from "./scaffold.ts";
import { BRIEF, movePin } from "./update.ts";

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

/**
 * Without a terminal, what to run instead of `cf-os init --take-over`: `command`, the `cf-os import`
 * that carries the same flags and asks nothing.
 */
export function noTerminalTakeOver(command: string): string {
  return "cf-os init --take-over asks questions (which Gatekeepers to deploy, the names of the Workers it adds), " +
    `and there is no terminal to ask them at. Without one, run:\n  ${command}\n` +
    "It moves the project's cloudflare-os pin forward to the release the instance runs, staged and not " +
    "committed, then writes what it found, asking nothing. Fill in what it lists by hand (optional Gatekeepers " +
    "are entries in `gatekeepers`, and `customGatekeeper.enabled: false` drops the example custom one), then " +
    "`pnpm cf-os check`.";
}

/** What init runs besides `cf` lookups, so tests can record it instead. */
export interface InitDeps {
  /** The sign-ins and `wrangler secret bulk`. */
  spawn: SpawnTool;
  /** Wrangler's sign-in check. */
  capture: CaptureTool;
  /**
   * `cf-os deploy` against `ctx`, setting `secrets` on their Workers once it has deployed them.
   * Resolves to its exit code.
   */
  deploy(ctx: Context, options?: { secrets?: PendingSecrets[] }): Promise<number>;
  /** The optional Gatekeepers the project at `root` offers. */
  catalog(root: string): Promise<GatekeeperCatalog>;
  /** Moves the project's Cloudflare OS pin forward to the commit a taken-over instance was built from. */
  pin: PinMover;
}

/** What `cf-os init` runs against outside a test: the tools themselves, the submodule's catalog and `movePin`. */
export function defaultDeps(): InitDeps {
  return {
    spawn: defaultSpawn(),
    capture: defaultCapture(),
    catalog: loadCatalog,
    pin: movePin,
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
  /**
   * Null when `cf` is signed out: nothing can be looked up, so everything is typed. A read still in
   * flight shows a spinner while the step waits on it, as does a create.
   */
  client: CloudflareClient | null;
  /** The same reads, drawing nothing: what starts a read ahead of the step that uses it. */
  reads: CloudflareClient | null;
  account: ResolvedAccount;
  /** The signed-in email, the default admin. */
  email?: string;
  /**
   * The optional Gatekeepers the project offers, read from the submodule when first asked for. A
   * takeover asks only once its gate is through, so they are the ones of the pin the deploy builds.
   */
  catalog(): Promise<GatekeeperCatalog>;
  /**
   * Lets `instance` through to a takeover, or says why not and resolves to null ({@link admitInstance}).
   * Once per instance: a replay after Esc gets the first run's answer, so nothing is read, asked or
   * moved twice.
   */
  admit(instance: string, flags: TakeoverFlags): Promise<Admitted | null>;
}

/** An instance let through to a takeover: what was read of it, and the project's pin at or past its release. */
interface Admitted {
  inspection: Inspection;
  pin: PinOutcome;
}

/** `prompter`, each of whose confirmations says `reason` after its question. */
function explaining(prompter: Prompter, reason: string): Prompter {
  return { ...prompter, confirm: (message, initial) => prompter.confirm(`${message} ${reason}`, initial) };
}

/** Who read the project's cloudflare-os checkout in this process before a takeover's gate was reached. */
type ReadAhead =
  /** The command that ran this wizard and goes on once it returns: `cf-os deploy` or `cf-os check`. */
  | "caller"
  /** This wizard, for a question asked before the takeover was chosen. */
  | "wizard";

/** What the gate is told of the run it is part of ({@link admitInstance}). */
interface GateRun {
  /** The command's own context, not a replaying view of it: what the gate prints and asks happens once. */
  ctx: Context;
  prompter: Prompter;
  /** One run's cache of account reads, and whether a read of it is still in flight. */
  reads: { quiet: CloudflareClient; pending(): boolean };
  /** The deployment file as it was read. */
  file: Record<string, unknown>;
  /** Moves the pin. */
  pin: PinMover;
  /**
   * The `cf-os init --take-over` command line for `instance` of `accountId` under take-over flags
   * `flags`, with everything else this run was given: the sign-in and the files it reads and writes.
   */
  command(accountId: string, instance: string, flags: TakeoverFlags): string;
  /** Who has read the checkout so far, which a pin move leaves holding the old pin's; null when nobody has. */
  readAhead(): ReadAhead | null;
}

/** What stands for the commit in a command printed for the operator to complete. */
const COMMIT_PLACEHOLDER = "<sha>";

/**
 * What to do about a takeover that stopped for want of `--commit`: the command that takes the flag
 * and, when no Worker of the instance names a release at all, which commit that is for Workers this
 * project deployed itself. `own` is whether the deployment file is already the instance's.
 */
function commitHint(command: string, unnamed: boolean, own: boolean): string {
  const lines = [`With init, --commit goes with the instance: \`${command}\`.`];
  if (unnamed) {
    lines.push(
      (own
        ? "The deployment file is already this instance's, so this project has most likely deployed over it: Workers "
        : "If this project has already deployed over the instance, that is why: Workers ") +
      "it deploys name no release, and the deploy flow has no command for them. The commit to pass is then the " +
      "cloudflare-os commit it deployed them from, which is the project's pin unless the pin has moved since: " +
      "`git -C cloudflare-os rev-parse HEAD` prints the commit checked out, which a pin staged and not yet committed " +
      "is too.");
  }
  return lines.join("\n");
}

/**
 * Why a run stops once the gate has moved the pin to `pin` under a process that had read the
 * checkout at the old one (`readAhead`), and what to run in its place: `command`, for a wizard that
 * read it itself.
 */
function staleAfterMove(pin: string | null, readAhead: ReadAhead, command: string): string {
  const moved = `The cloudflare-os pin is at ${pin} from here on, staged and not committed`;
  return readAhead === "caller"
    ? `${moved}, but the command that ran this wizard read the project before the move, the Gatekeeper catalog and ` +
      "each Gatekeeper's config among it, and would deploy the new pin's code under the old pin's. So it stops here, " +
      "with nothing written and nothing deployed. Run the same command again: it reads the project at the new pin, and " +
      "the takeover goes on from there."
    : `${moved}, but this run read the Gatekeeper catalog before the move, and what reads it stays loaded as the old pin ` +
      `had it. So it stops here, with nothing written. Run the takeover again, which reads it at the new pin:\n  ${command}`;
}

/**
 * The gate every takeover goes through before it asks anything about instance `instance` of account
 * `accountId`: null, with why printed, unless the instance is one to take over and the project's pin
 * is at or past the commit its release was built from.
 *
 * It reads what the instance's Workers run, under the router and backend names `flags` give or the
 * hosted flow's defaults, and refuses Workers that are not one instance's or not the one named
 * (`instanceRefusal`). It settles which commit the project must not be behind (`decideCommit`), from
 * the releases the Workers report and `flags`' `--release` and `--commit`. Then it holds the pin
 * against that commit (`settlePin`): a pin behind is moved forward, the pin alone, staged and
 * uncommitted, once the person at the terminal confirms it, the question saying from which commit to
 * which and why. Declined, or not movable, the takeover stops.
 *
 * It stops as well when the move was made under a process that had already read the checkout
 * ({@link GateRun.readAhead}): the pin stays moved, which is the safe side, and a run started afresh
 * finds it where the instance's release is.
 */
async function admitInstance(gate: GateRun, accountId: string, instance: string, flags: TakeoverFlags): Promise<Admitted | null> {
  const { ctx } = gate;
  const inspection = await inspectInstance(ctx, gate.reads, accountId, instance, flags);
  ctx.out.log(`Hosted instance "${instance}" in account ${accountId}:\n`);
  const refusal = instanceRefusal(instance, inspection);
  if (refusal) {
    ctx.out.log(refusal);
    return null;
  }
  ctx.out.log(`${formatInstance(inspection.hosted)}\n`);
  const decision = decideCommit(inspection.hosted.reports, flags);
  if (!decision.ok) {
    // What asks for --commit is answered on init too, where the instance may have been picked from a menu.
    const asksForCommit = flags.commit === undefined && (decision.reason === "no-commit" || decision.reason === "unorderable");
    const hint = asksForCommit
      ? `\n${commitHint(gate.command(accountId, instance, { ...flags, commit: COMMIT_PLACEHOLDER }),
        inspection.hosted.reports.length === 0, fileIsInstance(gate.file, accountId, instance, inspection.names.router))}`
      : "";
    ctx.out.log(`${decision.message}${hint}\nNothing was moved or written.`);
    return null;
  }
  // Asked before the move, which is what makes it stale.
  const readAhead = gate.readAhead();
  const asking: Context = { ...ctx, prompter: explaining(gate.prompter, pinMoveReason(instance, decision.release)) };
  const standing = await settlePin(asking, decision, { write: true, ask: true }, gate.pin);
  if (!standing.ok) return null;
  if (standing.moved && readAhead) {
    ctx.out.log(staleAfterMove(standing.pin, readAhead, gate.command(accountId, instance, flags)));
    return null;
  }
  return { inspection, pin: standing };
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

/**
 * Right after "A new deployment": the reads both its ways make, whatever the base name turns out to
 * be. Both read the account's Workers and its Zero Trust organization (for the Access step, or for
 * the inventory of the hosted instance the name may turn out to be), and both list the Access
 * applications once the organization has a team domain.
 */
function prefetchNew(session: Session): void {
  const { reads, account } = session;
  if (!reads) return;
  prefetch(reads.listWorkers(account.id));
  prefetch(reads.getOrganization(account.id)
    .then((organization) => organization.auth_domain ? reads.listAccessApps(account.id) : undefined));
}

/**
 * Right after "Take over a hosted instance": the account's Workers, which the instance is picked from,
 * and, once they show one to pick, the rest of the inventory the takeover reads, while the instance
 * question is open.
 */
function prefetchTakeover(session: Session): void {
  const { reads, account } = session;
  if (!reads) return;
  prefetch(reads.listWorkers(account.id)
    .then((workers) => findInstances(workers).length ? fetchInventory(reads, account.id) : undefined));
}

/**
 * Once the base name is settled, and the flow can no longer turn into a takeover: the AI Gateways the
 * gateway question offers, and the identity providers the Access step checks. That step reads them
 * only once it has an organization with a team domain and the list of applications.
 */
function prefetchAfterName(session: Session): void {
  const { reads, account } = session;
  if (!reads) return;
  prefetch(reads.listAiGateways(account.id));
  prefetch(reads.getOrganization(account.id).then((organization) => organization.auth_domain
    ? reads.listAccessApps(account.id).then(() => reads.listIdentityProviders(account.id))
    : undefined));
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
    // Off the list the base name was checked against, which is already in the cache.
    const subdomain = await lookup(session, "the account's Workers",
      async (client) => workersDevSubdomainOf(await client.listWorkers(account.id)));
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
  /** For a takeover: where the project's pin stands to the instance's release, and whether this run moved it. */
  pin?: PinOutcome;
}

/** What a new deployment's flow ended in: its edits, or a switch to taking over instance `n`. */
type NewOutcome = Configured | { takeover: string };

async function newDeployment(session: Session, file: Record<string, unknown>): Promise<NewOutcome> {
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

  prefetchAfterName(session);
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
  const catalog = await session.catalog();
  const choice = await askGatekeepers(session, catalog, [
    ...valueAtPath(file, ["customGatekeeper", "enabled"]) === false ? [] : [CUSTOM_GATEKEEPER_CHOICE],
    ...listed,
  ]);
  const customGatekeeper = choice.custom ? await askDisplay(session, file) : null;
  const gatekeepers = await nameGatekeepers(session, workers, name, choice.slugs);
  const pdfRenderer = await nameRenderer(session, workers, name, choice.slugs, catalog);

  const answers = {
    accountId: account.id, name, route, admins, aiGateway: { name: gateway, providers }, customGatekeeper,
    gatekeepers, removedGatekeepers: deselected(listed, choice, catalog), ...pdfRenderer && { pdfRenderer },
  };
  // Another deployment's push identity, left in the file by a takeover, is not this one's to send.
  // The name was accepted against `workers`, so where they were listed its Workshop Worker is not there.
  const stray = strayPushIdentity(file, answers, workers ?? null);
  if (stray.note) ctx.out.log(stray.note);
  const edits = [...newDeploymentEdits(answers), ...stray.edits, ...await askUndeclaredVars(session, file, choice.slugs)];
  edits.push(...await setUpAccess(session, newDeploymentAccessTarget(answers)));
  return { edits, live: [], originFound: true };
}

/** The slugs the file's `gatekeepers` block lists. */
function gatekeepersIn(file: Record<string, unknown>): string[] {
  const block = valueAtPath(file, ["gatekeepers"]);
  return block && typeof block === "object" && !Array.isArray(block) ? Object.keys(block) : [];
}

/**
 * The optional Gatekeepers the account already runs for instance `n`, whose router Worker is
 * `router`: those `discovered`, plus the file's entries whose Worker exists when the file is the
 * instance's ({@link fileIsInstance}). Where the two differ the operator picks; `passedOver` holds
 * the Worker not picked.
 */
async function liveGatekeepers(
  session: Session,
  n: string,
  router: string,
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
  const instanceFile = fileIsInstance(file, session.account.id, n, router);
  const fromFile = instanceFile ? running : [];
  const foreign = running.filter(({ name }) => !discovered.some((gatekeeper) => gatekeeper.name === name));
  if (!instanceFile && foreign.length) {
    session.ctx.out.log(`The file is not ${n}'s in account ${session.account.id} (its workers.router.name or ` +
      "accountId differs), so the Gatekeeper Workers its gatekeepers block names may be another deployment's, " +
      `and are left alone: ${foreign.map(({ name }) => name).join(", ")}.`);
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
 * The example custom Gatekeeper's Worker the account runs for instance `n`, whose router Worker is
 * `router`, if any: the file's name for it when the file is the instance's ({@link fileIsInstance}),
 * else `<n>-gk-custom`.
 */
function liveCustomGatekeeper(
  file: Record<string, unknown>,
  accountId: string,
  n: string,
  router: string,
  workers: CfWorker[],
): string[] {
  const own = fileIsInstance(file, accountId, n, router);
  if (own && valueAtPath(file, ["customGatekeeper", "enabled"]) === false) return [];
  const name = fileCustomGatekeeper(file, accountId, n, router) ?? workerNames(n).customGatekeeper;
  return workers.some((worker) => worker.name === name) ? [name] : [];
}

/** The file's filled-in custom Gatekeeper Worker name, when the file is the instance's ({@link fileIsInstance}). */
function fileCustomGatekeeper(file: Record<string, unknown>, accountId: string, n: string, router: string): string | undefined {
  if (!fileIsInstance(file, accountId, n, router)) return undefined;
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
 * The PDF renderer's Worker name for a new deployment `n`, asked for only when one of the Gatekeepers
 * `slugs` binds the renderer and the account already has a Worker named `<n>-pdf-renderer`, which
 * the deploy would overwrite. Undefined means the derived name.
 */
async function nameRenderer(
  session: Session,
  workers: CfWorker[] | null | undefined,
  n: string,
  slugs: string[],
  catalog: GatekeeperCatalog,
): Promise<string | undefined> {
  const binds = slugs.some((slug) => {
    const entry = catalog.offered.find((candidate) => candidate.slug === slug);
    return entry !== undefined && bindsPdfRenderer(entry);
  });
  const derived = workerNames(n).pdfRenderer;
  if (!binds || !workers?.some((worker) => worker.name === derived)) return undefined;
  session.ctx.out.log(`A Gatekeeper chosen binds the PDF renderer, which would be deployed as ${derived}, a Worker ` +
    "the account already has.");
  return askNewWorker(session, workers, "PDF renderer Worker name", derived);
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

/**
 * The model providers to advertise. The default is `found`, the ones a taken-over instance's backend
 * advertises, where it was read and serves any the starter does; else the file's own choice when it
 * has one.
 */
async function askProviders(session: Session, file: Record<string, unknown>, found?: unknown): Promise<AiGatewayProvider[]> {
  const current = valueAtPath(file, ["aiGateway", "providers"]);
  const advertised = offeredProviders(found);
  const initial = advertised.length ? advertised
    : Array.isArray(current) && current.length &&
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

/**
 * The takeover of a hosted instance: `chosen`, or the one picked from the account's. The instance
 * goes through the gate first ({@link Session.admit}), which may move the project's pin; then what
 * it runs is matched against the catalog at that pin, reported, and the rest is asked. Null when
 * there is nothing to take over, or the gate stopped it; why has been printed.
 */
async function takeover(
  session: Session,
  file: Record<string, unknown>,
  chosen?: { instance: string; flags: TakeoverFlags },
): Promise<Configured | null> {
  const { prompter, ctx, account } = session;
  const client = session.client!;
  const instance = chosen?.instance ?? await pickInstance(ctx, client, account.id, "pnpm cf-os import --account <id>");
  if (!instance) return null;
  const admitted = await session.admit(instance, chosen?.flags ?? {});
  if (!admitted) return null;
  const { inspection: { names: core, inventory, hosted }, pin } = admitted;
  // After the gate: the catalog is the submodule's, at the pin the gate left it at.
  const catalog = await session.catalog();
  const discovery = discoverInstance(instance, inventory, catalog, { names: core, instance: hosted });
  const { removals: pushRemovals, note: pushNote } = foreignPushIdentity(file, account.id, instance, discovery, core.router);
  if (pushNote) discovery.notes.push(pushNote);
  // Another deployment's renderer name, which a deploy with Google would deploy over, as `--out` resets it.
  const { reset: rendererReset, note: rendererNote } = foreignRenderer(file, account.id, instance, core.router, discovery);
  if (rendererNote) discovery.notes.push(rendererNote);
  ctx.out.log(`\n${formatReport(instance, discovery)}\n`);
  // What the gate let through has both, so this holds only where discovery disagrees with it.
  if (!discovery.matched) {
    ctx.out.log("Nothing matched; nothing to write" +
      `${pin.moved ? `, though the cloudflare-os pin had moved to ${pin.pin}, staged and not committed, and stays there` : ""}. ` +
      `Check the instance name against the Worker list. ${CUSTOM_NAMES_HINT}`);
    return null;
  }

  const names = workerNames(instance, core);
  const discovered = (path: string) => discovery.edits.find((edit) => edit.path.join(".") === path)?.value;
  // The instance's own admins where its backend carries them, then the file's, then whoever is signed in.
  const adminDefault = offeredAdmins(discovered("access.admins"), valueAtPath(file, ["access", "admins"])) ?? session.email;
  const hasWebsearch = discovery.rows.some((row) => row.path === "workers.websearch.name" && row.found);
  const admins = parseAdmins(await prompter.text("Admin emails, comma-separated (they can open /admin)", {
    initial: adminDefault, validate: adminsProblem,
  }));
  const websearch = hasWebsearch ? undefined : await askNewWorker(session, inventory.workers,
    "Web Search Gatekeeper Worker name (the instance has none; the deploy creates it)", names.websearch);
  const { found, passedOver } = await liveGatekeepers(session, instance, core.router, file, inventory.workers, catalog,
    discovery.foundGatekeepers);
  const choice = await askGatekeepers(session, catalog, [CUSTOM_GATEKEEPER_CHOICE, ...found.map(({ slug }) => slug)]);
  const liveCustom = liveCustomGatekeeper(file, account.id, instance, core.router, inventory.workers);
  const unbinds = (name: string) => ctx.out.log(`Warning: leaving out ${name} removes its binding, so it ` +
    "disappears from the app along with every user's connection to it. The Worker keeps running; " +
    `\`CLOUDFLARE_ACCOUNT_ID=${account.id} pnpm exec wrangler delete --name ${name}\` removes it.`);
  [...passedOver, ...found.filter(({ slug }) => !choice.slugs.includes(slug))].forEach(({ name }) => unbinds(name));
  if (!choice.custom) liveCustom.forEach(unbinds);
  // A rerun keeps the custom Gatekeeper on the Worker the file names, which holds its users' connections.
  const ownCustom = liveCustom.find((name) => name === fileCustomGatekeeper(file, account.id, instance, core.router));
  const customWorker = choice.custom
    ? await askNewWorker(session, inventory.workers, "Custom Gatekeeper Worker name",
      ownCustom ?? names.customGatekeeper, ownCustom)
    : undefined;
  if (customWorker) liveCustom.filter((name) => name !== customWorker).forEach(unbinds);
  const errorReporter = await askNewWorker(session, inventory.workers, "Error Reporter Worker name", names.errorReporter);
  const providers = await askProviders(session, file, discovered("aiGateway.providers"));
  const display = choice.custom ? await askDisplay(session, file) : undefined;
  const live = found.filter(({ slug }) => choice.slugs.includes(slug));
  const answers = {
    admins, websearch, errorReporter, providers,
    customGatekeeper: customWorker && display ? { worker: customWorker, display } : null,
    gatekeepers: await nameGatekeepers(session, inventory.workers, instance, choice.slugs, live),
    removedGatekeepers: deselected(gatekeepersIn(file), choice, catalog),
  };
  // takeoverEdits records the Gatekeepers chosen, found or not; discovery's are only what it found.
  const asked = [...takeoverEdits(answers), ...await askUndeclaredVars(session, file, choice.slugs)];
  // An answer stands in place of the value discovery found for the same path, which was its default.
  const answered = new Set(asked.map((edit) => edit.path.join(".")));
  const edits = [
    ...discovery.edits.filter((edit) => edit.path[0] !== "gatekeepers" && !answered.has(edit.path.join("."))),
    ...pushRemovals,
    // Before the answers, which win over it.
    ...rendererReset ? [rendererReset] : [],
    ...asked,
  ];
  if (!discovery.edits.some((edit) => edit.path.join(".") === "access.audience")) {
    ctx.out.log("No Access application was found for this instance. After writing, `pnpm cf-os access` " +
      "finds or creates one for its hostname.");
  }
  const originFound = discovery.edits.some((edit) => edit.path.join(".") === "workers.router.route");
  return { edits, live, originFound, pin };
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
 * {@link askAndSetSecrets} for `slugs`: the values entered for a `"deferred"` upload, and the
 * Gatekeepers whose credentials could not be set, which make init exit 1.
 */
async function askSecrets(
  ctx: Context,
  deps: InitDeps,
  config: DeploymentConfig,
  catalog: GatekeeperCatalog,
  slugs: string[],
  upload: "now" | "deferred",
  originFound: boolean,
  present?: Map<string, Promise<string[] | null>>,
): Promise<{ pending: PendingSecrets[]; failed: string[] }> {
  if (!slugs.length) return { pending: [], failed: [] };
  const origin = originFound ? publicOrigin(config) : UNKNOWN_ORIGIN;
  const outcome = await askAndSetSecrets(ctx, { prompter: ctx.prompter, client: await ctx.client(), spawn: deps.spawn },
    { config, catalog, slugs, upload, origin, present });
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
  // The raw client, not the cache: a second check after `cf auth login` has to ask again.
  const client = await ctx.client();
  try {
    const who = await waitOn(ctx.prompter, LABELS.whoami(), () => client.whoami());
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
  return succeeded(deps.spawn(...await localBin(ctx.root, "cf", ["auth", "login", ...profile]), { cwd: ctx.root, capture: false }));
}

/**
 * `wrangler login`, offered when Wrangler, which does the deploying, is signed out: `check` is
 * `wrangler whoami --json`, started earlier, which exits non-zero when signed out.
 */
async function offerWranglerSignIn(ctx: Context, deps: InitDeps, check: Promise<ToolResult>): Promise<void> {
  if (succeeded(await waitOn(ctx.prompter, "Checking the Wrangler sign-in", () => check))) return;
  if (await ctx.prompter!.confirm("Sign in to Wrangler? It opens a browser. Wrangler deploys the Workers.", true)) {
    deps.spawn(...await localBin(ctx.root, "wrangler", ["login"]), { cwd: ctx.root, capture: false });
  }
}

/** `cf-os init`, inside a project. */
export async function run(args: CommandArgs, ctx: Context): Promise<number> {
  return configure(args, ctx, defaultDeps());
}

/**
 * Configures the deployment file, resolving to the exit code. With `offerDeploy`, a complete file
 * ends in the offer to deploy it; `cf-os deploy` turns that off, as it carries on deploying itself,
 * with what it read of the project before it got here. So without `offerDeploy`, a takeover that
 * moves the pin resolves to 1 once it has, with nothing written: the caller must not carry on, and
 * is run again ({@link staleAfterMove}).
 * With `--take-over <instance>` among `args`, it is that instance's takeover, the mode and instance
 * questions skipped.
 */
export async function configure(
  args: CommandArgs,
  ctx: Context,
  deps: InitDeps,
  { offerDeploy = true }: { offerDeploy?: boolean } = {},
): Promise<number> {
  if (args.positionals[0]) {
    // The hosted deploy flow's command names a directory to create: run inside a project, it is the take-over without one.
    const asked = takeOverOf(args.values, ctx.flags);
    throw new UsageError(`You are inside a project already (${ctx.root}), so init configures it. ` +
      (asked
        ? `To take ${asked.instance} over from this project, leave the directory out: ` +
          `\`${initCommand(asked, args.values.out as string | undefined)}\`. `
        : "") +
      "To create another, run `cf-os init <dir>` from outside this one.");
  }
  if (args.values.template || args.values.ref) {
    throw new UsageError("--template and --ref only apply when creating a project.");
  }
  const takeOver = takeOverOf(args.values, ctx.flags);
  const inPath = configPath(ctx);
  const where = displayPath(ctx, inPath);
  const out = args.values.out as string | undefined;
  if (!ctx.prompter) {
    ctx.out.log(takeOver ? noTerminalTakeOver(importCommand({ ...takeOver, account: accountFlag(ctx) }, out ?? where)) : NO_TERMINAL);
    return 1;
  }
  const prompter = ctx.prompter;
  // Before anything is read: by the time the file is written, a takeover may have moved the pin.
  if (out !== undefined) await checkOutPath(ctx, out);
  const outPath = out ? resolve(ctx.cwd, out) : inPath;
  const file = parseDeployment(await readFile(inPath, "utf8"), where);

  // Wrangler's sign-in, needed only to deploy, checked from the start rather than after the file is
  // written; on the way out, no longer waited on if nothing used it.
  const stopWranglerCheck = new AbortController();
  const wranglerSignIn = deps.capture(...await localBin(ctx.root, "wrangler", ["whoami", "--json"]),
    { cwd: ctx.root, signal: stopWranglerCheck.signal });
  try {
    // Listed beside the sign-in check: the account question reads the list, and so does the example
    // custom Gatekeeper's default name. Signed out, the list fails; after a sign-in it is read again.
    const raw = await ctx.client();
    let cache = cachedReads(raw);
    prefetch(cache.quiet.listAccounts());
    let { client, email } = await signedIn(ctx);
    if (!client && await offerCfSignIn(ctx, deps)) {
      cache = cachedReads(raw);
      prefetch(cache.quiet.listAccounts());
      ({ client, email } = await signedIn(ctx));
    }
    if (!client && takeOver) {
      ctx.out.log(`cf is not signed in, and taking over ${takeOver.instance} reads it from your account. Sign in ` +
        "(`pnpm exec cf auth login`), then run this again. Nothing was moved or written.");
      return 1;
    }
    if (!client) {
      ctx.out.log("cf is not signed in, so nothing can be looked up in your account: you will type the " +
        "values, and Access is left for later. To sign in first: `pnpm exec cf auth login`.\n");
    }

    // Read on first use, and once: a pin move that follows a read stops the run at the gate.
    let catalogRead: Promise<GatekeeperCatalog> | undefined;
    const readCatalog = () => catalogRead ??= deps.catalog(ctx.root);
    const gate: GateRun = {
      ctx, prompter, reads: cache, file, pin: deps.pin,
      command: (accountId, instance, flags) => initCommand(
        { instance, flags, account: accountId, profile: ctx.flags.profile, config: ctx.flags.config }, out),
      // A caller that deploys read the project before it ran this; the wizard reads only the catalog.
      readAhead: () => !offerDeploy ? "caller" : catalogRead ? "wizard" : null,
    };
    // Each instance's way through the takeover gate, made once however often its questions are replayed.
    const admissions = new Map<string, Promise<Admitted | null>>();
    const admit = (accountId: string, instance: string, flags: TakeoverFlags) => {
      const key = `${accountId} ${instance}`;
      let admission = admissions.get(key);
      if (!admission) {
        admission = admitInstance(gate, accountId, instance, flags);
        admissions.set(key, admission);
      }
      return admission;
    };
    // Every question up to the write, which Esc goes back through.
    const { account, configured } = await withBack(prompter, ctx.out, async (asker, askOut) => {
      const askCtx: Context = { ...ctx, prompter: asker, out: askOut };
      // Through this run's asker, which draws nothing while answers are replayed.
      const reader = client && cache.loud(asker);
      const chosen = await chooseAccount(askCtx, asker, reader, file, where);
      const session: Session = { ctx: askCtx, prompter: asker, client: reader, reads: client && cache.quiet,
        account: chosen, email, catalog: readCatalog, admit: (instance, flags) => admit(chosen.id, instance, flags) };

      // Named on the command line: the takeover itself, with no mode or instance to ask for.
      if (takeOver) return { account: chosen, configured: await takeover(session, file, takeOver) };

      // While the question is open: either answer reads the account's Workers.
      if (session.reads) prefetch(session.reads.listWorkers(chosen.id));
      const mode = reader
        ? await asker.select("What are you setting up?", [
          { value: "new" as const, label: "A new deployment" },
          { value: "takeover" as const, label: "Take over a hosted instance", hint: "one the hosted deploy created" },
        ])
        : "new";

      if (mode === "takeover") {
        prefetchTakeover(session);
        return { account: chosen, configured: await takeover(session, file) };
      }
      prefetchNew(session);
      const outcome = await newDeployment(session, file);
      return {
        account: chosen,
        configured: "takeover" in outcome ? await takeover(session, file, { instance: outcome.takeover, flags: {} }) : outcome,
      };
    });
    if (!configured) return 1;
    const catalog = await readCatalog();
    const { edits } = configured;
    if (account.isNew && !edits.some((edit) => edit.path[0] === "accountId")) {
      edits.unshift({ path: ["accountId"], value: account.id });
    }

    const outWhere = displayPath(ctx, outPath);
    ctx.out.log(`\n${outWhere} values:\n${describeEdits(edits)}`);
    // The pin a takeover moved, which stays moved whatever becomes of the write: this takeover's, or
    // one the questions went back out of, whose move was made all the same.
    let movedPin = configured.pin?.moved ? configured.pin.pin : null;
    const abandoned = movedPin === null;
    for (const admission of abandoned ? admissions.values() : []) {
      const admitted = await admission.catch(() => null);
      if (admitted?.pin.moved) movedPin = admitted.pin.pin;
    }
    try {
      await updateDeployment(inPath, edits, outPath);
    } catch (error) {
      // The move came first and is not undone: the pin forward is the safe side to be left on.
      if (movedPin !== null) {
        ctx.out.log(`\n${outWhere} could not be written, and nothing was. The cloudflare-os pin had moved to ${movedPin}, ` +
          "staged and not committed, and stays there: run this again once the file can be written.");
      }
      throw error;
    }
    const removed = edits.filter((edit) => edit.value === undefined).length;
    ctx.out.log(`\nWrote ${edits.length - removed} values to ${outWhere}` +
      `${removed ? `, removing ${removed} ${removed === 1 ? "entry" : "entries"}` : ""}, comments intact.`);
    if (outPath === inPath) ctx.out.log(`${outWhere} belongs in your repository: commit it.`);
    if (movedPin !== null) {
      ctx.out.log(`The cloudflare-os pin moved to ${movedPin} for ${abandoned ? "the takeover this run began" : "this takeover"}, ` +
        `staged and not committed: review what it brings (${displayPath(ctx, join(ctx.root, BRIEF))}) and commit it with the file.`);
    }

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
    // A Worker the account runs can take its secrets now; a new one only once the deploy creates it.
    const oauth = (live: boolean) => selected.filter((gatekeeper) => gatekeeper.oauth && gatekeeper.live === live)
      .map(({ slug }) => slug);
    // Listed before the Wrangler sign-in is offered, through a fresh client: the cache is for the questions.
    const ahead = oauth(true).length ? readSecretsAhead(await ctx.client(), config, catalog, oauth(true)) : undefined;
    await offerWranglerSignIn(ctx, deps, wranglerSignIn);
    const live = await askSecrets(outCtx, deps, config, catalog, oauth(true), "now", originFound, ahead);
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
  } finally {
    stopWranglerCheck.abort();
  }
}
