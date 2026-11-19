// `cf-os import [<instance>] [--account <id>] [--router <name>] [--backend <name>] [--release <id>]
//   [--commit <sha>] [--config <path>] [--out <path>]`
//
// Takes over an instance created by the hosted deploy: finds what it already runs in the account
// (core/discovery.ts), which release that is and which of its Workers were changed by hand
// (core/hosted-release.ts), and prints the `deployment.jsonc` values that redeploy over it -- the
// fragment as JSON on stdout, the report on stderr. Missing an account or an instance name, it asks
// at a terminal, and otherwise lists the candidates and stops, so the choice is always the
// operator's. Read-only against Cloudflare.
//
// The Workers read are checked to be one instance's, and that instance the one named, before
// anything else (`instanceRefusal`): every other resource is found by the instance's name, and the
// router's and the backend's names are the operator's to choose, so what the Workers carry must name
// the instance, whether they were named with `--router` and `--backend` or found as `N` and
// `N-backend`.
//
// A deploy of this project must never put older code over the instance: storage a newer release
// migrated cannot be taken back. So the project's Cloudflare OS pin is held against the commit the
// instance's release was built from, and everything that cannot settle that stops the run with
// nothing written:
//
// - Without `--out`, nothing is moved or written: the report says the release, its commit, the
//   project's pin and whether that pin is behind.
// - `--out <path>` first moves the pin forward to that commit, as `cf-os update --to` moves it but
//   never merging the starter and never backwards (`movePin`, update.ts), then reads the Gatekeeper
//   catalog from the submodule at its pin, then writes the values into a local copy of the config,
//   comments intact (pass `--config`'s path to update it in place).
//
// Each read is made once per run (cached-reads.ts). At a terminal, a step waiting on a read shows a
// spinner, and while "Which hosted instance?" is open the rest of the account is read in the
// background.

import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { cachedReads, INSTANCE_LABEL, INVENTORY_LABEL } from "../cached-reads.ts";
import {
  configPath,
  displayPath,
  takeoverArgs,
  takeoverFlags,
  UsageError,
  type CommandArgs,
  type Context,
  type TakeoverFlags,
} from "../context.ts";
import type { CloudflareClient } from "../core/client.ts";
import {
  discover,
  fetchInventory,
  instanceNameProblem,
  type Discovery,
  type HostedSources,
  type Inventory,
} from "../core/discovery.ts";
import { editsAsFragment, isPlaceholder, PUSH_IDENTITY_PATH, valueAtPath, type DeploymentEdit } from "../core/edits.ts";
import type { GatekeeperCatalog } from "../core/gatekeepers.ts";
import {
  decideCommit,
  formatHandEdited,
  formatReleases,
  instanceStops,
  readInstance,
  type CommitDecision,
  type HandEditedWorker,
  type HostedInstance,
} from "../core/hosted-release.ts";
import { coreNames, CUSTOM_NAMES_HINT, findInstances, WORKER_NAME, workerNames, type CoreNames } from "../core/naming.ts";
import { parseDeployment, updateDeployment } from "../deployment-file.ts";
import { loadCatalog } from "../gatekeeper-catalog.ts";
import { waitOn } from "../prompt.ts";
import { resolveAccount } from "./account.ts";
import { movePin, type PinMove } from "./update.ts";

/**
 * {@link discover} against the submodule's Gatekeeper catalog, saying so when there is none: every
 * optional Gatekeeper then reads as not deployable. `hosted` is what is known of the instance beyond
 * the account's inventory: its router and backend names, and what its Workers run.
 */
export function discoverInstance(
  n: string,
  inventory: Inventory,
  catalog: GatekeeperCatalog,
  hosted: HostedSources = {},
): Discovery {
  const discovery = discover(n, inventory, catalog.offered.map((entry) => entry.slug), catalog.excluded, hosted);
  if (catalog.unavailable && discovery.orphanedGatekeepers.length) {
    discovery.notes.push(`The Gatekeeper catalog could not be read, so no optional Gatekeeper is deployable: ${catalog.unavailable}`);
  }
  return discovery;
}

/**
 * Whether `file` is instance `n`'s in account `accountId`, as on a rerun after a deploy: its
 * `workers.router.name` is the instance's router (`router`, which is `n` unless the instance was
 * deployed under a router name of its own) and its `accountId` is that account. Only then are the
 * Workers it names the instance's own. A router of the same name in another account (`--account`,
 * or another account picked) is another deployment, whose Worker names may be anyone's in this
 * account; so is a file whose `accountId` is still a placeholder, which was never deployed.
 */
export function fileIsInstance(file: Record<string, unknown>, accountId: string, n: string, router = n): boolean {
  const fileAccount = valueAtPath(file, ["accountId"]);
  return valueAtPath(file, ["workers", "router", "name"]) === router &&
    typeof fileAccount === "string" && !isPlaceholder(fileAccount) &&
    fileAccount.toLowerCase() === accountId.toLowerCase();
}

/**
 * The file's `gatekeepers` entries to remove, with a note each, when it is not the instance's
 * ({@link fileIsInstance}). Slugs discovery found stay: its edits rename them.
 */
export function foreignGatekeepers(
  file: Record<string, unknown>,
  accountId: string,
  n: string,
  discovery: Discovery,
  router = n,
): { removals: DeploymentEdit[]; note?: string } {
  const block = valueAtPath(file, ["gatekeepers"]);
  if (fileIsInstance(file, accountId, n, router) || !block || typeof block !== "object" || Array.isArray(block)) {
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
    note: `The file is not ${n}'s in account ${accountId} (its workers.router.name or accountId differs), so the ` +
      "Gatekeeper Workers its gatekeepers block names may be another deployment's, and are left alone. --out " +
      `removes their entries: ${listed.join(", ")}.`,
  };
}

/**
 * The Worker names `--out` leaves as the file has them unless discovery writes one, and their
 * placeholders. Discovery never writes the last two, and writes a built-in Gatekeeper's only where
 * the instance has that Gatekeeper.
 */
const UNDISCOVERED_WORKERS = [
  { path: ["workers", "context", "name"], placeholder: "<CONTEXT_WORKER_NAME>", builtIn: true },
  { path: ["workers", "scheduler", "name"], placeholder: "<SCHEDULER_WORKER_NAME>", builtIn: true },
  { path: ["workers", "websearch", "name"], placeholder: "<WEBSEARCH_WORKER_NAME>", builtIn: true },
  { path: ["workers", "customGatekeeper", "name"], placeholder: "<CUSTOM_GATEKEEPER_WORKER_NAME>", builtIn: false },
  { path: ["workers", "errorReporter", "name"], placeholder: "<ERROR_REPORTER_WORKER_NAME>", builtIn: false },
];

/** Where the PDF renderer's name goes: optional, so `--out` sets another deployment's to the instance's, not to a placeholder. */
const RENDERER_PATH = ["workers", "pdfRenderer", "name"];

/** Whose the file is, for a note on names it gives that may be another deployment's. */
function foreignFile(router: string, accountId: string, n: string, instanceRouter: string): string {
  // An instance under a router name of its own can share its name with another deployment's router.
  return router === n && instanceRouter !== n
    ? `The file is the deployment's whose router is ${router}, not ${n}'s in account ${accountId}, whose router is ${instanceRouter}`
    : `The file is ${router}'s, not ${n}'s in account ${accountId}`;
}

/** The router name the file gives, when it is not the instance's ({@link fileIsInstance}). */
function foreignRouter(file: Record<string, unknown>, accountId: string, n: string, instanceRouter: string): string | undefined {
  const router = valueAtPath(file, ["workers", "router", "name"]);
  return typeof router !== "string" || isPlaceholder(router) || fileIsInstance(file, accountId, n, instanceRouter)
    ? undefined : router;
}

/**
 * The edit setting the PDF renderer's name to the one the hosted deploy gives instance `n`'s, with a
 * note, when the file names a router but is not the instance's ({@link fileIsInstance}), names
 * another renderer, and `discovery` found the instance none: the name is then another deployment's,
 * which a deploy with Google would deploy over. Not a placeholder, which would stop a deployment
 * that never deploys one.
 */
export function foreignRenderer(
  file: Record<string, unknown>,
  accountId: string,
  n: string,
  instanceRouter = n,
  discovery?: Discovery,
): { reset?: DeploymentEdit; note?: string } {
  const router = foreignRouter(file, accountId, n, instanceRouter);
  const renderer = valueAtPath(file, RENDERER_PATH);
  const instanceRenderer = workerNames(n).pdfRenderer;
  if (router === undefined || typeof renderer !== "string" || renderer === instanceRenderer || discovery === undefined ||
      discovered(discovery, RENDERER_PATH.join("."))) {
    return {};
  }
  return {
    reset: { path: RENDERER_PATH, value: instanceRenderer },
    note: `${foreignFile(router, accountId, n, instanceRouter)}, so the PDF renderer name it gives, ` +
      `${RENDERER_PATH.join(".")} (${renderer}), may be that deployment's. ${rendererMove(n, instanceRenderer)}`,
  };
}

/** What becomes of a renderer name {@link foreignRenderer} resets. */
function rendererMove(n: string, instanceRenderer: string): string {
  return `${RENDERER_PATH.join(".")} goes to ${instanceRenderer} instead, the name the hosted deploy gives ` +
    `${n}'s: a placeholder would stop a deployment that deploys no PDF renderer.`;
}

/**
 * The edits setting Worker names back to placeholders when the file names a router but is not the
 * instance's ({@link fileIsInstance}): the custom Gatekeeper's and the Error Reporter's, which
 * discovery never writes, and each built-in Gatekeeper's `discovery` found the instance none of
 * (without `discovery`, the built-in ones are left alone: nothing says which it wrote). The PDF
 * renderer's goes to the name the hosted deploy gives the instance's ({@link foreignRenderer}).
 * `--out` would otherwise keep another deployment's names in a file that reads as this instance's.
 */
export function foreignWorkers(
  file: Record<string, unknown>,
  accountId: string,
  n: string,
  instanceRouter = n,
  discovery?: Discovery,
): { resets: DeploymentEdit[]; note?: string } {
  const router = foreignRouter(file, accountId, n, instanceRouter);
  if (router === undefined) return { resets: [] };
  const named = UNDISCOVERED_WORKERS.flatMap(({ path, placeholder, builtIn }) => {
    const name = valueAtPath(file, path);
    // A built-in Gatekeeper's name stands where discovery writes the instance's own over it.
    const kept = builtIn && (discovery === undefined || discovered(discovery, path.join(".")));
    return typeof name === "string" && !isPlaceholder(name) && !kept ? [{ path, placeholder, name }] : [];
  });
  const { reset: rendererReset } = foreignRenderer(file, accountId, n, instanceRouter, discovery);
  if (!named.length && !rendererReset) return { resets: [] };
  const listed = [...named, ...rendererReset ? [{ path: RENDERER_PATH, name: valueAtPath(file, RENDERER_PATH) as string }] : []];
  return {
    resets: [...named.map(({ path, placeholder }) => ({ path, value: placeholder })), ...rendererReset ? [rendererReset] : []],
    note: `${foreignFile(router, accountId, n, instanceRouter)}, so the Worker names it gives the rest may be ` +
      `that deployment's: ${listed.map(({ path, name }) => `${path.join(".")} (${name})`).join(", ")}.` +
      (named.length ? " --out sets them back to placeholders, and `pnpm cf-os init` asks for this deployment's." : "") +
      (rendererReset ? ` ${rendererMove(n, rendererReset.value as string)}` : ""),
  };
}

/**
 * The removal of the file's push identity, with a note, when the file is not the instance's
 * ({@link fileIsInstance}) and discovery found the instance none: the block is another deployment's
 * identity with the notification service, which a deploy of this one must not send.
 */
export function foreignPushIdentity(
  file: Record<string, unknown>,
  accountId: string,
  n: string,
  discovery: Discovery,
  router = n,
): { removals: DeploymentEdit[]; note?: string } {
  const path = [...PUSH_IDENTITY_PATH];
  const block = valueAtPath(file, path);
  const found = discovery.edits.some((edit) => edit.path.join(".") === path.join("."));
  if (block === undefined || block === null || found || fileIsInstance(file, accountId, n, router)) return { removals: [] };
  return {
    removals: [{ path, value: undefined }],
    note: `The file is not ${n}'s in account ${accountId}, so the push identity its ${path.join(".")} block holds is ` +
      "another deployment's, and this instance has none. --out removes the block.",
  };
}

/** Whether `discovery` found a value for config path `path`. */
function discovered(discovery: Discovery, path: string): boolean {
  return discovery.edits.some((edit) => edit.path.join(".") === path);
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
  // Only what no read supplies: the admins and the providers are the backend's own values wherever
  // its variables were read and carry them.
  lines.push(
    "",
    "Not part of the hosted deploy, so not discoverable -- set these by hand (`cf-os init` asks):",
    ...discovered(discovery, "access.admins") ? []
      : ["  access.admins              the admin emails (the wizard's admin email, at least)"],
    `  workers.customGatekeeper   a new name, e.g. "${n}-gk-custom"`,
    `  workers.errorReporter      a new name, e.g. "${n}-errors"`,
    ...discovered(discovery, "aiGateway.providers") ? []
      : ["  aiGateway.providers        add anthropic/openai if you stored keys on the gateway"],
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
      `its Workshop. If the instance is in another account, pass --account. ${CUSTOM_NAMES_HINT}`);
    return null;
  }
  if (!ctx.prompter) {
    ctx.out.log(`Hosted instances in account ${accountId}:\n\n${instances.map((n) => `  ${n}`).join("\n")}` +
      `\n\nThen: ${rerun}\n${CUSTOM_NAMES_HINT}`);
    return null;
  }
  return ctx.prompter.select("Which hosted instance?", instances.map((n) => ({ value: n, label: n })));
}

/** Why `instance` cannot be an instance name, as a usage error. */
export function checkInstanceName(instance: string | undefined): void {
  if (instance !== undefined && !WORKER_NAME.test(instance)) {
    throw new UsageError(`"${instance}" is not a Worker name. The instance name is the router Worker's, unless ` +
      "--router names another.");
  }
}

/** What a take-over reads of an instance before anything is pinned or written. */
export interface Inspection {
  /** The router and backend Worker names it was read under. */
  names: Required<CoreNames>;
  /** What the account holds. */
  inventory: Inventory;
  /** What the instance's Workers run. */
  hosted: HostedInstance;
}

/**
 * Reads instance `instance` of account `accountId`: the account's inventory, then what each of the
 * instance's Workers runs, under the router and backend names `flags` give or the hosted flow's
 * defaults. Read-only. `reads` is one run's cache (`cachedReads`): its quiet view, and whether a read
 * of it is still in flight, which is when the wait shows a spinner.
 */
export async function inspectInstance(
  ctx: Pick<Context, "prompter">,
  reads: { quiet: CloudflareClient; pending(): boolean },
  accountId: string,
  instance: string,
  flags: TakeoverFlags = {},
): Promise<Inspection> {
  const names = coreNames(instance, flags);
  // One spinner for the six reads, so it clears when fetchInventory settles, on its first failure
  // too, though later reads are still in flight. fetchInventory starts or reuses every read
  // synchronously, so `pending` already covers them all.
  const reading = fetchInventory(reads.quiet, accountId);
  const inventory = await (reads.pending() ? waitOn(ctx.prompter, INVENTORY_LABEL, () => reading) : reading);
  const hosted = await waitOn(ctx.prompter, INSTANCE_LABEL, () => readInstance(reads.quiet, accountId, names));
  return { names, inventory, hosted };
}

/**
 * Why what was read as instance `instance` is not one to take over under that name, as the lines to
 * print; null when it is. Three things, in order, each before anything is pinned or written:
 *
 * - Its Workers are not one instance's, whole (`instanceStops`, core/hosted-release.ts). An instance
 *   whose router or backend the account lacks reads as not found, with how to name one deployed
 *   under names of its own.
 * - What its Workers carry does not name `instance` (`instanceNameProblem`, core/discovery.ts):
 *   everything else is matched by that name, and a router and a backend called `X` and `X-backend`
 *   by the operator are found as an instance "X" that is not theirs.
 * - The account's list of Workers lacks its router or its backend, though each was read: the account
 *   changed between the two reads, and the values would be matched against a list that is not it.
 */
export function instanceRefusal(instance: string, { names, inventory, hosted }: Inspection): string | null {
  const unmoved = "Nothing was moved or written.";
  const stops = instanceStops(hosted);
  if (stops.length) {
    const missing = stops.some((stop) => stop.reason === "missing");
    return [
      missing
        ? `No hosted instance "${instance}" here: the account lacks its router Worker, its backend Worker, or both.`
        : `"${instance}" cannot be taken over as it was read:`,
      ...stops.map((stop) => `  ${stop.message}`),
      ...missing ? [`Check the instance name against the Worker list. ${CUSTOM_NAMES_HINT}`] : [],
      unmoved,
    ].join("\n");
  }
  const misnamed = instanceNameProblem(instance, inventory, names, hosted);
  if (misnamed !== null) return `${misnamed}\n${unmoved}`;
  const unlisted = [names.router, names.backend].filter((name) => !inventory.workers.some((worker) => worker.name === name));
  if (unlisted.length) {
    return `The account's list of Workers does not have ${unlisted.join(" or ")}, read a moment ago as "${instance}"'s: the ` +
      `account changed while it was being read. Run this again.\n${unmoved}`;
  }
  return null;
}

/**
 * Why `out`, the path `--out` gives, cannot be written, as a usage error: its directory is not
 * there, or it is a directory itself. Checked before anything is read, since by the time the file is
 * written the pin has moved.
 */
export async function checkOutPath(ctx: Context, out: string): Promise<void> {
  const path = resolve(ctx.cwd, out);
  const directory = await stat(dirname(path)).catch(() => null);
  if (!directory?.isDirectory()) {
    throw new UsageError(`--out ${out}: ${displayPath(ctx, dirname(path))} is not a directory. Nothing was moved or written.`);
  }
  if ((await stat(path).catch(() => null))?.isDirectory()) {
    throw new UsageError(`--out ${out} is a directory, not a file to write. Nothing was moved or written.`);
  }
}

/** What `hosted`'s Workers run, for the report: each one's release, the instance's, and the Workers changed by hand. */
export function formatInstance(hosted: HostedInstance): string {
  const edited = formatHandEdited(hosted.handEdited);
  return ["What its Workers run:", ...formatReleases(hosted), ...edited.length ? ["", ...edited] : []].join("\n");
}

/**
 * Moves the Cloudflare OS pin forward to a commit, or with `dryRun` only compares the two, refusing
 * when that would leave the pin behind one of `atLeast`'s commits: `movePin` (update.ts), which a
 * test stands in for.
 */
export type PinMover = (
  to: string,
  ctx: Context,
  options?: { dryRun?: boolean; atLeast?: readonly string[] },
) => Promise<PinMove>;

/** Where the project's pin stands to the commit the instance's release was built from, once {@link settlePin} is through. */
export interface PinOutcome {
  /**
   * Whether the take-over may go on. With `write`, only when the pin is at or past the commit. Without
   * it, always: a report of a pin behind is still the report asked for.
   */
  ok: boolean;
  /** The release the commit is the commit of; null when `--commit` came with no release to go with it. */
  release: string | null;
  /** The commit: its full SHA once upstream's history gave it, else as it was decided. */
  commit: string;
  /** Where the commit came from: `--commit`, or the release id's abbreviated one. */
  source: "flag" | "release";
  /** The project's pin, as it stands when this returns; null when it could not be read. */
  pin: string | null;
  /** Whether that pin is behind the commit; null when the two could not be compared. */
  behind: boolean | null;
  /** Whether this run moved the pin. */
  moved: boolean;
}

/** `count` commits, said; nothing when they could not be counted. */
const byCommits = (count: number | null) => count === null ? "" : ` by ${count} commit${count === 1 ? "" : "s"}`;

/** What running older code over the instance costs: why a pin behind stops a take-over. */
const DOWNGRADE = "deploying it would put older code over storage the instance has already migrated, which cannot be undone";

/**
 * What the `pnpm cf-os update --to <sha>` a stopped take-over names does beyond the take-over's own
 * move, said wherever that command is printed: run without a terminal, it merges the starter with no
 * question asked.
 */
const UPDATE_MERGES = "That is the command-line `update`, which merges the starter's main as well as moving the pin: " +
  "at a terminal it asks first, and without one it merges unasked. Running this again moves the pin alone.";

/**
 * Holds the project's pin against the commit `decision` names, and says where it stands. With
 * `write`, a pin behind is moved forward to it (`move`): the pin alone, staged and uncommitted, the
 * starter never merged, and never backwards. Without it nothing is moved, only compared. `ask` lets
 * the move be confirmed at a terminal; otherwise it is made unasked, as the command asked for it.
 *
 * With `write`, anything short of a pin at or past the commit is `ok: false`, said with what to do:
 * the project is not safe to deploy over the instance.
 *
 * The commits the instance's own Workers name beside it (`decision.atLeast`) are held too: a pin
 * that would be left behind one of them, or that cannot be placed against it, is `ok: false` with or
 * without `write`, as the command is then not one for what the instance runs.
 */
export async function settlePin(
  ctx: Context,
  decision: Extract<CommitDecision, { ok: true }>,
  { write, ask = false }: { write: boolean; ask?: boolean },
  move: PinMover = movePin,
): Promise<PinOutcome> {
  const { release, from: source } = decision;
  const of = release === null ? "the commit --commit names" : `release ${release}`;
  const atLeast = decision.atLeast ?? [];
  const reported = atLeast
    .map(({ workers, release: named, commit: floor }) => `${named} (commit ${floor}, reported by ${workers.join(", ")})`)
    .join("; ");
  const result = await move(decision.commit, ask ? ctx : { ...ctx, prompter: null },
    // Once each: two releases built from one commit are two floors, one commit to place.
    { dryRun: !write, ...atLeast.length ? { atLeast: [...new Set(atLeast.map(({ commit: floor }) => floor))] } : {} });
  // The full SHA, once upstream's history gave it; until then, the commit as decided.
  const commit = result.to || decision.commit;
  const outcome = (fields: Pick<PinOutcome, "ok" | "pin" | "behind" | "moved">): PinOutcome =>
    ({ release, commit, source, ...fields });
  ctx.out.log(release === null
    ? `Taking it over at cloudflare-os commit ${commit}, which --commit names; no Worker says which release that is.`
    : `Release ${release} was built from cloudflare-os commit ${commit}` +
      (source === "flag" ? ", which --commit names." : ", the commit its id ends in."));
  const unsafe = "The project is not safe to deploy over the instance yet. Nothing was written.";
  // Said of a pin that is where the take-over leaves it, or with a comparison alone, where --out would.
  if (atLeast.length && (result.status === "current" || result.status === "moved" || result.status === "behind")) {
    ctx.out.log(`The instance's Workers themselves report ${reported}: where this leaves the pin is at or past ` +
      `${atLeast.length === 1 ? "that commit" : "those commits"} too.`);
  }
  switch (result.status) {
    case "current":
      ctx.out.log(result.past
        ? `This project pins cloudflare-os at ${result.from}: the project is already at or past the instance's ` +
          "release; deploying is an upgrade."
        : "This project pins cloudflare-os at that commit: deploying is the release the instance already runs.");
      return outcome({ ok: true, pin: result.from, behind: false, moved: false });
    case "behind":
      ctx.out.log(`This project pins cloudflare-os at ${result.from}, which is behind ${of}${byCommits(result.commits)}: ` +
        `${DOWNGRADE}.` + (write ? "" : " --out moves the pin forward to it first, staged and not committed."));
      // A comparison only: with `write` the pin is still behind, so the take-over stops.
      if (write) ctx.out.log(unsafe);
      return outcome({ ok: !write, pin: result.from, behind: true, moved: false });
    case "moved":
      if (result.problems.length) {
        ctx.out.log(`The cloudflare-os pin is at ${result.to}, staged and not committed, but the move left work undone:\n` +
          `${result.problems.map((problem) => `  ${problem}`).join("\n")}\nThe project does not build until that is dealt ` +
          "with. Nothing was written: deal with it, then run this again.");
        return outcome({ ok: false, pin: result.to, behind: false, moved: true });
      }
      ctx.out.log(`Moved the cloudflare-os pin from ${result.from} forward to it${byCommits(result.commits)}, staged and ` +
        `not committed, as \`pnpm cf-os update --to\` leaves it. ${displayPath(ctx, result.brief)} says what the move ` +
        "brings, and what to check before committing it.");
      return outcome({ ok: true, pin: result.to, behind: false, moved: true });
    case "declined":
      ctx.out.log(`The pin was not moved: it is still ${result.from}, behind ${of}, and ${DOWNGRADE}. ${unsafe}\n` +
        `Run this again and accept the move, or make it with \`${result.command}\`. ${UPDATE_MERGES}`);
      return outcome({ ok: false, pin: result.from, behind: true, moved: false });
    case "blocked": {
      const pin = result.from ?? null;
      if (result.cause === "floor") {
        ctx.out.log([
          `The instance's Workers themselves report ${reported}, and where commit ${commit} leaves the pin is not shown ` +
            `to be at or past ${atLeast.length === 1 ? "that commit" : "those commits"}:`,
          result.reason,
          "Deploying a pin behind a commit a Worker runs would put older code over storage the instance has already " +
            "migrated, which cannot be undone, so the command is not one for what the instance runs. Get a fresh one " +
            "from the deploy flow, or leave --release and --commit out to take the instance over at the release its " +
            "Workers report. Where that stops too (a later build from an older revision), move the pin forward first, " +
            "to a commit at or past every one above, with `pnpm cf-os update --to <commit>`, then run this again " +
            "without --release and --commit: a pin already past the release is held to these commits where it stands.",
          "Nothing was moved or written.",
        ].join("\n"));
        return outcome({ ok: false, pin, behind: null, moved: false });
      }
      if (!write) {
        ctx.out.log(result.behind
          ? `This project pins cloudflare-os at ${pin}, which is behind ${of}: ${DOWNGRADE}. --out moves the pin ` +
            `forward first, which the checkout is not ready for:\n${result.reason}`
          : `Whether this project's cloudflare-os pin${pin === null ? "" : ` (${pin})`} is behind ${of} could not be ` +
            `told:\n${result.reason}`);
        return outcome({ ok: true, pin, behind: result.behind ? true : null, moved: false });
      }
      ctx.out.log([
        result.behind
          ? `This project pins cloudflare-os at ${pin}, which is behind ${of}, and the pin could not be moved forward:`
          : `This project's cloudflare-os pin${pin === null ? "" : ` (${pin})`} is not known to be at or past ${of}, ` +
            "and could not be moved there:",
        result.reason,
        unsafe,
        result.command === undefined
          ? "Deal with the above, then run this again."
          : `Deal with the above, then run this again, or move the pin with \`${result.command}\`. ${UPDATE_MERGES}`,
      ].join("\n"));
      return outcome({ ok: false, pin, behind: result.behind ? true : null, moved: false });
    }
  }
}

/**
 * What `import` prints on stdout of the release beside the config values: the pin's standing
 * ({@link PinOutcome}) under the release's own id.
 */
export interface ReleaseSummary extends Omit<PinOutcome, "ok" | "release"> {
  /** The release the instance counts as running; null when only `--commit` says what to pin. */
  id: string | null;
}

/**
 * `import`'s result on stdout: the `deployment.jsonc` fragment `--out` writes, with two keys beside
 * it that are no part of the file. `release` is the release the instance runs and where the
 * project's pin stands to it; `handEdited` lists the Workers changed by hand since the hosted flow
 * deployed them, whose changes a deploy overwrites.
 */
export function importResult(
  discovery: Discovery,
  pin: PinOutcome,
  handEdited: readonly HandEditedWorker[],
): Record<string, unknown> {
  const release: ReleaseSummary = {
    id: pin.release, commit: pin.commit, source: pin.source, pin: pin.pin, behind: pin.behind, moved: pin.moved,
  };
  return { ...editsAsFragment(discovery.edits), release, handEdited: [...handEdited] };
}

/**
 * `cf-os import`, against the catalog `catalog` reads from the project at its root, moving or
 * comparing the pin with `pin`.
 */
export async function run(
  args: CommandArgs,
  ctx: Context,
  catalog: (root: string) => Promise<GatekeeperCatalog> = loadCatalog,
  pin: PinMover = movePin,
): Promise<number> {
  let instance: string | undefined = args.positionals[0];
  checkInstanceName(instance);
  const flags = takeoverFlags(args.values);
  const out = args.values.out as string | undefined;
  if (out !== undefined) await checkOutPath(ctx, out);
  const inPath = configPath(ctx);
  const where = displayPath(ctx, inPath);
  const file = parseDeployment(await readFile(inPath, "utf8"), where);
  const cache = cachedReads(await ctx.client());
  const { quiet } = cache;
  const client = cache.loud(ctx.prompter);
  // A flag given once is in every command this prints, so it need not be given again.
  const given = takeoverArgs(flags).join(" ");

  const account = await resolveAccount(ctx, client, file, {
    question: "Which account is the hosted instance in?",
    rerun: ["pnpm cf-os import", instance, "--account <id>", given].filter(Boolean).join(" "),
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
    ["pnpm cf-os import <instance>", accountFlag, given].filter(Boolean).join(" ")) ?? undefined;
  if (!instance) return 1;

  const inspection = await inspectInstance(ctx, cache, account.id, instance, flags);
  const { names, inventory, hosted } = inspection;
  ctx.out.log(`Hosted instance "${instance}" in account ${account.id}:\n`);
  const refusal = instanceRefusal(instance, inspection);
  if (refusal) {
    ctx.out.log(refusal);
    return 1;
  }
  ctx.out.log(`${formatInstance(hosted)}\n`);

  // Which commit the project must not be behind, then where its pin stands to it. With --out the pin
  // is moved before the catalog is read, which is the submodule's at that pin, and before any write.
  const decision = decideCommit(hosted.reports, flags);
  if (!decision.ok) {
    ctx.out.log(`${decision.message}\nNothing was moved or written.`);
    return 1;
  }
  const standing = await settlePin(ctx, decision, { write: out !== undefined }, pin);
  if (!standing.ok) return 1;

  const discovery = discoverInstance(instance, inventory, await catalog(ctx.root), { names, instance: hosted });
  const { removals, note } = foreignGatekeepers(file, account.id, instance, discovery, names.router);
  if (note) discovery.notes.push(note);
  const { resets, note: workersNote } = foreignWorkers(file, account.id, instance, names.router, discovery);
  if (workersNote) discovery.notes.push(workersNote);
  const { removals: pushRemovals, note: pushNote } = foreignPushIdentity(file, account.id, instance, discovery, names.router);
  if (pushNote) discovery.notes.push(pushNote);

  ctx.out.log(`\n${formatReport(instance, discovery)}`);
  // What `instanceRefusal` let through has both, so this holds only where discovery disagrees with it.
  if (!discovery.matched) {
    ctx.out.log(`\nNo hosted instance "${instance}" here: it has no router and Workshop Workers. Nothing was ` +
      `written${standing.moved ? `, but the cloudflare-os pin had moved to ${standing.pin}, staged and not committed, and stays there` : ""}. ` +
      `Check the instance name against the Worker list. ${CUSTOM_NAMES_HINT}`);
    return 1;
  }
  if (account.isNew) discovery.edits.unshift({ path: ["accountId"], value: account.id });
  const result = importResult(discovery, standing, hosted.handEdited);
  if (out) {
    const outPath = resolve(ctx.cwd, out);
    const outWhere = displayPath(ctx, outPath);
    try {
      await updateDeployment(inPath, [...discovery.edits, ...removals, ...pushRemovals, ...resets], outPath);
    } catch (error) {
      // The move came first and is not undone: the pin forward is the safe side to be left on.
      if (standing.moved) {
        ctx.out.log(`\n${outWhere} could not be written, and nothing was. The cloudflare-os pin had moved to ${standing.pin}, ` +
          "staged and not committed, and stays there: run this again once the file can be written.");
      }
      throw error;
    }
    // The result follows the write, so a run that wrote nothing prints none.
    ctx.out.json(result);
    const removed = removals.length
      ? `, removing ${removals.length} gatekeepers ${removals.length === 1 ? "entry" : "entries"}` : "";
    const unpushed = pushRemovals.length ? `, removing ${PUSH_IDENTITY_PATH.join(".")}` : "";
    const placeheld = resets.filter(({ value }) => isPlaceholder(value));
    const reset = (placeheld.length ? `, setting ${placeheld.map(({ path }) => path.join(".")).join(" and ")} back to placeholders` : "") +
      resets.filter(({ value }) => !isPlaceholder(value)).map(({ path, value }) => `, setting ${path.join(".")} to ${String(value)}`).join("");
    ctx.out.log(`\nWrote ${discovery.edits.length} values to ${outWhere}${removed}${unpushed}${reset} (local file only; nothing in ` +
      `the account changed). Review it${outPath === inPath ? ` with \`git diff ${outWhere}\`` : ""}, ` +
      "fill in what is listed above, then run `pnpm cf-os check` and, once it passes, `pnpm cf-os deploy`." +
      (standing.moved ? " The cloudflare-os pin moved with it, staged and not committed: review that too." : ""));
  } else {
    ctx.out.json(result);
    // The whole command, so a choice made at a prompt does not have to be made again.
    const rerun = ["pnpm cf-os import", instance, accountFlag, given,
      ctx.flags.config ? `--config ${ctx.flags.config}` : "", `--out ${where}`];
    ctx.out.log(`\nNothing written; the values are on stdout. To fill them into ${where}` +
      `${standing.behind ? ", moving the pin first" : ""}:\n  ` + rerun.filter(Boolean).join(" "));
  }
  return 0;
}
