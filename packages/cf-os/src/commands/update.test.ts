import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scratchProject, scriptedPrompter, TEMPLATE, testContext, type Step } from "../test-support.ts";
import { DEFAULT_TEMPLATE, UPSTREAM } from "./scaffold.ts";
import { BRIEF, findSubmodule, update, type UpdateDeps } from "./update.ts";

const OLD_HEAD = "a".repeat(40);
const TARGET = "b".repeat(40);
const OLD_PIN = "c".repeat(40);
const NEW_PIN = "d".repeat(40);
const UPSTREAM_MAIN = "e".repeat(40);
const OLDER = "f".repeat(40);

/** One recorded reply. */
type Reply = { status?: number; stdout?: string; stderr?: string };

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
      return { status: reply.status ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
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
    values?: Record<string, string | boolean>; replies?: Replies; script?: Step[]; path?: string;
    /** The root `package.json`: written empty, as given, or not at all. */
    packageJson?: boolean | object;
  } = {},
) {
  const root = path ? scratchRepository(t, path) : scratchProject(t, TEMPLATE);
  path ??= "cloudflare-os";
  writeFileSync(join(root, path, ".git"), `gitdir: ../.git/modules/${path}\n`);
  if (packageJson) writeFileSync(join(root, "package.json"), `${JSON.stringify(packageJson === true ? {} : packageJson)}\n`);
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
  assert.doesNotMatch(text, /pnpm cf-os|set-url/);
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
    api: null,
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

/** A root `package.json` with the starter's `api:generate` script. */
const GENERATING = { scripts: { "api:generate": "node packages/cf-os/generator/generate.ts" } };

/** The generated files, as `api:generate` reports them. */
const GENERATED = ["packages/cf-os/src/api/generated/commands.ts", "packages/cf-os/src/api/generated/schema.json"];

/** `api:generate`'s stdout: one JSON line, as generate.ts prints it. */
const generatedJson = (commands: { added?: string[]; removed?: string[]; changed?: string[] }, files = GENERATED) =>
  `${JSON.stringify({ files, commands: { added: [], removed: [], changed: [], ...commands } })}\n`;

/** The JSON summary's `api`, as far as these tests read it. */
type Api = { status: string; files?: string[]; added?: string[]; removed?: string[]; changed?: string[] } | null;
const apiOf = (json: unknown[]) => (json[0] as { api: Api }).api;

test("runs api:generate after the install only when the root package.json has the script", async (t) => {
  const without = await updating(t, { path: "public", values: { upstream: true } });
  assert.ok(!without.commands().some((command) => command.includes("api:generate")));
  assert.equal(apiOf(without.json), null);
  assert.doesNotMatch(without.brief()!, /API commands|api:generate/);

  const { code, commands, ran, root } = await updating(t, {
    path: "public", values: { upstream: true }, packageJson: GENERATING,
    replies: { "pnpm run api:generate": { stdout: generatedJson({}, []) } },
  });
  assert.equal(code, 0);
  // Its commands compared with where the update started, not with the working tree a merge changed.
  assert.deepEqual(commands().slice(-2), ["pnpm install", `pnpm run api:generate --since ${OLD_HEAD}`]);
  // Captured, as its stdout is the JSON read back, and run in the root.
  const generate = ran.at(-1)!;
  assert.deepEqual([generate.cwd, generate.capture], [root, true]);
});

test("api:generate's commands are in the brief, capped, and in full in the JSON; its files are left unstaged", async (t) => {
  const added = Array.from({ length: 22 }, (_, index) => `open-gadget new-${String(index).padStart(2, "0")}`);
  const { code, commands, json, stderr, brief } = await updating(t, {
    path: "public", values: { upstream: true }, packageJson: GENERATING,
    replies: {
      "pnpm run api:generate": {
        stdout: generatedJson({ added, removed: ["public old-thing"], changed: ["open-gadget get-chat-history"] }),
      },
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(apiOf(json), {
    status: "generated", files: GENERATED, added, removed: ["public old-thing"], changed: ["open-gadget get-chat-history"],
  });
  // Staged is the pin alone: nothing adds what generation wrote.
  assert.deepEqual(commands().filter((command) => command.startsWith("git add")), ["git add public"]);
  assert.match(stderr(), /API commands: 22 added, 1 removed, 1 changed; 2 regenerated files left unstaged, for review\.\n {2}Added:\n {4}open-gadget new-00\n/);
  assert.match(stderr(), / {4}open-gadget new-19\n {4}… 2 more\n {2}Removed:\n {4}public old-thing\n {2}Changed \(arguments or result\):\n {4}open-gadget get-chat-history/);
  assert.doesNotMatch(stderr(), /new-20/);

  const text = brief()!;
  assert.match(text, /## API commands\n\n`pnpm run api:generate` regenerated `cf-os api` from the pin: 22 added, 1 removed, 1 changed\. These files are left unstaged, for review:\n\n- `packages\/cf-os\/src\/api\/generated\/commands\.ts`\n- `packages\/cf-os\/src\/api\/generated\/schema\.json`\n\nAdded \(22\):\n\n- `open-gadget new-00`/);
  assert.match(text, /- `open-gadget new-19`\n- … and 2 more\n\nRemoved \(1\):\n\n- `public old-thing`\n\nChanged \(arguments or result\) \(1\):\n\n- `open-gadget get-chat-history`/);
  assert.doesNotMatch(text, /new-20/);
  assert.match(text, /generated files were regenerated from the pin and left unstaged .*Review them with the staged pin: .*Then commit them with the pin \(`git add packages\/cf-os\/src\/api\/generated\/commands\.ts packages\/cf-os\/src\/api\/generated\/schema\.json`\)\./);
  assert.match(text, /## Undo\n\n- To drop the regenerated API files, first: `git restore -- packages\/cf-os\/src\/api\/generated\/commands\.ts /);
});

test("after a clean starter merge, regenerated API files mean the update is not done: they go in a commit after the merge", async (t) => {
  const { code, stderr, brief } = await updating(t, {
    packageJson: GENERATING, script: [["Merge 2 starter commits", true]],
    replies: { "pnpm run api:generate": { stdout: generatedJson({ changed: ["whoami"] }, GENERATED.slice(1)) } },
  });
  assert.equal(code, 0);
  assert.doesNotMatch(stderr(), /Next: `pnpm cf-os check`/);
  assert.match(stderr(), /Next: ask your coding agent to follow \.cf-os\/update\.md\./);
  assert.match(brief()!, /Then commit them in a commit of their own, right after the merge \(`git add packages\/cf-os\/src\/api\/generated\/schema\.json`\)\./);
});

test("after a merge that brought the regenerated files, the commands it changed are still the brief's", async (t) => {
  const { code, json, stderr, brief } = await updating(t, {
    packageJson: GENERATING, script: [["Merge 2 starter commits", true]],
    replies: { "pnpm run api:generate": { stdout: generatedJson({ removed: ["public old-thing"] }, []) } },
  });
  assert.equal(code, 0);
  assert.deepEqual(apiOf(json), { status: "generated", files: [], added: [], removed: ["public old-thing"], changed: [] });
  assert.match(stderr(), /API commands: 0 added, 1 removed, 0 changed; the generated files already match the pin\.\n {2}Removed:\n {4}public old-thing/);
  // A removed command is work for the agent, not a clean update.
  assert.match(stderr(), /Next: ask your coding agent to follow \.cf-os\/update\.md\./);
  const text = brief()!;
  assert.match(text, new RegExp("## API commands\\n\\n`pnpm run api:generate` ran, and the generated files already matched the pin, " +
    `as the merge brought them\\. Since \`${OLD_HEAD}\`, where the update started, the API commands changed: 0 added, 1 removed, 0 changed\\.\\n\\nRemoved \\(1\\):\\n\\n- \`public old-thing\``));
  assert.match(text, /Some `cf-os api` commands were removed or changed \(listed under "API commands"\): that breaks the scripts/);
  assert.doesNotMatch(text, /left unstaged|git restore -- packages/);
});

test("api:generate with nothing to change says so, and adds no step", async (t) => {
  const { code, json, stderr, brief } = await updating(t, {
    path: "public", values: { upstream: true }, packageJson: GENERATING,
    replies: { "pnpm run api:generate": { stdout: generatedJson({}, []) } },
  });
  assert.equal(code, 0);
  assert.deepEqual(apiOf(json), { status: "generated", files: [], added: [], removed: [], changed: [] });
  assert.match(stderr(), /API commands: the generated files already match the pin\./);
  const text = brief()!;
  assert.match(text, /## API commands\n\n`pnpm run api:generate` ran, and the generated files already matched the pin/);
  assert.doesNotMatch(text, /left unstaged|git restore -- packages|api:check/);
});

test("a failing api:generate is reported, and leaves the pin staged: not fatal to the move", async (t) => {
  const { code, commands, json, stderr, brief } = await updating(t, {
    path: "public", values: { upstream: true }, packageJson: GENERATING,
    replies: { "pnpm run api:generate": { status: 1, stdout: "", stderr: "API generation failed: unsupported type" } },
  });
  assert.equal(code, 1);
  assert.ok(commands().includes("git add public"));
  assert.equal(pinOf(json).moved, true);
  assert.equal((json[0] as { pin: { staged: boolean } }).pin.staged, true);
  assert.deepEqual(apiOf(json), { status: "failed" });
  const { problems } = json[0] as { problems: string[] };
  assert.match(problems.join("\n"), /`pnpm run api:generate` failed, so `cf-os api`'s generated files may not match the pin\./);
  // Its output is captured, so its end is shown for the failure.
  assert.match(stderr(), /Running pnpm run api:generate\.\nAPI generation failed: unsupported type/);
  const text = brief()!;
  assert.match(text, /Still to do:\n\n- `pnpm run api:generate` failed/);
  assert.match(text, /## API commands\n\n`pnpm run api:generate` failed: see "Still to do"\./);
  assert.match(text, /fix what it reports .* `pnpm lint` runs `api:check`, which fails until they match the pin\./);
});

test("api:generate that prints no result is a problem too", async (t) => {
  const { code, json } = await updating(t, {
    path: "public", values: { upstream: true }, packageJson: GENERATING,
    replies: { "pnpm run api:generate": { stdout: "not json\n" } },
  });
  assert.equal(code, 1);
  assert.deepEqual(apiOf(json), { status: "failed" });
  assert.match((json[0] as { problems: string[] }).problems.join("\n"), /printed no result/);
});

test("api:generate waits for the install: not run when it failed, and the brief says to run it after", async (t) => {
  const { commands, json, brief } = await updating(t, {
    path: "public", values: { upstream: true }, packageJson: GENERATING, replies: { "pnpm install": { status: 1 } },
  });
  assert.ok(!commands().includes("pnpm run api:generate"));
  assert.deepEqual(apiOf(json), { status: "not-run" });
  const text = brief()!;
  assert.match(text, /## API commands\n\n`pnpm run api:generate` did not run, as the install did not complete\./);
  assert.match(text, /Once `pnpm install` has run, run `pnpm api:generate` too/);
});

test("--dry-run runs no api:generate", async (t) => {
  const { commands, json } = await updating(t, { values: { "dry-run": true }, packageJson: GENERATING });
  assert.ok(!commands().some((command) => command.startsWith("pnpm")));
  assert.equal(apiOf(json), null);
});
