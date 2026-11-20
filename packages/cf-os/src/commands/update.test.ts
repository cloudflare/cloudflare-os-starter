import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CANCEL, scratchProject, scriptedPrompter, TEMPLATE, testContext, type Step } from "../test-support.ts";
import { DEFAULT_TEMPLATE, UPSTREAM } from "./scaffold.ts";
import { BRIEF, findSubmodule, movePin, update, type PinMove, type UpdateDeps, type UpdateOptions } from "./update.ts";

// Keeps the git commands this suite runs, and those of the code it drives, out of any trace2
// listener in the user's git config: one that writes into a repository's .git can race the
// cleanup of a scratch repository, failing it with ENOTEMPTY, or hold the run open past the test
// runner's idle limit. The environment variable overrides trace2.eventTarget.
process.env.GIT_TRACE2_EVENT = "0";

const OLD_HEAD = "a".repeat(40);
const TARGET = "b".repeat(40);
const OLD_PIN = "c".repeat(40);
const NEW_PIN = "d".repeat(40);
const UPSTREAM_MAIN = "e".repeat(40);
const OLDER = "f".repeat(40);

/** One recorded reply. */
type Reply = { status?: number; stdout?: string };

/**
 * What the recording tools report: by `<command> <first args>`, the longest match winning. A list
 * answers successive calls in turn, its last reply repeating.
 */
type Replies = Record<string, Reply | Reply[]>;

/** The `.gitmodules` of a repository with Cloudflare OS at `path`, as `git config --get-regexp` prints it. */
const gitmodules = (path: string, url = "https://github.com/cloudflare/cloudflare-os.git") =>
  `submodule.${path}.path ${path}\nsubmodule.${path}.url ${url}\n`;

/**
 * A repository, with Cloudflare OS at `path`, two starter commits and three upstream commits behind,
 * with nothing in the way.
 */
const behind = (path = "cloudflare-os"): Replies => ({
  "git config -f .gitmodules --get-regexp": { stdout: gitmodules(path) },
  // Not mid-merge.
  "git rev-parse -q --verify MERGE_HEAD": { status: 1 },
  "git rev-parse HEAD": { stdout: `${OLD_HEAD}\n` },
  [`git rev-parse HEAD:${path}`]: { stdout: `${OLD_PIN}\n` },
  "git rev-parse FETCH_HEAD": { stdout: `${TARGET}\n` },
  "git log --format=%h %s HEAD..": { stdout: "bbbbbbb Second starter change\nb000000 First starter change\n" },
  [`git rev-parse ${TARGET}:${path}`]: { stdout: `${NEW_PIN}\n` },
  // A shallow submodule, as `init` clones it, whose old pin was committed at this time.
  [`git -C ${path} rev-parse --is-shallow-repository`]: { stdout: "true\n" },
  [`git -C ${path} log -1 --format=%ct ${OLD_PIN}`]: { stdout: "1760000000\n" },
  [`git -C ${path} rev-parse FETCH_HEAD`]: { stdout: `${UPSTREAM_MAIN}\n` },
  [`git -C ${path} log --format=%h %s ${OLD_PIN}..${NEW_PIN}`]: { stdout: "ddddddd Three\nd111111 Two\nd000000 One\n" },
  [`git -C ${path} log --format=%h %s ${OLD_PIN}..${UPSTREAM_MAIN}`]: { stdout: "eeeeeee Four\nddddddd Three\nd111111 Two\nd000000 One\n" },
  // Of those, one changes the Gatekeeper contract.
  [`git -C ${path} log --format=%h %s ${OLD_PIN}..${NEW_PIN} ${CONTRACT}`]: { stdout: "d111111 Two\n" },
  [`git -C ${path} log --format=%h %s ${OLD_PIN}..${UPSTREAM_MAIN} ${CONTRACT}`]: { stdout: "d111111 Two\n" },
});

/** `git log`'s pathspec for the Gatekeeper contract. */
const CONTRACT = "-- packages/workshop-shared/src/gatekeeper.ts packages/workshop-shared/src/cloudflare-gatekeeper.ts";

/** Deps that record every command and answer from `replies`. */
function recording(replies: Replies) {
  const ran: { command: string; args: string[]; cwd: string; capture: boolean }[] = [];
  const deps: UpdateDeps = {
    spawn: (command, args, { cwd, capture }) => {
      ran.push({ command, args, cwd, capture });
      const line = `${command} ${args.join(" ")}`;
      const key = Object.keys(replies).filter((candidate) => line.startsWith(candidate))
        .toSorted((a, b) => b.length - a.length)[0];
      const found = key ? replies[key] : {};
      const reply = Array.isArray(found) ? (found.length > 1 ? found.shift()! : found[0]) : found;
      return { status: reply.status ?? 0, stdout: reply.stdout ?? "" };
    },
    now: () => new Date("2026-10-17T12:00:00Z"),
  };
  return { deps, ran, commands: () => ran.map((entry) => [entry.command, ...entry.args].join(" ")) };
}

/** A scratch repository that is not a starter project: no `deployment.jsonc`, and an empty `<path>/`. */
function scratchRepository(t: Parameters<typeof scratchProject>[0], path: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cf-os-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, path));
  return dir;
}

/**
 * Runs `cf-os update` in a scratch repository whose submodule is checked out: a starter project with
 * it at `cloudflare-os/`, or, with `path`, a repository pinning Cloudflare OS there instead.
 */
async function updating(
  t: Parameters<typeof scratchProject>[0],
  { values = {}, replies = {}, script, path, packageJson = true }: {
    values?: Record<string, string | boolean>; replies?: Replies; script?: Step[]; path?: string; packageJson?: boolean;
  } = {},
) {
  const root = path ? scratchRepository(t, path) : scratchProject(t, TEMPLATE);
  path ??= "cloudflare-os";
  writeFileSync(join(root, path, ".git"), `gitdir: ../.git/modules/${path}\n`);
  if (packageJson) writeFileSync(join(root, "package.json"), "{}\n");
  const tools = recording({ "git rev-parse --show-toplevel": { stdout: `${root}\n` }, ...behind(path), ...replies });
  const prompter = script ? scriptedPrompter(script) : null;
  const harness = testContext({ root, prompter });
  // A refusal is returned rather than thrown, so the test can check nothing ran before it.
  const code = await update({ command: "update", values, positionals: [] }, harness.ctx, tools.deps)
    .catch((error: Error) => error);
  if (prompter) assert.deepEqual(prompter.remaining(), [], "the script was not used up");
  const brief = join(root, BRIEF);
  return { code, root, ...tools, ...harness, brief: () => existsSync(brief) ? readFileSync(brief, "utf8") : undefined };
}

test("merges the starter, checks out its pin, installs, and writes the brief", async (t) => {
  const { code, commands, ran, root, stderr, brief } = await updating(t);
  assert.equal(code, 0);
  assert.deepEqual(commands(), [
    "git rev-parse --show-toplevel",
    "git config -f .gitmodules --get-regexp ^submodule\\.",
    "git rev-parse -q --verify MERGE_HEAD",
    "git status --porcelain --untracked-files=no --ignore-submodules=dirty",
    "git rev-parse HEAD",
    "git rev-parse HEAD:cloudflare-os",
    `git fetch --no-tags ${DEFAULT_TEMPLATE} main`,
    "git rev-parse FETCH_HEAD^{commit}",
    `git log --format=%h %s HEAD..${TARGET}`,
    `git rev-parse ${TARGET}:cloudflare-os`,
    "git symbolic-ref -q HEAD",
    `git merge-base HEAD ${TARGET}`,
    "git -C cloudflare-os rev-parse --is-shallow-repository",
    `git -C cloudflare-os log -1 --format=%ct ${OLD_PIN}`,
    // Deepened to just before the old pin, so the fetched commit is not a shallow root of its own.
    `git -C cloudflare-os fetch --no-tags --shallow-since=2025-10-09T08:53:19Z ${UPSTREAM} ${NEW_PIN}`,
    `git -C cloudflare-os merge-base --is-ancestor ${OLD_PIN} ${NEW_PIN}`,
    `git -C cloudflare-os log --format=%h %s ${OLD_PIN}..${NEW_PIN}`,
    `git -C cloudflare-os log --format=%h %s ${OLD_PIN}..${NEW_PIN} ${CONTRACT}`,
    `git merge --no-edit -m Merge branch 'main' of ${DEFAULT_TEMPLATE} ${TARGET}`,
    "git submodule update --init --recursive -- cloudflare-os",
    "git rev-parse :cloudflare-os",
    "pnpm install",
  ]);
  assert.ok(ran.every((entry) => entry.cwd === root));
  assert.match(stderr(), /Starter \(\S+ main\): 2 new commits\.\n {2}bbbbbbb Second starter change\n {2}b000000 First/);
  assert.match(stderr(), /cloudflare-os: ccccccc → ddddddd \(3 commits\), the starter's pin\./);
  assert.match(stderr(), /Gatekeeper contract: changed in 1 commit, listed in \.cf-os\/update\.md\./);
  assert.match(stderr(), /Merged 2 starter commits cleanly\./);
  // No terminal, as when the coding agent runs it: the brief is its own to carry out.
  assert.match(stderr(), /Next: carry out the steps in \.cf-os\/update\.md now\. They are addressed to you, the agent that ran this/);

  const text = brief()!;
  assert.match(text, new RegExp(`\\| \`${OLD_HEAD}\` \\| \`${TARGET}\` \\|`));
  assert.match(text, new RegExp(`\\| \`${OLD_PIN}\` \\| \`${NEW_PIN}\` \\(the starter's pin, checked out\\) \\|`));
  assert.match(text, /Merge: Merged cleanly\./);
  assert.match(text, /## Starter commits \(2\)\n\nCompare: https:\/\/github\.com\/cloudflare\/cloudflare-os-starter\/compare\/a+\.\.\.b+\n\n- `bbbbbbb` Second starter change/);
  assert.match(text, /## cloudflare-os commits \(3\)\n\nCompare: https:\/\/github\.com\/cloudflare\/cloudflare-os\/compare\/c+\.\.\.d+\n\n- `ddddddd` Three/);
  assert.match(text, new RegExp(`git reset --keep ${OLD_HEAD}`));
  assert.match(text, /references\/updating\.md/);
  assert.match(text, /## Gatekeeper contract changes \(1\)\n\nThese change `@gadgets\/workshop-shared\/gatekeeper`[\s\S]*- `d111111` Two/);
  assert.match(text, /That includes the operator's own Gatekeepers, which the starter cannot adapt for them\./);
  assert.match(text, /not a class passes both/);
  // `cf-os api` runs the pin's own commands, which the pin generates: the scripts calling them may break.
  assert.match(text, /`cf-os api`'s commands are the pin's, generated from its API, so a method it removed or renamed breaks whatever here calls its command .*`git -C cloudflare-os diff --stat ccccccc ddddddd -- packages\/workshop-shared\/src\/api\.ts` shows whether the API changed/);
  assert.doesNotMatch(text, /git merge --abort|upgrade-and-rollback|Catalog Alignment|set-url/);
});

test("leaves conflicts to git: lists them, skips the install, and exits 1", async (t) => {
  const { code, commands, stderr, brief } = await updating(t, {
    replies: {
      "git merge": { status: 1 },
      "git diff --name-only --diff-filter=U": { stdout: "deployment.jsonc\nREADME.md\n" },
    },
  });
  assert.equal(code, 1);
  // The pin itself did not conflict, so it is checked out; the install waits for the merge.
  assert.deepEqual(commands().slice(-4), [
    `git merge --no-edit -m Merge branch 'main' of ${DEFAULT_TEMPLATE} ${TARGET}`,
    "git diff --name-only --diff-filter=U",
    "git submodule update --init --recursive -- cloudflare-os",
    "git rev-parse :cloudflare-os",
  ]);
  assert.match(stderr(), /stopped on conflicts in:\n {2}deployment\.jsonc\n {2}README\.md/);
  // No terminal, as when the coding agent runs it: the brief is its own to carry out.
  assert.match(stderr(), /Next: carry out the steps in \.cf-os\/update\.md now\. They are addressed to you, the agent that ran this/);
  const text = brief()!;
  assert.match(text, /\*\*Stopped on conflicts\.\*\*[\s\S]*- `deployment\.jsonc`\n- `README\.md`/);
  assert.match(text, /git merge --abort/);
  assert.match(text, /`pnpm install` did not run/);
  assert.match(text, /keep every value and adopt new fields/);
});

test("a conflicted pin is left for the agent to choose, not checked out", async (t) => {
  const { code, commands, brief } = await updating(t, {
    replies: {
      "git merge": { status: 1 },
      "git diff --name-only --diff-filter=U": { stdout: "cloudflare-os\n" },
    },
  });
  assert.equal(code, 1);
  assert.ok(!commands().some((command) => command.startsWith("git submodule update")));
  assert.match(brief()!, /The cloudflare-os pin itself conflicted/);
});

test("refuses uncommitted changes, or a merge in progress, before fetching anything", async (t) => {
  const cases: Replies[] = [
    { "git status --porcelain": { stdout: " M deployment.jsonc\n" } },
    { "git rev-parse -q --verify MERGE_HEAD": { status: 0, stdout: `${TARGET}\n` } },
  ];
  for (const replies of cases) {
    const { code, commands } = await updating(t, { replies });
    assert.match(String(code), /uncommitted changes[\s\S]*M deployment\.jsonc|merge is already in progress/);
    assert.ok(!commands().some((command) => command.startsWith("git fetch")));
  }
});

test("a submodule checked out off its pin is not in the way: updating checks the pin out", async (t) => {
  const { code, commands } = await updating(t, { replies: { "git status --porcelain": { stdout: " M cloudflare-os\n" } } });
  assert.equal(code, 0);
  assert.ok(commands().includes("git submodule update --init --recursive -- cloudflare-os"));
});

test("an old pin outside the new one's history has no range: the brief says so, and to diff instead", async (t) => {
  const { code, commands, stderr, brief } = await updating(t, { replies: { "git -C cloudflare-os merge-base": { status: 1 } } });
  assert.equal(code, 0);
  assert.ok(!commands().some((command) => command.startsWith("git -C cloudflare-os log --format")));
  assert.match(stderr(), /cloudflare-os: ccccccc → ddddddd, the starter's pin\.\n {2}Its commits cannot be listed: the old pin is not in the new one's history\./);
  const text = brief()!;
  assert.match(text, /## cloudflare-os commits\n\nThe old pin is not in the new one's history[\s\S]*`git -C cloudflare-os diff --stat ccccccc ddddddd`\./);
  assert.match(text, /## Gatekeeper contract changes\n\nCould not be listed here\. Diff it instead: `git -C cloudflare-os diff --stat ccccccc ddddddd -- packages\/workshop-shared\/src\/gatekeeper\.ts/);
  // A compare page between unrelated commits is a 404.
  assert.doesNotMatch(text, /compare\/c+\.\.\.d+/);
});

test("when git cannot tell whether the pins are related, the brief keeps the compare link", async (t) => {
  const { stderr, brief } = await updating(t, { replies: { "git -C cloudflare-os merge-base": { status: 128 } } });
  assert.match(stderr(), /Its commits could not be listed: see the brief's compare link/);
  assert.match(brief()!, /## cloudflare-os commits\n\nCompare: https:\/\/github\.com\/cloudflare\/cloudflare-os\/compare\/c+\.\.\.d+\n\nCould not be listed here\./);
});

test("fetches from the starter's URL, or --template's, and never touches a remote", async (t) => {
  const { commands } = await updating(t, { values: { template: "https://github.com/me/fork.git", ref: "next" } });
  assert.ok(commands().includes("git fetch --no-tags https://github.com/me/fork.git next"));
  assert.ok(commands().includes(`git merge --no-edit -m Merge branch 'next' of https://github.com/me/fork.git ${TARGET}`));
  assert.ok(!commands().some((command) => command.startsWith("git remote") || command.includes("starter main")));
});

test("with nothing new, says so and changes nothing", async (t) => {
  const { code, commands, stderr, brief } = await updating(t, {
    replies: { "git log --format=%h %s HEAD..": { stdout: "" }, [`git rev-parse ${TARGET}:cloudflare-os`]: { stdout: `${OLD_PIN}\n` } },
  });
  assert.equal(code, 0);
  assert.match(stderr(), /Already up to date\./);
  assert.ok(!commands().some((command) => /^git (merge |submodule)|^pnpm/.test(command)));
  assert.equal(brief(), undefined);
});

test("--dry-run lists what is coming, and merges and writes nothing", async (t) => {
  const { code, commands, stderr, brief } = await updating(t, { values: { "dry-run": true } });
  assert.equal(code, 0);
  assert.match(stderr(), /2 new commits[\s\S]*3 commits[\s\S]*Dry run: nothing was merged/);
  assert.ok(!commands().some((command) => /^git (merge |submodule)|^pnpm/.test(command)));
  assert.equal(brief(), undefined);
});

test("--upstream checks upstream's main out and stages it, and the brief names the upgrade gate", async (t) => {
  const { code, commands, stderr, brief } = await updating(t, { values: { upstream: true } });
  assert.equal(code, 0);
  assert.ok(commands().includes(`git -C cloudflare-os fetch --no-tags --shallow-since=2025-10-09T08:53:19Z ${UPSTREAM} main`));
  assert.deepEqual(commands().slice(-6), [
    `git merge --no-edit -m Merge branch 'main' of ${DEFAULT_TEMPLATE} ${TARGET}`,
    "git submodule update --init --recursive -- cloudflare-os",
    "git rev-parse :cloudflare-os",
    `git -C cloudflare-os checkout --detach ${UPSTREAM_MAIN}`,
    "git add cloudflare-os",
    "pnpm install",
  ]);
  assert.ok(!commands().some((command) => command.startsWith("git commit")), "the pin is staged, not committed");
  assert.match(stderr(), /cloudflare-os: ccccccc → eeeeeee \(4 commits\), upstream's main, to be staged for review\./);
  assert.match(stderr(), /staged and not committed, for review/);
  // No terminal, as when the coding agent runs it: the brief is its own to carry out.
  assert.match(stderr(), /Next: carry out the steps in \.cf-os\/update\.md now\. They are addressed to you, the agent that ran this/);
  const text = brief()!;
  assert.match(text, /\*\*staged, not committed\*\*/);
  assert.match(text, /upgrade-and-rollback\.md` before committing the pin/);
  assert.match(text, /git restore --staged cloudflare-os/);
});

test("--upstream with conflicts leaves the pin at the starter's until the merge is concluded", async (t) => {
  const { code, commands, brief } = await updating(t, {
    values: { upstream: true },
    replies: { "git merge": { status: 1 }, "git diff --name-only --diff-filter=U": { stdout: "README.md\n" } },
  });
  assert.equal(code, 1);
  assert.ok(!commands().some((command) => command.includes("checkout --detach")));
  assert.match(brief()!, /run `npx cf-os@latest update --upstream` again/);
});

test("asks first at a terminal, and declined, merges nothing", async (t) => {
  const { code, commands, brief } = await updating(t, {
    script: [["Merge 2 starter commits; move cloudflare-os ccccccc → ddddddd (3 commits)?", false]],
  });
  assert.equal(code, 0);
  assert.ok(!commands().some((command) => /^git (merge |submodule)|^pnpm/.test(command)));
  assert.equal(brief(), undefined);
});

test("the brief is ignored by a .gitignore of its own, in any repository", async (t) => {
  const { root } = await updating(t);
  assert.equal(readFileSync(join(root, ".cf-os", ".gitignore"), "utf8"), "*\n");
});

test("outside a starter project, refuses to update without --upstream, before fetching anything", async (t) => {
  for (const values of [{}, { "dry-run": true }] as Record<string, boolean>[]) {
    const { code, commands, brief } = await updating(t, { path: "public", values });
    assert.match(String(code), /does not descend from the starter .*no reviewed pin to take; pass --upstream .*, or --to <ref>/);
    assert.ok(!commands().some((command) => command.includes(" fetch ")));
    assert.equal(brief(), undefined);
  }
});

test("outside a starter project, refuses --ref and --template: there is no starter to merge", async (t) => {
  const cases: Record<string, string | boolean>[] = [{ upstream: true, ref: "next" }, { upstream: true, template: "https://github.com/me/fork" }];
  for (const values of cases) {
    const { code, commands } = await updating(t, { path: "public", values });
    assert.match(String(code), /--ref and --template name the starter to merge/);
    assert.ok(!commands().some((command) => command.includes(" fetch ")));
  }
});

test("outside a starter project, --upstream moves the pin alone: no starter fetch, no merge", async (t) => {
  const { code, commands, ran, root, stderr, brief } = await updating(t, { path: "public", values: { upstream: true } });
  assert.equal(code, 0);
  assert.deepEqual(commands(), [
    "git rev-parse --show-toplevel",
    "git config -f .gitmodules --get-regexp ^submodule\\.",
    "git rev-parse -q --verify MERGE_HEAD",
    "git status --porcelain --untracked-files=no --ignore-submodules=dirty",
    "git rev-parse HEAD",
    "git rev-parse HEAD:public",
    "git -C public rev-parse --is-shallow-repository",
    `git -C public log -1 --format=%ct ${OLD_PIN}`,
    `git -C public fetch --no-tags --shallow-since=2025-10-09T08:53:19Z ${UPSTREAM} main`,
    "git -C public rev-parse FETCH_HEAD^{commit}",
    `git -C public merge-base ${OLD_PIN} ${UPSTREAM_MAIN}`,
    `git -C public merge-base --is-ancestor ${OLD_PIN} ${UPSTREAM_MAIN}`,
    `git -C public log --format=%h %s ${OLD_PIN}..${UPSTREAM_MAIN}`,
    `git -C public log --format=%h %s ${OLD_PIN}..${UPSTREAM_MAIN} ${CONTRACT}`,
    "git submodule update --init --recursive -- public",
    `git -C public checkout --detach ${UPSTREAM_MAIN}`,
    "git add public",
    "pnpm install",
  ]);
  assert.ok(ran.every((entry) => entry.cwd === root));
  assert.doesNotMatch(stderr(), /Starter|merge/i);
  assert.match(stderr(), /public: ccccccc → eeeeeee \(4 commits\), upstream's main, to be staged for review\./);
  assert.match(stderr(), /public is at upstream's eeeeeee, staged and not committed, for review\./);
  // No terminal, as when the coding agent runs it: the brief is its own to carry out.
  assert.match(stderr(), /Next: carry out the steps in \.cf-os\/update\.md now\. They are addressed to you, the agent that ran this/);

  const text = brief()!;
  assert.doesNotMatch(text, /Starter \(|## Starter commits|Merge:|git merge|git reset/);
  assert.match(text, new RegExp(`\\| \`public\` \\| \`${OLD_PIN}\` \\| \`${UPSTREAM_MAIN}\` \\(upstream's \`main\`, checked out and \\*\\*staged`));
  assert.match(text, /## public commits \(4\)\n\nCompare: https:\/\/github\.com\/cloudflare\/cloudflare-os\/compare\/c+\.\.\.e+/);
  assert.match(text, /https:\/\/github\.com\/cloudflare\/cloudflare-os-starter\/blob\/main\/\.agents\/skills\/cloudflare-os-operator\/references\/updating\.md/);
  assert.match(text, /marked \*\(starter\)\*/);
  assert.match(text, /references\/upgrade-and-rollback\.md, mapped the same way/);
  assert.match(text, /git restore --staged public/);
  assert.match(text, /failures are expected: they are the work/);
  assert.match(text, /Start with the catalog, even though the install ran\. .*`public\/pnpm-workspace\.yaml`'s catalog/);
  assert.match(text, /## For the coding agent\n\nIf you ran `cf-os update` yourself, these steps are yours: carry them out now/);
  assert.match(text, /Then the Gatekeeper contract, which the commits under "Gatekeeper contract changes" change\. Migrate every/);
  assert.match(text, /## Gatekeeper contract changes \(1\)/);
  assert.doesNotMatch(text, /pnpm cf-os|set-url|cf-os api/);
});

test("a failed install is in the brief, with where to start: the catalog", async (t) => {
  const { code, stderr, brief } = await updating(t, { path: "public", values: { upstream: true }, replies: { "pnpm install": { status: 1 } } });
  assert.equal(code, 1);
  assert.match(stderr(), /`pnpm install` failed\. Run it again to see why, and fix that first\./);
  const text = brief()!;
  assert.match(text, /Still to do:\n\n- `pnpm install` failed\. Run it again to see why/);
  assert.match(text, /Start with the install, which failed: nothing type-checks until it works\. Run it and read the error; a missing registry token/);
  assert.doesNotMatch(text, /output is above/);
});

test("a range that leaves the Gatekeeper contract alone says so", async (t) => {
  const { stderr, brief } = await updating(t, {
    path: "public", values: { upstream: true },
    replies: { [`git -C public log --format=%h %s ${OLD_PIN}..${UPSTREAM_MAIN} ${CONTRACT}`]: { stdout: "" } },
  });
  assert.match(stderr(), /Gatekeeper contract: unchanged\./);
  assert.match(brief()!, /## Gatekeeper contract changes \(0\)\n\nNone: no commit in the range changes/);
  assert.match(brief()!, /No commit in the range changes the Gatekeeper contract's types\. Still check/);
});

test("a submodule whose URL is not upstream's: the brief says to point it at upstream before committing", async (t) => {
  const fork = "git@gitlab.example.com:team/os.git";
  const { stderr, brief } = await updating(t, {
    path: "public", values: { upstream: true, submodule: "public" },
    replies: { "git config -f .gitmodules --get-regexp": { stdout: gitmodules("public", fork) } },
  });
  assert.match(stderr(), new RegExp(`\\.gitmodules points public at ${fork}, not upstream`));
  assert.match(brief()!, new RegExp(`points \`public\` at ${fork}[\\s\\S]*\`git submodule set-url public ${UPSTREAM}\\.git\``));
});

test("a pin staged by an earlier update is named in the refusal, with how to drop it", async (t) => {
  const { code } = await updating(t, { path: "public", values: { upstream: true }, replies: { "git status --porcelain": { stdout: "M  public\n" } } });
  assert.match(String(code), /uncommitted changes[\s\S]*The public pin is staged, by an earlier update perhaps: commit it, or drop it with `git restore --staged public`\./);
});

test("outside a starter project, with no package.json, installs nothing", async (t) => {
  const { code, commands, brief } = await updating(t, { path: "public", values: { upstream: true }, packageJson: false });
  assert.equal(code, 0);
  assert.ok(!commands().some((command) => command.startsWith("pnpm")));
  assert.match(brief()!, /Install: The root has no `package.json`, so nothing was installed\./);
  assert.doesNotMatch(brief()!, /pnpm install/);
});

test("outside a starter project, --dry-run lists the pin's commits and writes nothing", async (t) => {
  const { code, commands, stderr, brief } = await updating(t, { path: "public", values: { upstream: true, "dry-run": true } });
  assert.equal(code, 0);
  assert.match(stderr(), /public: ccccccc → eeeeeee \(4 commits\)[\s\S]*Dry run: nothing was checked out or written\./);
  assert.ok(!commands().some((command) => /^git (submodule|add)|^pnpm/.test(command)));
  assert.equal(brief(), undefined);
});

test("--submodule names the submodule when .gitmodules does not point at upstream", async (t) => {
  const fork = { "git config -f .gitmodules --get-regexp": { stdout: gitmodules("public", "https://github.com/me/os.git") } };
  const without = await updating(t, { path: "public", values: { upstream: true }, replies: fork });
  assert.match(String(without.code), /No submodule in \.gitmodules points at .*--submodule <path>/);
  const named = await updating(t, { path: "public", values: { upstream: true, submodule: "public/" }, replies: fork });
  assert.equal(named.code, 0);
  assert.ok(named.commands().includes("git add public"));
});

test("finds Cloudflare OS by its URL, in any of the forms git takes", () => {
  for (const url of [
    "https://github.com/cloudflare/cloudflare-os",
    "https://github.com/cloudflare/cloudflare-os.git",
    "git@github.com:cloudflare/cloudflare-os.git",
    "ssh://git@github.com/cloudflare/cloudflare-os",
  ]) {
    assert.equal(findSubmodule(gitmodules("tools", "https://github.com/me/tools.git") + gitmodules("vendor/os", url)).path, "vendor/os", url);
  }
  assert.throws(() => findSubmodule(gitmodules("starter", "https://github.com/cloudflare/cloudflare-os-starter")),
    /No submodule in \.gitmodules points at/);
  assert.throws(() => findSubmodule(""), /No submodule/);
  // A starter project has it at cloudflare-os/, wherever that pins from.
  assert.deepEqual(findSubmodule(gitmodules("cloudflare-os", "git@github.com:me/os.git")),
    { path: "cloudflare-os", url: "git@github.com:me/os.git" });
});

test("several submodules pointing at upstream need --submodule to choose", () => {
  const two = gitmodules("public") + gitmodules("old", "git@github.com:cloudflare/cloudflare-os.git");
  assert.throws(() => findSubmodule(two), /Several submodules point at .* \(public, old\)\. Name the one to update with --submodule <path>\./);
  assert.equal(findSubmodule(two, "./old").path, "old");
  assert.throws(() => findSubmodule(two, "nope"), /\.gitmodules has no submodule at nope\./);
  // Read by a command that has no --submodule to pass, a refusal names none.
  assert.throws(() => findSubmodule(two, undefined, false),
    /^Error: Several submodules point at .* \(public, old\)\. Nothing says which of them this project builds from: a starter project has the one, at cloudflare-os\/\.$/);
  assert.throws(() => findSubmodule("", undefined, false),
    /^Error: No submodule in \.gitmodules points at [^ ]+, and none is at cloudflare-os\/, where a starter project has it, so there is no pin to compare or move\.$/);
  assert.equal(findSubmodule(gitmodules("cloudflare-os", "git@github.com:me/os.git"), undefined, false).path, "cloudflare-os");
});

test("at a terminal, Next: is for the operator: check and deploy when clean, else hand the brief to their agent", async (t) => {
  const clean = await updating(t, { script: [["Merge 2 starter commits", true]] });
  assert.match(clean.stderr(), /Next: `pnpm cf-os check`, then `pnpm cf-os deploy`/);
  const staged = await updating(t, { values: { upstream: true }, script: [["Merge 2 starter commits", true]] });
  assert.match(staged.stderr(), /Next: ask your coding agent to follow \.cf-os\/update\.md\./);
  assert.doesNotMatch(staged.stderr(), /addressed to you/);
});

/** `--shallow-since` for a commit made at `time`, as the deepening computes it. */
const sinceFor = (time: number) => `--shallow-since=${new Date((time - 1) * 1000).toISOString().replace(/\.\d+Z$/, "Z")}`;

test("--to stages a given commit on upstream's main, and implies --upstream outside a starter project", async (t) => {
  const { code, commands, stderr, brief } = await updating(t, {
    path: "public", values: { to: "v2" },
    replies: {
      // First the target, then main.
      "git -C public rev-parse FETCH_HEAD": [{ stdout: `${NEW_PIN}\n` }, { stdout: `${UPSTREAM_MAIN}\n` }],
      [`git -C public log -1 --format=%ct ${NEW_PIN}`]: { stdout: "1770000000\n" },
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(commands().slice(6, 17), [
    "git -C public rev-parse --is-shallow-repository",
    `git -C public fetch --no-tags --depth=1 ${UPSTREAM} v2`,
    "git -C public rev-parse FETCH_HEAD^{commit}",
    "git -C public rev-parse --is-shallow-repository",
    `git -C public log -1 --format=%ct ${OLD_PIN}`,
    `git -C public log -1 --format=%ct ${NEW_PIN}`,
    // Deepened to the older of the two: the old pin.
    `git -C public fetch --no-tags ${sinceFor(1760000000)} ${UPSTREAM} main`,
    "git -C public rev-parse FETCH_HEAD^{commit}",
    `git -C public merge-base --is-ancestor ${NEW_PIN} ${UPSTREAM_MAIN}`,
    `git -C public merge-base ${OLD_PIN} ${NEW_PIN}`,
    `git -C public merge-base --is-ancestor ${OLD_PIN} ${NEW_PIN}`,
  ]);
  assert.ok(commands().includes(`git -C public checkout --detach ${NEW_PIN}`));
  assert.match(stderr(), /public: ccccccc → ddddddd \(3 commits\), upstream's v2, to be staged for review\./);
  const text = brief()!;
  assert.match(text, /\(upstream's `v2`, checked out and \*\*staged, not committed\*\*: it is unreviewed\)/);
  assert.match(text, /The pin is upstream's `v2`, which nobody has reviewed/);
  assert.doesNotMatch(text, /This is a rollback|rolled back|a rollback,/);
});

test("--to refuses a commit that is not on upstream's main, before staging anything", async (t) => {
  const { code, commands } = await updating(t, {
    path: "public", values: { to: "some-branch" },
    replies: {
      "git -C public rev-parse FETCH_HEAD": [{ stdout: `${NEW_PIN}\n` }, { stdout: `${UPSTREAM_MAIN}\n` }],
      [`git -C public merge-base --is-ancestor ${NEW_PIN} ${UPSTREAM_MAIN}`]: { status: 1 },
    },
  });
  assert.match(String(code), /some-branch \(ddddddd\) is not on upstream's main, and only commits on main are pinned/);
  assert.ok(!commands().some((command) => /^git (submodule|add)|checkout --detach|^pnpm/.test(command)));
});

test("--to an older commit is a rollback: deepened back to it, its departing commits listed, the rollback matrix named", async (t) => {
  const { code, commands, stderr, brief } = await updating(t, {
    path: "public", values: { to: OLDER },
    replies: {
      "git -C public rev-parse FETCH_HEAD": [{ stdout: `${OLDER}\n` }, { stdout: `${UPSTREAM_MAIN}\n` }],
      [`git -C public log -1 --format=%ct ${OLDER}`]: { stdout: "1750000000\n" },
      [`git -C public merge-base --is-ancestor ${OLD_PIN} ${OLDER}`]: { status: 1 },
      [`git -C public log --format=%h %s ${OLDER}..${OLD_PIN}`]: { stdout: "ccccccc Newest\nc111111 Contract change\n" },
      [`git -C public log --format=%h %s ${OLDER}..${OLD_PIN} ${CONTRACT}`]: { stdout: "c111111 Contract change\n" },
    },
  });
  assert.equal(code, 0);
  // Deepened to the older of the two: the target this time.
  assert.ok(commands().includes(`git -C public fetch --no-tags ${sinceFor(1750000000)} ${UPSTREAM} main`));
  assert.ok(commands().includes(`git -C public merge-base --is-ancestor ${OLDER} ${OLD_PIN}`));
  assert.ok(commands().includes(`git -C public checkout --detach ${OLDER}`));
  assert.match(stderr(), /public: ccccccc → fffffff \(rolls back 2 commits\), upstream's fffffff, to be staged for review\./);
  assert.match(stderr(), /Gatekeeper contract: changes in 1 commit roll back, listed in \.cf-os\/update\.md\./);
  const text = brief()!;
  assert.match(text, /a rollback, checked out and \*\*staged, not committed\*\*\)/);
  assert.match(text, /## public commits rolled back \(2\)\n\nThese leave with the rollback\.\n\nCompare: https:\/\/github\.com\/cloudflare\/cloudflare-os\/compare\/f+\.\.\.c+\n\n- `ccccccc` Newest/);
  assert.match(text, /## Gatekeeper contract changes rolled back \(1\)\n\nThese changed .*, and leave with the rollback:\n\n- `c111111` Contract change/);
  assert.match(text, /This is a rollback: .*upgrade-and-rollback\.md's "Rollback Matrix"/);
  assert.match(text, /Take every Gatekeeper implementation and its tests back to match/);
  assert.doesNotMatch(text, /which nobody has reviewed|Migrate every/);
});

test("at a terminal, a rollback is asked as one", async (t) => {
  const { code } = await updating(t, {
    path: "public", values: { to: OLDER },
    script: [["Roll back public ccccccc → fffffff (2 commits)?", false]],
    replies: {
      "git -C public rev-parse FETCH_HEAD": [{ stdout: `${OLDER}\n` }, { stdout: `${UPSTREAM_MAIN}\n` }],
      [`git -C public merge-base --is-ancestor ${OLD_PIN} ${OLDER}`]: { status: 1 },
      [`git -C public log --format=%h %s ${OLDER}..${OLD_PIN}`]: { stdout: "ccccccc Newest\nc111111 Older\n" },
    },
  });
  assert.equal(code, 0);
});

test("--to an abbreviated SHA finds it in main's history, which git can fetch, rather than fetching it by name", async (t) => {
  const { code, commands } = await updating(t, {
    path: "public", values: { to: "ddddddd" },
    replies: { "git -C public rev-parse --verify --quiet ddddddd^{commit}": { stdout: `${NEW_PIN}\n` } },
  });
  assert.equal(code, 0);
  assert.ok(!commands().some((command) => command.includes("--depth=1")));
  assert.deepEqual(commands().slice(9, 12), [
    "git -C public rev-parse FETCH_HEAD^{commit}",
    "git -C public rev-parse --verify --quiet ddddddd^{commit}",
    `git -C public merge-base --is-ancestor ${NEW_PIN} ${UPSTREAM_MAIN}`,
  ]);
  assert.ok(commands().includes(`git -C public checkout --detach ${NEW_PIN}`));
});

test("--to an abbreviated SHA that main's history does not reach asks for the full one", async (t) => {
  const { code, commands } = await updating(t, {
    path: "public", values: { to: "a0fc096" },
    replies: { "git -C public rev-parse --verify --quiet": { status: 1 } },
  });
  assert.match(String(code), /a0fc096 is not a commit on upstream's main since the current pin\. .*pass all 40 characters/);
  assert.ok(!commands().some((command) => /^git (submodule|add)|checkout --detach/.test(command)));
});

/** Replies for `--to <branch> --preview`: the branch's tip is NEW_PIN, and it is not on main. */
const offMain = (extra: Replies = {}): Replies => ({
  "git -C public rev-parse FETCH_HEAD": [{ stdout: `${NEW_PIN}\n` }, { stdout: `${UPSTREAM_MAIN}\n` }],
  [`git -C public log -1 --format=%ct ${NEW_PIN}`]: { stdout: "1770000000\n" },
  [`git -C public merge-base --is-ancestor ${NEW_PIN} ${UPSTREAM_MAIN}`]: { status: 1 },
  ...extra,
});

test("--preview needs --to", async (t) => {
  const { code, commands } = await updating(t, { path: "public", values: { preview: true } });
  assert.match(String(code), /--preview pins an upstream branch .*needs --to <branch\|pull\/N\|commit>/);
  assert.ok(!commands().some((command) => command.includes(" fetch ")));
});

test("--to a branch off main with --preview stages it as a preview pin, its history deepened to meet the old pin", async (t) => {
  const { code, commands, stderr, brief } = await updating(t, {
    path: "public", values: { to: "me/feature", preview: true }, replies: offMain(),
  });
  assert.equal(code, 0);
  assert.ok(commands().includes(`git -C public fetch --no-tags --depth=1 ${UPSTREAM} me/feature`));
  // Fetched again, deepened as main was, so the range from the old pin can be listed.
  assert.ok(commands().includes(`git -C public fetch --no-tags ${sinceFor(1760000000)} ${UPSTREAM} me/feature`));
  assert.ok(!commands().some((command) => command.includes("--unshallow")));
  assert.ok(commands().includes(`git -C public checkout --detach ${NEW_PIN}`));
  assert.match(stderr(), /public: ccccccc → ddddddd \(3 commits\), upstream's me\/feature, a preview pin not on main, to be staged\./);
  assert.match(stderr(), /public is at upstream's me\/feature \(ddddddd\), staged and not committed: a preview pin, not for merging\./);
  const text = brief()!;
  assert.match(text, /\(upstream's `me\/feature`, a \*\*preview pin\*\* not on `main`, checked out and \*\*staged, not committed\*\*\)/);
  assert.match(text, /This is a preview pin: `me\/feature` is not on upstream's `main`\. Commit it on this repository's merge request branch/);
  assert.match(text, /move the pin to that commit \(`npx cf-os@latest update --to <commit>`, or `--upstream`\) before merging/);
  assert.doesNotMatch(text, /which nobody has reviewed|## Left out/);
});

test("a preview of a branch that left main before the current pin lists what it leaves out", async (t) => {
  const { code, commands, stderr, brief } = await updating(t, {
    path: "public", values: { to: "me/old-branch", preview: true },
    replies: offMain({
      [`git -C public merge-base --is-ancestor ${OLD_PIN} ${NEW_PIN}`]: { status: 1 },
      [`git -C public merge-base --is-ancestor ${NEW_PIN} ${OLD_PIN}`]: { status: 1 },
      [`git -C public log --format=%h %s ${NEW_PIN}..${OLD_PIN}`]: { stdout: "ccccccc On main since\nc111111 Contract fix\n" },
      [`git -C public log --format=%h %s ${NEW_PIN}..${OLD_PIN} ${CONTRACT}`]: { stdout: "c111111 Contract fix\n" },
    }),
  });
  assert.equal(code, 0);
  assert.ok(commands().includes(`git -C public merge-base ${OLD_PIN} ${NEW_PIN}`));
  assert.match(stderr(), /\(3 commits, leaves out 2\)[\s\S]*Leaves out 2 commits the current pin has:\n {2}ccccccc On main since/);
  assert.match(stderr(), /Gatekeeper contract: 1 change the current pin has are left out\./);
  const text = brief()!;
  assert.match(text, /## Left out \(2\)\n\nThe current pin has these and the preview does not: the upstream branch left `main` before them\.\n\n- `ccccccc` On main since/);
  assert.match(text, /Of these, these change the Gatekeeper contract:\n\n- `c111111` Contract fix/);
  assert.match(text, /The preview leaves out 2 commits .*Some change the Gatekeeper contract.*rebase the upstream branch onto `main`/);
});

test("a preview branch the deepening does not join to the old pin is fetched whole", async (t) => {
  const { commands } = await updating(t, {
    path: "public", values: { to: "me/ancient", preview: true },
    replies: offMain({ [`git -C public merge-base ${OLD_PIN} ${NEW_PIN}`]: { status: 1 } }),
  });
  assert.ok(commands().includes(`git -C public fetch --no-tags --unshallow ${UPSTREAM} main me/ancient`));
});

test("--to #<n> pins a pull request's head", async (t) => {
  const { code, commands, brief } = await updating(t, { path: "public", values: { to: "#796", preview: true }, replies: offMain() });
  assert.equal(code, 0);
  assert.ok(commands().includes(`git -C public fetch --no-tags --depth=1 ${UPSTREAM} refs/pull/796/head`));
  assert.match(brief()!, /This is a preview pin: `#796` is not on upstream's `main`/);
});

test("leaving a preview pin for main lists the branch's commits as left out, and says they may be squashed", async (t) => {
  const { brief } = await updating(t, {
    path: "public", values: { upstream: true },
    replies: {
      [`git -C public merge-base --is-ancestor ${OLD_PIN} ${UPSTREAM_MAIN}`]: { status: 1 },
      [`git -C public merge-base --is-ancestor ${UPSTREAM_MAIN} ${OLD_PIN}`]: { status: 1 },
      [`git -C public log --format=%h %s ${UPSTREAM_MAIN}..${OLD_PIN}`]: { stdout: "ccccccc Preview work\n" },
      [`git -C public log --format=%h %s ${UPSTREAM_MAIN}..${OLD_PIN} ${CONTRACT}`]: { stdout: "" },
    },
  });
  const text = brief()!;
  assert.match(text, /## Left out \(1\)\n\nThe current pin has these and the new one does not\. If the current pin was a preview .*squashed, say/);
  assert.match(text, /which nobody has reviewed/);
  assert.doesNotMatch(text, /This is a preview pin/);
});

test("leaving a pin whose history the shallow deepening does not join to main fetches main whole", async (t) => {
  const { commands } = await updating(t, {
    path: "public", values: { upstream: true },
    replies: { [`git -C public merge-base ${OLD_PIN} ${UPSTREAM_MAIN}`]: { status: 1 } },
  });
  assert.ok(commands().includes(`git -C public fetch --no-tags --unshallow ${UPSTREAM} main`));
});

test("prints what it did as JSON on stdout, since the exit code cannot say how far it got", async (t) => {
  const { json, brief, root } = await updating(t, { path: "public", values: { upstream: true } });
  assert.ok(brief());
  assert.deepEqual(json, [{
    status: "updated",
    mode: "pin",
    submodule: "public",
    starter: null,
    pin: {
      from: OLD_PIN, to: UPSTREAM_MAIN, source: "main", moved: true, staged: true, rollback: false, preview: false,
      commits: 4, leftOut: 0, starterLeftOut: 0, contractChanges: 1,
    },
    installed: true,
    brief: join(root, BRIEF),
    problems: [],
  }]);
});

test("the JSON says the pin moved even when the install failed and the exit code is 1", async (t) => {
  const { code, json } = await updating(t, { path: "public", values: { upstream: true }, replies: { "pnpm install": { status: 1 } } });
  assert.equal(code, 1);
  const [result] = json as { pin: { staged: boolean }; installed: boolean; problems: string[] }[];
  assert.equal(result.pin.staged, true);
  assert.equal(result.installed, false);
  assert.match(result.problems[0], /`pnpm install` failed/);
});

test("the JSON covers a starter merge, a dry run and nothing to do", async (t) => {
  const merged = await updating(t);
  const [starter] = merged.json as { mode: string; starter: { commits: number; merge: string }; pin: { source: string } }[];
  assert.equal(starter.mode, "starter");
  assert.deepEqual([starter.starter.commits, starter.starter.merge, starter.pin.source], [2, "merged", "starter"]);
  const dry = await updating(t, { values: { "dry-run": true } });
  assert.deepEqual(dry.json.map((entry) => (entry as { status: string; brief: unknown }).status), ["dry-run"]);
  const none = await updating(t, {
    replies: { "git log --format=%h %s HEAD..": { stdout: "" }, [`git rev-parse ${TARGET}:cloudflare-os`]: { stdout: `${OLD_PIN}\n` } },
  });
  assert.deepEqual(none.json.map((entry) => (entry as { status: string }).status), ["up-to-date"]);
});

test("with nobody at a terminal the install's output is held back, and only its end shown if it fails", async (t) => {
  const output = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n");
  const { ran, stderr } = await updating(t, {
    path: "public", values: { upstream: true }, replies: { "pnpm install": { status: 1, stdout: `${output}\n` } },
  });
  assert.equal(ran.find((entry) => entry.command === "pnpm")!.capture, true);
  assert.match(stderr(), /Running pnpm install\.\n… 20 earlier lines\nline 21\n[\s\S]*line 60\n/);
  assert.doesNotMatch(stderr(), /line 20\n/);

  const passed = await updating(t, { path: "public", values: { upstream: true }, replies: { "pnpm install": { stdout: output } } });
  assert.doesNotMatch(passed.stderr(), /line 1\b/);
});

test("at a terminal the install's output is shown as it runs", async (t) => {
  const { ran } = await updating(t, { script: [["Merge 2 starter commits", true]] });
  assert.equal(ran.find((entry) => entry.command === "pnpm")!.capture, false);
});

/** The JSON summary's `pin`, as far as these tests read it. */
type Pin = { from: string; to: string; source: string; moved: boolean; preview: boolean; starterLeftOut: number | null };
const pinOf = (json: unknown[]) => (json[0] as { pin: Pin }).pin;

test("a pin the project moved itself, which the starter has not, survives the merge: no move is reported", async (t) => {
  const base = "1".repeat(40);
  const { code, json, stderr, brief } = await updating(t, {
    replies: {
      [`git merge-base HEAD ${TARGET}`]: { stdout: `${base}\n` },
      // The starter still pins what both had then, so the merge keeps the project's own.
      [`git rev-parse ${base}:cloudflare-os`]: { stdout: `${NEW_PIN}\n` },
    },
  });
  assert.equal(code, 0);
  assert.deepEqual([pinOf(json).to, pinOf(json).moved], [OLD_PIN, false]);
  assert.doesNotMatch(stderr(), /cloudflare-os: ccccccc →|is at the starter's/);
  const text = brief()!;
  assert.match(text, new RegExp(`\\| \`${OLD_PIN}\` \\| \`${OLD_PIN}\` \\(unchanged\\) \\|`));
  assert.doesNotMatch(text, /rollback|rolled back/i);
});

test("with every starter commit already merged, the pin is the project's own, not the starter's", async (t) => {
  const { code, json, commands } = await updating(t, { replies: { "git log --format=%h %s HEAD..": { stdout: "" } } });
  assert.equal(code, 0);
  assert.equal((json[0] as { status: string }).status, "up-to-date");
  assert.equal(pinOf(json).moved, false);
  assert.ok(!commands().some((command) => /^git (merge |submodule)/.test(command)));
});

test("the summary reports the gitlink the merge left, when it is not the one expected", async (t) => {
  const { json, stderr, brief } = await updating(t, { replies: { "git rev-parse :cloudflare-os": { stdout: `${OLD_PIN}\n` } } });
  assert.deepEqual([pinOf(json).to, pinOf(json).moved], [OLD_PIN, false]);
  assert.doesNotMatch(stderr(), /is at the starter's/);
  assert.match(brief()!, /## cloudflare-os commits \(0\)|None: the pin did not move/);
  assert.doesNotMatch(brief()!, /cf-os api/);
});

test("a conflicted pin gets commands that set a gitlink, and nothing claims it is checked out", async (t) => {
  const { code, stderr, brief, json } = await updating(t, {
    replies: { "git merge": { status: 1 }, "git diff --name-only --diff-filter=U": { stdout: "cloudflare-os\n" } },
  });
  assert.equal(code, 1);
  const [problem] = (json[0] as { problems: string[] }).problems;
  assert.match(problem, new RegExp(`git -C cloudflare-os checkout --detach ${NEW_PIN}\` and \`git add cloudflare-os\`; ` +
    `to keep the project's, the same with ${OLD_PIN}`));
  assert.doesNotMatch(problem, /--theirs/);
  assert.doesNotMatch(stderr(), /is at the starter's/);
  assert.match(brief()!, /\(\*\*conflicted\*\*, not checked out: see below\)/);
});

test("--upstream with a conflicted pin stages nothing, and says to run it again once the merge is concluded", async (t) => {
  const { commands, json } = await updating(t, {
    values: { upstream: true },
    replies: { "git merge": { status: 1 }, "git diff --name-only --diff-filter=U": { stdout: "cloudflare-os\n" } },
  });
  assert.ok(!commands().some((command) => command.includes("checkout --detach")));
  const { problems } = json[0] as { problems: string[] };
  assert.match(problems.join("\n"), /run `npx cf-os@latest update --upstream` again to stage upstream's main/);
  assert.deepEqual([pinOf(json).to, pinOf(json).source], [NEW_PIN, "starter"]);
});

test("a preview left for a conflicted merge reports the starter's pin, and its rerun command survives a shell", async (t) => {
  const { code, json } = await updating(t, {
    values: { to: "#796", preview: true },
    replies: {
      "git merge": { status: 1 },
      "git diff --name-only --diff-filter=U": { stdout: "README.md\n" },
      "git -C cloudflare-os rev-parse FETCH_HEAD": [{ stdout: `${OLDER}\n` }, { stdout: `${UPSTREAM_MAIN}\n` }],
      [`git -C cloudflare-os merge-base --is-ancestor ${OLDER} ${UPSTREAM_MAIN}`]: { status: 1 },
    },
  });
  assert.equal(code, 1);
  assert.deepEqual([pinOf(json).to, pinOf(json).source, pinOf(json).preview], [NEW_PIN, "starter", false]);
  const { problems } = json[0] as { problems: string[] };
  assert.match(problems.join("\n"), /run `npx cf-os@latest update --to pull\/796 --preview` again/);
});

test("--to an abbreviated SHA off main, with --preview, is fetched by its full SHA", async (t) => {
  const { code, commands } = await updating(t, {
    path: "public", values: { to: "fffffff", preview: true },
    replies: {
      "git -C public rev-parse --verify --quiet fffffff^{commit}": { stdout: `${OLDER}\n` },
      [`git -C public merge-base --is-ancestor ${OLDER} ${UPSTREAM_MAIN}`]: { status: 1 },
    },
  });
  assert.equal(code, 0);
  assert.ok(commands().some((command) => command.startsWith("git -C public fetch ") && command.endsWith(` ${OLDER}`)));
  assert.ok(!commands().some((command) => / fetch .* fffffff$/.test(command)));
});

test("refuses to merge onto a detached HEAD, but moves a pin alone on one", async (t) => {
  const detached = { "git symbolic-ref -q HEAD": { status: 1 } };
  const starter = await updating(t, { replies: detached });
  assert.match(String(starter.code), /HEAD is detached .*Switch to a branch/);
  assert.ok(!starter.commands().some((command) => command.startsWith("git merge ")));
  const pin = await updating(t, { path: "public", values: { upstream: true }, replies: detached });
  assert.equal(pin.code, 0);
});

test("a submodule checked out at commits nothing else keeps is in the way: updating would leave them", async (t) => {
  const local = "9".repeat(40);
  const { code, commands } = await updating(t, {
    replies: {
      "git status --porcelain": { stdout: " M cloudflare-os\n" },
      "git -C cloudflare-os rev-parse HEAD": { stdout: `${local}\n` },
      [`git -C cloudflare-os merge-base --is-ancestor ${local}`]: { status: 1 },
      "git -C cloudflare-os for-each-ref --contains": { stdout: "" },
    },
  });
  assert.match(String(code), /cloudflare-os is checked out at 9999999, which nothing keeps[\s\S]*git -C cloudflare-os branch <name> 9999999/);
  assert.ok(!commands().some((command) => command.includes(" fetch ")));
});

test("a submodule at a pin another branch here commits is kept by it: updating goes ahead", async (t) => {
  const preview = "9".repeat(40);
  const { code, commands } = await updating(t, {
    replies: {
      "git status --porcelain": { stdout: " M cloudflare-os\n" },
      "git -C cloudflare-os rev-parse HEAD": { stdout: `${preview}\n` },
      [`git -C cloudflare-os merge-base --is-ancestor ${preview}`]: { status: 1 },
      "git -C cloudflare-os for-each-ref --contains": { stdout: "" },
      // As git prints it: the preview branch's commit of the pin, then main's.
      "git log --all --format= --raw --no-abbrev -- cloudflare-os": {
        stdout: `:160000 160000 ${OLD_PIN} ${preview} M\tcloudflare-os\n:000000 160000 ${"0".repeat(40)} ${OLD_PIN} A\tcloudflare-os\n`,
      },
    },
  });
  assert.equal(code, 0);
  assert.ok(commands().some((command) => command.startsWith("git merge ")));
});

test("both sides moved the pin, the project's past the starter's: git fast-forwards to it, and no move is reported", async (t) => {
  const base = "1".repeat(40);
  const replies: Replies = {
    [`git merge-base HEAD ${TARGET}`]: { stdout: `${base}\n` },
    // Neither side's pin is the one both had.
    [`git rev-parse ${base}:cloudflare-os`]: { stdout: `${OLDER}\n` },
  };
  const { code, json, stderr } = await updating(t, { values: { "dry-run": true }, replies });
  assert.equal(code, 0);
  assert.deepEqual([pinOf(json).to, pinOf(json).moved], [OLD_PIN, false]);
  assert.doesNotMatch(stderr(), /cloudflare-os: ccccccc →|roll/);
  // Not descended from the starter's: the starter's is the one offered, as before.
  const diverged = await updating(t, {
    values: { "dry-run": true },
    replies: { ...replies, [`git -C cloudflare-os merge-base --is-ancestor ${NEW_PIN} ${OLD_PIN}`]: { status: 1 } },
  });
  assert.deepEqual([pinOf(diverged.json).to, pinOf(diverged.json).moved], [NEW_PIN, true]);
});

test("the rerun command for a conflicted merge keeps the starter it merged, quoted for a shell", async (t) => {
  const fork = mkdtempSync(join(tmpdir(), "cf-os fork "));
  t.after(() => rmSync(fork, { recursive: true, force: true }));
  const { json } = await updating(t, {
    values: { template: fork, ref: "stable", upstream: true },
    replies: { "git merge": { status: 1 }, "git diff --name-only --diff-filter=U": { stdout: "README.md\n" } },
  });
  const { problems } = json[0] as { problems: string[] };
  assert.ok(problems.join("\n").includes(`run \`npx cf-os@latest update --template '${fork}' --ref stable --upstream\` again`),
    problems.join("\n"));
});

test("--to a pin without some of the starter's pin's commits lists them: the merged starter code was adapted to them", async (t) => {
  const staged = "9".repeat(40);
  const { code, json, stderr, brief } = await updating(t, {
    values: { to: "v2" },
    replies: {
      "git -C cloudflare-os rev-parse FETCH_HEAD": [{ stdout: `${staged}\n` }, { stdout: `${UPSTREAM_MAIN}\n` }],
      [`git -C cloudflare-os log --format=%h %s ${NEW_PIN} ^${staged} ^${OLD_PIN}`]: { stdout: "ddddddd Three\n" },
      [`git -C cloudflare-os log --format=%h %s ${NEW_PIN} ^${staged} ^${OLD_PIN} ${CONTRACT}`]: { stdout: "" },
    },
  });
  assert.equal(code, 0);
  assert.equal(pinOf(json).starterLeftOut, 1);
  assert.match(stderr(), /Leaves out 1 commit of the starter's pin ddddddd, which the starter's code was adapted to:\n {2}ddddddd Three/);
  const text = brief()!;
  assert.match(text, /## Left out of the starter's pin \(1\)\n\nThe merge committed the starter's pin `d+`, and the staged pin replaces it without these:\n\n- `ddddddd` Three/);
  assert.match(text, /The merged starter code was adapted to the commits under "Left out of the starter's pin"/);
});

// In-process runs: `pinOnly` and `forwardOnly`, which no flag reaches, and `movePin`, which sets both.

/**
 * Whether a command fetches or merges the starter, or reads what such a fetch or merge would need: git
 * run on the project itself (the submodule's is `git -C`), or anything naming the starter.
 */
const touchesStarter = (command: string) =>
  /^git (fetch|merge|merge-base|symbolic-ref|rev-parse FETCH_HEAD|log --format=%h %s HEAD\.\.)/.test(command) ||
  command.includes("cloudflare-os-starter");

/** Whether a command changes the checkout: a merge, a checkout, anything staged, an install. */
const changesCheckout = (command: string) => /^git (merge |submodule|add)|checkout --detach|^pnpm/.test(command);

/** Runs `update` in-process with `options`, in a scratch starter project whose submodule is checked out. */
async function restricted(
  t: Parameters<typeof scratchProject>[0],
  options: UpdateOptions,
  { values = {}, replies = {}, script }: { values?: Record<string, string | boolean>; replies?: Replies; script?: Step[] } = {},
) {
  const root = scratchProject(t, TEMPLATE);
  writeFileSync(join(root, "cloudflare-os", ".git"), "gitdir: ../.git/modules/cloudflare-os\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  const tools = recording({ "git rev-parse --show-toplevel": { stdout: `${root}\n` }, ...behind(), ...replies });
  const prompter = script ? scriptedPrompter(script) : null;
  const harness = testContext({ root, prompter });
  const code = await update({ command: "update", values, positionals: [] }, harness.ctx, tools.deps, options)
    .catch((error: Error) => error);
  if (prompter) assert.deepEqual(prompter.remaining(), [], "the script was not used up");
  const brief = join(root, BRIEF);
  return { code, root, ...tools, ...harness, brief: () => existsSync(brief) ? readFileSync(brief, "utf8") : undefined };
}

/** Replies for `--to <full SHA>`: the fetched commit is `target`, then upstream's main. */
const fetched = (target: string): Replies => ({
  "git -C cloudflare-os rev-parse FETCH_HEAD": [{ stdout: `${target}\n` }, { stdout: `${UPSTREAM_MAIN}\n` }],
});

test("pinOnly never fetches or merges the starter, whatever else is asked for", async (t) => {
  const cases: { values: Record<string, string | boolean>; replies?: Replies; script?: Step[] }[] = [
    { values: { to: NEW_PIN }, replies: fetched(NEW_PIN) },
    { values: { to: NEW_PIN, "dry-run": true }, replies: fetched(NEW_PIN) },
    { values: { to: NEW_PIN }, replies: fetched(NEW_PIN), script: [["Move cloudflare-os ccccccc → ddddddd (3 commits)?", true]] },
    { values: { to: "ddddddd" }, replies: { "git -C cloudflare-os rev-parse --verify --quiet ddddddd^{commit}": { stdout: `${NEW_PIN}\n` } } },
    { values: { upstream: true } },
    { values: { upstream: true, "dry-run": true } },
    { values: { to: "me/feature", preview: true }, replies: { ...fetched(NEW_PIN), [`git -C cloudflare-os merge-base --is-ancestor ${NEW_PIN} ${UPSTREAM_MAIN}`]: { status: 1 } } },
    // A rollback, which without forwardOnly is still made: of the pin alone.
    { values: { to: OLDER }, replies: { ...fetched(OLDER), [`git -C cloudflare-os merge-base --is-ancestor ${OLD_PIN} ${OLDER}`]: { status: 1 } } },
    // No target at all: the pin stays, and with nothing to merge there is nothing to do.
    { values: {} },
    { values: { "dry-run": true } },
    // A submodule off its pin is checked out at it, and still nothing is merged.
    { values: {}, replies: { "git status --porcelain": { stdout: " M cloudflare-os\n" } } },
  ];
  for (const { values, replies, script } of cases) {
    const { code, commands, json, stderr } = await restricted(t, { pinOnly: true }, { values, replies, script });
    assert.equal(code, 0, JSON.stringify(values));
    assert.deepEqual(commands().filter(touchesStarter), [], JSON.stringify(values));
    assert.doesNotMatch(stderr(), /Starter|starter commit|Merged/, JSON.stringify(values));
    assert.partialDeepStrictEqual(json, [{ mode: "pin", starter: null }], JSON.stringify(values));
  }
});

test("pinOnly refuses --ref and --template, which name a starter to merge, before fetching anything", async (t) => {
  const cases: Record<string, string | boolean>[] = [{ to: NEW_PIN, ref: "next" }, { upstream: true, template: "https://github.com/me/fork" }];
  for (const values of cases) {
    const { code, commands } = await restricted(t, { pinOnly: true }, { values });
    assert.match(String(code), /--ref and --template name the starter to merge, and this run moves the pin alone/);
    assert.deepEqual(commands(), []);
  }
});

test("pinOnly in a starter project moves the pin as outside one, and the brief says the starter was not merged", async (t) => {
  const { code, commands, stderr, json, brief, root } = await restricted(t, { pinOnly: true }, { values: { to: NEW_PIN }, replies: fetched(NEW_PIN) });
  assert.equal(code, 0);
  assert.deepEqual(commands(), [
    "git rev-parse --show-toplevel",
    "git config -f .gitmodules --get-regexp ^submodule\\.",
    "git rev-parse -q --verify MERGE_HEAD",
    "git status --porcelain --untracked-files=no --ignore-submodules=dirty",
    "git rev-parse HEAD",
    "git rev-parse HEAD:cloudflare-os",
    "git -C cloudflare-os rev-parse --is-shallow-repository",
    `git -C cloudflare-os fetch --no-tags --depth=1 ${UPSTREAM} ${NEW_PIN}`,
    "git -C cloudflare-os rev-parse FETCH_HEAD^{commit}",
    "git -C cloudflare-os rev-parse --is-shallow-repository",
    `git -C cloudflare-os log -1 --format=%ct ${OLD_PIN}`,
    `git -C cloudflare-os log -1 --format=%ct ${NEW_PIN}`,
    `git -C cloudflare-os fetch --no-tags --shallow-since=2025-10-09T08:53:19Z ${UPSTREAM} main`,
    "git -C cloudflare-os rev-parse FETCH_HEAD^{commit}",
    `git -C cloudflare-os merge-base --is-ancestor ${NEW_PIN} ${UPSTREAM_MAIN}`,
    `git -C cloudflare-os merge-base ${OLD_PIN} ${NEW_PIN}`,
    `git -C cloudflare-os merge-base --is-ancestor ${OLD_PIN} ${NEW_PIN}`,
    `git -C cloudflare-os log --format=%h %s ${OLD_PIN}..${NEW_PIN}`,
    `git -C cloudflare-os log --format=%h %s ${OLD_PIN}..${NEW_PIN} ${CONTRACT}`,
    "git submodule update --init --recursive -- cloudflare-os",
    `git -C cloudflare-os checkout --detach ${NEW_PIN}`,
    "git add cloudflare-os",
    "pnpm install",
  ]);
  assert.match(stderr(), /cloudflare-os: ccccccc → ddddddd \(3 commits\), upstream's ddddddd, to be staged for review\./);
  assert.match(stderr(), /cloudflare-os is at upstream's ddddddd, staged and not committed, for review\.\nWrote \.cf-os\/update\.md\./);
  // The command that asked for the move carries on, and says what is next itself.
  assert.doesNotMatch(stderr(), /Next:/);
  assert.deepEqual(json, [{
    status: "updated",
    mode: "pin",
    submodule: "cloudflare-os",
    starter: null,
    pin: {
      from: OLD_PIN, to: NEW_PIN, source: "ddddddd", moved: true, staged: true, rollback: false, preview: false,
      commits: 3, leftOut: 0, starterLeftOut: 0, contractChanges: 1,
    },
    installed: true,
    brief: join(root, BRIEF),
    problems: [],
  }]);
  const text = brief() ?? "";
  assert.doesNotMatch(text, /Starter \(|## Starter commits|Merge:|git merge|git reset|both commit ranges|Nothing conflicted|after the merge|beyond the merge/);
  assert.match(text, new RegExp(`\\| \`cloudflare-os\` \\| \`${OLD_PIN}\` \\| \`${NEW_PIN}\` \\(upstream's \`ddddddd\`, checked out and \\*\\*staged, not committed\\*\\*: it is unreviewed\\) \\|`));
  // A starter project all the same: its own copy of the references, and its own checks.
  assert.match(text, /1\. Read `\.agents\/skills\/cloudflare-os-operator\/references\/updating\.md`, then work through its checklist against the commit range above\. Only the pin moved: the starter was not merged/);
  assert.match(text, /`npx cf-os@latest update` merges it, once this pin is committed\./);
  assert.match(text, /Follow `\.agents\/skills\/cloudflare-os-operator\/references\/upgrade-and-rollback\.md` before committing the pin/);
  assert.match(text, /That includes the operator's own Gatekeepers/);
  assert.match(text, /Run `pnpm lint` and `pnpm cf-os check`/);
  assert.match(text, /If nothing beyond the pin move was needed, say why/);
  assert.match(text, /## Undo\n\n- `git restore --staged cloudflare-os`, then `git submodule update --init --recursive cloudflare-os` and `pnpm install`\./);
  assert.match(text, /Finish moving this repository's Cloudflare OS pin, then report to the operator\./);
});

test("forwardOnly changes nothing when the target is behind the pin: a rollback is never made", async (t) => {
  const { code, commands, stderr, json, brief } = await restricted(t, { forwardOnly: true }, {
    values: { to: OLDER },
    replies: { ...fetched(OLDER), [`git -C cloudflare-os merge-base --is-ancestor ${OLD_PIN} ${OLDER}`]: { status: 1 } },
  });
  assert.equal(code, 0);
  // Decided by the two ancestor checks, each way.
  assert.deepEqual(commands().slice(-2), [
    `git -C cloudflare-os merge-base --is-ancestor ${OLD_PIN} ${OLDER}`,
    `git -C cloudflare-os merge-base --is-ancestor ${OLDER} ${OLD_PIN}`,
  ]);
  assert.deepEqual(commands().filter(changesCheckout), []);
  assert.deepEqual(commands().filter(touchesStarter), []);
  assert.match(stderr(), /cloudflare-os is pinned at ccccccc, which is past fffffff: nothing was changed\./);
  assert.doesNotMatch(stderr(), /roll|→/);
  assert.deepEqual(json, [{
    status: "current",
    mode: "pin",
    submodule: "cloudflare-os",
    starter: null,
    pin: {
      from: OLD_PIN, to: OLDER, source: "fffffff", moved: false, staged: false, rollback: false, preview: false,
      commits: 0, leftOut: 0, starterLeftOut: 0, contractChanges: 0,
    },
    installed: false,
    brief: null,
    problems: [],
  }]);
  assert.equal(brief(), undefined);
});

test("forwardOnly changes nothing when the target is the pin", async (t) => {
  const cases: Record<string, string | boolean>[] = [{ to: OLD_PIN }, { to: OLD_PIN, "dry-run": true }];
  for (const values of cases) {
    const { code, commands, stderr, json, brief } = await restricted(t, { forwardOnly: true }, { values, replies: fetched(OLD_PIN) });
    assert.equal(code, 0);
    assert.deepEqual(commands().filter(changesCheckout), []);
    assert.match(stderr(), /cloudflare-os is already pinned at ccccccc: nothing was changed\./);
    assert.partialDeepStrictEqual(json, [{ status: "current", pin: { from: OLD_PIN, to: OLD_PIN, moved: false, staged: false } }]);
    assert.equal(brief(), undefined);
  }
});

test("forwardOnly moves the pin to a commit that descends from it, without the starter", async (t) => {
  const { code, commands, json } = await restricted(t, { forwardOnly: true }, { values: { to: NEW_PIN }, replies: fetched(NEW_PIN) });
  assert.equal(code, 0);
  assert.deepEqual(commands().slice(-4), [
    "git submodule update --init --recursive -- cloudflare-os",
    `git -C cloudflare-os checkout --detach ${NEW_PIN}`,
    "git add cloudflare-os",
    "pnpm install",
  ]);
  assert.ok(!commands().some((command) => /^git (fetch|merge) /.test(command)));
  assert.partialDeepStrictEqual(json, [{ status: "updated", mode: "pin", pin: { to: NEW_PIN, staged: true, rollback: false } }]);
});

test("forwardOnly stops when git cannot tell how the two commits relate, after fetching a shallow history whole", async (t) => {
  // Exit 128, as for a commit the submodule does not have: neither a yes nor a definite no.
  const unknown: Replies = { ...fetched(NEW_PIN), "git -C cloudflare-os merge-base --is-ancestor": { status: 128 } };
  // On main by the first check; nothing after that can be told.
  const onMain = { [`git -C cloudflare-os merge-base --is-ancestor ${NEW_PIN} ${UPSTREAM_MAIN}`]: { status: 0 } };
  const { code, commands, json, brief } = await restricted(t, { forwardOnly: true }, { values: { to: NEW_PIN }, replies: { ...unknown, ...onMain } });
  assert.match(String(code), /git could not compare cloudflare-os's pin ccccccc with ddddddd, so whether that is a move forward is unknown, and nothing was moved\./);
  assert.ok(commands().includes(`git -C cloudflare-os fetch --no-tags --unshallow ${UPSTREAM} main`));
  // Asked again once the whole history is there, each way.
  assert.equal(commands().filter((command) => command === `git -C cloudflare-os merge-base --is-ancestor ${OLD_PIN} ${NEW_PIN}`).length, 2);
  assert.equal(commands().filter((command) => command === `git -C cloudflare-os merge-base --is-ancestor ${NEW_PIN} ${OLD_PIN}`).length, 2);
  assert.deepEqual(commands().filter(changesCheckout), []);
  assert.deepEqual(json, []);
  assert.equal(brief(), undefined);

  // A definite no each way is not one while the history is still cut short: the whole of it did not arrive.
  const cut = await restricted(t, { forwardOnly: true }, {
    values: { to: NEW_PIN },
    replies: {
      ...fetched(NEW_PIN),
      [`git -C cloudflare-os merge-base --is-ancestor ${OLD_PIN} ${NEW_PIN}`]: { status: 1 },
      [`git -C cloudflare-os merge-base --is-ancestor ${NEW_PIN} ${OLD_PIN}`]: { status: 1 },
      [`git -C cloudflare-os fetch --no-tags --unshallow ${UPSTREAM} main`]: { status: 128 },
    },
  });
  assert.match(String(cut.code), /git could not compare cloudflare-os's pin ccccccc with ddddddd/);
  assert.deepEqual(cut.commands().filter(changesCheckout), []);
});

test("forwardOnly stops at a target that has left the pin's history: neither forward nor a rollback", async (t) => {
  const { code, commands, brief } = await restricted(t, { forwardOnly: true }, {
    values: { to: NEW_PIN },
    replies: {
      ...fetched(NEW_PIN),
      [`git -C cloudflare-os merge-base --is-ancestor ${OLD_PIN} ${NEW_PIN}`]: { status: 1 },
      [`git -C cloudflare-os merge-base --is-ancestor ${NEW_PIN} ${OLD_PIN}`]: { status: 1 },
      // A full clone, whose history hides nothing.
      "git -C cloudflare-os rev-parse --is-shallow-repository": { stdout: "false\n" },
    },
  });
  assert.match(String(code), /ddddddd does not descend from cloudflare-os's pin ccccccc: the pin has commits it lacks .*not a move forward, and nothing was moved\./);
  assert.ok(!commands().some((command) => command.includes("--unshallow")));
  assert.deepEqual(commands().filter(changesCheckout), []);
  assert.equal(brief(), undefined);
});

test("forwardOnly needs a target, and reads no commit time once the target is known: the graph decides", async (t) => {
  const none = await restricted(t, { forwardOnly: true });
  assert.match(String(none.code), /forwardOnly compares the pin with a target, so it needs --to or --upstream/);
  assert.deepEqual(none.commands(), []);
  // The only commit times read are the fetch's own, to deepen a shallow clone: none after the target is known.
  const { commands } = await restricted(t, { forwardOnly: true }, {
    values: { to: OLDER },
    replies: { ...fetched(OLDER), [`git -C cloudflare-os merge-base --is-ancestor ${OLD_PIN} ${OLDER}`]: { status: 1 } },
  });
  const decided = commands().indexOf(`git -C cloudflare-os merge-base --is-ancestor ${OLDER} ${UPSTREAM_MAIN}`);
  assert.ok(decided > 0);
  assert.deepEqual(commands().slice(decided + 1).filter((command) => /--format=%ct|log |show /.test(command)), []);
});

test("forwardOnly with --upstream and no --to holds the pin against upstream's main: forward to it, or nothing", async (t) => {
  // Behind main: the pin alone moves there.
  const moved = await restricted(t, { forwardOnly: true }, { values: { upstream: true } });
  assert.equal(moved.code, 0);
  assert.deepEqual(moved.commands().slice(-4), [
    "git submodule update --init --recursive -- cloudflare-os",
    `git -C cloudflare-os checkout --detach ${UPSTREAM_MAIN}`,
    "git add cloudflare-os",
    "pnpm install",
  ]);
  assert.deepEqual(moved.commands().filter(touchesStarter), []);
  assert.partialDeepStrictEqual(moved.json, [{
    status: "updated", mode: "pin", starter: null, pin: { from: OLD_PIN, to: UPSTREAM_MAIN, moved: true, staged: true, rollback: false },
  }]);
  // Main is fetched once, deepened back to the pin, and nothing is fetched by name before it.
  assert.deepEqual(moved.commands().filter((command) => command.includes(" fetch ")),
    [`git -C cloudflare-os fetch --no-tags --shallow-since=2025-10-09T08:53:19Z ${UPSTREAM} main`]);

  const dry = await restricted(t, { forwardOnly: true }, { values: { upstream: true, "dry-run": true } });
  assert.equal(dry.code, 0);
  assert.deepEqual(dry.commands().filter(changesCheckout), []);
  assert.partialDeepStrictEqual(dry.json, [{ status: "dry-run", pin: { from: OLD_PIN, to: UPSTREAM_MAIN, staged: false } }]);
  assert.equal(dry.brief(), undefined);

  // The pin is main's tip already.
  const same = await restricted(t, { forwardOnly: true }, {
    values: { upstream: true }, replies: { "git -C cloudflare-os rev-parse FETCH_HEAD": { stdout: `${OLD_PIN}\n` } },
  });
  assert.equal(same.code, 0);
  assert.deepEqual(same.commands().filter(changesCheckout), []);
  assert.match(same.stderr(), /cloudflare-os is already pinned at ccccccc: nothing was changed\./);
  assert.partialDeepStrictEqual(same.json, [{ status: "current", pin: { from: OLD_PIN, to: OLD_PIN, moved: false, staged: false } }]);

  // A pin main does not descend from (a preview's): not a move forward, so nothing moves.
  const aside = await restricted(t, { forwardOnly: true }, {
    values: { upstream: true },
    replies: {
      [`git -C cloudflare-os merge-base --is-ancestor ${OLD_PIN} ${UPSTREAM_MAIN}`]: { status: 1 },
      [`git -C cloudflare-os merge-base --is-ancestor ${UPSTREAM_MAIN} ${OLD_PIN}`]: { status: 1 },
      "git -C cloudflare-os rev-parse --is-shallow-repository": { stdout: "false\n" },
    },
  });
  assert.match(String(aside.code), /eeeeeee does not descend from cloudflare-os's pin ccccccc: .*not a move forward, and nothing was moved\./);
  assert.deepEqual(aside.commands().filter(changesCheckout), []);
  assert.deepEqual(aside.json, []);
  for (const { commands, brief } of [same, aside]) {
    assert.deepEqual(commands().filter(touchesStarter), []);
    assert.equal(brief(), undefined);
  }
});

/** Runs `movePin` in a scratch starter project, against recorded replies. */
async function moving(
  t: Parameters<typeof scratchProject>[0],
  { to = NEW_PIN, dryRun, replies = {}, script, checkedOut = true }: {
    to?: string; dryRun?: boolean; replies?: Replies; script?: Step[]; checkedOut?: boolean;
  } = {},
) {
  const root = scratchProject(t, TEMPLATE);
  if (checkedOut) writeFileSync(join(root, "cloudflare-os", ".git"), "gitdir: ../.git/modules/cloudflare-os\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  const tools = recording({ "git rev-parse --show-toplevel": { stdout: `${root}\n` }, ...behind(), ...fetched(to), ...replies });
  const prompter = script ? scriptedPrompter(script) : null;
  const harness = testContext({ root, prompter });
  const result: PinMove | Error = await movePin(to, harness.ctx, { dryRun }, tools.deps).catch((error: Error) => error);
  if (prompter) assert.deepEqual(prompter.remaining(), [], "the script was not used up");
  const brief = join(root, BRIEF);
  return { result, root, ...tools, ...harness, brief: () => existsSync(brief) ? readFileSync(brief, "utf8") : undefined };
}

/** Replies for a target that is an ancestor of the pin. */
const behindThePin = (target: string): Replies => ({ [`git -C cloudflare-os merge-base --is-ancestor ${OLD_PIN} ${target}`]: { status: 1 } });

test("movePin moves the pin forward and returns what it did, with nothing on stdout", async (t) => {
  const { result, commands, json, stderr, root, brief } = await moving(t);
  assert.deepEqual(result, {
    status: "moved", path: "cloudflare-os", from: OLD_PIN, to: NEW_PIN, commits: 3, brief: join(root, BRIEF),
    installed: true, problems: [],
  });
  // stdout is the calling command's.
  assert.deepEqual(json, []);
  assert.deepEqual(commands().slice(-4), [
    "git submodule update --init --recursive -- cloudflare-os",
    `git -C cloudflare-os checkout --detach ${NEW_PIN}`,
    "git add cloudflare-os",
    "pnpm install",
  ]);
  assert.ok(!commands().some((command) => /^git (fetch|merge|commit) /.test(command)), "no starter, and the pin is not committed");
  assert.match(stderr(), /cloudflare-os is at upstream's ddddddd, staged and not committed, for review\./);
  assert.doesNotMatch(stderr(), /Next:|Starter/);
  assert.match(brief() ?? "", /Only the pin moved: the starter was not merged/);
});

test("movePin leaves a pin at or past the target alone, and says which", async (t) => {
  const past = await moving(t, { to: OLDER, replies: behindThePin(OLDER) });
  assert.deepEqual(past.result, { status: "current", path: "cloudflare-os", from: OLD_PIN, to: OLDER, past: true });
  const same = await moving(t, { to: OLD_PIN });
  assert.deepEqual(same.result, { status: "current", path: "cloudflare-os", from: OLD_PIN, to: OLD_PIN, past: false });
  for (const { commands, json, brief } of [past, same]) {
    assert.deepEqual(commands().filter(changesCheckout), []);
    assert.deepEqual(json, []);
    assert.equal(brief(), undefined);
  }
});

test("movePin with uncommitted changes: the dirty-tree message and the exact command, once a move is known to be needed", async (t) => {
  const dirty = { "git status --porcelain": { stdout: " M deployment.jsonc\n" } };
  for (const dryRun of [false, true]) {
    const { result, commands, json, brief } = await moving(t, { dryRun, replies: dirty });
    assert.deepEqual(result, {
      status: "blocked",
      cause: "checkout",
      reason: "The checkout has uncommitted changes, and updating needs a clean one. Commit or stash them (`git stash`), " +
        "then run this again:\n   M deployment.jsonc",
      behind: true,
      command: `pnpm cf-os update --to ${NEW_PIN}`,
      from: OLD_PIN,
      to: NEW_PIN,
    });
    assert.deepEqual(commands().filter(changesCheckout), []);
    assert.deepEqual(json, []);
    assert.equal(brief(), undefined);
  }
  // Nothing has to move, so the changes are not in the way: the command would be a rollback, and is not offered.
  const past = await moving(t, { to: OLDER, replies: { ...dirty, ...behindThePin(OLDER) } });
  assert.deepEqual(past.result, { status: "current", path: "cloudflare-os", from: OLD_PIN, to: OLDER, past: true });
  assert.deepEqual(past.commands().filter(changesCheckout), []);
});

test("movePin stops before fetching at a checkout it cannot compare from, and offers no command", async (t) => {
  const cases: [Replies, RegExp][] = [
    [{ "git rev-parse -q --verify MERGE_HEAD": { status: 0, stdout: `${TARGET}\n` } }, /A merge is already in progress/],
    // The pin staged, and the submodule checked out somewhere else again.
    [{ "git status --porcelain": { stdout: "MM cloudflare-os\n" } }, /uncommitted changes[\s\S]*The cloudflare-os pin is staged/],
    [{ "git status --porcelain": { stdout: "UU cloudflare-os\n" } }, /uncommitted changes/],
    [{ "git status --porcelain": { status: 128 } }, /Could not read the checkout's status/],
  ];
  for (const [replies, reason] of cases) {
    const { result, commands } = await moving(t, { replies });
    assert.ok(!(result instanceof Error) && result.status === "blocked", String(reason));
    assert.deepEqual([result.cause, result.behind, result.command, result.to], ["checkout", false, undefined, undefined], String(reason));
    assert.match(result.reason, reason);
    assert.ok(!commands().some((command) => command.includes(" fetch ")), String(reason));
    assert.deepEqual(commands().filter(changesCheckout), []);
  }
});

test("movePin with the submodule not checked out says how to check it out, and offers no command", async (t) => {
  const { result, commands } = await moving(t, { checkedOut: false });
  assert.deepEqual(result, {
    status: "blocked",
    cause: "checkout",
    reason: "cloudflare-os/ is not checked out, so its pin can be neither compared nor moved. Run `git submodule update --init cloudflare-os`, then run this again.",
    behind: false,
    command: undefined,
    from: undefined,
    to: undefined,
  });
  assert.ok(!commands().some((command) => command.includes(" fetch ")));
});

test("movePin's refusals name no flag the calling command lacks, and no update nobody asked for", async (t) => {
  const two = gitmodules("public") + gitmodules("old", "git@github.com:cloudflare/cloudflare-os.git");
  const cases: [Replies, RegExp][] = [
    [{ "git rev-parse --show-toplevel": { status: 128 } }, / is not a git checkout, so it pins no Cloudflare OS commit to compare or move\.$/],
    [{ "git config -f .gitmodules --get-regexp": { status: 1 } }, /^No submodule in \.gitmodules points at [^ ]+, and none is at cloudflare-os\/, .* so there is no pin to compare or move\.$/],
    [{ "git config -f .gitmodules --get-regexp": { stdout: two } }, /^Several submodules point at .* Nothing says which of them this project builds from/],
    [{ [`git -C cloudflare-os merge-base --is-ancestor ${NEW_PIN} ${UPSTREAM_MAIN}`]: { status: 1 } }, /is not on upstream's main/],
  ];
  for (const [replies, reason] of cases) {
    const { result, commands } = await moving(t, { replies });
    assert.ok(!(result instanceof Error) && result.status === "blocked", String(reason));
    assert.match(result.reason, reason);
    assert.doesNotMatch(result.reason, /--submodule|--preview|--upstream|--to\b|tag or branch|update again|nothing to update/, String(reason));
    assert.equal(result.command, undefined, String(reason));
    assert.deepEqual(commands().filter(changesCheckout), []);
  }
  // The command-line update keeps its own words for the same refusals.
  const line = await updating(t, { values: { upstream: true }, replies: { "git rev-parse --show-toplevel": { status: 128 } } });
  assert.match(String(line.code), /is not a git checkout, so there is nothing to update\.$/);
  const aside = await updating(t, {
    values: { to: NEW_PIN },
    replies: { ...fetched(NEW_PIN), [`git -C cloudflare-os merge-base --is-ancestor ${NEW_PIN} ${UPSTREAM_MAIN}`]: { status: 1 } },
  });
  assert.match(String(aside.code),
    /only commits on main are pinned\. Pass a commit, tag or branch whose commit is on main, or add --preview to pin it for a merge request's preview deploy\.$/);
});

test("movePin takes a commit's SHA only: nothing else reaches git", async (t) => {
  for (const to of ["main", "--upload-pack=touch", "pull/7", "#7", "abc123", "g".repeat(40), "a".repeat(41), "", "abcdef1 --all"]) {
    const { result, commands } = await moving(t, { to });
    assert.deepEqual(result, {
      status: "blocked", cause: "target", reason: `${to} is not a commit SHA: seven to 40 hexadecimal characters.`,
      behind: false, command: undefined, from: undefined, to: undefined,
    });
    assert.deepEqual(commands(), []);
  }
  // Upper case is the same commit.
  const upper = await moving(t, { to: NEW_PIN.toUpperCase(), replies: fetched(NEW_PIN) });
  assert.ok(upper.commands().includes(`git -C cloudflare-os fetch --no-tags --depth=1 ${UPSTREAM} ${NEW_PIN}`));
  assert.ok(!(upper.result instanceof Error) && upper.result.status === "moved" && upper.result.to === NEW_PIN);
});

test("movePin stops at a target upstream's main does not have", async (t) => {
  const unfetched = await moving(t, { replies: { [`git -C cloudflare-os fetch --no-tags --depth=1 ${UPSTREAM} ${NEW_PIN}`]: { status: 128 } } });
  assert.deepEqual(unfetched.result, {
    status: "blocked", cause: "target", reason: `Could not fetch ${NEW_PIN} from ${UPSTREAM}. git's output is above.`,
    behind: false, command: undefined, from: OLD_PIN, to: undefined,
  });
  const branch = await moving(t, { replies: { [`git -C cloudflare-os merge-base --is-ancestor ${NEW_PIN} ${UPSTREAM_MAIN}`]: { status: 1 } } });
  assert.ok(!(branch.result instanceof Error) && branch.result.status === "blocked");
  assert.deepEqual([branch.result.cause, branch.result.command], ["target", undefined]);
  // Said without the flags and refs the command-line `update` takes: the calling command has neither.
  assert.equal(branch.result.reason, `${NEW_PIN} (ddddddd) is not on upstream's main, and only commits on main are pinned. ` +
    "Nothing was moved. Where it is the commit a hosted instance's release was built from, the instance has to be updated " +
    "to a release built from main before this project can be pinned for it.");
  for (const { commands, brief } of [unfetched, branch]) {
    assert.deepEqual(commands().filter(changesCheckout), []);
    assert.equal(brief(), undefined);
  }
});

test("movePin finds an abbreviated SHA older than a shallow clone reaches by fetching main whole", async (t) => {
  // Not in what the deepening fetched; there once the whole of main is.
  const lookup = "git -C cloudflare-os rev-parse --verify --quiet fffffff^{commit}";
  const { result, commands } = await moving(t, {
    to: "fffffff",
    replies: { [lookup]: [{ status: 1 }, { stdout: `${OLDER}\n` }], ...behindThePin(OLDER) },
  });
  assert.deepEqual(result, { status: "current", path: "cloudflare-os", from: OLD_PIN, to: OLDER, past: true });
  const whole = commands().indexOf(`git -C cloudflare-os fetch --no-tags --unshallow ${UPSTREAM} main`);
  assert.ok(whole > 0);
  assert.equal(commands()[whole + 1], lookup);
  // Never fetched by its abbreviation, which git would read as a ref.
  assert.ok(!commands().some((command) => / fetch .* fffffff$/.test(command)));

  const missing = await moving(t, { to: "fffffff", replies: { [lookup]: { status: 1 } } });
  assert.deepEqual(missing.result, {
    status: "blocked", cause: "target",
    reason: "fffffff is not a commit on upstream's main: no commit in its history abbreviates to it, or more than one does. " +
      "Pass all 40 characters.",
    behind: false, command: undefined, from: OLD_PIN, to: undefined,
  });
  assert.deepEqual(missing.commands().filter(changesCheckout), []);

  // The whole of main could not be fetched: that is what is said, not that no commit has the abbreviation.
  const offline = await moving(t, {
    to: "fffffff",
    replies: { [lookup]: { status: 1 }, [`git -C cloudflare-os fetch --no-tags --unshallow ${UPSTREAM} main`]: { status: 128 } },
  });
  assert.deepEqual(offline.result, {
    status: "blocked", cause: "target", reason: `Could not fetch the whole of main from ${UPSTREAM}. git's output is above.`,
    behind: false, command: undefined, from: OLD_PIN, to: undefined,
  });
});

test("movePin stops when the target does not descend from the pin, or git cannot tell: only the first offers the command", async (t) => {
  const full = { "git -C cloudflare-os rev-parse --is-shallow-repository": { stdout: "false\n" } };
  const diverged = await moving(t, {
    replies: {
      ...full,
      [`git -C cloudflare-os merge-base --is-ancestor ${OLD_PIN} ${NEW_PIN}`]: { status: 1 },
      [`git -C cloudflare-os merge-base --is-ancestor ${NEW_PIN} ${OLD_PIN}`]: { status: 1 },
    },
  });
  assert.ok(!(diverged.result instanceof Error) && diverged.result.status === "blocked");
  assert.deepEqual([diverged.result.cause, diverged.result.behind, diverged.result.command, diverged.result.from, diverged.result.to],
    ["relation", false, `pnpm cf-os update --to ${NEW_PIN}`, OLD_PIN, NEW_PIN]);
  assert.match(diverged.result.reason, /does not descend from cloudflare-os's pin ccccccc/);

  const unknown = await moving(t, {
    replies: {
      ...full,
      [`git -C cloudflare-os merge-base --is-ancestor ${OLD_PIN} ${NEW_PIN}`]: { status: 128 },
      [`git -C cloudflare-os merge-base --is-ancestor ${NEW_PIN} ${OLD_PIN}`]: { status: 128 },
    },
  });
  assert.ok(!(unknown.result instanceof Error) && unknown.result.status === "blocked");
  assert.deepEqual([unknown.result.cause, unknown.result.behind, unknown.result.command], ["relation", false, undefined]);
  assert.match(unknown.result.reason, /git could not compare/);
  // A yes one way and an error the other is still a yes: the pin descends from the target.
  const past = await moving(t, { replies: { ...full, [`git -C cloudflare-os merge-base --is-ancestor ${OLD_PIN} ${NEW_PIN}`]: { status: 128 } } });
  assert.deepEqual(past.result, { status: "current", path: "cloudflare-os", from: OLD_PIN, to: NEW_PIN, past: true });
  for (const { commands, brief } of [diverged, unknown, past]) {
    assert.deepEqual(commands().filter(changesCheckout), []);
    assert.equal(brief(), undefined);
  }
});

test("movePin counts a pin staged and checked out as the pin: run again after a move, it has nothing to do", async (t) => {
  const staged = { "git status --porcelain": { stdout: "M  cloudflare-os\n M deployment.jsonc\n" }, "git rev-parse :cloudflare-os": { stdout: `${NEW_PIN}\n` } };
  const again = await moving(t, { replies: staged });
  assert.deepEqual(again.result, { status: "current", path: "cloudflare-os", from: NEW_PIN, to: NEW_PIN, past: false });
  assert.deepEqual(again.commands().filter(changesCheckout), []);
  // The committed pin is behind the target, and the staged one is past it: it is the staged one a build uses.
  const older = await moving(t, { to: OLDER, replies: { ...staged, [`git -C cloudflare-os merge-base --is-ancestor ${NEW_PIN} ${OLDER}`]: { status: 1 } } });
  assert.deepEqual(older.result, { status: "current", path: "cloudflare-os", from: NEW_PIN, to: OLDER, past: true });
  assert.ok(!older.commands().includes(`git -C cloudflare-os merge-base --is-ancestor ${OLD_PIN} ${OLDER}`));

  // A target past the staged pin needs a move, which the staged pin is in the way of.
  const further = await moving(t, { to: UPSTREAM_MAIN, replies: staged });
  assert.ok(!(further.result instanceof Error) && further.result.status === "blocked");
  assert.deepEqual([further.result.cause, further.result.behind, further.result.command, further.result.from, further.result.to],
    ["checkout", true, `pnpm cf-os update --to ${UPSTREAM_MAIN}`, NEW_PIN, UPSTREAM_MAIN]);
  assert.match(further.result.reason, /The cloudflare-os pin is staged, by an earlier update perhaps: commit it, or drop it/);
  assert.deepEqual(further.commands().filter(changesCheckout), []);
});

test("movePin does not call a pin current while the submodule is checked out somewhere else", async (t) => {
  const stale = { "git status --porcelain": { stdout: " M cloudflare-os\n" }, "git -C cloudflare-os rev-parse HEAD": { stdout: `${"9".repeat(40)}\n` } };
  for (const to of [OLD_PIN, OLDER]) {
    const { result, commands } = await moving(t, { to, replies: { ...stale, ...behindThePin(OLDER) } });
    assert.deepEqual(result, {
      status: "blocked", cause: "checkout",
      reason: "cloudflare-os is checked out at 9999999, not at its pin ccccccc, so what a build would use is not the pin. " +
        "Check the pin out (`git submodule update --init --recursive cloudflare-os`), then run this again.",
      behind: false, command: undefined, from: OLD_PIN, to,
    });
    assert.deepEqual(commands().filter(changesCheckout), []);
  }
  // A move forward checks the pin out on its way, as update does.
  const forward = await moving(t, { replies: stale });
  assert.ok(!(forward.result instanceof Error) && forward.result.status === "moved");
  assert.ok(forward.commands().includes("git submodule update --init --recursive -- cloudflare-os"));
});

test("movePin --dry-run says the pin is behind, and changes nothing", async (t) => {
  const { result, commands, json, stderr, brief } = await moving(t, { dryRun: true });
  assert.deepEqual(result, { status: "behind", path: "cloudflare-os", from: OLD_PIN, to: NEW_PIN, commits: 3 });
  assert.deepEqual(commands().filter(changesCheckout), []);
  assert.match(stderr(), /Dry run: nothing was checked out or written\./);
  assert.deepEqual(json, []);
  assert.equal(brief(), undefined);
});

test("movePin asks first at a terminal: declined, nothing moves; cancelled, the cancellation is thrown", async (t) => {
  const declined = await moving(t, { script: [["Move cloudflare-os ccccccc → ddddddd (3 commits)?", false]] });
  assert.deepEqual(declined.result, {
    status: "declined", path: "cloudflare-os", from: OLD_PIN, to: NEW_PIN, command: `pnpm cf-os update --to ${NEW_PIN}`,
  });
  const cancelled = await moving(t, { script: [["Move cloudflare-os", CANCEL]] });
  assert.ok(cancelled.result instanceof Error);
  assert.equal(cancelled.result.message, "Cancelled.");
  const accepted = await moving(t, { script: [["Move cloudflare-os", true]] });
  assert.ok(!(accepted.result instanceof Error) && accepted.result.status === "moved");
  // At a terminal the install's output is the person's to watch.
  assert.equal(accepted.ran.find((entry) => entry.command === "pnpm")?.capture, false);
  for (const { commands, brief } of [declined, cancelled]) {
    assert.deepEqual(commands().filter(changesCheckout), []);
    assert.equal(brief(), undefined);
  }
});

test("movePin reports a move left unfinished: the pin staged with a failed install, or not staged at all", async (t) => {
  const install = await moving(t, { replies: { "pnpm install": { status: 1 } } });
  assert.ok(!(install.result instanceof Error) && install.result.status === "moved");
  assert.deepEqual([install.result.installed, install.result.problems], [false, ["`pnpm install` failed. Run it again to see why, and fix that first."]]);

  const unstaged = await moving(t, { replies: { "git add cloudflare-os": { status: 1 } } });
  assert.deepEqual(unstaged.result, {
    status: "blocked", cause: "incomplete",
    reason: `Could not stage cloudflare-os at ${NEW_PIN}. Run \`git -C cloudflare-os checkout --detach ${NEW_PIN}\` and \`git add cloudflare-os\`.`,
    behind: true, command: `pnpm cf-os update --to ${NEW_PIN}`, from: OLD_PIN, to: NEW_PIN,
  });
  assert.ok(!unstaged.commands().includes("pnpm install"));
  // Nothing was staged, so nothing moved: the refusal leaves no brief behind.
  assert.equal(unstaged.brief(), undefined);
  assert.ok(!existsSync(join(unstaged.root, ".cf-os")));
  assert.doesNotMatch(unstaged.stderr(), /Wrote /);
  assert.notEqual(install.brief(), undefined);
});

// The same, against git itself: throwaway repositories under the temporary directory, an upstream of a
// few commits and a starter project pinning it. The recorded replies above pin what is asked of git;
// these pin what git answers, and what is left on disk.

/** When the upstream's commits were made, by name: not in the order of its history, so nothing decided by date comes out right. */
const DATES: Record<string, string> = {
  one: "2026-03-05T00:00:00Z", two: "2026-03-09T00:00:00Z", three: "2026-03-03T00:00:00Z", four: "2026-03-01T00:00:00Z",
  side: "2026-03-04T00:00:00Z", five: "2026-03-10T00:00:00Z",
};

/** The same commits a day apart in the order of their history, as a shallow clone's deepening by date expects. */
const ORDERED: Record<string, string> = {
  one: "2026-03-01T00:00:00Z", two: "2026-03-02T00:00:00Z", three: "2026-03-03T00:00:00Z", four: "2026-03-04T00:00:00Z",
  side: "2026-03-03T00:00:00Z", five: "2026-03-10T00:00:00Z",
};

/**
 * An upstream with `one`..`four` on main and `side` branching off `two`, and a starter project whose
 * `cloudflare-os` submodule is a clone of it checked out and committed at `pin` (a shallow clone of
 * main's tip, with `shallow`, of commits dated in their order). `deps` runs git for real, with upstream's URL replaced by the local
 * one, and records pnpm instead of running it; `strayed` lists any command that named another remote.
 */
function repositories(t: Parameters<typeof scratchProject>[0], { pin = "three", shallow = false }: { pin?: string; shallow?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cf-os-pin-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: base, GIT_CONFIG_GLOBAL: join(base, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
    // A submodule cloned from a local path, which git otherwise refuses.
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always",
  };
  const git = (cwd: string, args: string[], date?: string): string => {
    const result = spawnSync("git", args, {
      cwd, encoding: "utf8", env: date ? { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : env,
    });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const upstream = join(base, "upstream");
  const project = join(base, "project");
  const submodule = join(project, "cloudflare-os");
  mkdirSync(upstream);
  mkdirSync(project);
  git(upstream, ["init", "-q", "-b", "main"]);
  // As GitHub does: a commit is fetched by its SHA.
  git(upstream, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const shas: Record<string, string> = {};
  const commit = (name: string) => {
    writeFileSync(join(upstream, "file.txt"), `${name}\n`);
    git(upstream, ["add", "file.txt"]);
    git(upstream, ["commit", "-q", "-m", name], (shallow ? ORDERED : DATES)[name]);
    shas[name] = git(upstream, ["rev-parse", "HEAD"]);
  };
  for (const name of ["one", "two"]) commit(name);
  git(upstream, ["checkout", "-q", "-b", "side"]);
  commit("side");
  git(upstream, ["checkout", "-q", "main"]);
  for (const name of ["three", "four"]) commit(name);

  const url = `file://${upstream}`;
  git(project, ["init", "-q", "-b", "main"]);
  writeFileSync(join(project, "deployment.jsonc"), TEMPLATE);
  writeFileSync(join(project, "package.json"), "{}\n");
  git(project, ["submodule", "add", "-q", ...shallow ? ["--depth", "1"] : [], url, "cloudflare-os"]);
  if (!shallow) git(submodule, ["checkout", "-q", "--detach", shas[pin]]);
  git(project, ["add", "-A"]);
  git(project, ["commit", "-q", "-m", "Project"]);

  const ran: string[] = [];
  const strayed: string[] = [];
  const deps: UpdateDeps = {
    spawn: (command, args, { cwd }) => {
      const line = [command, ...args].join(" ");
      ran.push(line);
      if (command !== "git") return { status: 0, stdout: "" };
      const local = args.map((arg) => arg === UPSTREAM ? url : arg);
      // Anything else that names a remote would be the starter's, or upstream's by another spelling.
      if (local.some((arg) => /github\.com|^https?:|^git@|^ssh:/.test(arg))) {
        strayed.push(line);
        return { status: 1, stdout: "" };
      }
      const result = spawnSync("git", local, { cwd, env, encoding: "utf8" });
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
    },
    now: () => new Date("2026-10-17T12:00:00Z"),
  };
  /** What a run must leave alone when it changes nothing. */
  const state = () => ({
    head: git(project, ["rev-parse", "HEAD"]),
    committedPin: git(project, ["rev-parse", "HEAD:cloudflare-os"]),
    stagedPin: git(project, ["rev-parse", ":cloudflare-os"]),
    checkedOut: git(submodule, ["rev-parse", "HEAD"]),
    status: git(project, ["status", "--porcelain"]),
    brief: existsSync(join(project, ".cf-os")),
    deployment: readFileSync(join(project, "deployment.jsonc"), "utf8"),
  });
  const move = async (
    to: string,
    { dryRun = false, script, atLeast }: { dryRun?: boolean; script?: Step[]; atLeast?: string[] } = {},
  ) => {
    const prompter = script ? scriptedPrompter(script) : null;
    const harness = testContext({ root: project, prompter });
    const result = await movePin(to, harness.ctx, { dryRun, atLeast }, deps);
    if (prompter) assert.deepEqual(prompter.remaining(), [], "the script was not used up");
    assert.deepEqual(strayed, [], "a command named a remote other than upstream");
    assert.deepEqual(harness.json, [], "stdout is the calling command's");
    return { result, stderr: harness.stderr };
  };
  return { upstream, project, submodule, shas, git, commit, ran, state, move, deps };
}

test("against git: a target ahead of the pin is checked out and staged, uncommitted, and the starter is never fetched", async (t) => {
  const { project, shas, ran, state, move } = repositories(t);
  const before = state();
  assert.equal(before.committedPin, shas.three);
  // `four` was committed before `three`, and descends from it all the same.
  assert.ok(DATES.four < DATES.three);
  // A dry run, by the target's abbreviation, compares and leaves the checkout as it was.
  assert.deepEqual((await move(shas.four.slice(0, 7), { dryRun: true })).result,
    { status: "behind", path: "cloudflare-os", from: shas.three, to: shas.four, commits: 1 });
  assert.deepEqual(state(), before);
  // At a terminal the move is confirmed, and declined, nothing moves.
  const question = `Move cloudflare-os ${shas.three.slice(0, 7)} → ${shas.four.slice(0, 7)} (1 commit)?`;
  assert.deepEqual((await move(shas.four, { script: [[question, false]] })).result,
    { status: "declined", path: "cloudflare-os", from: shas.three, to: shas.four, command: `pnpm cf-os update --to ${shas.four}` });
  assert.deepEqual(state(), before);

  const { result } = await move(shas.four, { script: [[question, true]] });
  assert.deepEqual(result, {
    status: "moved", path: "cloudflare-os", from: shas.three, to: shas.four, commits: 1, brief: join(project, BRIEF),
    installed: true, problems: [],
  });
  assert.deepEqual(state(), {
    ...before, stagedPin: shas.four, checkedOut: shas.four, status: "M  cloudflare-os", brief: true,
  });
  assert.deepEqual(ran.filter(touchesStarter), []);
  assert.deepEqual(ran.filter((command) => command.startsWith("pnpm")), ["pnpm install"]);
  assert.match(readFileSync(join(project, BRIEF), "utf8"), /Only the pin moved: the starter was not merged/);
});

test("against git: a target behind the pin, or the pin itself, changes nothing, whatever the commits' dates say", async (t) => {
  const { shas, state, move } = repositories(t);
  const before = state();
  // `two` was committed after `three`, and is its ancestor all the same.
  assert.ok(DATES.two > DATES.three);
  assert.deepEqual((await move(shas.two)).result, { status: "current", path: "cloudflare-os", from: shas.three, to: shas.two, past: true });
  assert.deepEqual((await move(shas.one.slice(0, 7))).result, { status: "current", path: "cloudflare-os", from: shas.three, to: shas.one, past: true });
  assert.deepEqual((await move(shas.three)).result, { status: "current", path: "cloudflare-os", from: shas.three, to: shas.three, past: false });
  assert.deepEqual(state(), before);
});

test("against git: a pin off main and a target on it have diverged, which stops; a target the pin descends from does not", async (t) => {
  const { shas, state, move } = repositories(t, { pin: "side" });
  const before = state();
  const { result } = await move(shas.four);
  assert.ok(result.status === "blocked");
  assert.deepEqual([result.cause, result.behind, result.command, result.from, result.to],
    ["relation", false, `pnpm cf-os update --to ${shas.four}`, shas.side, shas.four]);
  assert.match(result.reason, /does not descend from cloudflare-os's pin/);
  // `side` branched off `two`.
  assert.deepEqual((await move(shas.two)).result, { status: "current", path: "cloudflare-os", from: shas.side, to: shas.two, past: true });
  assert.deepEqual(state(), before);
});

test("against git: a target off upstream's main, or one upstream does not have, stops", async (t) => {
  const { shas, state, move } = repositories(t);
  const before = state();
  const branch = (await move(shas.side)).result;
  assert.ok(branch.status === "blocked");
  assert.deepEqual([branch.cause, branch.command], ["target", undefined]);
  assert.match(branch.reason, /is not on upstream's main, and only commits on main are pinned\. Nothing was moved\./);
  assert.doesNotMatch(branch.reason, /--preview|tag or branch/);
  for (const absent of ["0".repeat(39) + "1", "0000001"]) {
    const { result } = await move(absent);
    assert.ok(result.status === "blocked", absent);
    assert.deepEqual([result.cause, result.command, result.to], ["target", undefined, undefined], absent);
  }
  assert.deepEqual(state(), before);
});

test("against git: uncommitted changes are in the way of a move only, and are left as they were", async (t) => {
  const { project, shas, state, move } = repositories(t);
  writeFileSync(join(project, "deployment.jsonc"), `${TEMPLATE}\n// edited\n`);
  const before = state();
  assert.equal(before.status, "M deployment.jsonc");
  assert.deepEqual((await move(shas.two)).result, { status: "current", path: "cloudflare-os", from: shas.three, to: shas.two, past: true });
  for (const dryRun of [true, false]) {
    const { result } = await move(shas.four, { dryRun });
    assert.ok(result.status === "blocked");
    assert.deepEqual([result.cause, result.behind, result.command, result.from, result.to],
      ["checkout", true, `pnpm cf-os update --to ${shas.four}`, shas.three, shas.four]);
    assert.match(result.reason, /The checkout has uncommitted changes[\s\S]*M deployment\.jsonc/);
  }
  assert.deepEqual(state(), before);
});

test("against git: run again after a move, the staged pin is the pin, and a further move waits for it to be committed", async (t) => {
  const { shas, commit, state, move } = repositories(t);
  assert.equal((await move(shas.four)).result.status, "moved");
  const staged = state();
  assert.deepEqual([staged.committedPin, staged.stagedPin, staged.status], [shas.three, shas.four, "M  cloudflare-os"]);
  assert.deepEqual((await move(shas.four)).result, { status: "current", path: "cloudflare-os", from: shas.four, to: shas.four, past: false });
  // At the committed pin's own commit, which the staged one is past.
  assert.deepEqual((await move(shas.three)).result, { status: "current", path: "cloudflare-os", from: shas.four, to: shas.three, past: true });
  commit("five");
  const { result } = await move(shas.five);
  assert.ok(result.status === "blocked");
  assert.deepEqual([result.cause, result.behind, result.command, result.from, result.to],
    ["checkout", true, `pnpm cf-os update --to ${shas.five}`, shas.four, shas.five]);
  assert.match(result.reason, /The cloudflare-os pin is staged/);
  assert.deepEqual(state(), staged);
});

test("against git: a submodule checked out behind its pin is not called current, and a move forward checks it out", async (t) => {
  const { submodule, shas, git, state, move } = repositories(t);
  git(submodule, ["checkout", "-q", "--detach", shas.two]);
  const before = state();
  assert.equal(before.status, "M cloudflare-os");
  for (const to of [shas.three, shas.one]) {
    const { result } = await move(to);
    assert.ok(result.status === "blocked", to);
    assert.deepEqual([result.cause, result.behind, result.command], ["checkout", false, undefined]);
    assert.match(result.reason, new RegExp(`cloudflare-os is checked out at ${shas.two.slice(0, 7)}, not at its pin ${shas.three.slice(0, 7)}`));
  }
  assert.deepEqual(state(), before);
  assert.equal((await move(shas.four)).result.status, "moved");
  assert.deepEqual([state().stagedPin, state().checkedOut, state().status], [shas.four, shas.four, "M  cloudflare-os"]);
});

test("against git: in a shallow clone, a target older than its history reaches is found by fetching main whole, and is behind the pin", async (t) => {
  const { submodule, shas, git, state, move } = repositories(t, { shallow: true });
  assert.equal(git(submodule, ["rev-parse", "--is-shallow-repository"]), "true");
  const before = state();
  assert.equal(before.committedPin, shas.four);
  // By its abbreviation, which a clone holding the pin alone cannot resolve, nor one deepened back to the pin.
  assert.deepEqual((await move(shas.two.slice(0, 7))).result, { status: "current", path: "cloudflare-os", from: shas.four, to: shas.two, past: true });
  assert.equal(git(submodule, ["rev-parse", "--is-shallow-repository"]), "false");
  assert.deepEqual(state(), before);
  // With the whole of main there, an abbreviation no commit has is a stop.
  const { result } = await move("0000001");
  assert.ok(result.status === "blocked");
  assert.deepEqual([result.cause, result.command], ["target", undefined]);
  assert.match(result.reason, /0000001 is not a commit on upstream's main: no commit in its history abbreviates to it/);
  assert.deepEqual(state(), before);
});

test("against git: in a shallow clone, a full SHA behind the pin is fetched and compared, and one ahead of it is moved to", async (t) => {
  const { shas, commit, state, move } = repositories(t, { shallow: true });
  const before = state();
  assert.deepEqual((await move(shas.one)).result, { status: "current", path: "cloudflare-os", from: shas.four, to: shas.one, past: true });
  assert.deepEqual(state(), before);
  commit("five");
  const { result } = await move(shas.five);
  assert.ok(result.status === "moved");
  assert.deepEqual([result.from, result.to, result.commits], [shas.four, shas.five, 1]);
  assert.deepEqual([state().committedPin, state().stagedPin, state().checkedOut], [shas.four, shas.five, shas.five]);
});

test("against git: a pin that would be left behind a commit it must be at or past is not moved, and nothing changes", async (t) => {
  const { shas, state, move } = repositories(t, { pin: "two" });
  const before = state();
  const three = shas.three.slice(0, 7);
  // The target is behind the pin, so the pin would stay at `two`, which `three` is ahead of: by a
  // comparison alone, and by a move, at a terminal or not.
  for (const options of [{ dryRun: true }, {}, { script: [] }]) {
    const { result } = await move(shas.one, { ...options, atLeast: [three] });
    assert.deepEqual(result, {
      status: "blocked", cause: "floor", behind: false, command: undefined, from: shas.two, to: shas.one,
      reason: `${three} is ahead of ${shas.two.slice(0, 7)}, where this would leave cloudflare-os's pin, so the pin would be ` +
        "behind it, and nothing was moved.",
    });
    assert.deepEqual(state(), before);
  }
  // The same of a target that is the pin, and of one ahead of the pin that is still short of the commit.
  const short = await move(shas.three, { atLeast: [shas.four] });
  assert.ok(short.result.status === "blocked");
  assert.deepEqual([short.result.cause, short.result.command, short.result.from, short.result.to], ["floor", undefined, shas.two, shas.three]);
  assert.match(short.result.reason, new RegExp(`${shas.four.slice(0, 7)} is ahead of ${three}, where this would leave`));
  assert.equal((await move(shas.two, { atLeast: [three] })).result.status, "blocked");
  // A commit off the pin's line cannot be placed, and one git does not have is not looked past.
  const aside = await move(shas.four, { atLeast: [shas.side.slice(0, 7)] });
  assert.ok(aside.result.status === "blocked" && aside.result.cause === "floor");
  assert.match(aside.result.reason, /git could not place .* so whether the pin would be behind it is unknown, and nothing was moved/);
  const absent = await move(shas.four, { atLeast: ["0000001"] });
  assert.ok(absent.result.status === "blocked" && absent.result.cause === "floor");
  assert.match(absent.result.reason, /0000001 is not a commit cloudflare-os has of upstream's main/);
  // Anything but a SHA never reaches git.
  const unreadable = await move(shas.four, { atLeast: ["main"] });
  assert.deepEqual(unreadable.result, {
    status: "blocked", cause: "floor", behind: false, command: undefined, from: undefined, to: undefined,
    reason: "main is not a commit SHA: seven to 40 hexadecimal characters.",
  });
  assert.deepEqual(state(), before);
});

test("against git: a pin at or past every commit it is held to moves, or stays, as it would without them", async (t) => {
  const { shas, state, move } = repositories(t, { pin: "two" });
  const before = state();
  // Behind the pin already, or the pin itself: nothing in the way of a target behind the pin either.
  assert.deepEqual((await move(shas.one, { atLeast: [shas.one.slice(0, 7), shas.two] })).result,
    { status: "current", path: "cloudflare-os", from: shas.two, to: shas.one, past: true });
  assert.deepEqual(state(), before);
  // Ahead of the pin, and the target is at or past it: the move is made, to the target.
  assert.deepEqual((await move(shas.four, { dryRun: true, atLeast: [shas.three.slice(0, 7)] })).result,
    { status: "behind", path: "cloudflare-os", from: shas.two, to: shas.four, commits: 2 });
  assert.deepEqual(state(), before);
  const { result } = await move(shas.four, { atLeast: [shas.three.slice(0, 7), shas.four.slice(0, 7)] });
  assert.ok(result.status === "moved");
  assert.deepEqual([state().committedPin, state().stagedPin, state().checkedOut], [shas.two, shas.four, shas.four]);
});

test("against git: in a shallow clone, a commit to be at or past is looked for in the whole of main", async (t) => {
  const { submodule, shas, git, state, move } = repositories(t, { shallow: true });
  const before = state();
  assert.equal(before.committedPin, shas.four);
  // The clone holds the pin alone; `one` is found once main is whole, and the pin is past it.
  assert.deepEqual((await move(shas.four, { atLeast: [shas.one.slice(0, 7)] })).result,
    { status: "current", path: "cloudflare-os", from: shas.four, to: shas.four, past: false });
  assert.equal(git(submodule, ["rev-parse", "--is-shallow-repository"]), "false");
  assert.deepEqual(state(), before);
});

test("against git: forward only, --upstream with no --to moves the pin to upstream's main, and a pin there or off main stays", async (t) => {
  const { project, shas, ran, state, deps } = repositories(t);
  const advance = async (values: Record<string, boolean> = {}) => {
    const harness = testContext({ root: project, prompter: null });
    const code = await update({ command: "update", values: { upstream: true, ...values }, positionals: [] }, harness.ctx, deps, { forwardOnly: true });
    return { code, json: harness.json };
  };
  const before = state();
  const dry = await advance({ "dry-run": true });
  assert.equal(dry.code, 0);
  assert.partialDeepStrictEqual(dry.json, [{ status: "dry-run", mode: "pin", starter: null, pin: { from: shas.three, to: shas.four, staged: false } }]);
  assert.deepEqual(state(), before);

  const moved = await advance();
  assert.equal(moved.code, 0);
  assert.partialDeepStrictEqual(moved.json, [{ status: "updated", mode: "pin", starter: null, pin: { from: shas.three, to: shas.four, staged: true, rollback: false } }]);
  const after = state();
  assert.deepEqual(after, { ...before, stagedPin: shas.four, checkedOut: shas.four, status: "M  cloudflare-os", brief: true });
  assert.deepEqual(ran.filter(touchesStarter), []);

  // Run again, the staged pin is main's tip: nothing to do.
  const again = await advance();
  assert.equal(again.code, 0);
  assert.partialDeepStrictEqual(again.json, [{ status: "current", pin: { from: shas.four, to: shas.four, moved: false } }]);
  assert.deepEqual(state(), after);

  // A pin off main: main does not descend from it, so it is neither moved nor called current.
  const aside = repositories(t, { pin: "side" });
  const unmoved = aside.state();
  const harness = testContext({ root: aside.project, prompter: null });
  await assert.rejects(
    update({ command: "update", values: { upstream: true }, positionals: [] }, harness.ctx, aside.deps, { forwardOnly: true }),
    /does not descend from cloudflare-os's pin .* not a move forward, and nothing was moved\./);
  assert.deepEqual(harness.json, []);
  assert.deepEqual(aside.state(), unmoved);
  assert.deepEqual(aside.ran.filter(touchesStarter), []);
});

test("against git: a pin staged behind the committed one is the pin: a target ahead of it waits, one at or behind it changes nothing", async (t) => {
  const { project, submodule, shas, git, state, move } = repositories(t);
  // A rollback staged and checked out, not committed: HEAD pins `three`, the index and the checkout `two`.
  git(submodule, ["checkout", "-q", "--detach", shas.two]);
  git(project, ["add", "cloudflare-os"]);
  const before = state();
  assert.deepEqual([before.committedPin, before.stagedPin, before.checkedOut, before.status], [shas.three, shas.two, shas.two, "M  cloudflare-os"]);
  // What a build would use is `two`: the committed pin's own commit is ahead of that, and so a move.
  for (const to of [shas.four, shas.three]) {
    const { result } = await move(to);
    assert.ok(result.status === "blocked", to);
    assert.deepEqual([result.cause, result.behind, result.command, result.from, result.to],
      ["checkout", true, `pnpm cf-os update --to ${to}`, shas.two, to]);
    assert.match(result.reason, /The cloudflare-os pin is staged/);
    assert.deepEqual(state(), before);
  }
  assert.deepEqual((await move(shas.two)).result, { status: "current", path: "cloudflare-os", from: shas.two, to: shas.two, past: false });
  assert.deepEqual((await move(shas.one)).result, { status: "current", path: "cloudflare-os", from: shas.two, to: shas.one, past: true });
  assert.deepEqual(state(), before);
});

test("against git: a checkout git refuses part of the way leaves the pin, the index and the project as they were, with no brief", async (t) => {
  const { upstream, submodule, shas, git, ran, state, move } = repositories(t);
  // A commit on main adds a file the submodule's checkout already has, untracked: git will not overwrite it.
  writeFileSync(join(upstream, "added.txt"), "upstream's\n");
  git(upstream, ["add", "added.txt"]);
  git(upstream, ["commit", "-q", "-m", "five"], DATES.five);
  const five = git(upstream, ["rev-parse", "HEAD"]);
  writeFileSync(join(submodule, "added.txt"), "kept\n");
  const before = state();
  assert.equal(before.brief, false);
  const { result } = await move(five);
  assert.ok(result.status === "blocked");
  assert.deepEqual([result.cause, result.behind, result.command, result.from, result.to],
    ["incomplete", true, `pnpm cf-os update --to ${five}`, shas.three, five]);
  assert.match(result.reason, new RegExp(`^Could not stage cloudflare-os at ${five}\\.`));
  assert.deepEqual(state(), before);
  assert.equal(readFileSync(join(submodule, "added.txt"), "utf8"), "kept\n");
  assert.ok(!ran.includes("pnpm install"));
});
