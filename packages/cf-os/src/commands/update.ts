// `cf-os update [--ref <branch>] [--template <git-url|path>] [--upstream] [--to <ref> [--preview]] [--submodule <path>] [--dry-run]`
//
// Brings a project up to date with the starter: merges the starter's branch into it, checks the
// Cloudflare OS submodule out at the pin that merge brings, installs, and writes `.cf-os/update.md`,
// a brief for the operator's coding agent: what changed in both repositories, what conflicted, and
// how to finish. Conflicts are left to git; nothing is resolved here. When the root `package.json`
// has an `api:generate` script, as the starter's does, it then regenerates `cf-os api`'s committed
// files from the new pin and leaves them unstaged, for review with it, listing the commands changed
// since the commit the update started from.
//
// The starter is fetched from its URL, not through a remote, so this works whether the project kept
// the `starter` remote `init` made, renamed it or removed it. The submodule follows the starter's
// pin, which the starter has already adapted itself to. `--upstream` moves it on to upstream's
// `main` instead, staged and not committed: that pin is unreviewed, and the operator skill's upgrade
// gate applies before it is committed. `--to` pins a given commit on upstream's `main` the same way:
// one with green CI, the fix for a broken `main`, a step part of the way, or an older one, a rollback.
// With `--preview` it also takes an upstream branch or pull request that is not on `main`, for a merge
// request's preview deploy: committed on that branch, and moved to `main` before it merges.
//
// Any other repository that pins Cloudflare OS (one without `deployment.jsonc` at its root, which is
// what marks a starter project) gets the pin move alone: there is no starter to merge, so no reviewed
// pin to take, and `--upstream` is required. The submodule is whichever `.gitmodules` entry points at
// upstream, or `--submodule`'s.
//
// It runs in the copy that was started and is never handed to the project's own (main.ts): it is
// what replaces that copy, and a project older than this command does not have it. So, like
// scaffolding, it is on the packed path: node builtins and this package's dependency-free modules.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { displayPath, type CommandArgs, type Context } from "../context.ts";
import { defaultSpawn, succeeded, type SpawnTool } from "../tools.ts";
import { DEFAULT_TEMPLATE, UPSTREAM } from "./scaffold.ts";

/** The starter branch merged by default. */
export const DEFAULT_REF = "main";

/** The brief, relative to the repository root. */
export const BRIEF = join(".cf-os", "update.md");

/** Where a starter project has the submodule, whatever its URL. */
const STARTER_SUBMODULE = "cloudflare-os";

/** The operator skill's references on the starter's `main`, for repositories that do not have them merged in. */
const REFERENCES = `${DEFAULT_TEMPLATE}/blob/main/.agents/skills/cloudflare-os-operator/references`;

/** Upstream's Gatekeeper contract, `@gadgets/workshop-shared/gatekeeper` and `/cloudflare-gatekeeper`. */
const CONTRACT = ["packages/workshop-shared/src/gatekeeper.ts", "packages/workshop-shared/src/cloudflare-gatekeeper.ts"];

/** Lines of a failed tool's output shown; the install's can run to hundreds. */
const OUTPUT_TAIL = 40;

/** Commits listed per repository in the terminal; the brief lists them all. */
const LISTED = 20;

/** The root script that regenerates `cf-os api`'s committed files from the pin, printing what changed as JSON. */
const API_GENERATE = "api:generate";

/** API commands listed per kind (added, removed, changed), in the terminal and the brief. */
const API_LISTED = 20;

/** What updating runs against, so tests can record the sequence instead of running it. */
export interface UpdateDeps {
  spawn: SpawnTool;
  /** The time the brief is stamped with. */
  now(): Date;
}

function defaultDeps(): UpdateDeps {
  return { spawn: defaultSpawn(), now: () => new Date() };
}

/** Runs git in the repository root, capturing its output. */
function git(ctx: Context, deps: UpdateDeps, args: string[]): ReturnType<SpawnTool> {
  return deps.spawn("git", args, { cwd: ctx.root, capture: true });
}

/** git's trimmed output, or a thrown `failure` when it does not succeed. */
function gitValue(ctx: Context, deps: UpdateDeps, args: string[], failure: string): string {
  const result = git(ctx, deps, args);
  if (result.error) throw new Error(`Could not run git: ${result.error.message}`);
  if (result.status !== 0) throw new Error(failure);
  return result.stdout.trim();
}

/**
 * One line per commit in `range`, a range or revisions such as `[a, "^b"]` (touching `paths`, when
 * given), newest first: `<short sha> <subject>`. Undefined when git cannot say.
 */
function commits(
  ctx: Context, deps: UpdateDeps, range: string | string[], submodule?: string, paths: string[] = [],
): string[] | undefined {
  const where = submodule ? ["-C", submodule] : [];
  const revisions = typeof range === "string" ? [range] : range;
  const result = git(ctx, deps, [...where, "log", "--format=%h %s", ...revisions, ...paths.length ? ["--", ...paths] : []]);
  if (!succeeded(result)) return undefined;
  return result.stdout.split("\n").filter(Boolean);
}

/** Whether the submodule is a shallow clone, as `init` makes it. */
function isShallow(ctx: Context, deps: UpdateDeps, path: string): boolean {
  return git(ctx, deps, ["-C", path, "rev-parse", "--is-shallow-repository"]).stdout.trim() === "true";
}

/**
 * Fetches `what`, a branch or a commit, from upstream into the submodule. The clone `init` makes is
 * shallow, and a commit fetched into a shallow clone arrives as a new shallow root, cut off from the
 * old pin, so `old..new` would list one commit. A shallow one is therefore deepened back to just
 * before the oldest of `joined`'s commit times, which joins them.
 */
function fetchUpstream(ctx: Context, deps: UpdateDeps, path: string, what: string, joined: string[]): ReturnType<SpawnTool> {
  const shallow = isShallow(ctx, deps, path);
  const times = joined.map((commit) => Number(git(ctx, deps, ["-C", path, "log", "-1", "--format=%ct", commit]).stdout.trim()))
    .filter(Boolean);
  const since = shallow && times.length
    ? [`--shallow-since=${new Date((Math.min(...times) - 1) * 1000).toISOString().replace(/\.\d+Z$/, "Z")}`]
    : [];
  return deps.spawn("git", ["-C", path, "fetch", "--no-tags", ...since, UPSTREAM, what], { cwd: ctx.root, capture: false });
}

/**
 * The pin HEAD has once `target`'s `count` commits are merged, as git's merge decides it: the starter's,
 * unless the project moved its own pin since the two diverged and the starter did not (an earlier
 * `update --upstream`, committed), or both moved it and the project's descends from the starter's,
 * which git fast-forwards to. With nothing to merge, the project's own. Both moved otherwise, the
 * gitlink conflicts, and the starter's is the one offered.
 */
function pinAfterMerge(
  ctx: Context, deps: UpdateDeps, path: string, target: string, count: number, oldPin: string, starterPin: string,
): string {
  if (!count || starterPin === oldPin) return oldPin;
  const base = git(ctx, deps, ["merge-base", "HEAD", target]).stdout.trim();
  if (!base) return starterPin;
  const basePin = git(ctx, deps, ["rev-parse", `${base}:${path}`]).stdout.trim();
  if (basePin === starterPin) return oldPin;
  if (basePin === oldPin) return starterPin;
  const descends = (older: string, newer: string) =>
    succeeded(git(ctx, deps, ["-C", path, "merge-base", "--is-ancestor", older, newer]));
  return descends(basePin, starterPin) && descends(starterPin, oldPin) ? oldPin : starterPin;
}

/** What lies between two pins, as far as the submodule can see. */
type PinRange = Pick<Update, "submodule" | "contract" | "dropped" | "droppedContract" | "unrelated" | "rollback">;

/** A range with nothing in it. */
const EMPTY_RANGE: PinRange = { submodule: [], contract: [], dropped: [], droppedContract: [], unrelated: false, rollback: false };

/** A range that could not be listed. */
const UNLISTED: PinRange = {
  submodule: undefined, contract: undefined, dropped: undefined, droppedContract: undefined, unrelated: false, rollback: false,
};

/**
 * The range between `oldPin` and `newPin`, listed only when the submodule sees one descend from the
 * other. When the new pin is the older, it is a rollback, and the range is the commits that leave. When
 * neither holds the other but they share history (a branch that left `main` before the old pin), the
 * range is the new pin's own commits, and `dropped` the old pin's that it does not have.
 */
function pinRange(ctx: Context, deps: UpdateDeps, path: string, oldPin: string, newPin: string): PinRange {
  const forward = git(ctx, deps, ["-C", path, "merge-base", "--is-ancestor", oldPin, newPin]);
  const back = succeeded(forward) ? undefined : git(ctx, deps, ["-C", path, "merge-base", "--is-ancestor", newPin, oldPin]);
  if (back && !succeeded(back)) {
    // Exit 1 is a definite no; anything else, git could not tell.
    const definite = forward.status === 1 && back.status === 1;
    const base = definite ? git(ctx, deps, ["-C", path, "merge-base", oldPin, newPin]) : undefined;
    if (!base || !succeeded(base)) return { ...UNLISTED, unrelated: definite };
    return {
      submodule: commits(ctx, deps, `${oldPin}..${newPin}`, path),
      contract: commits(ctx, deps, `${oldPin}..${newPin}`, path, CONTRACT),
      dropped: commits(ctx, deps, `${newPin}..${oldPin}`, path),
      droppedContract: commits(ctx, deps, `${newPin}..${oldPin}`, path, CONTRACT),
      unrelated: false,
      rollback: false,
    };
  }
  const range = back ? `${newPin}..${oldPin}` : `${oldPin}..${newPin}`;
  return {
    ...EMPTY_RANGE,
    submodule: commits(ctx, deps, range, path),
    contract: commits(ctx, deps, range, path, CONTRACT),
    rollback: Boolean(back),
  };
}

/** Whether a submodule URL is upstream's: https or ssh, with or without `.git`. */
function isUpstream(url: string): boolean {
  return /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[:/]cloudflare\/cloudflare-os(?:\.git)?\/?$/i.test(url.trim());
}

/**
 * The Cloudflare OS submodule, from `git config -f .gitmodules --get-regexp ^submodule\.`'s output:
 * `given` (`--submodule`), else the one entry whose URL is upstream's, else one at `cloudflare-os/`,
 * where a starter project has it even when it pins a fork.
 */
export function findSubmodule(gitmodules: string, given?: string): { path: string; url?: string } {
  const entries = new Map<string, { path?: string; url?: string }>();
  for (const line of gitmodules.split("\n")) {
    const match = /^submodule\.(.+)\.(path|url)\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, name, key, value] = match;
    entries.set(name, { ...entries.get(name), [key]: value });
  }
  const submodules = [...entries.values()].flatMap(({ path, url }) => path ? [{ path, url }] : []);
  const at = (path: string) => submodules.find((entry) => entry.path === path);
  if (given) {
    const path = given.replace(/^\.\//, "").replace(/\/+$/, "");
    const found = at(path);
    if (!found) throw new Error(`.gitmodules has no submodule at ${path}.`);
    return found;
  }
  const upstream = submodules.filter((entry) => entry.url && isUpstream(entry.url));
  if (upstream.length > 1) {
    throw new Error(`Several submodules point at ${UPSTREAM} (${upstream.map((entry) => entry.path).join(", ")}). ` +
      "Name the one to update with --submodule <path>.");
  }
  if (upstream.length) return upstream[0];
  const starter = at(STARTER_SUBMODULE);
  if (starter) return starter;
  throw new Error(`No submodule in .gitmodules points at ${UPSTREAM}. If this repository pins Cloudflare OS from ` +
    "somewhere else (a fork, say), name its submodule with --submodule <path>.");
}

/** A GitHub compare page between two commits of `repository`, when it is on GitHub. */
function compareLink(repository: string, from: string, to: string): string | undefined {
  const github = /^https:\/\/github\.com\/[^/]+\/[^/]+?(?:\.git)?\/?$/.exec(repository);
  return github ? `${repository.replace(/(?:\.git)?\/?$/, "")}/compare/${from}...${to}` : undefined;
}

const short = (sha: string) => sha.slice(0, 7);

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Everything one run found and did, which the summary and the brief are both written from. */
interface Update {
  /** Whether this is a starter project, which merges the starter; otherwise only the pin moves. */
  isStarter: boolean;
  /** The submodule's path in the repository. */
  path: string;
  /** `--submodule`, when it was given. */
  givenSubmodule: string | undefined;
  template: string;
  ref: string;
  oldHead: string;
  target: string;
  /** Starter commits the merge brings, newest first. */
  starter: string[];
  oldPin: string;
  /** The starter's pin at `target`; the old pin when there is no starter. */
  starterPin: string;
  /**
   * The pin the merge leaves: the starter's, unless the project moved its own since the two diverged
   * and the starter did not, or there is nothing to merge. The old pin when there is no starter.
   */
  mergedPin: string;
  /** Where the submodule ends up: the merged pin, or upstream's with `--upstream` or `--to`. */
  newPin: string;
  upstream: boolean;
  /** `--to`'s ref, when the pin goes there rather than to upstream's `main`. */
  to: string | undefined;
  /** Upstream commits from the old pin to the new one, or back from it in a rollback; undefined when they could not be listed. */
  submodule: string[] | undefined;
  /** Whether the new pin is older than the old one, so the commits above leave. */
  rollback: boolean;
  /** The old pin's commits the new one does not have, when neither holds the other; undefined when unlisted. */
  dropped: string[] | undefined;
  /** Those of them that change the Gatekeeper contract. */
  droppedContract: string[] | undefined;
  /** Whether the new pin is a preview: `--to` an upstream branch or pull request not on `main`. */
  preview: boolean;
  /** Those of them that change the Gatekeeper contract; undefined when they could not be listed. */
  contract: string[] | undefined;
  /**
   * With `--upstream` or `--to` in a starter project, the merged pin's commits that neither the staged
   * pin nor the old one has: the starter's code was adapted to them. Undefined when unlisted.
   */
  starterLeftOut: string[] | undefined;
  /** Those of them that change the Gatekeeper contract. */
  starterLeftOutContract: string[] | undefined;
  /** Whether the old pin is outside the new one's history, so there is no range at all. */
  unrelated: boolean;
  /** `.gitmodules`' URL for the submodule, when it is not upstream's: the new pin may not be there. */
  foreignUrl: string | undefined;
  merge: "none" | "merged" | "conflicted";
  conflicts: string[];
  /** Whether the new pin was checked out and staged (`--upstream` only). */
  staged: boolean;
  /** Whether the root has a `package.json` to install. */
  installable: boolean;
  installed: boolean;
  /** `pnpm run api:generate`'s outcome; undefined when the root `package.json` has no such script. */
  api: ApiGeneration | undefined;
  /** Steps that did not complete, each with its fix. */
  problems: string[];
}

/**
 * What `pnpm run api:generate` did: regenerated the files (those listed changed, and the commands
 * between them, as space-joined paths such as `open-gadget get-chat-history`), failed, or did not run
 * because the install did not complete.
 */
type ApiGeneration = GeneratedApi | { status: "failed" } | { status: "not-run" };

/** `api:generate`'s result: the repository-relative files it rewrote, and the commands added, removed and changed. */
type GeneratedApi = { status: "generated"; files: string[]; added: string[]; removed: string[]; changed: string[] };

/** The root of the git checkout the command was run in. */
function repositoryRoot(ctx: Context, deps: UpdateDeps): string {
  const top = deps.spawn("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, capture: true });
  if (top.error) throw new Error(`Could not run git: ${top.error.message}`);
  if (top.status !== 0) throw new Error(`${ctx.cwd} is not a git checkout, so there is nothing to update.`);
  return resolve(top.stdout.trim());
}

/** Fails unless the checkout can take a merge, or a moved pin. */
function preconditions(ctx: Context, deps: UpdateDeps, path: string): { staleCheckout: boolean } {
  if (succeeded(git(ctx, deps, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]))) {
    throw new Error("A merge is already in progress. Finish it (resolve, then `git commit`) or abandon it " +
      "(`git merge --abort`), then run update again.");
  }
  // Not trimmed: the first column is significant.
  const status = git(ctx, deps, ["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=dirty"]);
  if (!succeeded(status)) throw new Error("Could not read the checkout's status (`git status`).");
  const lines = status.stdout.split("\n").filter(Boolean);
  // The submodule checked out somewhere other than its pin, unstaged: usually a `git pull` that did
  // not update it. Checking out the pin is part of updating, so that is not in the way, unless it
  // would leave commits made in the submodule that nothing else keeps.
  const staleCheckout = lines.includes(` M ${path}`);
  if (staleCheckout) {
    const head = git(ctx, deps, ["-C", path, "rev-parse", "HEAD"]).stdout.trim();
    const pin = git(ctx, deps, ["rev-parse", `HEAD:${path}`]).stdout.trim();
    // Kept by the pin's history, by a ref of the submodule's, or by a gitlink any commit here records (a
    // preview pin committed on another branch, fetched by URL into no ref of the submodule's).
    const kept = succeeded(git(ctx, deps, ["-C", path, "merge-base", "--is-ancestor", head, pin])) ||
      git(ctx, deps, ["-C", path, "for-each-ref", "--contains", head, "--count=1"]).stdout.trim() !== "" ||
      git(ctx, deps, ["log", "--all", "--format=", "--raw", "--no-abbrev", "--", path]).stdout.split("\n")
        .some((line) => line.split(" ")[3] === head);
    if (!kept) {
      throw new Error(`${path} is checked out at ${short(head)}, which nothing keeps (no branch or tag of it, and no commit here pins it), and updating ` +
        `would check out the pin instead. Keep it first (\`git -C ${path} branch <name> ${short(head)}\`), then run ` +
        "update again.");
    }
  }
  const changed = lines.filter((line) => line !== ` M ${path}`);
  if (changed.length) {
    // Usually the pin an earlier `update --upstream` staged, which stashing would not obviously undo.
    const staged = changed.some((line) => line[0] !== " " && line.slice(3) === path);
    throw new Error("The checkout has uncommitted changes, and updating needs a clean one. Commit or stash " +
      `them (\`git stash\`), then run update again:\n${changed.map((line) => `  ${line}`).join("\n")}` +
      (staged ? `\nThe ${path} pin is staged, by an earlier update perhaps: commit it, or drop it with ` +
        `\`git restore --staged ${path}\`.` : ""));
  }
  return { staleCheckout };
}

/** The upstream ref the pin goes to with `--upstream` or `--to`, a full SHA shortened. */
const upstreamRef = (state: Update) => state.to && /^[0-9a-f]{40}$/i.test(state.to) ? short(state.to) : state.to ?? "main";

/** Commits for the terminal, indented, the first {@link LISTED} only. */
function listed(lines: string[]): string[] {
  return [
    ...lines.slice(0, LISTED).map((line) => `  ${line}`),
    ...lines.length > LISTED ? [`  … ${lines.length - LISTED} more in ${BRIEF}`] : [],
  ];
}

/** The terminal's account of what is coming. */
function describe(ctx: Context, state: Update): void {
  if (state.isStarter) {
    ctx.out.log([
      state.starter.length
        ? `Starter (${state.template} ${state.ref}): ${plural(state.starter.length, "new commit")}.`
        : "Starter: no new commits.",
      ...listed(state.starter),
    ].join("\n"));
  }
  if (state.newPin === state.oldPin) return;
  const leaves = state.dropped?.length ? `, leaves out ${state.dropped.length}` : "";
  const count = state.submodule
    ? ` (${state.rollback ? "rolls back " : ""}${plural(state.submodule.length, "commit")}${leaves})`
    : "";
  const where = state.preview ? `, a preview pin not on main, to be staged` : ", to be staged for review";
  ctx.out.log([
    `${state.path}: ${short(state.oldPin)} → ${short(state.newPin)}${count}` +
      `${state.upstream ? `, upstream's ${upstreamRef(state)}${where}` : ", the starter's pin"}.`,
    ...state.submodule
      ? listed(state.submodule)
      : [state.unrelated
        ? "  Its commits cannot be listed: the old pin is not in the new one's history."
        : "  Its commits could not be listed: see the brief's compare link."],
    ...state.dropped?.length
      ? [`  Leaves out ${plural(state.dropped.length, "commit")} the current pin has:`, ...listed(state.dropped)]
      : [],
    ...state.droppedContract?.length
      ? [`  Gatekeeper contract: ${plural(state.droppedContract.length, "change")} the current pin has are left out.`]
      : [],
    ...state.starterLeftOut?.length
      ? [`  Leaves out ${plural(state.starterLeftOut.length, "commit")} of the starter's pin ${short(state.mergedPin)}, ` +
        "which the starter's code was adapted to:", ...listed(state.starterLeftOut)]
      : [],
    ...state.contract
      ? [state.contract.length
        ? `  Gatekeeper contract: ${state.rollback ? "changes in" : "changed in"} ${plural(state.contract.length, "commit")}` +
          `${state.rollback ? " roll back" : ""}, listed in ${BRIEF}.`
        : "  Gatekeeper contract: unchanged."]
      : [],
    ...state.foreignUrl
      ? [`  .gitmodules points ${state.path} at ${state.foreignUrl}, not upstream: see ${BRIEF} before committing the pin.`]
      : [],
  ].join("\n"));
}

/** The confirmation question: what the merge and the pin move amount to. */
function question(state: Update): string {
  const parts = [
    ...state.starter.length ? [`merge ${plural(state.starter.length, "starter commit")}`] : [],
    ...state.newPin !== state.oldPin
      ? [`${state.rollback ? "roll back" : "move"} ${state.path} ${short(state.oldPin)} → ${short(state.newPin)}` +
        `${state.submodule ? ` (${plural(state.submodule.length, "commit")}` +
          `${state.dropped?.length ? `, leaves out ${state.dropped.length}` : ""})` : ""}`]
      : [],
  ];
  const text = parts.length ? parts.join("; ") : `check ${state.path} out at its pin`;
  return `${text[0].toUpperCase()}${text.slice(1)}?`;
}

/** Merges `target`, leaving any conflicts in place. */
function merge(ctx: Context, deps: UpdateDeps, state: Update): void {
  ctx.out.log("");
  const result = deps.spawn("git",
    ["merge", "--no-edit", "-m", `Merge branch '${state.ref}' of ${state.template}`, state.target],
    { cwd: ctx.root, capture: false });
  if (result.error) throw new Error(`Could not run git: ${result.error.message}`);
  if (result.status === 0) {
    state.merge = "merged";
    return;
  }
  const conflicts = git(ctx, deps, ["diff", "--name-only", "--diff-filter=U"]);
  state.conflicts = succeeded(conflicts) ? conflicts.stdout.split("\n").filter(Boolean) : [];
  // Refused outright (an untracked file in the way, say): nothing was merged.
  if (!state.conflicts.length) throw new Error("git merge did not run. Its output is above; fix that, then run update again.");
  state.merge = "conflicted";
}

/** The range from the old pin to the new one, as far as the submodule can see. */
function rangeOf(ctx: Context, deps: UpdateDeps, state: Update): PinRange {
  return state.newPin === state.oldPin ? EMPTY_RANGE : pinRange(ctx, deps, state.path, state.oldPin, state.newPin);
}

/** `value` as one shell word: as it is when that is safe, else single-quoted. */
function shellWord(value: string): string {
  return /^[\w./:@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * This run's `update` again, for once the merge is concluded, with the starter and submodule it was
 * given. `#796` as `pull/796`, which a shell reads whole.
 */
function rerunCommand(state: Update): string {
  const to = state.to?.replace(/^#(\d+)$/, "pull/$1");
  return ["npx cf-os@latest update",
    // A Windows path with forward slashes, which git takes as well, needs no quotes cmd.exe would not read.
    ...state.template !== DEFAULT_TEMPLATE
      ? [`--template ${shellWord(sep === "\\" ? state.template.replaceAll("\\", "/") : state.template)}`]
      : [],
    ...state.ref !== DEFAULT_REF ? [`--ref ${shellWord(state.ref)}`] : [],
    ...state.givenSubmodule ? [`--submodule ${shellWord(state.givenSubmodule)}`] : [],
    to ? `--to ${shellWord(to)}${state.preview ? " --preview" : ""}` : "--upstream",
  ].join(" ");
}

/** With `--upstream` or `--to` and a merge left unfinished: the pin stays the merge's, with how to stage upstream's later. */
function deferUpstream(ctx: Context, deps: UpdateDeps, state: Update, why: string): void {
  if (!state.upstream || state.newPin === state.mergedPin) return;
  state.problems.push(`${why} Once the merge is concluded, run \`${rerunCommand(state)}\` again to stage upstream's ` +
    `${upstreamRef(state)}.`);
  Object.assign(state, { newPin: state.mergedPin, upstream: false, preview: false, starterLeftOut: [], starterLeftOutContract: [] });
  Object.assign(state, rangeOf(ctx, deps, state));
}

/** Checks the submodule out at the merged pin, then, with `--upstream`, stages upstream's. */
function checkOutSubmodule(ctx: Context, deps: UpdateDeps, state: Update): void {
  const { path } = state;
  if (state.conflicts.includes(path)) {
    const reinstall = state.installable ? ", then `pnpm install`" : "";
    state.problems.push(`The ${path} pin itself conflicted, so it is not checked out. To take the starter's, run ` +
      `\`git -C ${path} checkout --detach ${state.starterPin}\` and \`git add ${path}\`; to keep the project's, the ` +
      `same with ${state.oldPin}${reinstall}.`);
    deferUpstream(ctx, deps, state, `${path} was not moved to upstream's pin, as its pin conflicted.`);
    return;
  }
  const checkout = deps.spawn("git", ["submodule", "update", "--init", "--recursive", "--", path],
    { cwd: ctx.root, capture: false });
  if (!succeeded(checkout)) {
    state.problems.push(`Could not check ${path} out at its pin. Run \`git submodule update --init ` +
      `--recursive ${path}\`${state.installable ? ", then `pnpm install`" : ""}.`);
    return;
  }
  // The gitlink the merge left in the index, which is what was checked out.
  const merged = state.merge === "none" ? "" : git(ctx, deps, ["rev-parse", `:${path}`]).stdout.trim();
  if (merged && merged !== state.mergedPin) {
    state.mergedPin = merged;
    if (!state.upstream) {
      state.newPin = merged;
      Object.assign(state, rangeOf(ctx, deps, state));
    } else {
      const replaced = merged !== state.oldPin && merged !== state.newPin;
      const revisions = [merged, `^${state.newPin}`, `^${state.oldPin}`];
      state.starterLeftOut = replaced ? commits(ctx, deps, revisions, path) : [];
      state.starterLeftOutContract = replaced ? commits(ctx, deps, revisions, path, CONTRACT) : [];
    }
  }
  if (!state.upstream || state.newPin === state.mergedPin) return;
  if (state.merge === "conflicted") {
    deferUpstream(ctx, deps, state, `${path} was left at the merged pin, as the merge has conflicts.`);
    return;
  }
  const detached = git(ctx, deps, ["-C", path, "checkout", "--detach", state.newPin]);
  const added = succeeded(detached) && succeeded(git(ctx, deps, ["add", path]));
  if (!added) {
    state.problems.push(`Could not stage ${path} at ${state.newPin}. Run \`git -C ${path} checkout ` +
      `--detach ${state.newPin}\` and \`git add ${path}\`.`);
    return;
  }
  state.staged = true;
}

function commitList(lines: string[] | undefined, link: string | undefined): string {
  const compare = link ? `Compare: ${link}\n\n` : "";
  if (!lines) return `${compare}Could not be listed here${link ? "" : ": compare the two commits in the repository itself"}.`;
  if (!lines.length) return `${compare}None.`;
  return `${compare}${lines.map((line) => {
    const space = line.indexOf(" ");
    return `- \`${line.slice(0, space)}\` ${line.slice(space + 1)}`;
  }).join("\n")}`;
}

/** How to see the change between two pins with no range between them. */
function diffCommand(state: Update, paths: string[] = []): string {
  return `\`git -C ${state.path} diff --stat ${short(state.oldPin)} ${short(state.newPin)}${
    paths.length ? ` -- ${paths.join(" ")}` : ""}\``;
}

/** The step for the Gatekeeper contract, the most common real work, when the pin moved. */
function contractStep(state: Update): string[] {
  if (state.newPin === state.oldPin) return [];
  if (state.rollback) {
    return state.contract?.length === 0 ? [] : [
      "Then the Gatekeeper contract: the commits under \"Gatekeeper contract changes rolled back\" changed it, and " +
        "leave with the rollback. Take every Gatekeeper implementation and its tests back to match, in one pass.",
    ];
  }
  const migrate = "Migrate every Gatekeeper implementation and its tests in one pass, not only the first that " +
    "fails to type-check.";
  if (!state.contract) {
    return [`Then the Gatekeeper contract: diff it as under "Gatekeeper contract changes" below. ${migrate}`];
  }
  return [state.contract.length
    ? `Then the Gatekeeper contract, which the commits under "Gatekeeper contract changes" change. ${migrate}`
    : "No commit in the range changes the Gatekeeper contract's types. Still check the range for new rules and " +
      "changed helpers that Gatekeepers use."];
}

/** A reference in the operator skill: the merged copy in a starter project, else the starter's `main`. */
function reference(state: Update, file: string): string {
  return state.isStarter ? `\`.agents/skills/cloudflare-os-operator/references/${file}\`` : `${REFERENCES}/${file}`;
}

/** The step for a pin moved back. */
function rollbackStep(state: Update): string {
  return `This is a rollback: it removes the commits listed under "${state.path} commits rolled back". Follow ` +
    `${reference(state, "upgrade-and-rollback.md")}'s "Rollback Matrix" before committing it. Durable Object ` +
    "migrations and storage changes in those commits do not roll back with the code: if there are any, stop and put " +
    "them to the operator. Whatever this repository changed to follow those commits (Gatekeepers migrated for a " +
    "contract change, new vars, catalog entries) has to go back too.";
}

/** The steps for a preview pin, which is committed on a merge request's branch but never merged. */
function previewSteps(state: Update): string[] {
  if (!state.preview || !state.staged) return [];
  return [
    `This is a preview pin: \`${upstreamRef(state)}\` is not on upstream's \`main\`. Commit it on this repository's ` +
      "merge request branch, in a commit of its own, so the merge request's preview deploys it; do not merge it. A " +
      "pin check in CI, if the repository has one, blocks the merge until it moves. Once the upstream change is on " +
      "`main`, move the pin to that commit (`npx cf-os@latest update --to <commit>`, or `--upstream`) before merging.",
    ...state.dropped?.length
      ? [`The preview leaves out ${plural(state.dropped.length, "commit")} the current pin has, listed under "Left out": ` +
        "the upstream branch left `main` before them. " +
        (state.droppedContract?.length
          ? "Some change the Gatekeeper contract, so Gatekeepers already migrated to them will not build against the " +
            "preview. "
          : "") +
        "Where the preview needs them, rebase the upstream branch onto `main` and run update again, rather than " +
        "undoing this repository's changes."]
      : [],
  ];
}

/** What type-checks and tests miss. */
const EXPORT_STEP = "Type-checks and tests do not catch everything: a named export from a Worker's main module that " +
  "is not a class passes both and stops the Worker at startup. Check each changed Worker's main module.";

/** The step for a submodule whose URL is not upstream's. */
function urlStep(state: Update): string[] {
  if (!state.foreignUrl || state.newPin === state.oldPin) return [];
  return [`\`.gitmodules\` points \`${state.path}\` at ${state.foreignUrl}, but the new pin is upstream's and may ` +
    "not exist there, which would break `git submodule update` for everyone else. Before committing the pin, " +
    `point it at upstream (\`git submodule set-url ${state.path} ${UPSTREAM}.git\`, then \`git add .gitmodules\`), ` +
    "or push the pin to that repository."];
}

/** The coding agent's steps after a starter merge. */
function starterSteps(state: Update): string[] {
  return [
    "Read `.agents/skills/cloudflare-os-operator/references/updating.md` (in the merged tree, so it is the " +
      "newest version), then work through its checklist against both commit ranges above.",
    state.merge === "conflicted"
      ? "Resolve the conflicts listed above. Keep the operator's values and customisations: " +
        "`deployment.jsonc`'s values, their own Gatekeepers (such as `packages/custom-gatekeeper`), branding. " +
        "Take the starter's tooling and docs. For `deployment.jsonc`, keep every value and adopt new fields and " +
        "comments. Then conclude the merge (`git add` the files, `git commit --no-edit`) and run `pnpm install`."
      : "Nothing conflicted. Where the merge brought starter changes to files the operator customised, check " +
        "their values and customisations survived.",
    ...state.staged && state.rollback ? [rollbackStep(state)] : [],
    ...state.staged && !state.rollback
      ? [`The ${state.path} pin moved off the starter's, to a commit the starter has not adapted to: everything ` +
        "in `updating.md` may apply to `packages/cf-os` too, and lint, build or test failures are expected. " +
        "Start with the catalog (`updating.md`'s \"Catalog Alignment\"), as nothing type-checks until it matches." +
        (state.preview ? "" : " Follow `.agents/skills/cloudflare-os-operator/references/upgrade-and-rollback.md` " +
          "before committing the pin.")]
      : [],
    ...previewSteps(state),
    ...state.starterLeftOut?.length
      ? [`The merged starter code was adapted to the commits under "Left out of the starter's pin", which the staged ` +
        "pin does not have. Check what in `packages/cf-os`, `deployment.jsonc` and the starter's Gatekeepers depends " +
        "on them, and take that back to match the staged pin."]
      : [],
    // The starter adapts its own code to its pin, but not the operator's Gatekeepers.
    ...contractStep(state).map((step) => `${step} That includes the operator's own Gatekeepers, which the starter ` +
      "cannot adapt for them."),
    ...state.newPin !== state.oldPin ? [EXPORT_STEP] : [],
    ...apiStep(state),
    ...urlStep(state),
    "Keep any follow-up fixes in commits of their own, after the merge, so the update itself stays reviewable.",
    "Run `pnpm lint` and `pnpm cf-os check`. Deploy (`pnpm cf-os deploy`) only once the operator approves.",
    "Summarise for the operator: user-visible changes, breaking changes, Durable Object migrations, new config " +
      "fields, vars or Gatekeepers, and what, if anything, needed fixing. If nothing beyond the merge was needed, " +
      "say why (`updating.md`'s \"prove it\" list).",
  ];
}

/** The coding agent's steps after moving the pin of a repository that is not a starter project. */
function pinSteps(state: Update): string[] {
  return [
    `Read the updating guide on the starter's \`main\` (${REFERENCES}/updating.md), then work through its checklist ` +
      `against the ${state.unrelated ? "diff" : "commit range"} above. This repository is not a starter project: its ` +
      "generic sections apply as written, and the sections marked *(starter)* describe the starter's own config " +
      "generation, build and deploy, so map them onto this repository's own config generation, build and deploy " +
      "scripts. The steps below are its essentials, in order.",
    "The pin moved, so install, lint, build or test failures are expected: they are the work, not a reason to stop " +
      "or to drop the pin.",
    ...state.installable
      ? [(state.installed
        ? "Start with the catalog, even though the install ran. "
        : "Start with the install, which failed: nothing type-checks until it works. Run it and read the error; " +
          "a missing registry token or other environment problem is setup to fix, not the pin. After a pin move, " +
          "the usual cause is the catalog. ") +
        `Versions this repository shares with \`${state.path}/pnpm-workspace.yaml\`'s catalog (\`typescript\`, ` +
        "`capnweb`, `@cloudflare/workers-types`, Wrangler, the Vitest pool) must match it, and every catalog entry " +
        `the submodule's packages use must exist here too.`]
      : [],
    ...contractStep(state),
    EXPORT_STEP,
    ...apiStep(state),
    ...urlStep(state),
    ...state.staged && state.rollback ? [rollbackStep(state)] : [],
    ...state.staged && !state.rollback && !state.preview
      ? [`The pin is upstream's \`${upstreamRef(state)}\`, which nobody has reviewed for this repository. Follow ` +
        `${REFERENCES}/upgrade-and-rollback.md, mapped the same way, before committing it.`]
      : [],
    ...previewSteps(state),
    "Keep any fixes the pin needs in commits of their own, after the one moving it, so the move itself stays " +
      "reviewable.",
    "Run this repository's own lint, tests and build. Deploy only once the operator approves.",
    "Summarise for the operator: user-visible changes, breaking changes, Durable Object migrations, new config " +
      "fields, vars or Gatekeepers, and what, if anything, needed fixing. If nothing beyond the pin move was " +
      "needed, say why (the guide's \"prove it\" list).",
  ];
}

/** How many API commands were added, removed and changed. */
const apiCounts = (api: GeneratedApi) => `${api.added.length} added, ${api.removed.length} removed, ${api.changed.length} changed`;

/** Each kind of API command change that has any, with its commands. */
const apiKinds = (api: GeneratedApi): [string, string[]][] =>
  ([["Added", api.added], ["Removed", api.removed], ["Changed (arguments or result)", api.changed]] as [string, string[]][])
    .filter(([, commands]) => commands.length);

/** Whether any API command was removed or changed: what breaks the scripts, docs and skills calling it. */
const apiBreaks = (api: GeneratedApi) => api.removed.length > 0 || api.changed.length > 0;

/** The terminal's account of the regenerated API, when it changed: a failure is among the problems. */
function apiLines(state: Update): string[] {
  const { api } = state;
  if (api?.status !== "generated") return [];
  if (!api.files.length && !apiKinds(api).length) return ["API commands: the generated files already match the pin."];
  return [
    `API commands: ${apiCounts(api)}; ` +
      (api.files.length ? `${plural(api.files.length, "regenerated file")} left unstaged, for review.` : "the generated files already match the pin."),
    ...apiKinds(api).flatMap(([kind, commands]) => [
      `  ${kind}:`,
      ...commands.slice(0, API_LISTED).map((command) => `    ${command}`),
      ...commands.length > API_LISTED ? [`    … ${commands.length - API_LISTED} more`] : [],
    ]),
  ];
}

/** The brief's account of `pnpm run api:generate`, when the root has the script. */
function apiSection(state: Update): string[] {
  const { api } = state;
  if (!api) return [];
  const script = `\`pnpm run ${API_GENERATE}\``;
  const text = api.status === "failed"
    ? `${script} failed: see "Still to do".`
    : api.status === "not-run"
      ? `${script} did not run, as the install did not complete.`
      : !api.files.length && !apiKinds(api).length
        ? `${script} ran, and the generated files already matched the pin: no API command changed.`
        : [
          api.files.length
            ? `${script} regenerated \`cf-os api\` from the pin: ${apiCounts(api)}. These files are left unstaged, for review:`
            : `${script} ran, and the generated files already matched the pin, as the merge brought them. Since ` +
              `\`${state.oldHead}\`, where the update started, the API commands changed: ${apiCounts(api)}.`,
          ...api.files.length ? ["", ...api.files.map((file) => `- \`${file}\``)] : [],
          ...apiKinds(api).flatMap(([kind, commands]) => [
            "",
            `${kind} (${commands.length}):`,
            "",
            ...commands.slice(0, API_LISTED).map((command) => `- \`${command}\``),
            ...commands.length > API_LISTED ? [`- … and ${commands.length - API_LISTED} more`] : [],
          ]),
        ].join("\n");
  return ["## API commands", "", text, ""];
}

/** The step for `cf-os api`'s generated files and changed commands, unless generation ran and changed nothing. */
function apiStep(state: Update): string[] {
  const { api } = state;
  if (!api || api.status === "generated" && !api.files.length && !apiBreaks(api)) return [];
  const check = "`pnpm lint` runs `api:check`, which fails until they match the pin.";
  if (api.status === "not-run") {
    return [`Once \`pnpm install\` has run, run \`pnpm ${API_GENERATE}\` too, and review the files it regenerates with the ` +
      `pin. ${check}`];
  }
  if (api.status === "failed") {
    return [`\`pnpm run ${API_GENERATE}\` failed: fix what it reports (the install, or a type in the new \`api.ts\` the ` +
      `generator does not handle), run it again, and review the files it regenerates with the pin. ${check}`];
  }
  if (!api.files.length) {
    return ["Some `cf-os api` commands were removed or changed (listed under \"API commands\"): that breaks the scripts, " +
      "docs and skills that call them, so update those."];
  }
  return [`\`cf-os api\`'s generated files were regenerated from the pin and left unstaged (listed under "API commands"). ` +
    `Review them${state.staged ? " with the staged pin" : ""}: a removed or changed command breaks the scripts, docs and ` +
    `skills that call it, so update those. Then commit them ${state.staged ? "with the pin" : "in a commit of their own, right after the merge"} ` +
    `(\`git add ${api.files.join(" ")}\`).`];
}

/** The brief's account of the old pin's commits the new one does not have. */
function leftOut(state: Update): string {
  const why = state.preview
    ? "The current pin has these and the preview does not: the upstream branch left `main` before them."
    : "The current pin has these and the new one does not. If the current pin was a preview of an upstream branch " +
      "that has since merged, these are its commits, on `main` now in another form (squashed, say): check that they are.";
  return [
    why,
    "",
    commitList(state.dropped, undefined),
    ...state.droppedContract?.length
      ? ["", "Of these, these change the Gatekeeper contract:", "", commitList(state.droppedContract, undefined)]
      : [],
  ].join("\n");
}

/** What a run did, as JSON on stdout for whoever ran it: the exit code alone cannot say. */
function summary(state: Update, status: "up-to-date" | "dry-run" | "declined" | "updated", brief?: string) {
  const moved = state.newPin !== state.oldPin;
  return {
    status,
    mode: state.isStarter ? "starter" : "pin",
    submodule: state.path,
    starter: state.isStarter
      ? {
        template: state.template, ref: state.ref, from: state.oldHead, to: state.target, commits: state.starter.length,
        merge: state.merge, conflicts: state.conflicts,
      }
      : null,
    pin: {
      from: state.oldPin,
      to: state.newPin,
      source: state.upstream ? upstreamRef(state) : "starter",
      moved,
      staged: state.staged,
      rollback: state.rollback,
      preview: state.preview,
      commits: moved ? state.submodule?.length ?? null : 0,
      leftOut: state.dropped?.length ?? null,
      starterLeftOut: state.starterLeftOut?.length ?? null,
      contractChanges: state.contract?.length ?? null,
    },
    installed: state.installable ? state.installed : null,
    api: state.api ?? null,
    brief: brief ?? null,
    problems: state.problems,
  };
}

/** `.cf-os/update.md`: the record of this update, and the coding agent's instructions. */
function brief(state: Update, when: Date): string {
  const pinMoved = state.newPin !== state.oldPin;
  const mergeState = {
    none: "Nothing to merge: the project already had every starter commit.",
    merged: "Merged cleanly.",
    conflicted: `**Stopped on conflicts.** The merge is in progress, with conflicts in:\n\n${
      state.conflicts.map((file) => `- \`${file}\``).join("\n")}`,
  }[state.merge];
  const pinState = state.conflicts.includes(state.path)
    ? "**conflicted**, not checked out: see below"
    : !pinMoved
    ? "unchanged"
    : state.staged
      ? state.preview
        ? `upstream's \`${upstreamRef(state)}\`, a **preview pin** not on \`main\`, checked out and **staged, not committed**`
        : state.rollback
        ? `upstream's \`${upstreamRef(state)}\`, a rollback, checked out and **staged, not committed**`
        : `upstream's \`${upstreamRef(state)}\`, checked out and **staged, not committed**: it is unreviewed`
      : state.isStarter ? "the starter's pin, checked out" : "not staged: see below";
  const install = !state.installable
    ? "The root has no `package.json`, so nothing was installed."
    : state.installed
      ? "`pnpm install` ran."
      : state.merge === "conflicted"
        ? "`pnpm install` did not run: conflict markers would break it. Run it once the merge is concluded."
        : "`pnpm install` did not complete. Run it once the problems below are fixed.";
  const reinstall = state.installable ? " and `pnpm install`" : "";
  const regenerated = state.api?.status === "generated" && state.api.files.length ? state.api.files : [];
  const undo = [
    ...regenerated.length
      ? [`- To drop the regenerated API files, first: \`git restore -- ${regenerated.join(" ")}\`.`]
      : [],
    ...state.isStarter
      ? [
        ...state.merge === "conflicted" ? ["- While the merge is in progress: `git merge --abort`."] : [],
        ...state.staged
          ? [`- To drop only the staged pin: \`git restore --staged ${state.path}\`, then \`git submodule update --init --recursive\`.`]
          : [],
        `- To go back to where the project was${state.staged ? ", once the pin is dropped" : ""}: ` +
          `\`git reset --keep ${state.oldHead}\`, then \`git submodule update --init --recursive\`${reinstall}.`,
      ]
      : [`- \`git restore --staged ${state.path}\`, then \`git submodule update --init --recursive ${state.path}\`${reinstall}.`],
  ];
  const steps = state.isStarter ? starterSteps(state) : pinSteps(state);
  const contract = !state.contract
    ? `Could not be listed here. Diff it instead: ${diffCommand(state, CONTRACT)}.`
    : state.contract.length
      ? `These ${state.rollback ? "changed" : "change"} \`@gadgets/workshop-shared/gatekeeper\` or ` +
        `\`/cloudflare-gatekeeper\`, which every Gatekeeper implements${state.rollback ? ", and leave with the rollback" : ""}:` +
        `\n\n${commitList(state.contract, undefined)}`
      : `None: no commit in the range changes \`${CONTRACT.join("` or `")}\`.`;
  const pinCommits = !pinMoved
    ? "None: the pin did not move."
    : state.unrelated
      ? "The old pin is not in the new one's history, so there is no range to list: it was pinned from another " +
        `repository, or from history upstream has since rewritten. Review the change as a diff: ${diffCommand(state)}.`
      : state.rollback
        ? `These leave with the rollback.\n\n${commitList(state.submodule, compareLink(UPSTREAM, state.newPin, state.oldPin))}`
        : commitList(state.submodule, compareLink(UPSTREAM, state.oldPin, state.newPin));
  return [
    "# Cloudflare OS update",
    "",
    `Written by \`cf-os update\` at ${when.toISOString()}. Each run rewrites it; it is not tracked.`,
    "",
    "| | From | To |",
    "| --- | --- | --- |",
    ...state.isStarter
      ? [`| Starter (${state.template}, \`${state.ref}\`) | \`${state.oldHead}\` | \`${state.target}\` |`]
      : [],
    `| \`${state.path}\` | \`${state.oldPin}\` | \`${state.newPin}\` (${pinState}) |`,
    "",
    ...state.isStarter ? [`Merge: ${mergeState}`, ""] : [],
    `Install: ${install}`,
    ...state.problems.length ? ["", "Still to do:", "", ...state.problems.map((problem) => `- ${problem}`)] : [],
    ...state.isStarter
      ? [
        "",
        `## Starter commits (${state.starter.length})`,
        "",
        commitList(state.starter, state.starter.length ? compareLink(state.template, state.oldHead, state.target) : undefined),
      ]
      : [],
    "",
    `## ${state.path} commits${state.rollback ? " rolled back" : ""}${state.submodule ? ` (${state.submodule.length})` : ""}`,
    "",
    pinCommits,
    "",
    ...state.dropped?.length
      ? [`## Left out (${state.dropped.length})`, "", leftOut(state), ""]
      : [],
    ...state.starterLeftOut?.length
      ? [`## Left out of the starter's pin (${state.starterLeftOut.length})`, "",
        `The merge committed the starter's pin \`${state.mergedPin}\`, and the staged pin replaces it without these:`, "",
        commitList(state.starterLeftOut, undefined),
        ...state.starterLeftOutContract?.length
          ? ["", "Of these, these change the Gatekeeper contract:", "", commitList(state.starterLeftOutContract, undefined)]
          : [],
        ""]
      : [],
    ...pinMoved
      ? [`## Gatekeeper contract changes${state.rollback ? " rolled back" : ""}${state.contract ? ` (${state.contract.length})` : ""}`,
        "", contract, ""]
      : [],
    ...apiSection(state),
    "## Undo",
    "",
    ...undo,
    "",
    "## For the coding agent",
    "",
    "If you ran `cf-os update` yourself, these steps are yours: carry them out now, rather than handing them back " +
      "to the operator.",
    "",
    state.isStarter
      ? "Finish bringing this project up to date with the changes above, then report to the operator."
      : "Finish moving this repository's Cloudflare OS pin, then report to the operator.",
    "",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
  ].join("\n");
}

/** Writes the brief, and a `.gitignore` beside it so it is ignored without touching the repository's own. */
function writeBrief(ctx: Context, state: Update, when: Date): string {
  const dir = join(ctx.root, ".cf-os");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "*\n");
  const path = join(ctx.root, BRIEF);
  writeFileSync(path, brief(state, when));
  return path;
}

/** The end of a captured tool's output, where its error is. */
function outputTail(result: ReturnType<SpawnTool>): string {
  const lines = `${result.stdout}\n${result.stderr ?? ""}`.split("\n").filter((line) => line.trim());
  return [
    ...lines.length > OUTPUT_TAIL ? [`… ${lines.length - OUTPUT_TAIL} earlier lines`] : [],
    ...lines.slice(-OUTPUT_TAIL),
  ].join("\n");
}

/** Whether the root `package.json` has script `name`. One that does not parse (conflict markers, say) has none. */
function hasScript(root: string, name: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    return typeof manifest.scripts?.[name] === "string";
  } catch {
    return false;
  }
}

/** `value`, when it is an array of strings. */
const strings = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : undefined;

/**
 * `api:generate`'s result from its stdout, or undefined when it printed none. The last line, as a pnpm
 * that prints the script's banner prints it to stdout first.
 */
function parseGenerated(stdout: string): GeneratedApi | undefined {
  try {
    const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { files?: unknown; commands?: Record<string, unknown> };
    const [files, added, removed, changed] = [parsed.files, parsed.commands?.added, parsed.commands?.removed,
      parsed.commands?.changed].map(strings);
    return files && added && removed && changed ? { status: "generated", files, added, removed, changed } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs `pnpm run api:generate`, which rewrites `cf-os api`'s committed files to match the pin, and
 * leaves what it wrote unstaged. A failure is one of the run's problems, and leaves the pin as it is.
 */
function generateApi(ctx: Context, deps: UpdateDeps, state: Update): ApiGeneration {
  ctx.out.log(`\nRunning pnpm run ${API_GENERATE}.`);
  // Captured, as its stdout is the result read here. Its log is shown at a terminal, and when it fails.
  // Compared with where the update started: a merge that brought regenerated files has already
  // replaced the working tree's schema, which would otherwise be the baseline.
  const result = deps.spawn("pnpm", ["run", API_GENERATE, "--since", state.oldHead], { cwd: ctx.root, capture: true });
  const generated = succeeded(result) ? parseGenerated(result.stdout) : undefined;
  if (generated) {
    if (ctx.prompter && result.stderr?.trim()) ctx.out.log(result.stderr.trimEnd());
    return generated;
  }
  ctx.out.log(outputTail(result));
  state.problems.push(succeeded(result)
    ? `\`pnpm run ${API_GENERATE}\` printed no result, so what it regenerated is unknown. Run it again, and review ` +
      "what `git status` shows."
    : `\`pnpm run ${API_GENERATE}\` failed, so \`cf-os api\`'s generated files may not match the pin. Run it again to ` +
      "see why; `pnpm lint` fails until they match.");
  return { status: "failed" };
}

/** Updates the repository from `args`, resolving to the exit code. */
export async function update(args: CommandArgs, ctx: Context, deps: UpdateDeps): Promise<number> {
  const given = args.values.template as string | undefined;
  // A path is relative to where the command was run, but git runs in the repository root.
  const template = given && existsSync(resolve(ctx.cwd, given)) ? resolve(ctx.cwd, given) : given ?? DEFAULT_TEMPLATE;
  const ref = (args.values.ref as string | undefined) ?? DEFAULT_REF;
  const to = args.values.to as string | undefined;
  const preview = Boolean(args.values.preview);
  if (preview && to === undefined) {
    throw new Error("--preview pins an upstream branch for a merge request's preview, so it needs --to <branch|pull/N|commit>.");
  }
  const upstream = Boolean(args.values.upstream) || to !== undefined;

  const root = repositoryRoot(ctx, deps);
  ctx = { ...ctx, root };
  // No `.gitmodules` reads as no submodules.
  const gitmodules = git(ctx, deps, ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\."]);
  const { path, url } = findSubmodule(succeeded(gitmodules) ? gitmodules.stdout : "", args.values.submodule as string | undefined);
  const isStarter = existsSync(join(root, "deployment.jsonc"));
  if (!isStarter) {
    if (args.values.ref !== undefined || given !== undefined) {
      throw new Error(`--ref and --template name the starter to merge, and ${root} does not descend from the ` +
        "starter (it has no deployment.jsonc), so there is none.");
    }
    if (!upstream) {
      throw new Error(`${root} does not descend from the starter (it has no deployment.jsonc), so there is no ` +
        "reviewed pin to take; pass --upstream to stage upstream's main for review, or --to <ref> for a given commit.");
    }
  }
  const { staleCheckout } = preconditions(ctx, deps, path);
  const checkedOut = existsSync(join(root, path, ".git"));
  if (upstream && !checkedOut) {
    throw new Error(`${path}/ is not checked out, so --upstream has nothing to move. Run ` +
      `\`git submodule update --init ${path}\`, then update again.`);
  }
  const oldHead = gitValue(ctx, deps, ["rev-parse", "HEAD"], "The repository has no commits to update.");
  const oldPin = gitValue(ctx, deps, ["rev-parse", `HEAD:${path}`], `HEAD does not pin ${path}.`);

  let target = oldHead;
  let starter: string[] = [];
  let starterPin = oldPin;
  if (isStarter) {
    ctx.out.log(`Fetching ${ref} from ${template}.`);
    const fetched = deps.spawn("git", ["fetch", "--no-tags", template, ref], { cwd: root, capture: false });
    if (fetched.error) throw new Error(`Could not run git: ${fetched.error.message}`);
    if (fetched.status !== 0) throw new Error(`Could not fetch ${ref} from ${template}. git's output is above.`);
    target = gitValue(ctx, deps, ["rev-parse", "FETCH_HEAD^{commit}"], "Could not read what was fetched.");
    starter = commits(ctx, deps, `HEAD..${target}`) ?? [];
    starterPin = gitValue(ctx, deps, ["rev-parse", `${target}:${path}`],
      `${template} ${ref} does not pin ${path}, so it is not a Cloudflare OS starter.`);
    // A merge commits onto whatever is checked out, and a detached HEAD keeps it nowhere.
    if (starter.length && !succeeded(git(ctx, deps, ["symbolic-ref", "-q", "HEAD"]))) {
      throw new Error("HEAD is detached (a tag or commit checked out, or a rebase stopped part way), so the merge " +
        "would be on no branch. Switch to a branch (`git switch <branch>`) or finish the rebase, then run update again.");
    }
  }
  const mergedPin = isStarter ? pinAfterMerge(ctx, deps, path, target, starter.length, oldPin, starterPin) : oldPin;

  // The new pin's history, fetched from upstream itself rather than through the submodule's remote.
  let newPin = mergedPin;
  let offMain = false;
  if (upstream) {
    let target: string | undefined;
    // git fetches a commit by its full SHA only, so an abbreviated one is looked up in main's history instead.
    const abbreviated = to !== undefined && /^[0-9a-f]{4,39}$/i.test(to);
    // A pull request, `#796` or `pull/796`, by the ref GitHub keeps for its head.
    const pull = to && /^(?:#|pull\/)(\d+)$/.exec(to);
    const spec = pull ? `refs/pull/${pull[1]}/head` : to;
    if (to && !abbreviated) {
      // Fetched alone first only to learn its date: deepening main back to the older of it and the old
      // pin then joins all three, a rollback's included.
      const depth = isShallow(ctx, deps, path) ? ["--depth=1"] : [];
      const fetched = deps.spawn("git", ["-C", path, "fetch", "--no-tags", ...depth, UPSTREAM, spec!], { cwd: root, capture: false });
      if (fetched.error) throw new Error(`Could not run git: ${fetched.error.message}`);
      if (fetched.status !== 0) throw new Error(`Could not fetch ${to} from ${UPSTREAM}. git's output is above.`);
      target = gitValue(ctx, deps, ["-C", path, "rev-parse", "FETCH_HEAD^{commit}"], `Could not read ${to}.`);
    }
    if (!succeeded(fetchUpstream(ctx, deps, path, "main", target ? [oldPin, target] : [oldPin]))) {
      throw new Error(`Could not fetch main from ${UPSTREAM}. git's output is above.`);
    }
    const main = gitValue(ctx, deps, ["-C", path, "rev-parse", "FETCH_HEAD^{commit}"], "Could not read upstream's main.");
    if (abbreviated) {
      // main reaches back only to the old pin, so this finds a newer commit, not a rollback's.
      target = gitValue(ctx, deps, ["-C", path, "rev-parse", "--verify", "--quiet", `${to}^{commit}`],
        `${to} is not a commit on upstream's main since the current pin. git fetches a commit by its full SHA only, ` +
        "so for an older one (a rollback), pass all 40 characters; for a preview, the branch's name.");
    }
    // What git can fetch it by: an abbreviated SHA, once found, by its full one.
    const fetchable = abbreviated ? target! : spec!;
    if (target && !succeeded(git(ctx, deps, ["-C", path, "merge-base", "--is-ancestor", target, main]))) {
      if (!preview) {
        throw new Error(`${to} (${short(target)}) is not on upstream's main, and only commits on main are pinned. ` +
          "Pass a commit, tag or branch whose commit is on main, or add --preview to pin it for a merge request's " +
          "preview deploy.");
      }
      offMain = true;
      // Fetched at depth 1, the branch has no history yet: deepened as main was, so it meets the old pin.
      if (!succeeded(fetchUpstream(ctx, deps, path, fetchable, [oldPin, target]))) {
        throw new Error(`Could not fetch ${to} from ${UPSTREAM}. git's output is above.`);
      }
    }
    newPin = target ?? main;
    // A pin off main (a preview's, or the one being left) can leave it before the deepening reaches, so
    // the two do not meet here: then the whole history, which a shallow clone otherwise never has.
    if (!succeeded(git(ctx, deps, ["-C", path, "merge-base", oldPin, newPin])) && isShallow(ctx, deps, path)) {
      deps.spawn("git", ["-C", path, "fetch", "--no-tags", "--unshallow", UPSTREAM, "main", ...offMain ? [fetchable] : []],
        { cwd: root, capture: false });
    }
  } else if (checkedOut && newPin !== oldPin) {
    // Not fatal: checking the pin out fetches it again, through the submodule's own remote.
    fetchUpstream(ctx, deps, path, newPin, [oldPin]);
  }
  const range: PinRange = newPin === oldPin ? EMPTY_RANGE : checkedOut ? pinRange(ctx, deps, path, oldPin, newPin) : UNLISTED;
  // The merged pin's own commits, when the staged pin replaces it: those the old pin had are in the range already.
  const replaced = upstream && mergedPin !== oldPin && mergedPin !== newPin;
  const starterLeftOut = replaced ? commits(ctx, deps, [mergedPin, `^${newPin}`, `^${oldPin}`], path) : [];
  const starterLeftOutContract = replaced ? commits(ctx, deps, [mergedPin, `^${newPin}`, `^${oldPin}`], path, CONTRACT) : [];
  const result: Update = {
    isStarter, path, givenSubmodule: args.values.submodule as string | undefined, template, ref, oldHead, target, starter,
    oldPin, starterPin, mergedPin, newPin, upstream, to, ...range,
    starterLeftOut, starterLeftOutContract, preview: offMain,
    foreignUrl: url && !isUpstream(url) ? url : undefined, merge: "none", conflicts: [], staged: false, installable: existsSync(join(root, "package.json")), installed: false,
    api: undefined, problems: [],
  };
  if (!starter.length && newPin === oldPin && !staleCheckout && checkedOut) {
    ctx.out.log("Already up to date.");
    ctx.out.json(summary(result, "up-to-date"));
    return 0;
  }
  ctx.out.log("");
  describe(ctx, result);

  if (args.values["dry-run"]) {
    ctx.out.log(`\nDry run: nothing was ${isStarter ? "merged, " : ""}checked out or written.`);
    ctx.out.json(summary(result, "dry-run"));
    return 0;
  }
  // Without a terminal (an agent running it) it carries on: every step is undone with git.
  if (ctx.prompter && !await ctx.prompter.confirm(question(result), true)) {
    ctx.out.log("Nothing was changed.");
    ctx.out.json(summary(result, "declined"));
    return 0;
  }

  if (starter.length) merge(ctx, deps, result);
  checkOutSubmodule(ctx, deps, result);
  if (result.installable && result.merge !== "conflicted" && !result.problems.length) {
    ctx.out.log("");
    // With nobody at a terminal (an agent, usually) its hundreds of lines would bury the summary: shown
    // only when it fails, and then only the end, where the error is.
    const quiet = !ctx.prompter;
    if (quiet) ctx.out.log("Running pnpm install.");
    const install = deps.spawn("pnpm", ["install"], { cwd: root, capture: quiet });
    if (succeeded(install)) {
      result.installed = true;
    } else {
      if (quiet) ctx.out.log(outputTail(install));
      result.problems.push("`pnpm install` failed. Run it again to see why, and fix that first.");
    }
  }
  // Whatever moved, the pin or the generator with the merge, the committed API files should be what
  // generation writes now. It reads the submodule's installed packages, so it waits for the install.
  if (result.installable && hasScript(root, API_GENERATE)) {
    result.api = result.installed ? generateApi(ctx, deps, result) : { status: "not-run" };
  }

  const written = writeBrief(ctx, result, deps.now());
  const where = displayPath(ctx, written);
  const outcome = !isStarter ? "" : {
    none: "Nothing to merge.",
    merged: `Merged ${plural(starter.length, "starter commit")} cleanly.`,
    conflicted: `The merge stopped on conflicts in:\n${result.conflicts.map((file) => `  ${file}`).join("\n")}`,
  }[result.merge];
  const pin = result.staged
    ? result.preview
      ? `${path} is at upstream's ${upstreamRef(result)} (${short(result.newPin)}), staged and not committed: a preview ` +
        "pin, not for merging."
      : `${path} is at upstream's ${short(result.newPin)}, staged and not committed, for review.`
    : result.newPin !== oldPin && !result.conflicts.includes(path) ? `${path} is at the starter's ${short(result.newPin)}.` : "";
  ctx.out.log(["", outcome, pin, ...apiLines(result), ...result.problems, `Wrote ${where}.`].filter(Boolean).join("\n"));
  // Regenerated API files are left to commit, so the update is not finished either.
  const regenerated = result.api?.status === "generated" && (result.api.files.length > 0 || apiBreaks(result.api));
  const clean = isStarter && result.merge !== "conflicted" && !result.problems.length && !result.staged && !regenerated;
  // With nobody at a terminal, it is usually the coding agent itself that ran this: the brief's steps are its own.
  ctx.out.log(!ctx.prompter
    ? `\nNext: carry out the steps in ${where} now. They are addressed to you, the agent that ran this; do not ` +
      "hand them back to the operator."
    : clean
      ? `\nNext: \`pnpm cf-os check\`, then \`pnpm cf-os deploy\`. ${where} lists what changed, for your coding agent to review.`
      : `\nNext: ask your coding agent to follow ${where}.`);
  ctx.out.json(summary(result, "updated", written));
  // 1 when work the command started is left undone (conflicts, a failed step), even with the pin moved:
  // the JSON says how far it got.
  return result.merge === "conflicted" || result.problems.length ? 1 : 0;
}

/** `cf-os update`. */
export async function run(args: CommandArgs, ctx: Context): Promise<number> {
  return update(args, ctx, defaultDeps());
}
