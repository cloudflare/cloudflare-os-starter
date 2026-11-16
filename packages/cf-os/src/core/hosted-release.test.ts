import assert from "node:assert/strict";
import test from "node:test";
import { cfClient } from "../cf-client.ts";
import { FAKE_ACCOUNT, fakeCf } from "../fake-cf.ts";
import {
  HOSTED_COMMIT,
  HOSTED_FINGERPRINT,
  HOSTED_RELEASE,
  fixtureVersionId,
  hostedAccountLive,
  hostedAnnotations,
  hostedInstanceLive,
  hostedMemoryAccount,
  hostedWorkerLive,
  pinnedDurableObjects,
  type HostedWorkerOptions,
} from "../test-support.ts";
import { CfAuthError, CfError, type CfWorkerVersion } from "./client.ts";
import {
  HAND_EDITED_NOTICE,
  PUSH_IDENTITY_SECRET,
  backendValues,
  decideCommit,
  flowTag,
  formatHandEdited,
  formatReleases,
  handEdited,
  hostedInstance,
  instanceRelease,
  instanceStops,
  instanceSummary,
  instanceWorker,
  liveMigrationTag,
  liveMigrations,
  migrationClasses,
  migrationGap,
  parseRelease,
  readInstance,
  readMigrations,
  readWorker,
  readWorkers,
  versionRelease,
  versionReleases,
  type CommitFloor,
  type MigrationStep,
  type ReleaseReport,
  type WorkerReading,
} from "./hosted-release.ts";
import { memoryClient } from "./memory-client.ts";

/** A later release than the fixtures', and one that no run number orders. */
const NEWER = "r004950-abcdef0";
const HAND_BUILT = "dev-t4k2p9";

/** What the two phrases the deploy flow's operators are told to expect must read, to the letter. */
const MOVED = (to: string) => `the instance moved to ${to} since this command was made; get a fresh one from the deploy flow`;
const ASK = "could not determine the commit; pass --commit, or copy the command from the deploy flow";

/** The reading of Worker `name` built with `options`, as `readWorker` would return it. */
function reading(name: string, options: HostedWorkerOptions = {}): WorkerReading {
  const { deployments, versions } = hostedWorkerLive(name, options);
  return { name, deployment: deployments[0], versions: [versions[0]] };
}

/** The reading of Worker `name` of the fixture instance "acme", its options changed by `change`. */
function instanceReading(name: string, change: HostedWorkerOptions = {}): WorkerReading {
  const { deployments, versions } = hostedInstanceLive({ [name]: change })[name];
  return { name, deployment: deployments[0], versions: [versions[0]] };
}

/** What the fixture instance's backend carries, its options changed by `change`. */
function backendValuesWith(change: HostedWorkerOptions) {
  return backendValues(instanceReading("acme-backend", change));
}

/** The live version of a Worker built with `options`. */
function version(options: HostedWorkerOptions = {}): CfWorkerVersion {
  return reading("acme-backend", options).versions[0];
}

/** A report that Worker `name` runs release `id`. */
function report(name: string, id: string): ReleaseReport {
  const release = parseRelease(id);
  assert.ok(release, `${id} is not a release id`);
  return { name, release };
}

/** A report that Worker `name` runs release run `run`, its id unknown. */
function runOnly(name: string, run: number): ReleaseReport {
  return { name, release: { id: null, run, sha7: null } };
}

test("takes a release id apart: the run number that orders it and the commit it ends in", () => {
  assert.deepEqual(parseRelease(HOSTED_RELEASE), { id: HOSTED_RELEASE, run: 4945, sha7: "6c8d301" });
  assert.deepEqual(parseRelease("r1234567-0a1b2c3"), { id: "r1234567-0a1b2c3", run: 1234567, sha7: "0a1b2c3" });
  // A hand-built or staging id orders nothing and names no commit.
  assert.deepEqual(parseRelease(HAND_BUILT), { id: HAND_BUILT, run: null, sha7: null });
  assert.deepEqual(parseRelease("4945"), { id: "4945", run: null, sha7: null });
  // A run number without a seven-digit commit still orders.
  assert.deepEqual(parseRelease("r004945-6c8d301-dirty"), { id: "r004945-6c8d301-dirty", run: 4945, sha7: null });
  assert.deepEqual(parseRelease("r004945-6C8D301"), { id: "r004945-6C8D301", run: 4945, sha7: null });
  for (const bad of ["", "-r1", "r1 2", "r004945/6c8d301", "a".repeat(65), "$(id)"]) assert.equal(parseRelease(bad), null, bad);
});

test("recognises the hosted flow's version tag, and nothing that merely resembles it", () => {
  assert.deepEqual(flowTag(version()), { release: "4945", fingerprint: HOSTED_FINGERPRINT });
  assert.deepEqual(flowTag(version({ release: HAND_BUILT })), { release: HAND_BUILT, fingerprint: HOSTED_FINGERPRINT });
  for (const tag of ["gd:4945", "gd:4945:1A2B3C4D", "gd:4945:1a2b3c4", "gd::1a2b3c4d", "gx:4945:1a2b3c4d", "v1.2.3", " gd:4945:1a2b3c4d"]) {
    assert.equal(flowTag(version({ annotations: { "workers/tag": tag } })), null, tag);
  }
  assert.equal(flowTag({ id: "v" }), null);
});

test("reads a version's release from its annotations first", () => {
  assert.deepEqual(versionRelease(version()), { id: HOSTED_RELEASE, run: 4945, sha7: "6c8d301", source: "annotations" });
  // The message without an upload id, as the contract allows.
  const bare = version({
    releaseVar: false,
    annotations: { "workers/tag": `gd:4945:${HOSTED_FINGERPRINT}`, "workers/message": `Cloudflare OS gk-github from release ${HOSTED_RELEASE}` },
  });
  assert.deepEqual(versionRelease(bare), { id: HOSTED_RELEASE, run: 4945, sha7: "6c8d301", source: "annotations" });
  // A hand-built release: the tag carries the whole id, the message names it too.
  assert.deepEqual(versionRelease(version({ release: HAND_BUILT })),
    { id: HAND_BUILT, run: null, sha7: null, source: "annotations" });
  // The annotations outrank a variable that says otherwise.
  const disagreeing = version({ releaseVar: false, vars: { CLOUDFLARE_OS_RELEASE_ID: NEWER } });
  assert.equal(versionRelease(disagreeing)?.id, HOSTED_RELEASE);
});

test("falls back to the release variable, then on the backend to the install description", () => {
  const tagOnly = { "workers/tag": `gd:4945:${HOSTED_FINGERPRINT}` };
  assert.deepEqual(versionRelease(version({ annotations: tagOnly })),
    { id: HOSTED_RELEASE, run: 4945, sha7: "6c8d301", source: "release-var" });
  const install = { json: { CLOUDFLARE_OS_DEPLOYMENT: { releaseId: HOSTED_RELEASE } } };
  const noVar = version({ annotations: tagOnly, releaseVar: false, ...install });
  assert.deepEqual(versionRelease(noVar, { backend: true }),
    { id: HOSTED_RELEASE, run: 4945, sha7: "6c8d301", source: "deployment-var" });
  // Only the backend's install description counts: any other Worker carrying one is not believed.
  assert.deepEqual(versionRelease(noVar), { id: null, run: 4945, sha7: null, source: "tag" });
  // The description as JSON text, which is how a variable set by hand holds it.
  const text = version({ annotations: tagOnly, releaseVar: false, vars: { CLOUDFLARE_OS_DEPLOYMENT: JSON.stringify({ releaseId: HOSTED_RELEASE }) } });
  assert.equal(versionRelease(text, { backend: true })?.source, "deployment-var");
  for (const broken of ["{", "[]", "null", JSON.stringify({ releaseId: 4945 }), JSON.stringify({ releaseId: "not a release" })]) {
    const unreadable = version({ annotations: tagOnly, releaseVar: false, vars: { CLOUDFLARE_OS_DEPLOYMENT: broken } });
    assert.equal(versionRelease(unreadable, { backend: true })?.source, "tag", broken);
  }
});

test("believes a message or a variable only when it is the release the tag stands for", () => {
  // The tag says run 4950; a message and a variable left over from 4945 are not the version's release.
  const stale = version({
    annotations: { ...hostedAnnotations(HOSTED_RELEASE), "workers/tag": `gd:4950:${HOSTED_FINGERPRINT}` },
    json: { CLOUDFLARE_OS_DEPLOYMENT: { releaseId: HOSTED_RELEASE } },
  });
  assert.deepEqual(versionRelease(stale, { backend: true }), { id: null, run: 4950, sha7: null, source: "tag" });
  // A hand-built release's tag is its id, which no other id stands for.
  const handBuilt = version({ release: HOSTED_RELEASE, annotations: { "workers/tag": `gd:${HAND_BUILT}:${HOSTED_FINGERPRINT}` } });
  assert.deepEqual(versionRelease(handBuilt), { id: HAND_BUILT, run: null, sha7: null, source: "tag" });
  // A release named by nothing but digits is its own tag.
  const digits = version({ release: "20261001" });
  assert.deepEqual(versionRelease(digits), { id: "20261001", run: null, sha7: null, source: "annotations" });
  // Digits too many to count with stand for no run number, and so for no release that carries none.
  const uncountable = version({
    release: HAND_BUILT,
    annotations: {
      "workers/tag": `gd:99999999999999999999:${HOSTED_FINGERPRINT}`,
      "workers/message": `Cloudflare OS core from release ${HAND_BUILT}`,
    },
  });
  assert.deepEqual(versionRelease(uncountable), { id: null, run: null, sha7: null, source: "tag" });
});

test("does not trust a release id that runs to the end of a message as long as the API keeps", () => {
  const tag = `gd:4945:${HOSTED_FINGERPRINT}`;
  const prefix = "Cloudflare OS gk-homeassistant from release ";
  const cut = `${prefix}${"r004945-6c8d301-with-a-long-hand-built-suffix-that-runs-on-and-on"}`.slice(0, 100);
  assert.equal(cut.length, 100);
  const truncated = version({ annotations: { "workers/tag": tag, "workers/message": cut } });
  // The variable, which nothing truncates, is what names the release.
  assert.deepEqual(versionRelease(truncated), { id: HOSTED_RELEASE, run: 4945, sha7: "6c8d301", source: "release-var" });
  assert.deepEqual(versionRelease(version({ annotations: { "workers/tag": tag, "workers/message": cut }, releaseVar: false })),
    { id: null, run: 4945, sha7: null, source: "tag" });
});

test("reads a hand-edited version's release from its variables alone", () => {
  const edited = version({ handEdited: true });
  assert.equal(flowTag(edited), null);
  assert.deepEqual(versionRelease(edited), { id: HOSTED_RELEASE, run: 4945, sha7: "6c8d301", source: "release-var" });
  // A message is evidence only beside the tag: anyone can type one.
  const typed = version({
    annotations: { "workers/message": `Cloudflare OS core from release ${NEWER}` },
    releaseVar: false,
    json: { CLOUDFLARE_OS_DEPLOYMENT: { releaseId: HOSTED_RELEASE } },
  });
  assert.equal(versionRelease(typed), null);
  assert.deepEqual(versionRelease(typed, { backend: true }), { id: HOSTED_RELEASE, run: 4945, sha7: "6c8d301", source: "deployment-var" });
  assert.equal(versionRelease({ id: "v" }, { backend: true }), null);
  assert.equal(versionRelease(version({ releaseVar: false, vars: { CLOUDFLARE_OS_RELEASE_ID: "not a release id" }, handEdited: true })), null);
});

test("reports every release a version gives evidence of when its tag, message and variables disagree", () => {
  const tag = `gd:4945:${HOSTED_FINGERPRINT}`;
  // One upload writes all three alike: one release, once.
  assert.deepEqual(versionReleases(version()), [{ id: HOSTED_RELEASE, run: 4945, sha7: "6c8d301", source: "annotations" }]);
  assert.deepEqual(versionReleases({ id: "v" }, { backend: true }), []);
  // A copied tag on a version whose message and variable name a later release: the tag's run, and the later release too.
  const copied = version({ release: NEWER, annotations: { "workers/tag": tag, "workers/message": `Cloudflare OS core from release ${NEWER}` } });
  assert.deepEqual(versionReleases(copied), [
    { id: null, run: 4945, sha7: null, source: "tag" },
    { id: NEWER, run: 4950, sha7: "abcdef0", source: "annotations" },
  ]);
  // The message agrees with the tag and a variable names a later release: both, the version's own first.
  assert.deepEqual(versionReleases(version({ releaseVar: false, vars: { CLOUDFLARE_OS_RELEASE_ID: NEWER } })).map(({ id, source }) => [id, source]),
    [[HOSTED_RELEASE, "annotations"], [NEWER, "release-var"]]);
  // One run number under two ids, and an id no run number orders against the tag's: neither is dropped.
  const sameRun = version({ releaseVar: false, vars: { CLOUDFLARE_OS_RELEASE_ID: "r004945-abcdef0" } });
  assert.deepEqual(versionReleases(sameRun).map(({ id }) => id), [HOSTED_RELEASE, "r004945-abcdef0"]);
  const handBuilt = version({ release: HOSTED_RELEASE, annotations: { "workers/tag": `gd:${HAND_BUILT}:${HOSTED_FINGERPRINT}` } });
  assert.deepEqual(versionReleases(handBuilt).map(({ id, source }) => [id, source]), [[HAND_BUILT, "tag"], [HOSTED_RELEASE, "release-var"]]);
  // What an older release left behind says nothing the tag does not, and is dropped.
  const leftover = version({ annotations: { ...hostedAnnotations(HOSTED_RELEASE), "workers/tag": `gd:4950:${HOSTED_FINGERPRINT}` } });
  assert.deepEqual(versionReleases(leftover), [{ id: null, run: 4950, sha7: null, source: "tag" }]);
  // Without the tag the variables are all there is: the backend's two, when they differ, are both reported.
  const edited = version({ handEdited: true, json: { CLOUDFLARE_OS_DEPLOYMENT: { releaseId: NEWER } } });
  assert.deepEqual(versionReleases(edited, { backend: true }).map(({ id, source }) => [id, source]),
    [[HOSTED_RELEASE, "release-var"], [NEWER, "deployment-var"]]);
  assert.deepEqual(versionReleases(edited).map(({ id }) => id), [HOSTED_RELEASE]);
});

test("never settles a version's contradictory evidence on the older release", () => {
  const tag = `gd:4945:${HOSTED_FINGERPRINT}`;
  const copied = reading("acme-backend", {
    release: NEWER,
    annotations: { "workers/tag": tag, "workers/message": `Cloudflare OS core from release ${NEWER}` },
  });
  const instance = hostedInstance([instanceWorker(reading("acme"), "router"), instanceWorker(copied, "backend")]);
  assert.deepEqual(instance.reports.map(({ name, release }) => [name, release.id ?? `run ${release.run}`]),
    [["acme", HOSTED_RELEASE], ["acme-backend", "run 4945"], ["acme-backend", NEWER]]);
  // The later release is the instance's, and its commit is the one pinned.
  assert.equal(instance.release.kind === "known" && instance.release.release.id, NEWER);
  assert.deepEqual(decideCommit(instance.reports), { ok: true, commit: "abcdef0", full: false, release: NEWER, from: "release" });
  // A command made for the older one is stale.
  const stale = decideCommit(instance.reports, { release: HOSTED_RELEASE, commit: HOSTED_COMMIT });
  assert.ok(!stale.ok && stale.reason === "stale" && stale.message.includes(MOVED(NEWER)));
  assert.equal(formatReleases(instance)[1],
    "  acme-backend  run 4945 (from its live version's tag alone), r004950-abcdef0 (from its live version's annotations)");
  // Evidence no run number orders stops instead.
  const mixed = reading("acme-backend", { annotations: { "workers/tag": `gd:${HAND_BUILT}:${HOSTED_FINGERPRINT}` } });
  const unordered = decideCommit(hostedInstance([instanceWorker(mixed, "backend")]).reports);
  assert.ok(!unordered.ok && unordered.reason === "unorderable" && unordered.message.includes(ASK));
});

test("lists a Worker whose live version is not the hosted flow's, with what the API says of it", () => {
  assert.equal(handEdited(reading("acme-backend")), null);
  const edited = reading("acme-backend", { handEdited: true });
  assert.deepEqual(handEdited(edited), {
    name: "acme-backend",
    reason: "its live version is not one the hosted flow uploaded",
    versionId: fixtureVersionId("acme-backend", 2),
    source: "dash",
    trigger: "upload",
    createdOn: "2026-10-20T14:30:00.000Z",
  });
  // Never deployed: nothing shows the code is the hosted flow's.
  assert.deepEqual(handEdited({ name: "acme", deployment: null, versions: [] }), {
    name: "acme", reason: "it has no live deployment", versionId: null, source: null, trigger: null, createdOn: null,
  });
  // A rollout between a hosted version and one made by hand.
  const split: WorkerReading = { ...edited, versions: [version(), edited.versions[0]] };
  assert.equal(handEdited(split)?.reason, "one of the 2 versions its deployment sends traffic to is not the hosted flow's");
  assert.equal(handEdited(split)?.versionId, fixtureVersionId("acme-backend", 2));
  // The trigger falls back to the deployment's when the version names none.
  const bare: WorkerReading = { name: "acme", deployment: edited.deployment, versions: [{ id: "v" }] };
  assert.equal(handEdited(bare)?.trigger, "deployment");
});

test("reports hand-edited Workers with the sentence about what a deploy does to them", () => {
  assert.deepEqual(formatHandEdited([]), []);
  const edited = handEdited(reading("acme-backend", { handEdited: true }));
  const undeployed = handEdited({ name: "acme", deployment: null, versions: [] });
  assert.ok(edited && undeployed);
  assert.deepEqual(formatHandEdited([edited, undeployed]), [
    "Workers changed by hand since the hosted flow deployed them:",
    `  acme-backend  its live version is not one the hosted flow uploaded (version ${fixtureVersionId("acme-backend", 2)}, ` +
      "source dash, triggered by upload, created 2026-10-20T14:30:00.000Z)",
    "  acme          it has no live deployment",
    HAND_EDITED_NOTICE,
  ]);
  assert.match(HAND_EDITED_NOTICE, /replaces each of these Workers' code, vars and bindings/);
  assert.match(HAND_EDITED_NOTICE, /must go into deployment\.jsonc or the source first/);
});

test("settles mixed releases by run number: the highest wins", () => {
  assert.deepEqual(instanceRelease([]), { kind: "none" });
  const same = [report("acme", HOSTED_RELEASE), report("acme-backend", HOSTED_RELEASE)];
  assert.deepEqual(instanceRelease(same), { kind: "known", release: parseRelease(HOSTED_RELEASE), behind: [] });
  // An optional Gatekeeper installed from a later release than the core Workers, whichever is listed first.
  const mixed = [report("acme", HOSTED_RELEASE), report("acme-backend", HOSTED_RELEASE), report("acme-gk-github", NEWER)];
  for (const reports of [mixed, mixed.toReversed()]) {
    const settled = instanceRelease(reports);
    assert.equal(settled.kind, "known");
    assert.deepEqual(settled.kind === "known" && settled.release, parseRelease(NEWER));
    assert.deepEqual(settled.kind === "known" && settled.behind.map(({ name }) => name).toSorted(), ["acme", "acme-backend"]);
  }
  // A run number read as a number, not as text: 10000 is after 9999.
  const rollover = instanceRelease([report("acme", "r010000-abcdef0"), report("acme-backend", "r009999-1234567")]);
  assert.equal(rollover.kind === "known" && rollover.release.id, "r010000-abcdef0");
});

test("does not settle releases it cannot order", () => {
  // One hand-built release everywhere is one release.
  assert.deepEqual(instanceRelease([report("acme", HAND_BUILT), report("acme-backend", HAND_BUILT)]),
    { kind: "known", release: parseRelease(HAND_BUILT), behind: [] });
  for (const reports of [
    [report("acme", HAND_BUILT), report("acme-backend", "dev-zz91")],
    [report("acme", HAND_BUILT), report("acme-backend", HOSTED_RELEASE)],
    [report("acme", HAND_BUILT), runOnly("acme-backend", 4945)],
    // One run number under two ids.
    [report("acme", HOSTED_RELEASE), report("acme-backend", "r004945-abcdef0")],
  ]) {
    assert.deepEqual(instanceRelease(reports), { kind: "unorderable", reports });
  }
  // The newest Worker's release is known by its run number alone.
  const tagged = [report("acme", HOSTED_RELEASE), runOnly("acme-gk-github", 4950)];
  assert.deepEqual(instanceRelease(tagged), { kind: "run-only", run: 4950, reports: tagged });
  // A bare run number no newer than a named release adds nothing.
  for (const run of [4945, 4000]) {
    const settled = instanceRelease([report("acme", HOSTED_RELEASE), runOnly("acme-gk-github", run)]);
    assert.equal(settled.kind === "known" && settled.release.id, HOSTED_RELEASE, String(run));
  }
});

test("without --commit, pins the commit the instance's release ends in", () => {
  const reports = [report("acme", HOSTED_RELEASE), report("acme-backend", HOSTED_RELEASE)];
  assert.deepEqual(decideCommit(reports), { ok: true, commit: "6c8d301", full: false, release: HOSTED_RELEASE, from: "release" });
  // Mixed: the newest release's commit, never an older one's.
  assert.deepEqual(decideCommit([...reports, report("acme-gk-github", NEWER)]),
    { ok: true, commit: "abcdef0", full: false, release: NEWER, from: "release" });
  // --release is one more report: whichever is newer is pinned. One no Worker reports is the
  // command's word alone, so the commit the Workers themselves name is still one to be at or past.
  assert.deepEqual(decideCommit(reports, { release: NEWER }), {
    ok: true, commit: "abcdef0", full: false, release: NEWER, from: "release",
    atLeast: [{ commit: "6c8d301", release: HOSTED_RELEASE, workers: ["acme", "acme-backend"] }],
  });
  assert.deepEqual(decideCommit([report("acme", NEWER)], { release: HOSTED_RELEASE }),
    { ok: true, commit: "abcdef0", full: false, release: NEWER, from: "release" });
  // And with nothing readable in the account, it is the only one.
  assert.deepEqual(decideCommit([], { release: HOSTED_RELEASE }),
    { ok: true, commit: "6c8d301", full: false, release: HOSTED_RELEASE, from: "release" });
});

test("without --commit, stops and asks for it when the release names no commit or cannot be settled", () => {
  const stops: [ReleaseReport[], { release?: string }, string, RegExp][] = [
    [[], {}, "no-commit", /No Worker of the instance says which release it runs, and no --release was given/],
    [[report("acme", HAND_BUILT)], {}, "no-commit", /Release dev-t4k2p9 does not say which commit it was built from/],
    [[], { release: HAND_BUILT }, "no-commit", /Release dev-t4k2p9 does not say which commit/],
    [[report("acme", HOSTED_RELEASE), runOnly("acme-gk-github", 4950)], {}, "no-commit", /runs release run 4950/],
    [[report("acme", HAND_BUILT), report("acme-backend", "dev-zz91")], {}, "unorderable", /acme: dev-t4k2p9, acme-backend: dev-zz91/],
    [[report("acme", HOSTED_RELEASE)], { release: HAND_BUILT }, "unorderable", /acme: r004945-6c8d301, --release: dev-t4k2p9/],
  ];
  for (const [reports, flags, reason, pattern] of stops) {
    const decision = decideCommit(reports, flags);
    assert.equal(decision.ok, false);
    assert.equal(!decision.ok && decision.reason, reason);
    assert.match(decision.ok ? "" : decision.message, pattern);
    assert.ok(!decision.ok && decision.message.includes(ASK), decision.ok ? "" : decision.message);
  }
});

test("an explicit --commit wins while the account does not show it stale", () => {
  const pinned = { ok: true, commit: HOSTED_COMMIT, full: true, release: HOSTED_RELEASE, from: "flag" };
  const flags = { release: HOSTED_RELEASE, commit: HOSTED_COMMIT };
  const reports = [report("acme", HOSTED_RELEASE), report("acme-backend", HOSTED_RELEASE)];
  assert.deepEqual(decideCommit(reports, flags), pinned);
  // Nothing readable in the account proves nothing.
  assert.deepEqual(decideCommit([], flags), pinned);
  // A Worker still on an older release is behind the command, not ahead of it.
  assert.deepEqual(decideCommit([...reports, report("acme-gk-github", "r004900-1234567")], flags), pinned);
  assert.deepEqual(decideCommit([...reports, runOnly("acme-gk-github", 4945)], flags), pinned);
  // Typed in capitals, it is the same commit.
  assert.deepEqual(decideCommit(reports, { ...flags, commit: HOSTED_COMMIT.toUpperCase() }), pinned);
  // A hand-built release the whole instance runs: the commit is the operator's word.
  assert.deepEqual(decideCommit([report("acme", HAND_BUILT)], { release: HAND_BUILT, commit: HOSTED_COMMIT }),
    { ...pinned, release: HAND_BUILT });
  // Without --release: the instance's own release ends in it, or names no commit to hold it to.
  assert.deepEqual(decideCommit(reports, { commit: HOSTED_COMMIT }), pinned);
  assert.deepEqual(decideCommit([report("acme", HAND_BUILT)], { commit: HOSTED_COMMIT }), { ...pinned, release: HAND_BUILT });
  for (const unsettled of [[], [report("acme", HAND_BUILT), report("acme-backend", "dev-zz91")], [runOnly("acme", 4950)]]) {
    assert.deepEqual(decideCommit(unsettled, { commit: HOSTED_COMMIT }), { ...pinned, release: null });
  }
  // A Worker left behind on an older release does not make the newest one's commit stale.
  assert.deepEqual(decideCommit([...reports, report("acme-gk-github", "r004900-1234567")], { commit: HOSTED_COMMIT }), pinned);
  // Two runs built the commit: it is the newer release's, whichever Worker is listed first.
  const rebuilt = [report("acme", HOSTED_RELEASE), report("acme-backend", "r004950-6c8d301")];
  for (const seen of [rebuilt, rebuilt.toReversed()]) {
    assert.deepEqual(decideCommit(seen, { commit: HOSTED_COMMIT }), { ...pinned, release: "r004950-6c8d301" });
    assert.deepEqual(decideCommit(seen), { ok: true, commit: "6c8d301", full: false, release: "r004950-6c8d301", from: "release" });
  }
  // A release past both is still the instance moving on.
  const moved = decideCommit([...rebuilt, report("acme-gk-github", "r004960-abcdef0")], { commit: HOSTED_COMMIT });
  assert.ok(!moved.ok && moved.reason === "stale" && moved.message.includes(MOVED("r004960-abcdef0")));
});

test("refuses a stale --commit: the instance moved after the command was made", () => {
  const flags = { release: HOSTED_RELEASE, commit: HOSTED_COMMIT };
  const stale: [ReleaseReport[], { release: string; commit: string }, string][] = [
    // A higher run number, on any one Worker.
    [[report("acme", HOSTED_RELEASE), report("acme-backend", NEWER)], flags, NEWER],
    [[report("acme-gk-github", NEWER), report("acme", HOSTED_RELEASE)], flags, NEWER],
    [[report("acme", "r004946-1111111"), report("acme-backend", NEWER)], flags, NEWER],
    // Known by its tag alone.
    [[report("acme", HOSTED_RELEASE), runOnly("acme-backend", 4950)], flags, "run 4950"],
    // A different id that no run number orders, either way round.
    [[report("acme", HAND_BUILT)], flags, HAND_BUILT],
    [[report("acme", HOSTED_RELEASE)], { release: HAND_BUILT, commit: HOSTED_COMMIT }, HOSTED_RELEASE],
    [[report("acme", "dev-zz91")], { release: HAND_BUILT, commit: HOSTED_COMMIT }, "dev-zz91"],
    // One run number under another id.
    [[report("acme", "r004945-abcdef0")], flags, "r004945-abcdef0"],
  ];
  for (const [reports, given, to] of stale) {
    const decision = decideCommit(reports, given);
    assert.equal(decision.ok, false, to);
    assert.equal(!decision.ok && decision.reason, "stale", to);
    assert.ok(!decision.ok && decision.message.includes(MOVED(to)), decision.ok ? "" : decision.message);
  }
  // Without --release, the commit of a release a Worker reports stands for that release: stale all the same.
  const older = [report("acme", HOSTED_RELEASE), report("acme-backend", HOSTED_RELEASE)];
  const unnamed: [ReleaseReport[], string][] = [
    [[...older, report("acme-gk-github", NEWER)], NEWER],
    [[...older, runOnly("acme-gk-github", 4950)], "run 4950"],
    [[...older, report("acme-gk-github", HAND_BUILT)], HAND_BUILT],
  ];
  for (const [reports, to] of unnamed) {
    const decision = decideCommit(reports, { commit: HOSTED_COMMIT });
    assert.equal(!decision.ok && decision.reason, "stale", to);
    assert.ok(!decision.ok && decision.message.includes(MOVED(to)), decision.ok ? "" : decision.message);
  }
  // Moved to releases that cannot be ordered: each is named.
  const scattered = decideCommit([report("acme", HAND_BUILT), report("acme-backend", "dev-zz91")], flags);
  assert.ok(!scattered.ok && scattered.message.includes(MOVED("acme: dev-t4k2p9, acme-backend: dev-zz91")));
});

test("refuses a --commit that is not the release's commit", () => {
  const other = "0123456789abcdef0123456789abcdef01234567";
  const reports = [report("acme", HOSTED_RELEASE)];
  // Not the commit --release ends in, whatever the account says.
  for (const seen of [reports, []]) {
    const decision = decideCommit(seen, { release: HOSTED_RELEASE, commit: other });
    assert.deepEqual(decision, {
      ok: false, reason: "mismatch",
      message: `--commit ${other} is not the commit of --release ${HOSTED_RELEASE}, which ends in 6c8d301: copy the whole ` +
        "command from the deploy flow.",
    });
  }
  // With no --release, not the commit the instance's release ends in: older or newer cannot be told.
  const alone = decideCommit(reports, { commit: other });
  assert.equal(!alone.ok && alone.reason, "mismatch");
  assert.match(alone.ok ? "" : alone.message, /is not the commit of r004945-6c8d301, the release the instance runs, which ends in 6c8d301/);
  assert.match(alone.ok ? "" : alone.message, /pnpm cf-os update --to <commit>/);
  // Nor, of mixed releases, the newest one's.
  const mixed = decideCommit([...reports, report("acme-gk-github", NEWER)], { commit: other });
  assert.equal(!mixed.ok && mixed.reason, "mismatch");
  assert.match(mixed.ok ? "" : mixed.message, /is not the commit of r004950-abcdef0, the release the instance runs/);
  // Nor, where the newest reports are one run under two ids, either of theirs; an older report's commit is no excuse.
  const twoIds = [runOnly("acme", 4900), report("acme-backend", NEWER), report("acme-gk-github", "r004950-1234567")];
  assert.deepEqual(decideCommit(twoIds, { commit: other }), {
    ok: false, reason: "mismatch",
    message: `--commit ${other} is not the commit of any release the instance's Workers report (acme-backend: ` +
      "r004950-abcdef0, acme-gk-github: r004950-1234567), each of which names its own: copy the command from the deploy flow.",
  });
  // One of the two it does name is the command's own release, and the other is the instance moving on.
  const one = decideCommit(twoIds, { commit: `abcdef0${"0".repeat(33)}` });
  assert.equal(!one.ok && one.reason, "stale");
  // A newest report that leaves its commit unsaid may be the one --commit is for: the flag stands,
  // held to the commits the other newest reports do name.
  const newer = { commit: "abcdef0", release: NEWER, workers: ["acme"] };
  const unsaid: [ReleaseReport[], CommitFloor[]][] = [
    [[report("acme", NEWER), report("acme-backend", "r004950-1234567"), runOnly("acme-gk-github", 4950)],
      [newer, { commit: "1234567", release: "r004950-1234567", workers: ["acme-backend"] }]],
    [[report("acme", NEWER), report("acme-backend", "r004950-1234567-dirty")], [newer]],
    [[report("acme", NEWER), report("acme-backend", HAND_BUILT)], [newer]],
  ];
  for (const [seen, atLeast] of unsaid) {
    assert.deepEqual(decideCommit(seen, { commit: other }), { ok: true, commit: other, full: true, release: null, from: "flag", atLeast });
  }
});

test("holds a commit to pin to the commits the Workers' own newest releases name", () => {
  const live = [report("acme", HOSTED_RELEASE), report("acme-backend", HOSTED_RELEASE)];
  const floor = [{ commit: "6c8d301", release: HOSTED_RELEASE, workers: ["acme", "acme-backend"] }];
  const older = `1111111${"0".repeat(33)}`;
  // A --release no Worker reports, with a run number above them all, does not make the Workers'
  // own commit one that may be left behind: with --commit, and resolved from the id without it.
  for (const release of ["r999999-1111111", "r004946-1111111"]) {
    assert.deepEqual(decideCommit(live, { release, commit: older }),
      { ok: true, commit: older, full: true, release, from: "flag", atLeast: floor }, release);
    assert.deepEqual(decideCommit(live, { release }),
      { ok: true, commit: "1111111", full: false, release, from: "release", atLeast: floor }, release);
  }
  // A CI release beside a hand-built one: --commit is the operator's word for the hand-built
  // release's commit, and the CI release's own is still one to be at or past.
  assert.deepEqual(decideCommit([report("acme", "r005012-9f8e7d6"), report("acme-backend", "dev-k3x9")], { commit: older }), {
    ok: true, commit: older, full: true, release: null, from: "flag",
    atLeast: [{ commit: "9f8e7d6", release: "r005012-9f8e7d6", workers: ["acme"] }],
  });
  // A report a run number puts behind another is left to the newer one to stand for.
  const lagging = [report("acme", "r004900-1234567"), report("acme-backend", "r005012-9f8e7d6"), report("acme-gk-github", "dev-k3x9")];
  const decision = decideCommit(lagging, { commit: older });
  assert.deepEqual(decision.ok && decision.atLeast, [{ commit: "9f8e7d6", release: "r005012-9f8e7d6", workers: ["acme-backend"] }]);
  // A newer report that names no commit stands for nothing: a Gatekeeper known by its tag's run
  // number alone, or by an id with no commit in it, does not hide the commit the other Workers name.
  for (const unnamed of [runOnly("acme-gk-github", 5000), report("acme-gk-github", "r005000-3333333-dirty")]) {
    const seen = [...live, unnamed];
    for (const flags of [{ release: "r999999-1111111", commit: older }, { commit: older }]) {
      const settled = decideCommit(seen, flags);
      assert.deepEqual(settled.ok && settled.atLeast, floor, JSON.stringify([unnamed, flags]));
    }
    // One that does name a commit, newer still, stands for them all.
    const named = decideCommit([...seen, report("acme-gk-notion", "r005012-9f8e7d6")], { release: "r999999-1111111", commit: older });
    assert.deepEqual(named.ok && named.atLeast, [{ commit: "9f8e7d6", release: "r005012-9f8e7d6", workers: ["acme-gk-notion"] }]);
  }
  // Nothing to hold to where the Workers' newest release is the one pinned, or names no commit.
  for (const [reports, flags] of [
    [live, {}],
    [live, { release: HOSTED_RELEASE, commit: HOSTED_COMMIT }],
    [[...live, report("acme-gk-github", "r004900-1234567")], { commit: HOSTED_COMMIT }],
    [[report("acme", HAND_BUILT)], { release: HAND_BUILT, commit: HOSTED_COMMIT }],
    [[runOnly("acme", 4950)], { commit: HOSTED_COMMIT }],
    [[], { release: HOSTED_RELEASE }],
  ] satisfies [ReleaseReport[], { release?: string; commit?: string }][]) {
    const settled = decideCommit(reports, flags);
    assert.ok(settled.ok && !("atLeast" in settled), JSON.stringify(settled));
  }
});

test("refuses flags that are not a release id or a full commit", () => {
  for (const commit of ["6c8d301", HOSTED_COMMIT.slice(0, 39), `${HOSTED_COMMIT}0`, "main", "", HOSTED_COMMIT.replace("6", "g")]) {
    const decision = decideCommit([report("acme", HOSTED_RELEASE)], { release: HOSTED_RELEASE, commit });
    assert.equal(!decision.ok && decision.reason, "invalid", commit);
    assert.match(decision.ok ? "" : decision.message, /is not a full commit SHA: pass all 40 hex digits/);
  }
  for (const release of ["", "r004945 6c8d301", "../x", "a".repeat(65)]) {
    for (const commit of [HOSTED_COMMIT, undefined]) {
      const decision = decideCommit([report("acme", HOSTED_RELEASE)], { release, commit });
      assert.equal(!decision.ok && decision.reason, "invalid", release);
      assert.match(decision.ok ? "" : decision.message, /is not a release id/);
    }
  }
});

test("reads what the backend carries: admins, providers, the origin, its Gatekeepers and the push identity", () => {
  assert.deepEqual(backendValues(instanceReading("acme-backend")), {
    admins: ["admin@example.com"],
    providers: ["cloudflare", "anthropic"],
    publicBaseUrl: "https://acme.acme-sub.workers.dev",
    gatekeepers: [
      { slug: "context", binding: "GATEKEEPER_CONTEXT", worker: "acme-gk-context" },
      { slug: "github", binding: "GATEKEEPER_GITHUB", worker: "acme-gk-github" },
      { slug: "scheduler", binding: "GATEKEEPER_SCHEDULER", worker: "acme-gk-scheduler" },
    ],
    unmappedGatekeepers: [],
    push: {
      serviceUrl: "https://push.example.com",
      installId: "install-acme",
      keyId: "key-1",
      webPushPublicKey: "BFixtureWebPushPublicKey",
    },
    pushKeyBound: true,
  });
  // A Worker with nothing set, and one never deployed.
  const empty = { admins: null, providers: null, publicBaseUrl: null, gatekeepers: [], unmappedGatekeepers: [], push: null, pushKeyBound: false };
  assert.deepEqual(backendValues(reading("acme")), empty);
  assert.deepEqual(backendValues({ name: "acme-backend", deployment: null, versions: [] }), empty);
});

test("reads each backend value in the forms a Worker can hold it, and nothing it cannot use", () => {
  const values = backendValuesWith;
  // ADMINS as JSON text, which the backend accepts too; anything else is no list.
  assert.deepEqual(values({ json: { ADMINS: undefined }, vars: { ADMINS: '["a@example.com", 7, "b@example.com"]' } }).admins,
    ["a@example.com", "b@example.com"]);
  assert.deepEqual(values({ json: { ADMINS: '["a@example.com"]' } }).admins, ["a@example.com"]);
  assert.deepEqual(values({ json: { ADMINS: [] } }).admins, []);
  for (const admins of ["admin@example.com", { admin: true }, null]) assert.equal(values({ json: { ADMINS: admins } }).admins, null);
  assert.equal(values({ json: { ADMINS: undefined }, vars: { ADMINS: "admin@example.com" } }).admins, null);
  // Providers: a comma-separated list, spaces and empty items dropped.
  assert.deepEqual(values({ vars: { CF_AI_GATEWAY_PROVIDERS: " cloudflare, openai ,," } }).providers, ["cloudflare", "openai"]);
  assert.deepEqual(values({ vars: { CF_AI_GATEWAY_PROVIDERS: "" } }).providers, []);
  assert.equal(values({ vars: { CF_AI_GATEWAY_PROVIDERS: undefined } }).providers, null);
  // The origin: read, and only an origin.
  assert.equal(values({ vars: { PUBLIC_BASE_URL: "https://os.example.com/" } }).publicBaseUrl, "https://os.example.com");
  assert.equal(values({ vars: { PUBLIC_BASE_URL: "http://localhost:8787" } }).publicBaseUrl, "http://localhost:8787");
  for (const origin of ["os.example.com", "https://os.example.com/app", "ftp://os.example.com", "", undefined]) {
    assert.equal(values({ vars: { PUBLIC_BASE_URL: origin } }).publicBaseUrl, null, String(origin));
  }
});

test("reads a variable only from a plain variable, and a Gatekeeper only from a service binding", () => {
  // Bindings as a client may hand them over: a value under a binding of the wrong kind is not that value.
  const base = instanceReading("acme-backend");
  const [live] = base.versions;
  const misfiled = (name: string, type: string) => ({
    ...base,
    versions: [{
      ...live,
      annotations: {},
      bindings: [
        ...(live.bindings ?? []).filter((binding) => binding.name !== name),
        { name, type, text: "r004950-abcdef0", json: ["someone@example.com"], service: "acme-gk-misfiled" },
      ],
    }],
  });
  // The release id, held as a secret or as JSON, is not a release id read.
  for (const type of ["secret_text", "json", "service"]) {
    const held = misfiled("CLOUDFLARE_OS_RELEASE_ID", type);
    assert.deepEqual(versionReleases(held.versions[0]), [], type);
  }
  // A push variable held as a secret is not carried, and without it there is no identity to carry.
  assert.equal(backendValues(misfiled("CFOS_INSTALL_ID", "secret_text")).push, null);
  assert.equal(backendValues(misfiled("NOTIFICATION_WEB_PUSH_PUBLIC_KEY", "secret_text")).push?.webPushPublicKey, null);
  assert.equal(backendValues(misfiled("PUBLIC_BASE_URL", "secret_text")).publicBaseUrl, null);
  assert.equal(backendValues(misfiled("CF_AI_GATEWAY_PROVIDERS", "secret_text")).providers, null);
  // ADMINS is read from a plain or a JSON variable, and from nothing else.
  assert.equal(backendValues(misfiled("ADMINS", "secret_text")).admins, null);
  assert.deepEqual(backendValues(misfiled("ADMINS", "json")).admins, ["someone@example.com"]);
  // A Gatekeeper name on a binding that is not a service binding names no Gatekeeper Worker.
  for (const type of ["plain_text", "secret_text", "kv_namespace"]) {
    const slugs = backendValues(misfiled("GATEKEEPER_MISFILED", type)).gatekeepers.map(({ slug }) => slug);
    assert.deepEqual(slugs, ["context", "github", "scheduler"], type);
  }
  assert.deepEqual(backendValues(misfiled("GATEKEEPER_MISFILED", "service")).gatekeepers.map(({ slug }) => slug),
    ["context", "github", "misfiled", "scheduler"]);
});

test("finds Gatekeeper Workers by the backend's bindings, whatever they are called", () => {
  const values = backendValues(instanceReading("acme-backend", {
    services: {
      GATEKEEPER_GITHUB: "octo-production",
      GATEKEEPER_MCPPORTAL: "acme-gk-mcpportal",
      GATEKEEPER_NOTES2: "acme-gk-notes2",
      // Not Gatekeepers: another prefix, and a binding of another kind.
      GATEKEEPERS: "acme-other",
      FRONTEND_ERROR_REPORTER: "acme-errors",
      // Named like one, with no slug the hosted flow accepts: nothing after the prefix, lower case,
      // a digit first, and a second word.
      GATEKEEPER_: "acme-nameless",
      GATEKEEPER_notes: "acme-lowercase",
      GATEKEEPER_9LIVES: "acme-digit",
      GATEKEEPER_HOME_ASSISTANT: "acme-two-words",
    },
    vars: { GATEKEEPER_NOTES: "a plain variable" },
  }));
  assert.deepEqual(values.gatekeepers, [
    { slug: "context", binding: "GATEKEEPER_CONTEXT", worker: "acme-gk-context" },
    { slug: "github", binding: "GATEKEEPER_GITHUB", worker: "octo-production" },
    { slug: "mcpportal", binding: "GATEKEEPER_MCPPORTAL", worker: "acme-gk-mcpportal" },
    { slug: "notes2", binding: "GATEKEEPER_NOTES2", worker: "acme-gk-notes2" },
    { slug: "scheduler", binding: "GATEKEEPER_SCHEDULER", worker: "acme-gk-scheduler" },
  ]);
  // The rest map to no Gatekeeper, and are still named: their Workers are read with the instance's.
  assert.deepEqual(values.unmappedGatekeepers, [
    { binding: "GATEKEEPER_", worker: "acme-nameless" },
    { binding: "GATEKEEPER_9LIVES", worker: "acme-digit" },
    { binding: "GATEKEEPER_HOME_ASSISTANT", worker: "acme-two-words" },
    { binding: "GATEKEEPER_notes", worker: "acme-lowercase" },
  ].toSorted((a, b) => a.binding.localeCompare(b.binding)));
  // One slug names one Gatekeeper: a second binding of the name, as no API lists, is not a second one.
  const base = instanceReading("acme-backend");
  const twice: WorkerReading = {
    ...base,
    versions: [{ ...base.versions[0], bindings: [...base.versions[0].bindings ?? [], { name: "GATEKEEPER_GITHUB", type: "service", service: "acme-second" }] }],
  };
  assert.deepEqual(backendValues(twice).gatekeepers.filter(({ slug }) => slug === "github").map(({ worker }) => worker), ["acme-gk-github"]);
  assert.deepEqual(backendValues(twice).unmappedGatekeepers, [{ binding: "GATEKEEPER_GITHUB", worker: "acme-second" }]);
});

test("reads the Worker of every Gatekeeper-like binding, on every version serving the backend's traffic", async () => {
  const account = hostedMemoryAccount({
    "acme-backend": { services: { GATEKEEPER_HOME_ASSISTANT: "acme-two-words" } },
    "acme-two-words": { release: NEWER },
    "acme-gk-slack": { operation: "gk-slack", release: "r004960-1234567" },
  });
  // A rollout: a tenth of the backend's traffic goes to a version that also binds a Slack Gatekeeper.
  const [larger] = account.versions?.["acme-backend"] ?? [];
  const smaller: CfWorkerVersion = {
    ...larger,
    id: fixtureVersionId("acme-backend", 5),
    bindings: [...larger.bindings ?? [], { name: "GATEKEEPER_SLACK", type: "service", service: "acme-gk-slack" }],
  };
  account.versions = { ...account.versions, "acme-backend": [larger, smaller] };
  account.deployments = {
    ...account.deployments,
    "acme-backend": [{ id: "rollout", versions: [{ version_id: smaller.id, percentage: 10 }, { version_id: larger.id, percentage: 90 }] }],
  };
  const instance = await readInstance(memoryClient(account), FAKE_ACCOUNT, { router: "acme", backend: "acme-backend" });
  assert.deepEqual(instance.workers.map(({ name, role, slug }) => [name, role, slug]), [
    ["acme", "router", undefined],
    ["acme-backend", "backend", undefined],
    ["acme-gk-context", "gatekeeper", "context"],
    ["acme-gk-github", "gatekeeper", "github"],
    ["acme-gk-scheduler", "gatekeeper", "scheduler"],
    ["acme-gk-slack", "gatekeeper", "slack"],
    // Bound under a name that gives no slug: read, as no Gatekeeper.
    ["acme-two-words", "other", undefined],
  ]);
  // The values are the larger share's; the release is the newest any of them runs.
  assert.deepEqual(instance.backend?.gatekeepers.map(({ slug }) => slug), ["context", "github", "scheduler"]);
  assert.deepEqual(instance.backend?.unmappedGatekeepers, [{ binding: "GATEKEEPER_HOME_ASSISTANT", worker: "acme-two-words" }]);
  assert.deepEqual(decideCommit(instance.reports), { ok: true, commit: "1234567", full: false, release: "r004960-1234567", from: "release" });
  assert.deepEqual(instanceStops(instance), []);
});

test("carries the push identity only when it is whole, and sees the signing key by name alone", () => {
  const values = backendValuesWith;
  for (const missing of ["NOTIFICATION_SERVICE_URL", "CFOS_INSTALL_ID", "CFOS_INSTALL_KEY_ID"]) {
    assert.equal(values({ vars: { [missing]: undefined } }).push, null, missing);
    assert.equal(values({ vars: { [missing]: "" } }).push, null, missing);
  }
  // Browser push is optional: native push works without its key.
  assert.equal(values({ vars: { NOTIFICATION_WEB_PUSH_PUBLIC_KEY: undefined } }).push?.webPushPublicKey, null);
  assert.equal(values({ vars: { NOTIFICATION_WEB_PUSH_PUBLIC_KEY: undefined } }).push?.installId, "install-acme");
  // The key is a secret binding: present or not, and nothing more.
  assert.equal(PUSH_IDENTITY_SECRET, "CFOS_INSTALL_PRIVATE_KEY");
  assert.equal(values({ secrets: [] }).pushKeyBound, false);
  assert.equal(values({ secrets: [], vars: { CFOS_INSTALL_PRIVATE_KEY: "typed into a plain variable" } }).pushKeyBound, false);
  assert.equal(JSON.stringify(values({})).includes("CFOS_INSTALL_PRIVATE_KEY"), false);
});

test("reads a Worker's live deployment and the one version it serves", async () => {
  const client = memoryClient(hostedMemoryAccount());
  const backend = await readWorker(client, FAKE_ACCOUNT, "acme-backend");
  assert.equal(backend?.name, "acme-backend");
  assert.equal(backend?.deployment?.versions[0].version_id, fixtureVersionId("acme-backend"));
  assert.deepEqual(backend?.versions.map(({ id }) => id), [fixtureVersionId("acme-backend")]);
  assert.deepEqual(client.calls, ["listWorkerDeployments", "getWorkerVersion"]);
  // Not in the account, and in it but never deployed.
  assert.equal(await readWorker(client, FAKE_ACCOUNT, "acme-gk-slack"), null);
  assert.deepEqual(await readWorker(client, FAKE_ACCOUNT, "unrelated"), { name: "unrelated", deployment: null, versions: [] });
});

test("reads every version a gradual rollout serves, the larger share first, and none it does not", async () => {
  const account = hostedMemoryAccount({ "acme-backend": { handEdited: true } });
  const [edited, uploaded] = account.versions?.["acme-backend"] ?? [];
  const retired: CfWorkerVersion = { ...uploaded, id: fixtureVersionId("acme-backend", 3) };
  account.versions = { ...account.versions, "acme-backend": [edited, uploaded, retired] };
  account.deployments = {
    ...account.deployments,
    "acme-backend": [
      { id: "live", versions: [{ version_id: edited.id, percentage: 10 }, { version_id: uploaded.id, percentage: 90 }, { version_id: retired.id, percentage: 0 }] },
      { id: "previous", versions: [{ version_id: retired.id, percentage: 100 }] },
    ],
  };
  const client = memoryClient(account);
  const backend = await readWorker(client, FAKE_ACCOUNT, "acme-backend");
  assert.deepEqual(backend?.versions.map(({ id }) => id), [uploaded.id, edited.id]);
  assert.deepEqual(client.calls, ["listWorkerDeployments", "getWorkerVersion", "getWorkerVersion"]);
  // The hand-made share makes the Worker hand-edited; the values are the larger share's.
  assert.ok(backend);
  assert.equal(handEdited(backend)?.versionId, edited.id);
  assert.equal(backendValues(backend).admins?.[0], "admin@example.com");
});

test("counts every release a rollout serves, so a newer one on a small share is not missed", () => {
  const older = version();
  const newer = { ...version({ release: NEWER }), id: fixtureVersionId("acme-backend", 9) };
  const worker = instanceWorker({ name: "acme-backend", deployment: null, versions: [older, newer] }, "backend");
  assert.deepEqual(worker.releases.map(({ id }) => id), [HOSTED_RELEASE, NEWER]);
  const instance = hostedInstance([worker, instanceWorker(reading("acme"), "router")]);
  assert.equal(instance.release.kind === "known" && instance.release.release.id, NEWER);
  assert.deepEqual(decideCommit(instance.reports), { ok: true, commit: "abcdef0", full: false, release: NEWER, from: "release" });
  // Two versions of one release are one report.
  const twice = instanceWorker({ name: "acme", deployment: null, versions: [older, { ...older, id: "second" }] }, "router");
  assert.equal(twice.releases.length, 1);
});

test("reads a whole instance: the backend, then the router and the Gatekeepers it binds", async () => {
  const client = memoryClient(hostedMemoryAccount());
  const instance = await readInstance(client, FAKE_ACCOUNT, { router: "acme", backend: "acme-backend" });
  assert.deepEqual(instance.workers.map(({ name, role, slug }) => [name, role, slug]), [
    ["acme", "router", undefined],
    ["acme-backend", "backend", undefined],
    ["acme-gk-context", "gatekeeper", "context"],
    ["acme-gk-github", "gatekeeper", "github"],
    ["acme-gk-scheduler", "gatekeeper", "scheduler"],
  ]);
  assert.deepEqual(instance.missing, []);
  assert.deepEqual(instance.handEdited, []);
  assert.deepEqual(instance.release, { kind: "known", release: parseRelease(HOSTED_RELEASE), behind: [] });
  assert.deepEqual(instance.reports.map(({ name, release }) => [name, release.id]),
    instance.workers.map(({ name }) => [name, HOSTED_RELEASE]));
  assert.ok(instance.workers.every(({ fingerprint }) => fingerprint === HOSTED_FINGERPRINT));
  assert.equal(instance.backend?.publicBaseUrl, "https://acme.acme-sub.workers.dev");
  // Read-only, and nothing but deployments and versions: the backend alone first, as it names the rest.
  assert.deepEqual(client.calls.slice(0, 2), ["listWorkerDeployments", "getWorkerVersion"]);
  assert.deepEqual(client.calls.toSorted(), [
    ...Array.from({ length: 5 }, () => "getWorkerVersion"),
    ...Array.from({ length: 5 }, () => "listWorkerDeployments"),
  ]);
  assert.deepEqual(client.created, []);
  assert.deepEqual(decideCommit(instance.reports), { ok: true, commit: "6c8d301", full: false, release: HOSTED_RELEASE, from: "release" });
});

test("reads an instance under custom Worker names, its Gatekeepers still found by binding", async () => {
  const live = hostedInstanceLive({
    acme: null,
    "acme-backend": null,
    "acme-gk-github": null,
    "moss-os": { services: { WORKSHOP_BACKEND: "moss-api" } },
    "moss-api": { services: { GATEKEEPER_GITHUB: "octo-production", GATEKEEPER_CONTEXT: "acme-gk-context" }, json: { ADMINS: ["moss@example.com"] } },
    "octo-production": { operation: "gk-github", release: NEWER },
  });
  const client = memoryClient({
    deployments: Object.fromEntries(Object.entries(live).map(([name, { deployments }]) => [name, deployments])),
    versions: Object.fromEntries(Object.entries(live).map(([name, { versions }]) => [name, versions])),
  });
  const instance = await readInstance(client, FAKE_ACCOUNT, { router: "moss-os", backend: "moss-api" });
  assert.deepEqual(instance.workers.map(({ name, role, slug }) => [name, role, slug]), [
    ["moss-os", "router", undefined],
    ["moss-api", "backend", undefined],
    ["acme-gk-context", "gatekeeper", "context"],
    ["octo-production", "gatekeeper", "github"],
  ]);
  assert.deepEqual(instance.backend?.admins, ["moss@example.com"]);
  // The renamed Gatekeeper runs a later release: that is the instance's.
  assert.equal(instance.release.kind === "known" && instance.release.release.id, NEWER);
  assert.deepEqual(instance.release.kind === "known" && instance.release.behind.map(({ name }) => name),
    ["moss-os", "moss-api", "acme-gk-context"]);
  // Under its own names it is whole.
  assert.deepEqual(instanceStops(instance), []);
  // The default names are another instance's, and are not touched.
  const defaults = await readInstance(client, FAKE_ACCOUNT, { router: "moss", backend: "moss-backend" });
  assert.deepEqual(defaults.workers, []);
  assert.deepEqual(defaults.missing, ["moss", "moss-backend"]);
  assert.equal(defaults.backend, null);
  assert.deepEqual(defaults.release, { kind: "none" });
});

test("reads Workers found another way too, once each, and names the ones the account lacks", async () => {
  const client = memoryClient(hostedMemoryAccount({ "acme-gk-websearch": {} }));
  const instance = await readInstance(client, FAKE_ACCOUNT, {
    router: "acme",
    backend: "acme-backend",
    // Found by the hosted flow's naming: one the backend binds, one it does not, one that is gone.
    others: ["acme-gk-context", "acme-gk-websearch", "acme-gk-slack", "acme", "acme-backend"],
  });
  assert.deepEqual(instance.workers.map(({ name, role }) => [name, role]), [
    ["acme", "router"],
    ["acme-backend", "backend"],
    ["acme-gk-context", "gatekeeper"],
    ["acme-gk-github", "gatekeeper"],
    ["acme-gk-scheduler", "gatekeeper"],
    ["acme-gk-websearch", "other"],
  ]);
  assert.deepEqual(instance.missing, ["acme-gk-slack"]);
  assert.equal(client.calls.filter((call) => call === "listWorkerDeployments").length, 7);
});

test("reports the hand-edited Workers of an instance, and still reads their release", async () => {
  const client = memoryClient(hostedMemoryAccount({ "acme-backend": { handEdited: true }, "acme-gk-github": { release: NEWER } }));
  const instance = await readInstance(client, FAKE_ACCOUNT, { router: "acme", backend: "acme-backend" });
  assert.deepEqual(instance.handEdited.map(({ name, source }) => [name, source]), [["acme-backend", "dash"]]);
  const backend = instance.workers.find(({ role }) => role === "backend");
  assert.deepEqual(backend?.releases, [{ id: HOSTED_RELEASE, run: 4945, sha7: "6c8d301", source: "release-var" }]);
  assert.equal(backend?.fingerprint, null);
  // Its bindings are read off the hand-made version, so its Gatekeepers are still found.
  assert.equal(instance.workers.length, 5);
  assert.deepEqual(formatReleases(instance), [
    "  acme               r004945-6c8d301 (from its live version's annotations)",
    "  acme-backend       r004945-6c8d301 (from CLOUDFLARE_OS_RELEASE_ID)",
    "  acme-gk-context    r004945-6c8d301 (from its live version's annotations)",
    "  acme-gk-github     r004950-abcdef0 (from its live version's annotations)",
    "  acme-gk-scheduler  r004945-6c8d301 (from its live version's annotations)",
    "The instance runs release r004950-abcdef0, the newest of its Workers' (acme: r004945-6c8d301, " +
      "acme-backend: r004945-6c8d301, acme-gk-context: r004945-6c8d301, acme-gk-scheduler: r004945-6c8d301).",
  ]);
  // A command made before the Gatekeeper moved on is stale.
  const decision = decideCommit(instance.reports, { release: HOSTED_RELEASE, commit: HOSTED_COMMIT });
  assert.ok(!decision.ok && decision.message.includes(MOVED(NEWER)));
});

test("says so when a Worker names no release, and when none does", async () => {
  const silent: HostedWorkerOptions = { annotations: {}, releaseVar: false, json: { CLOUDFLARE_OS_DEPLOYMENT: undefined } };
  const client = memoryClient(hostedMemoryAccount({
    acme: silent, "acme-backend": silent, "acme-gk-context": silent, "acme-gk-scheduler": silent, "acme-gk-github": silent,
  }));
  const instance = await readInstance(client, FAKE_ACCOUNT, { router: "acme", backend: "acme-backend" });
  assert.deepEqual(instance.reports, []);
  assert.equal(instance.handEdited.length, 5);
  assert.deepEqual(formatReleases(instance).slice(0, 1), ["  acme               no release named"]);
  assert.equal(formatReleases(instance).at(-1), "No Worker of the instance says which release it runs.");
  const decision = decideCommit(instance.reports);
  assert.ok(!decision.ok && decision.reason === "no-commit" && decision.message.includes(ASK));
  // The summary's other two endings.
  const runOnlyInstance = hostedInstance([instanceWorker(reading("acme", { annotations: { "workers/tag": `gd:4950:${HOSTED_FINGERPRINT}` }, releaseVar: false }), "router")]);
  assert.deepEqual(formatReleases(runOnlyInstance), [
    "  acme  run 4950 (from its live version's tag alone)",
    "The instance runs release run 4950; nothing on its Workers gives that release's id.",
  ]);
  const scattered = hostedInstance([instanceWorker(reading("acme", { release: HAND_BUILT }), "router"), instanceWorker(reading("acme-backend"), "backend")]);
  assert.equal(formatReleases(scattered).at(-1), "The instance's Workers name releases that cannot be put in order.");
});

test("reads a few Workers at a time, in order, and fails as the earliest failure would", async () => {
  const names = ["acme", "acme-backend", "acme-gk-context", "acme-gk-scheduler", "acme-gk-github", "acme-gk-slack"];
  const readings = await readWorkers(memoryClient(hostedMemoryAccount()), FAKE_ACCOUNT, names);
  assert.deepEqual(readings.map((read) => read?.name ?? null), [...names.slice(0, 5), null]);
  assert.deepEqual(await readWorkers(memoryClient({}), FAKE_ACCOUNT, []), []);

  // Never more than four in flight, and none started once one has failed.
  const account = hostedMemoryAccount();
  const base = memoryClient(account);
  let inFlight = 0;
  let most = 0;
  const started: string[] = [];
  const client = {
    ...base,
    async listWorkerDeployments(accountId: string, worker: string) {
      started.push(worker);
      most = Math.max(most, ++inFlight);
      // The later a Worker is in the list, the sooner its read settles.
      await new Promise((resolve) => setTimeout(resolve, 30 - 5 * names.indexOf(worker)));
      inFlight--;
      if (worker === "acme-backend") throw new CfError("backend failed");
      if (worker === "acme-gk-scheduler") throw new CfAuthError("scheduler failed");
      return base.listWorkerDeployments(accountId, worker);
    },
  };
  await assert.rejects(readWorkers(client, FAKE_ACCOUNT, names), /backend failed/);
  assert.equal(most, 4);
  assert.deepEqual(started, names.slice(0, 4));
  // Signed out, the whole read fails as signed out.
  await assert.rejects(readInstance(memoryClient({ signedOut: true }), FAKE_ACCOUNT, { router: "acme", backend: "acme-backend" }),
    (error: unknown) => error instanceof CfAuthError);
});

test("reads what the account says of each Worker's Durable Object migrations", async () => {
  const client = memoryClient(hostedMemoryAccount({ "acme-gk-github": { durableObjects: ["UserAccount", "HookDriver"] } }));
  const names = ["acme-backend", "acme", "acme-gk-github", "acme-gk-slack", "unrelated"];
  assert.deepEqual(await readMigrations(client, FAKE_ACCOUNT, names), [
    // No tag reported, as on an account read through `cf`: the classes say migrations were applied.
    { worker: "acme-backend", state: "untagged", classes: pinnedDurableObjects("acme-backend") },
    // The router has no Durable Objects.
    { worker: "acme", state: "no-storage" },
    { worker: "acme-gk-github", state: "untagged", classes: ["HookDriver", "UserAccount"] },
    // Not in the account, and in it but never deployed.
    { worker: "acme-gk-slack", state: "absent" },
    { worker: "unrelated", state: "no-storage" },
  ]);
  assert.ok(pinnedDurableObjects("acme-backend").length > 0);
  // One read of the namespaces for all of them, beside each Worker's own two; nothing else.
  assert.equal(client.calls.filter((call) => call === "listDurableObjectNamespaces").length, 1);
  assert.deepEqual(client.calls.filter((call) => !["listDurableObjectNamespaces", "listWorkerDeployments", "getWorkerVersion"].includes(call)), []);
  assert.deepEqual(client.created, []);
  // No Worker to read, no read.
  const idle = memoryClient(hostedMemoryAccount());
  assert.deepEqual(await readMigrations(idle, FAKE_ACCOUNT, []), []);
  assert.deepEqual(idle.calls, []);
  // An API that reports the tag.
  const tagging = memoryClient(hostedMemoryAccount({ "acme-backend": { migrationTag: "v7", durableObjects: ["Workspace"] } }));
  assert.deepEqual(await readMigrations(tagging, FAKE_ACCOUNT, ["acme-backend"]),
    [{ worker: "acme-backend", state: "tagged", tag: "v7", classes: ["Workspace"] }]);
  // A failed read is a failure, never a Worker with nothing to protect.
  const failing = memoryClient({ ...hostedMemoryAccount(), failing: { listDurableObjectNamespaces: "[10013] internal error" } });
  await assert.rejects(readMigrations(failing, FAKE_ACCOUNT, ["acme-backend"]), /\[10013\]/);
  await assert.rejects(readMigrations(memoryClient({ signedOut: true }), FAKE_ACCOUNT, ["acme-backend"]),
    (error: unknown) => error instanceof CfAuthError);
});

test("tells a Worker whose tag was not reported from one with no migrations", () => {
  const namespaces = [
    { id: "n1", script: "acme-backend", class: "Workspace" },
    { id: "n2", script: "acme-backend", class: "Account" },
    { id: "n3", script: "acme-backend", class: "Workspace" },
    { id: "n4", script: "acme-backend-2", class: "Other" },
  ];
  const backend = reading("acme-backend");
  assert.deepEqual(liveMigrations("acme-backend", backend, namespaces),
    { worker: "acme-backend", state: "untagged", classes: ["Account", "Workspace"] });
  assert.deepEqual(liveMigrations("acme-backend", backend, []), { worker: "acme-backend", state: "no-storage" });
  assert.deepEqual(liveMigrations("acme-backend", null, namespaces), { worker: "acme-backend", state: "absent" });
  // Storage outlives a deployment that cannot be read: never deployed, the classes still count.
  assert.deepEqual(liveMigrations("acme-backend", { name: "acme-backend", deployment: null, versions: [] }, namespaces),
    { worker: "acme-backend", state: "untagged", classes: ["Account", "Workspace"] });
  assert.deepEqual(liveMigrations("acme-backend", reading("acme-backend", { migrationTag: "v7" }), []),
    { worker: "acme-backend", state: "tagged", tag: "v7", classes: [] });
  // During a rollout: whichever serving version reports one.
  const tagged = version({ migrationTag: "v7" });
  assert.equal(liveMigrationTag({ name: "acme-backend", deployment: null, versions: [{ id: "first" }, tagged] }), "v7");
  assert.equal(liveMigrationTag({ name: "acme-backend", deployment: null, versions: [{ id: "first", migration_tag: "" }] }), null);
  assert.equal(liveMigrationTag({ name: "acme-backend", deployment: null, versions: [] }), null);
});

test("finds a Worker migrated past the project's configuration, by its tag or by its classes", () => {
  const steps: MigrationStep[] = [
    { tag: "v1", new_sqlite_classes: ["Workspace", "Account"] },
    { tag: "v2", new_classes: ["Legacy"], renamed_classes: [{ from: "Account", to: "Member" }] },
    { tag: "v3", deleted_classes: ["Legacy"], transferred_classes: [{ from: "Queue", from_script: "acme-old", to: "Inbox" }] },
  ];
  assert.deepEqual([...migrationClasses(steps)].toSorted(), ["Account", "Inbox", "Legacy", "Member", "Workspace"]);
  assert.deepEqual([...migrationClasses([{ tag: "v1", new_classes: "Workspace", renamed_classes: [{ to: 7 }, "Member", null] }])], []);
  const worker = "acme-backend";
  // Nothing to run behind.
  assert.equal(migrationGap({ worker, state: "absent" }, steps), null);
  assert.equal(migrationGap({ worker, state: "no-storage" }, steps), null);
  assert.equal(migrationGap({ worker, state: "no-storage" }), null);
  // The tag, when the API reports it: any of the project's, however far the project is ahead.
  for (const tag of ["v1", "v2", "v3"]) assert.equal(migrationGap({ worker, state: "tagged", tag, classes: ["Unlisted"] }, steps), null, tag);
  assert.deepEqual(migrationGap({ worker, state: "tagged", tag: "v4", classes: [] }, steps), {
    worker, kind: "tag", tag: "v4",
    message: "Worker acme-backend's live Durable Object migration tag is v4, which is not among the tags of this project's " +
      "configuration for it (v1, v2, v3).",
  });
  assert.match(migrationGap({ worker, state: "tagged", tag: "v1", classes: [] })?.message ?? "", /\(it has no migrations\)/);
  // Without it, the classes: a Worker at any step of the project's history passes.
  for (const classes of [["Account", "Workspace"], ["Legacy", "Member", "Workspace"], ["Inbox", "Member", "Workspace"]]) {
    assert.equal(migrationGap({ worker, state: "untagged", classes }, steps), null, classes.join());
  }
  // A class no step creates is a release the project does not have.
  assert.deepEqual(migrationGap({ worker, state: "untagged", classes: ["Member", "Presence", "Workspace"] }, steps), {
    worker, kind: "classes", classes: ["Presence"],
    message: "Worker acme-backend stores Durable Objects of a class no migration in this project's configuration for it creates (Presence).",
  });
  const none = migrationGap({ worker, state: "untagged", classes: ["Workspace", "Account"] });
  assert.deepEqual(none?.kind === "classes" && none.classes, ["Workspace", "Account"]);
  assert.match(none?.message ?? "", /of classes no migration in this project's configuration for it creates \(Workspace, Account\)/);
});

test("passes an instance on the project's own release, and refuses one a release ahead, with no tag to go by", async () => {
  // The project's configuration for the backend is the pinned upstream's, which the fixture instance was deployed from.
  const pinned: MigrationStep[] = [{ tag: "v0", new_sqlite_classes: pinnedDurableObjects("acme-backend") }];
  const [same] = await readMigrations(memoryClient(hostedMemoryAccount()), FAKE_ACCOUNT, ["acme-backend"]);
  assert.equal(same.state, "untagged");
  assert.equal(migrationGap(same, pinned), null);
  // The instance moved to a release whose migration added a class.
  const ahead = hostedMemoryAccount({ "acme-backend": { durableObjects: [...pinnedDurableObjects("acme-backend"), "AddedByALaterRelease"] } });
  const [moved] = await readMigrations(memoryClient(ahead), FAKE_ACCOUNT, ["acme-backend"]);
  const gap = migrationGap(moved, pinned);
  assert.deepEqual(gap?.kind === "classes" && gap.classes, ["AddedByALaterRelease"]);
  // The same two answers through `cf`: the namespaces listed once, each Worker's deployment and version read.
  const cf = fakeCf(hostedAccountLive({ "acme-backend": { durableObjects: [...pinnedDurableObjects("acme-backend"), "AddedByALaterRelease"] } }));
  const read = await readMigrations(cfClient({ spawn: cf.spawn }), FAKE_ACCOUNT, ["acme-backend", "acme-gk-scheduler"]);
  assert.deepEqual(read.map((live) => migrationGap(live, live.worker === "acme-backend" ? pinned : [])?.kind ?? null), ["classes", "classes"]);
  assert.deepEqual(read[1], { worker: "acme-gk-scheduler", state: "untagged", classes: pinnedDurableObjects("acme-gk-scheduler") });
  const commands = cf.calls.map((call) => call.args.slice(0, 3).join(" "));
  assert.equal(commands.filter((command) => command === "durable-objects namespaces list").length, 2);
  assert.ok(commands.every((command) => /^(durable-objects namespaces list|workers deployments list|workers versions get)$/.test(command)),
    commands.join("\n"));
});

test("stops a takeover of Workers that are not one whole installation", async () => {
  const client = memoryClient(hostedMemoryAccount());
  const whole = await readInstance(client, FAKE_ACCOUNT, { router: "acme", backend: "acme-backend" });
  assert.deepEqual(instanceStops(whole), []);
  // A Worker changed by hand carries no fingerprint, and is no evidence of another installation.
  const edited = await readInstance(memoryClient(hostedMemoryAccount({ "acme-gk-github": { handEdited: true } })), FAKE_ACCOUNT,
    { router: "acme", backend: "acme-backend" });
  assert.deepEqual(instanceStops(edited), []);
  // The backend is not in the account: its Gatekeepers were never read, and the router's release alone decides nothing.
  const half = await readInstance(client, FAKE_ACCOUNT, { router: "acme", backend: "acme-api" });
  assert.deepEqual(half.missing, ["acme-api"]);
  assert.equal(decideCommit(half.reports).ok, true);
  assert.deepEqual(instanceStops(half), [{
    reason: "missing", role: "backend",
    message: "The account has no backend Worker named acme-api for the instance: pass --backend <name> with the name it was deployed under.",
  }]);
  const neither = await readInstance(client, FAKE_ACCOUNT, { router: "moss", backend: "moss-backend" });
  assert.deepEqual(instanceStops(neither).map(({ reason, message }) => [reason, /--(router|backend) <name>/.exec(message)?.[1]]),
    [["missing", "router"], ["missing", "backend"]]);
  // One name for both is one Worker short.
  const doubled = await readInstance(client, FAKE_ACCOUNT, { router: "acme-backend", backend: "acme-backend" });
  assert.deepEqual(instanceStops(doubled).map(({ message }) => message),
    ["--router and --backend both name Worker acme-backend: an instance has one of each, under two names."]);
  // Read without names, the roles alone say what is missing.
  assert.deepEqual(instanceStops(hostedInstance([instanceWorker(reading("acme"), "router")])).map(({ message }) => message),
    ["The account has no backend Worker for the instance: pass --backend <name> with the name it was deployed under."]);
});

test("stops a takeover that would reach into another installation's Workers", async () => {
  const foreign = { ...hostedAnnotations(HOSTED_RELEASE), "workers/tag": "gd:4945:ffffffff" };
  // Bound to this backend, so that its fingerprint is all that tells it apart.
  const client = memoryClient(hostedMemoryAccount({ "moss-os": { annotations: foreign, services: { WORKSHOP_BACKEND: "acme-backend" } } }));
  // --router names a Worker another installation uploaded.
  const crossed = await readInstance(client, FAKE_ACCOUNT, { router: "moss-os", backend: "acme-backend" });
  assert.equal(decideCommit(crossed.reports).ok, true);
  assert.deepEqual(instanceStops(crossed), [{
    reason: "installations",
    message: "These Workers are not one installation's: moss-os (ffffffff); acme-backend, acme-gk-context, acme-gk-github, " +
      "acme-gk-scheduler (1a2b3c4d). Each was uploaded by the hosted flow for the installation in brackets; check --router " +
      "and --backend, and take over one installation's Workers only.",
  }]);
  // So does a Worker found by name that the backend does not bind.
  const stray = await readInstance(client, FAKE_ACCOUNT, { router: "acme", backend: "acme-backend", others: ["moss-os"] });
  assert.deepEqual(instanceStops(stray).map(({ reason }) => reason), ["installations"]);
  // A rollout between two installations' versions, on one Worker.
  const [mine] = instanceReading("acme").versions;
  const split = instanceWorker({ name: "acme", deployment: null, versions: [mine, { ...mine, id: "theirs", annotations: foreign }] }, "router");
  assert.deepEqual(split.fingerprints, [HOSTED_FINGERPRINT, "ffffffff"]);
  assert.equal(split.fingerprint, HOSTED_FINGERPRINT);
  assert.deepEqual(instanceStops(hostedInstance([split, instanceWorker(reading("acme-backend"), "backend")])).map(({ reason }) => reason),
    ["installations"]);
});

test("stops a takeover whose router is not bound to its backend", async () => {
  const names = { router: "acme", backend: "acme-backend" };
  const stopsOf = async (account: Parameters<typeof memoryClient>[0], asked = names) =>
    instanceStops(await readInstance(memoryClient(account), FAKE_ACCOUNT, asked));
  // The names the wrong way round. Read so, the real backend's Gatekeepers are never read, and the
  // commit decided is behind the one that moved on: it must not get that far.
  const account = hostedMemoryAccount({ "acme-gk-github": { release: NEWER } });
  const swapped = await readInstance(memoryClient(account), FAKE_ACCOUNT, { router: "acme-backend", backend: "acme" });
  assert.deepEqual(swapped.workers.map(({ name, role }) => [name, role]), [["acme-backend", "router"], ["acme", "backend"]]);
  assert.deepEqual(decideCommit(swapped.reports), { ok: true, commit: "6c8d301", full: false, release: HOSTED_RELEASE, from: "release" });
  assert.deepEqual(instanceStops(swapped), [{
    reason: "unlinked",
    message: "Worker acme-backend is not the router of acme: it has no WORKSHOP_BACKEND service binding, and a router " +
      "reaches its backend through that binding. acme is bound that way to acme-backend: --router and --backend are the " +
      "wrong way round.",
  }]);
  // The right way round, it is whole, and the Gatekeeper's release is the instance's.
  const right = await readInstance(memoryClient(account), FAKE_ACCOUNT, names);
  assert.deepEqual(instanceStops(right), []);
  assert.deepEqual(decideCommit(right.reports), { ok: true, commit: "abcdef0", full: false, release: NEWER, from: "release" });

  // Another deployment's router, changed by hand: no fingerprint tells it apart, its binding does.
  const foreign = hostedMemoryAccount({
    "moss-os": { handEdited: true, release: NEWER, services: { WORKSHOP_BACKEND: "moss-api" } },
  });
  assert.deepEqual(await stopsOf(foreign, { router: "moss-os", backend: "acme-backend" }), [{
    reason: "unlinked",
    message: "Worker moss-os is not the router of acme-backend: its WORKSHOP_BACKEND service binding points at moss-api, " +
      "and a router reaches its backend through that binding. Check --router and --backend: a takeover deploys over " +
      "both, so they must be one instance's.",
  }]);
  // The same Worker bound to this backend is this instance's router, hand-edited or not.
  const adopted = hostedMemoryAccount({ "moss-os": { handEdited: true, services: { WORKSHOP_BACKEND: "acme-backend" } } });
  assert.deepEqual(await stopsOf(adopted, { router: "moss-os", backend: "acme-backend" }), []);

  // Some other Worker of the account, and the right router with the wrong backend.
  assert.deepEqual((await stopsOf(hostedMemoryAccount({ unrelated: {} }), { router: "unrelated", backend: "acme-backend" }))
    .map(({ reason }) => reason), ["unlinked"]);
  const twoBackends = hostedMemoryAccount({ "moss-api": {} });
  assert.deepEqual((await stopsOf(twoBackends, { router: "acme", backend: "moss-api" })).map(({ reason, message }) => [reason, message]), [[
    "unlinked",
    "Worker acme is not the router of moss-api: its WORKSHOP_BACKEND service binding points at acme-backend, and a router " +
      "reaches its backend through that binding. Check --router and --backend: a takeover deploys over both, so they " +
      "must be one instance's.",
  ]]);
  // The binding by another name, or of another kind, is not the router's.
  for (const change of [
    { services: { WORKSHOP_BACKEND: undefined, BACKEND: "acme-backend" } },
    { services: { WORKSHOP_BACKEND: undefined }, vars: { WORKSHOP_BACKEND: "acme-backend" } },
  ]) {
    assert.deepEqual((await stopsOf(hostedMemoryAccount({ acme: change }))).map(({ reason }) => reason), ["unlinked"]);
  }
  // Every version serving the router's traffic must be bound to the backend, whichever has the larger share.
  const [bound] = instanceReading("acme").versions;
  const loose = { ...bound, id: "loose", bindings: [{ name: "WORKSHOP_BACKEND", type: "service", service: "moss-api" }] };
  const backend = instanceWorker(instanceReading("acme-backend"), "backend");
  for (const versions of [[bound, loose], [loose, bound]]) {
    const rollout = hostedInstance([instanceWorker({ name: "acme", deployment: null, versions }, "router"), backend]);
    assert.deepEqual(instanceStops(rollout).map(({ reason }) => reason), ["unlinked"]);
    assert.match(instanceStops(rollout)[0].message, /points at moss-api,/);
  }
  assert.deepEqual(instanceStops(hostedInstance([instanceWorker({ name: "acme", deployment: null, versions: [bound, { ...bound, id: "second" }] }, "router"), backend])), []);
  // A binding as a client may hand it over: the backend's name under one that is no service binding is not the link.
  const misfiled = { ...bound, id: "misfiled", bindings: [{ name: "WORKSHOP_BACKEND", type: "secret_text", service: "acme-backend" }] };
  assert.deepEqual(instanceStops(hostedInstance([instanceWorker({ name: "acme", deployment: null, versions: [misfiled] }, "router"), backend]))
    .map(({ reason, message }) => [reason, /it has no WORKSHOP_BACKEND service binding/.test(message)]), [["unlinked", true]]);
});

test("stops a takeover whose router or backend is one of the instance's Gatekeepers", async () => {
  // Bound to the backend too, so that being its Gatekeeper is all that is wrong with the name.
  const account = hostedMemoryAccount({ "acme-gk-context": { services: { WORKSHOP_BACKEND: "acme-backend" } } });
  const asRouter = await readInstance(memoryClient(account), FAKE_ACCOUNT, { router: "acme-gk-context", backend: "acme-backend" });
  assert.deepEqual(asRouter.workers.map(({ name, role }) => [name, role]), [
    ["acme-gk-context", "router"], ["acme-backend", "backend"], ["acme-gk-github", "gatekeeper"], ["acme-gk-scheduler", "gatekeeper"],
  ]);
  assert.equal(decideCommit(asRouter.reports).ok, true);
  assert.deepEqual(instanceStops(asRouter), [{
    reason: "roles",
    message: "Worker acme-gk-context is a Gatekeeper of the instance, not its router: the backend binds it as " +
      "GATEKEEPER_CONTEXT. Check --router and --backend.",
  }]);
  // Without that binding of its own, it is no router either.
  const plain = await readInstance(memoryClient(hostedMemoryAccount()), FAKE_ACCOUNT, { router: "acme-gk-context", backend: "acme-backend" });
  assert.deepEqual(instanceStops(plain).map(({ reason }) => reason), ["unlinked", "roles"]);
  // A backend bound as its own Gatekeeper, under a name that gives a slug or one that does not.
  for (const binding of ["GATEKEEPER_LOOP", "GATEKEEPER_LOOP_BACK"]) {
    const looped = await readInstance(memoryClient(hostedMemoryAccount({ "acme-backend": { services: { [binding]: "acme-backend" } } })),
      FAKE_ACCOUNT, { router: "acme", backend: "acme-backend" });
    assert.deepEqual(instanceStops(looped).map(({ reason, message }) => [reason, message]), [[
      "roles",
      `Worker acme-backend is a Gatekeeper of the instance, not its backend: the backend binds it as ${binding}. ` +
        "Check --router and --backend.",
    ]]);
  }
  // One Worker bound as two Gatekeepers: a deploy would put one's code over the other's.
  const shared = await readInstance(memoryClient(hostedMemoryAccount({ "acme-backend": { services: { GATEKEEPER_SLACK: "acme-gk-github" } } })),
    FAKE_ACCOUNT, { router: "acme", backend: "acme-backend" });
  assert.deepEqual(shared.workers.filter(({ name }) => name === "acme-gk-github").map(({ slug }) => slug), ["github"]);
  assert.deepEqual(instanceStops(shared), [{
    reason: "roles",
    message: "Worker acme-gk-github is bound as more than one Gatekeeper (GATEKEEPER_GITHUB, GATEKEEPER_SLACK): each " +
      "Gatekeeper is a Worker of its own, and a deploy would put one's code over the other's. Point each binding at its " +
      "own Worker through the hosted flow first.",
  }]);
});

test("stops a takeover whose router or backend has no live deployment to read", async () => {
  const account = hostedMemoryAccount();
  account.deployments = { ...account.deployments, "acme-backend": [] };
  const idle = await readInstance(memoryClient(account), FAKE_ACCOUNT, { router: "acme", backend: "acme-backend" });
  // The backend's bindings are unread, so its Gatekeepers are too: the router's release alone decides nothing.
  assert.deepEqual(idle.workers.map(({ name }) => name), ["acme", "acme-backend"]);
  assert.equal(idle.backend, null);
  assert.equal(decideCommit(idle.reports).ok, true);
  assert.deepEqual(instanceStops(idle), [{
    reason: "undeployed", role: "backend",
    message: "Worker acme-backend, read as the instance's backend, has no live deployment, so nothing says what it runs " +
      "or which Gatekeeper Workers it binds: check --backend, or deploy it through the hosted flow first.",
  }]);
  // A Worker never deployed is not shown to be the instance's router.
  const unrouted = await readInstance(memoryClient(hostedMemoryAccount()), FAKE_ACCOUNT, { router: "unrelated", backend: "acme-backend" });
  assert.deepEqual(instanceStops(unrouted), [{
    reason: "undeployed", role: "router",
    message: "Worker unrelated, read as the instance's router, has no live deployment, so nothing says what it runs: " +
      "check --router, or deploy it through the hosted flow first.",
  }]);
});

test("prints an instance as its summary: no reading, so no variable the backend's values do not name", async () => {
  const account = hostedMemoryAccount({
    acme: { vars: { ROUTER_NOTE: "router-variable-text" } },
    "acme-backend": { handEdited: true, vars: { CFOS_INSTALL_PRIVATE_KEY: "key-typed-into-a-plain-variable", OTHER: "backend-variable-text" } },
  });
  const instance = await readInstance(memoryClient(account), FAKE_ACCOUNT, { router: "acme", backend: "acme-backend" });
  // The readings are there to judge from.
  assert.ok(instance.workers.every((worker) => worker.reading.versions.length === 1));
  for (const printed of [JSON.stringify(instance), JSON.stringify({ instance }), JSON.stringify(instance.workers), JSON.stringify(instanceSummary(instance))]) {
    for (const text of ["key-typed-into-a-plain-variable", "backend-variable-text", "router-variable-text", "bindings", "CFOS_INSTALL_PRIVATE_KEY"]) {
      assert.ok(!printed.includes(text), text);
    }
  }
  // A copy of a Worker or of the instance carries no reading, so it has none to print either.
  const [, backend] = instance.workers;
  assert.equal(Object.keys(backend).includes("reading"), false);
  for (const copy of [
    { ...backend },
    structuredClone(backend),
    structuredClone(instance),
    { ...instance },
    { ...instance, workers: instance.workers.map((worker) => ({ ...worker, extra: 1 })) },
    instance.workers.map((worker) => Object.assign({}, worker)),
    Object.fromEntries(Object.entries(backend)),
  ]) {
    const printed = JSON.stringify(copy);
    assert.ok(printed.includes("acme-backend"));
    for (const text of ["key-typed-into-a-plain-variable", "backend-variable-text", "router-variable-text", "bindings", "CFOS_INSTALL_PRIVATE_KEY"]) {
      assert.ok(!printed.includes(text), `${text} in ${printed.slice(0, 80)}`);
    }
  }
  const summary = instanceSummary(instance);
  assert.deepEqual(JSON.parse(JSON.stringify(instance)), JSON.parse(JSON.stringify(summary)));
  assert.deepEqual(Object.keys(summary), ["workers", "missing", "release", "handEdited", "backend"]);
  assert.deepEqual(summary.workers[1], {
    name: "acme-backend",
    role: "backend",
    releases: [{ id: HOSTED_RELEASE, run: 4945, sha7: "6c8d301", source: "release-var" }],
    handEdited: instance.handEdited[0],
    fingerprint: null,
  });
  assert.equal(summary.workers[2].slug, "context");
  assert.deepEqual(summary.handEdited.map(({ name }) => name), ["acme-backend"]);
  assert.equal(summary.backend?.push?.installId, "install-acme");
});

test("the in-memory account fails a read of what a Worker runs that it was never told", async () => {
  // A fixture with Workers and no `deployments` says nothing of what they run: not "nothing is live".
  const silent = memoryClient({ workers: [{ name: "acme" }, { name: "acme-backend" }], secrets: { "acme-gk-github": [] } });
  for (const name of ["acme", "acme-backend", "acme-gk-github"]) {
    await assert.rejects(readWorker(silent, FAKE_ACCOUNT, name), /does not say what Worker .* runs: give it `deployments`/);
  }
  await assert.rejects(readInstance(silent, FAKE_ACCOUNT, { router: "acme", backend: "acme-backend" }), /does not say what Worker acme-backend runs/);
  await assert.rejects(readMigrations(silent, FAKE_ACCOUNT, ["acme-backend"]), /does not say what Worker acme-backend runs/);
  // A Worker it does not have is still simply absent, and one it was told was never deployed reads so.
  assert.equal(await readWorker(silent, FAKE_ACCOUNT, "acme-gk-slack"), null);
  const told = memoryClient({ workers: [{ name: "acme" }], deployments: {} });
  assert.deepEqual(await readWorker(told, FAKE_ACCOUNT, "acme"), { name: "acme", deployment: null, versions: [] });
});

test("reads the instance through cf with two commands a Worker, and keeps no secret", async () => {
  const cf = fakeCf(hostedAccountLive());
  const instance = await readInstance(cfClient({ spawn: cf.spawn }), FAKE_ACCOUNT, { router: "acme", backend: "acme-backend" });
  assert.equal(instance.release.kind === "known" && instance.release.release.id, HOSTED_RELEASE);
  assert.equal(instance.backend?.pushKeyBound, true);
  const commands = cf.calls.map((call) => call.args.join(" "));
  assert.deepEqual(commands.slice(0, 2), [
    "workers deployments list --script-name acme-backend",
    `workers versions get ${fixtureVersionId("acme-backend")} --worker-id acme-backend`,
  ]);
  assert.deepEqual(commands.toSorted(), ["acme", "acme-backend", "acme-gk-context", "acme-gk-github", "acme-gk-scheduler"].flatMap((name) => [
    `workers deployments list --script-name ${name}`,
    `workers versions get ${fixtureVersionId(name)} --worker-id ${name}`,
  ]).toSorted());
  assert.ok(cf.calls.every((call) => call.env.CLOUDFLARE_ACCOUNT_ID === FAKE_ACCOUNT));
  // No read of a secret's value, and no write of any kind.
  assert.ok(commands.every((command) => !/secret|create|update|delete|bulk|--include/.test(command)), commands.join("\n"));
});
