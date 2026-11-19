import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cfClient } from "../cf-client.ts";
import { parseDeployment, valueAtPath } from "../deployment-file.ts";
import { FAKE_ACCOUNT, fakeCf, workerLiveReplies, type FakeReply } from "../fake-cf.ts";
import { validatePushIdentity } from "../core/deployment-config.ts";
import type { GatekeeperCatalog } from "../core/gatekeepers.ts";
import {
  CANCEL,
  HOSTED_COMMIT,
  HOSTED_RELEASE,
  hostedAccountLive,
  hostedInstanceLive,
  hostedWorkerLive,
  recordingPinMove,
  reversing,
  scratchProject,
  scriptedPrompter,
  TEMPLATE,
  testCatalog,
  testContext,
  type HostedWorkerOptions,
  type PinMoveCall,
} from "../test-support.ts";
import { INSTANCE_LABEL, INVENTORY_LABEL } from "../cached-reads.ts";
import { UsageError } from "../context.ts";
import { run } from "./import.ts";
import { BRIEF, movePin, type PinMove, type UpdateDeps } from "./update.ts";

/** A release newer than {@link HOSTED_RELEASE}, and the commit its id ends in. */
const NEWER_RELEASE = "r005012-9f8e7d6";
const NEWER_COMMIT = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

/** The pin of a project behind the hosted fixtures' release. */
const OLD_PIN = "1111111111111111111111111111111111111111";

/** The full SHA a pin move is asked for, as upstream's history gives it for the fixtures' abbreviated ones. */
const fullCommit = (to: string) => [HOSTED_COMMIT, NEWER_COMMIT].find((commit) => commit.startsWith(to)) ?? to;

/** A pin that is the commit asked for: nothing to move. */
const atRelease = ({ to }: PinMoveCall): PinMove =>
  ({ status: "current", path: "cloudflare-os", from: fullCommit(to), to: fullCommit(to), past: false });

/** A pin behind the commit asked for: reported by a comparison, moved otherwise. */
const behindRelease = ({ to, dryRun, root }: PinMoveCall): PinMove => dryRun
  ? { status: "behind", path: "cloudflare-os", from: OLD_PIN, to: fullCommit(to), commits: 12 }
  : {
    status: "moved", path: "cloudflare-os", from: OLD_PIN, to: fullCommit(to), commits: 12, brief: join(root, BRIEF),
    installed: true, problems: [],
  };

/** The `cf` commands that only read: every one `import` may run. */
const READS = new Set([
  "accounts list", "zero-trust organization get", "workers list", "kv namespaces list", "r2 buckets list",
  "ai-gateway gateways list", "zero-trust access applications list", "workers deployments list", "workers versions get",
]);

/**
 * Runs `cf-os import <positionals>` in `root` against `account`, a hosted instance "acme" at
 * {@link HOSTED_RELEASE} by default, with {@link testCatalog} by default, each `cf` call settling
 * after `delay`. The pin is held against the release by `pin`, a stand-in that by default finds it at
 * the release; `events` lists, in order, each pin move asked for and each read of the catalog.
 */
async function importing(
  root: string,
  positionals: string[],
  { out, values = {}, account = hostedAccountLive(), flags = {}, prompter = null, catalog = testCatalog(), delay, pin = atRelease }:
    {
      out?: string; values?: Record<string, string>; account?: Record<string, FakeReply>; flags?: object;
      prompter?: ReturnType<typeof scriptedPrompter> | null; catalog?: GatekeeperCatalog;
      delay?: (args: string[]) => number; pin?: PinMove | ((call: PinMoveCall) => PinMove);
    } = {},
) {
  // Each `cf` call stamped with how many questions had been answered when it started.
  const cf = fakeCf(account, { delay, stamp: () => prompter?.answered.length });
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }), flags, prompter });
  const events: string[] = [];
  // The config as it was when the pin was moved or compared: a move comes before any write.
  const configAtMove: string[] = [];
  const mover = recordingPinMove(pin, ({ dryRun }) => {
    events.push(dryRun ? "compare" : "move");
    configAtMove.push(readFileSync(join(root, "deployment.jsonc"), "utf8"));
  });
  const code = await run({ command: "import", values: { out, ...values }, positionals }, harness.ctx, async () => {
    events.push("catalog");
    return catalog;
  }, mover.move);
  // Read-only against the account, whatever the run came to.
  assert.deepEqual(cf.calls.map(({ args }) => command(args)).filter((name) => !READS.has(name)), []);
  return { code, ...harness, calls: cf.calls, moves: mover.calls, events, configAtMove };
}

test("prints the fragment as JSON on stdout and the report on stderr, writing nothing", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const { code, json, stderr } = await importing(root, ["acme"], { flags: { account: FAKE_ACCOUNT } });
  assert.equal(code, 0);
  assert.equal(json.length, 1);
  // Parseable: what `--out` would write, and beside it the release and the Workers changed by hand.
  const fragment = JSON.parse(JSON.stringify(json[0])) as Record<string, any>;
  assert.equal(fragment.accountId, FAKE_ACCOUNT);
  assert.equal(fragment.workers.workshop.name, "acme-backend");
  assert.match(stderr(), /found {4}Workshop Worker/);
  assert.match(stderr(), /pnpm cf-os import acme --account [0-9a-f]{32} --out deployment\.jsonc/);
  assert.equal(readFileSync(join(root, "deployment.jsonc"), "utf8"), TEMPLATE);
});

/** {@link hostedAccountLive} with more Workers in the account's list, each running what `overrides` gives it. */
function hostedAccountWith(names: string[], overrides: Record<string, HostedWorkerOptions | null> = {}): Record<string, FakeReply> {
  const hosted = hostedAccountLive(overrides);
  return { ...hosted, "workers list": [...hosted["workers list"] as object[], ...names.map((name) => ({ name }))] };
}

test("includes the optional Gatekeepers the starter can deploy over, and lists the rest with why", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  // Two more Gatekeepers the backend binds: a second GitHub, and one the submodule does not have.
  const account = hostedAccountWith(["acme-gk-github2", "acme-gk-weather"], {
    "acme-backend": { services: { GATEKEEPER_GITHUB2: "acme-gk-github2", GATEKEEPER_WEATHER: "acme-gk-weather" } },
    "acme-gk-github2": { operation: "gk-github2" },
    "acme-gk-weather": { operation: "gk-weather" },
  });
  const { code, json, stderr } = await importing(root, ["acme"], { account, flags: { account: FAKE_ACCOUNT } });
  assert.equal(code, 0);
  const fragment = json[0] as Record<string, any>;
  assert.deepEqual(fragment.gatekeepers, { github: { name: "acme-gk-github" } });
  assert.match(stderr(), /found {4}github Gatekeeper Worker +acme-gk-github {2}-> gatekeepers\.github\.name/);
  const report = stderr();
  const orphaned = report.slice(report.indexOf("Gatekeepers not deployable by the starter"));
  assert.match(orphaned, /\n {2}acme-gk-github2 {2}a second install of github; the starter deploys one Worker per Gatekeeper package/);
  assert.match(orphaned, /\n {2}acme-gk-weather {2}no Gatekeeper in the submodule has the slug weather/);
  assert.doesNotMatch(orphaned, /acme-gk-github\s/);
  assert.match(report, /customGatekeeper\.enabled: false deploys none/);
  assert.match(report, /Note: A deploy keeps the found optional Gatekeepers' secrets but replaces their plain vars/);
});

test("without a catalog, writes no optional Gatekeeper and says why", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const { code, json, stderr } = await importing(root, ["acme"], {
    flags: { account: FAKE_ACCOUNT }, catalog: { offered: [], excluded: [], unavailable: "no submodule install" },
  });
  assert.equal(code, 0);
  assert.equal((json[0] as Record<string, unknown>).gatekeepers, undefined);
  assert.match(stderr(), /\n {2}acme-gk-github {2}no Gatekeeper in the submodule has the slug github/);
  assert.match(stderr(), /Note: The Gatekeeper catalog could not be read, so no optional Gatekeeper is deployable: no submodule install/);
});

test("--out writes the values into the file and leaves the rest alone", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const { code } = await importing(root, ["acme"], { out: "deployment.jsonc", flags: { account: FAKE_ACCOUNT } });
  assert.equal(code, 0);
  const text = readFileSync(join(root, "deployment.jsonc"), "utf8");
  const file = parseDeployment(text);
  assert.equal(valueAtPath(file, ["accountId"]), FAKE_ACCOUNT);
  assert.equal(valueAtPath(file, ["access", "audience"]), "aud-acme");
  assert.equal(valueAtPath(file, ["publicBaseUrl"]), "https://acme.acme-sub.workers.dev");
  // The admins are the backend's own, read off its ADMINS variable.
  assert.deepEqual(valueAtPath(file, ["access", "admins"]), ["admin@example.com"]);
  // Not discoverable, so untouched: still the placeholders a later check will name.
  assert.equal(valueAtPath(file, ["workers", "customGatekeeper", "name"]), "<CUSTOM_GATEKEEPER_WORKER_NAME>");
  assert.equal(valueAtPath(file, ["workers", "websearch", "name"]), "<WEBSEARCH_WORKER_NAME>");
  assert.ok(text.includes("// Worker names are permanent service identities."));
});

test("--out to another path leaves the input untouched", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const { code } = await importing(root, ["acme"], { out: "filled.jsonc", flags: { account: FAKE_ACCOUNT } });
  assert.equal(code, 0);
  assert.equal(readFileSync(join(root, "deployment.jsonc"), "utf8"), TEMPLATE);
  const filled = parseDeployment(readFileSync(join(root, "filled.jsonc"), "utf8"));
  assert.equal(valueAtPath(filled, ["workers", "workshop", "name"]), "acme-backend");
});

/**
 * A template for router `router` in account `accountId`, whose `gatekeepers` block names beta's GitHub
 * and Home Assistant Workers.
 */
function gatekeepersTemplate(router: string, accountId = FAKE_ACCOUNT): string {
  return TEMPLATE.replace('"<ROUTER_WORKER_NAME>"', JSON.stringify(router))
    .replace('"<CLOUDFLARE_ACCOUNT_ID>"', JSON.stringify(accountId)).replace('"gatekeepers": {},',
    '"gatekeepers": { "github": { "name": "beta-gk-github" }, "homeassistant": { "name": "beta-gk-homeassistant" } },');
}

test("--out removes the gatekeepers entries of a file for another router, and says so", async (t) => {
  const root = scratchProject(t, gatekeepersTemplate("beta"));
  const { code, json, stderr } = await importing(root, ["acme"], { out: "acme.jsonc", flags: { account: FAKE_ACCOUNT } });
  assert.equal(code, 0);
  // github is acme's own Worker; beta's Home Assistant Gatekeeper is left out, not bound to acme.
  const written = parseDeployment(readFileSync(join(root, "acme.jsonc"), "utf8"));
  assert.deepEqual(valueAtPath(written, ["gatekeepers"]), { github: { name: "acme-gk-github" } });
  assert.deepEqual((json[0] as Record<string, any>).gatekeepers, { github: { name: "acme-gk-github" } });
  assert.match(stderr(), new RegExp(`Note: The file is not acme's in account ${FAKE_ACCOUNT} \\(its workers\\.router\\.name or accountId differs\\), so the Gatekeeper Workers its gatekeepers block names may be another deployment's, and are left alone\\. --out removes their entries: gatekeepers\\.homeassistant \\(beta-gk-homeassistant\\)\\.`));
  assert.match(stderr(), /Wrote \d+ values to acme\.jsonc, removing 1 gatekeepers entry \(local file only/);
});

test("keeps the gatekeepers entries of the instance's own file", async (t) => {
  const root = scratchProject(t, gatekeepersTemplate("acme"));
  const { code, stderr } = await importing(root, ["acme"], { out: "deployment.jsonc", flags: { account: FAKE_ACCOUNT } });
  assert.equal(code, 0);
  const written = parseDeployment(readFileSync(join(root, "deployment.jsonc"), "utf8"));
  assert.deepEqual(valueAtPath(written, ["gatekeepers"]), {
    github: { name: "acme-gk-github" },
    homeassistant: { name: "beta-gk-homeassistant" },
  });
  assert.doesNotMatch(stderr(), /removing|--out removes/);
});

test("treats a file for the same router in another account, or in none yet, as another deployment's", async (t) => {
  for (const accountId of ["f".repeat(32), "<CLOUDFLARE_ACCOUNT_ID>"]) {
    const root = scratchProject(t, gatekeepersTemplate("acme", accountId));
    const { code, stderr } = await importing(root, ["acme"], { out: "acme.jsonc", flags: { account: FAKE_ACCOUNT } });
    assert.equal(code, 0);
    // Not the instance's own file, so beta's Home Assistant Worker is not bound in this account.
    const written = parseDeployment(readFileSync(join(root, "acme.jsonc"), "utf8"));
    assert.deepEqual(valueAtPath(written, ["gatekeepers"]), { github: { name: "acme-gk-github" } });
    assert.match(stderr(), /accountId differs[\s\S]*gatekeepers\.homeassistant \(beta-gk-homeassistant\)/);
  }
});

/** {@link gatekeepersTemplate}, naming the custom Gatekeeper's and Error Reporter's Workers too. */
function namedWorkersTemplate(router: string, accountId = FAKE_ACCOUNT): string {
  return gatekeepersTemplate(router, accountId)
    .replace('"<CUSTOM_GATEKEEPER_WORKER_NAME>"', '"shared-custom"')
    .replace('"<ERROR_REPORTER_WORKER_NAME>"', '"shared-errors"');
}

test("--out sets another deployment's custom Gatekeeper and Error Reporter names back to placeholders", async (t) => {
  for (const [router, accountId] of [["beta", FAKE_ACCOUNT], ["acme", "f".repeat(32)]]) {
    const root = scratchProject(t, namedWorkersTemplate(router, accountId));
    const { code, json, stderr } = await importing(root, ["acme"], { out: "acme.jsonc", flags: { account: FAKE_ACCOUNT } });
    assert.equal(code, 0);
    const written = parseDeployment(readFileSync(join(root, "acme.jsonc"), "utf8"));
    assert.equal(valueAtPath(written, ["workers", "customGatekeeper", "name"]), "<CUSTOM_GATEKEEPER_WORKER_NAME>");
    assert.equal(valueAtPath(written, ["workers", "errorReporter", "name"]), "<ERROR_REPORTER_WORKER_NAME>");
    // The file now reads as acme's, so it is the placeholders that keep it from deploying over them.
    assert.equal(valueAtPath(written, ["workers", "router", "name"]), "acme");
    assert.match(stderr(), new RegExp(`Note: The file is ${router}'s, not acme's in account ${FAKE_ACCOUNT}, so the Worker ` +
      "names it gives the rest may be that deployment's: workers\\.customGatekeeper\\.name \\(shared-custom\\), " +
      "workers\\.errorReporter\\.name \\(shared-errors\\)\\. --out sets them back to placeholders"));
    assert.match(stderr(), /setting workers\.customGatekeeper\.name and workers\.errorReporter\.name back to placeholders/);
    assert.equal((json[0] as Record<string, any>).workers.customGatekeeper, undefined, "a reset on stdout");
  }
});

test("--out sets another deployment's PDF renderer name to the instance's, not to a placeholder", async (t) => {
  // beta's file names beta's renderer, and acme has none: a placeholder would stop a deployment without Google.
  const root = scratchProject(t, gatekeepersTemplate("beta").replace('"workers": {', '"workers": { "pdfRenderer": { "name": "beta-pdf-renderer" },'));
  const { code, stderr } = await importing(root, ["acme"], { out: "acme.jsonc", flags: { account: FAKE_ACCOUNT } });
  assert.equal(code, 0);
  const written = parseDeployment(readFileSync(join(root, "acme.jsonc"), "utf8"));
  assert.equal(valueAtPath(written, ["workers", "pdfRenderer", "name"]), "acme-pdf-renderer");
  assert.match(stderr(), /workers\.pdfRenderer\.name \(beta-pdf-renderer\)\. workers\.pdfRenderer\.name goes to acme-pdf-renderer instead/);
  assert.match(stderr(), /setting workers\.pdfRenderer\.name to acme-pdf-renderer/);
});

/** {@link gatekeepersTemplate}, naming beta's Context and Web Search Gatekeeper Workers too. */
function builtInsTemplate(router: string): string {
  return gatekeepersTemplate(router)
    .replace('"<CONTEXT_WORKER_NAME>"', '"beta-gk-context"')
    .replace('"<WEBSEARCH_WORKER_NAME>"', '"beta-gk-websearch"');
}

test("--out sets back a built-in Gatekeeper name of another deployment's file that the instance has no Worker for", async (t) => {
  // beta's file names its Context and Web Search Workers; acme binds a Context Gatekeeper and no Web Search.
  const root = scratchProject(t, builtInsTemplate("beta"));
  const { code, json, stderr } = await importing(root, ["acme"], { out: "acme.jsonc", flags: { account: FAKE_ACCOUNT } });
  assert.equal(code, 0);
  const written = parseDeployment(readFileSync(join(root, "acme.jsonc"), "utf8"));
  // The one discovery found is the instance's own; the one it did not is not left naming beta's Worker.
  assert.equal(valueAtPath(written, ["workers", "context", "name"]), "acme-gk-context");
  assert.equal(valueAtPath(written, ["workers", "websearch", "name"]), "<WEBSEARCH_WORKER_NAME>");
  assert.match(stderr(), /Note: The file is beta's, not acme's in account [0-9a-f]{32}, so the Worker names it gives the rest may be that deployment's: workers\.websearch\.name \(beta-gk-websearch\)\. --out sets them back to placeholders/);
  assert.match(stderr(), /setting workers\.websearch\.name back to placeholders/);
  assert.doesNotMatch(readFileSync(join(root, "acme.jsonc"), "utf8"), /beta-gk-(context|websearch)/);
  assert.equal((json[0] as Record<string, any>).workers.websearch, undefined);
  // The instance's own file keeps the name it gave a Web Search Worker the deploy is to create.
  const own = scratchProject(t, builtInsTemplate("acme"));
  const kept = await importing(own, ["acme"], { out: "deployment.jsonc", flags: { account: FAKE_ACCOUNT } });
  assert.equal(valueAtPath(parseDeployment(readFileSync(join(own, "deployment.jsonc"), "utf8")), ["workers", "websearch", "name"]), "beta-gk-websearch");
  assert.doesNotMatch(kept.stderr(), /back to placeholders/);
});

test("--out keeps the custom Gatekeeper and Error Reporter names of the instance's own file, or of one naming no router", async (t) => {
  const own = scratchProject(t, namedWorkersTemplate("acme"));
  assert.equal((await importing(own, ["acme"], { out: "deployment.jsonc", flags: { account: FAKE_ACCOUNT } })).code, 0);
  const fresh = scratchProject(t, TEMPLATE.replace('"<CUSTOM_GATEKEEPER_WORKER_NAME>"', '"typed-custom"'));
  const { stderr } = await importing(fresh, ["acme"], { out: "deployment.jsonc", flags: { account: FAKE_ACCOUNT } });
  assert.equal(valueAtPath(parseDeployment(readFileSync(join(own, "deployment.jsonc"), "utf8")),
    ["workers", "customGatekeeper", "name"]), "shared-custom");
  assert.equal(valueAtPath(parseDeployment(readFileSync(join(fresh, "deployment.jsonc"), "utf8")),
    ["workers", "customGatekeeper", "name"]), "typed-custom");
  assert.doesNotMatch(stderr(), /back to placeholders/);
});

test("without an account, lists the ones cf can reach and stops", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const accounts = [{ id: FAKE_ACCOUNT, name: "Acme" }, { id: "f".repeat(32), name: "Acme Staging" }];
  const { code, stderr, json, calls, moves } = await importing(root, ["acme"], { account: { "accounts list": accounts } });
  assert.deepEqual(moves, []);
  assert.equal(code, 1);
  assert.match(stderr(), new RegExp(`${FAKE_ACCOUNT}  Acme\\n`));
  assert.match(stderr(), /Then: pnpm cf-os import acme --account <id>/);
  assert.deepEqual(json, []);
  // Account-less, so an ambient CLOUDFLARE_ACCOUNT_ID cannot narrow the list.
  assert.equal(calls[0].env.CLOUDFLARE_ACCOUNT_ID, undefined);
});

test("uses the only account cf can reach, and records it", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const account = { ...hostedAccountLive(), "accounts list": [{ id: FAKE_ACCOUNT, name: "Acme" }] };
  const { code } = await importing(root, ["acme"], { out: "deployment.jsonc", account });
  assert.equal(code, 0);
  assert.equal(valueAtPath(parseDeployment(readFileSync(join(root, "deployment.jsonc"), "utf8")), ["accountId"]), FAKE_ACCOUNT);
});

test("refuses an instance the account does not have, though its Access issuer is there", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  for (const out of [undefined, "init.jsonc"]) {
    const { code, json, stderr, moves, events } = await importing(root, ["acmee"], { out, flags: { account: FAKE_ACCOUNT } });
    assert.equal(code, 1);
    assert.deepEqual(json, []);
    assert.match(stderr(), /No hosted instance "acmee" here/);
    // Its Workers may be there under names of their own, which only the operator knows.
    assert.match(stderr(), /The account has no router Worker named acmee for the instance: pass --router <name>/);
    assert.match(stderr(), /The account has no backend Worker named acmee-backend for the instance: pass --backend <name>/);
    assert.match(stderr(), /Nothing was moved or written\./);
    // Refused before the pin is looked at, or the catalog read.
    assert.deepEqual([moves, events], [[], []]);
  }
  assert.equal(readFileSync(join(root, "deployment.jsonc"), "utf8"), TEMPLATE);
  assert.throws(() => readFileSync(join(root, "init.jsonc")), /ENOENT/);
});

test("without an instance, lists the account's hosted instances", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const { code, stderr } = await importing(root, [], { flags: { account: FAKE_ACCOUNT } });
  assert.equal(code, 1);
  assert.match(stderr(), /\n {2}acme\n/);
  assert.match(stderr(), new RegExp(`Then: pnpm cf-os import <instance> --account ${FAKE_ACCOUNT}`));
});

test("asks for the account and then the instance at a terminal", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const accounts = [{ id: "f".repeat(32), name: "Acme Staging" }, { id: FAKE_ACCOUNT, name: "Acme" }];
  const prompter = scriptedPrompter([
    ["Which account is the hosted instance in?", FAKE_ACCOUNT],
    ["Which hosted instance?", "acme"],
  ]);
  const { code, stderr } = await importing(root, [], { account: { ...hostedAccountLive(), "accounts list": accounts }, prompter });
  assert.equal(code, 0);
  assert.deepEqual(prompter.asked.map((asked) => asked.choices), [["f".repeat(32), FAKE_ACCOUNT], ["acme"]]);
  // The choices carry into the command it suggests, so they need not be made twice.
  assert.match(stderr(), new RegExp(`pnpm cf-os import acme --account ${FAKE_ACCOUNT} --out deployment\\.jsonc`));
});

test("stops when a prompt is cancelled", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  await assert.rejects(
    importing(root, [], { flags: { account: FAKE_ACCOUNT }, prompter: scriptedPrompter([["Which hosted instance?", CANCEL]]) }),
    { name: "Error", message: "Cancelled." });
});

test("rejects malformed arguments", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  await assert.rejects(importing(root, ["Not A Name"]), /not a Worker name/);
  await assert.rejects(importing(root, ["acme"], { flags: { account: "nope" } }), /--account must be a 32-hex/);
});

/** The command words of a `cf` call, before its first flag, less the version ID `workers versions get` names. */
function command(args: string[]): string {
  const end = args.findIndex((arg) => arg.startsWith("-"));
  return args.slice(0, end < 0 ? undefined : end).join(" ").replace(/^(workers versions get) .*$/, "$1");
}

/** The reads of what an instance of `workers` Workers runs, as `import` makes them: each one's deployments and live version. */
const instanceReads = (workers: number) => Array.from({ length: workers }, () => ["workers deployments list", "workers versions get"]).flat();

test("prints the same, byte for byte, whichever read finishes first", async (t) => {
  const outputs = [];
  for (const delay of [undefined, reversing()]) {
    const root = scratchProject(t, TEMPLATE);
    const { code, json, stderr } = await importing(root, ["acme"], { flags: { account: FAKE_ACCOUNT }, delay });
    outputs.push({ code, stdout: JSON.stringify(json), stderr: stderr() });
  }
  assert.equal(outputs[0].code, 0);
  assert.deepEqual(outputs[1], outputs[0]);
});

test("fails on a read that fails, with the same message whichever read finishes first", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const account = { ...hostedAccountLive(), "kv namespaces list": { fail: "[10013] internal error" } };
  for (const delay of [undefined, reversing()]) {
    await assert.rejects(importing(root, ["acme"], { flags: { account: FAKE_ACCOUNT }, account, delay }),
      /^Error: cf kv namespaces list --page 1 --per-page 100: APIError \[10013\] internal error$/);
  }
});

test("at a terminal, lists the Workers once, and reads the rest while it asks which instance", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const prompter = scriptedPrompter([["Which hosted instance?", "acme"]]);
  // The rest settle well after the question is answered, so each is still in flight when needed.
  const { code, calls } = await importing(root, [], {
    flags: { account: FAKE_ACCOUNT }, prompter, delay: (args) => command(args) === "workers list" ? 0 : 30,
  });
  assert.equal(code, 0);
  assert.deepEqual(calls.slice(0, 6).map(({ args, at }) => [command(args), at]), [
    ["workers list", 0],
    ["zero-trust organization get", 0],
    ["kv namespaces list", 0],
    ["r2 buckets list", 0],
    ["ai-gateway gateways list", 0],
    ["zero-trust access applications list", 0],
  ]);
  // Then, the instance chosen, what each of its five Workers runs: the backend first, whose bindings
  // name the rest.
  assert.deepEqual(calls.slice(6).map(({ args, at }) => [command(args), at]).toSorted(),
    instanceReads(5).map((name) => [name, 1]).toSorted());
  assert.deepEqual(calls.slice(6, 8).map(({ args }) => args.join(" ")).map((line) => line.replace(/get \S+/, "get <id>")), [
    "workers deployments list --script-name acme-backend",
    "workers versions get <id> --worker-id acme-backend",
  ]);
  // The Workers' list shown once, while it was in flight; settled, it shows nothing. The rest share
  // one spinner, and the instance's Workers another.
  assert.deepEqual(prompter.waited, ["Listing the account's Workers", INVENTORY_LABEL, INSTANCE_LABEL]);
});

test("at a terminal, reads nothing ahead when the account has no hosted instance", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const account = { ...hostedAccountLive(), "workers list": [{ name: "unrelated" }] };
  const prompter = scriptedPrompter([]);
  const { code, calls, stderr } = await importing(root, [], { flags: { account: FAKE_ACCOUNT }, account, prompter });
  assert.equal(code, 1);
  assert.match(stderr(), /No hosted instances in account/);
  // One deployed under Worker names of its own is not found by name: the operator names it.
  assert.match(stderr(), /pass its name with --router <name> and --backend <name>/);
  assert.deepEqual(calls.map(({ args }) => command(args)), ["workers list"]);
});

test("at a terminal, clears the spinner when a read fails, though later ones are still in flight", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const account = { ...hostedAccountLive(), "zero-trust organization get": { fail: "[10000] Authentication error" } };
  // Spinners still showing, by message: a busy call that has not settled.
  const showing: string[] = [];
  const prompter = scriptedPrompter([]);
  const scripted = prompter.busy!.bind(prompter);
  prompter.busy = async (message, work) => {
    showing.push(message);
    try {
      return await scripted(message, work);
    } finally {
      showing.splice(showing.indexOf(message), 1);
    }
  };
  await assert.rejects(importing(root, ["acme"], {
    flags: { account: FAKE_ACCOUNT }, account, prompter,
    delay: (args) => command(args) === "zero-trust organization get" ? 0 : 40,
  }), /Authentication error/);
  assert.deepEqual(showing, []);
  assert.deepEqual(prompter.waited, [INVENTORY_LABEL]);
  // The reads still in flight settle without drawing.
  await new Promise((settle) => setTimeout(settle, 60));
  assert.deepEqual(prompter.waited, [INVENTORY_LABEL]);
});

test("reads nothing ahead without a terminal, or with the instance given", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const account = { ...hostedAccountLive(), "accounts list": [{ id: FAKE_ACCOUNT, name: "Acme" }] };
  const listed = await importing(root, [], { account });
  assert.equal(listed.code, 1);
  assert.deepEqual(listed.calls.map(({ args }) => command(args)), ["accounts list", "workers list"]);

  // Given, the instance is not asked for, and each step is shown while its reads are in flight.
  const prompter = scriptedPrompter([]);
  const given = await importing(root, ["acme"], { account, prompter });
  assert.equal(given.code, 0);
  assert.deepEqual(given.calls.slice(0, 7).map(({ args }) => command(args)), [
    "accounts list",
    "zero-trust organization get",
    "workers list",
    "kv namespaces list",
    "r2 buckets list",
    "ai-gateway gateways list",
    "zero-trust access applications list",
  ]);
  assert.deepEqual(given.calls.slice(7).map(({ args }) => command(args)).toSorted(), instanceReads(5).toSorted());
  assert.deepEqual(prompter.waited, ["Listing your accounts", INVENTORY_LABEL, INSTANCE_LABEL]);
});

/** What `import` printed on stdout of the release, and of the Workers changed by hand. */
function resultOf(json: unknown[]): { release: Record<string, unknown>; handEdited: Record<string, unknown>[] } {
  assert.equal(json.length, 1);
  const { release, handEdited } = json[0] as { release: Record<string, unknown>; handEdited: Record<string, unknown>[] };
  return { release, handEdited };
}

test("without --out, reports the release, its commit, the pin and whether it is behind, and moves and writes nothing", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const { code, json, stderr, moves, events } = await importing(root, ["acme"], { flags: { account: FAKE_ACCOUNT }, pin: behindRelease });
  assert.equal(code, 0);
  // The pin was compared, never moved, and with the commit the release id ends in.
  assert.deepEqual(moves, [{ to: "6c8d301", dryRun: true, root, asks: false }]);
  assert.deepEqual(events, ["compare", "catalog"]);
  assert.match(stderr(), /The instance runs release r004945-6c8d301\./);
  assert.match(stderr(), new RegExp(`Release ${HOSTED_RELEASE} was built from cloudflare-os commit ${HOSTED_COMMIT}, the commit its id ends in\\.`));
  assert.match(stderr(), new RegExp(`This project pins cloudflare-os at ${OLD_PIN}, which is behind release ${HOSTED_RELEASE} by 12 commits: ` +
    "deploying it would put older code over storage the instance has already migrated, which cannot be undone\\. " +
    "--out moves the pin forward to it first, staged and not committed\\."));
  assert.match(stderr(), /Nothing written; the values are on stdout\. To fill them into deployment\.jsonc, moving the pin first:/);
  assert.deepEqual(resultOf(json), {
    release: { id: HOSTED_RELEASE, commit: HOSTED_COMMIT, source: "release", pin: OLD_PIN, behind: true, moved: false },
    handEdited: [],
  });
  assert.equal(readFileSync(join(root, "deployment.jsonc"), "utf8"), TEMPLATE);
  assert.deepEqual(readdirSync(root).toSorted(), ["cloudflare-os", "deployment.jsonc"]);
});

test("without --out, a pin at the release or past it is said, and nothing is offered to move", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const at = await importing(root, ["acme"], { flags: { account: FAKE_ACCOUNT } });
  assert.match(at.stderr(), /This project pins cloudflare-os at that commit: deploying is the release the instance already runs\./);
  assert.deepEqual(resultOf(at.json).release,
    { id: HOSTED_RELEASE, commit: HOSTED_COMMIT, source: "release", pin: HOSTED_COMMIT, behind: false, moved: false });
  const past = await importing(root, ["acme"], {
    flags: { account: FAKE_ACCOUNT },
    pin: { status: "current", path: "cloudflare-os", from: NEWER_COMMIT, to: HOSTED_COMMIT, past: true },
  });
  assert.equal(past.code, 0);
  assert.match(past.stderr(), new RegExp(`This project pins cloudflare-os at ${NEWER_COMMIT}: the project is already at or past the ` +
    "instance's release; deploying is an upgrade\\."));
  assert.deepEqual(resultOf(past.json).release,
    { id: HOSTED_RELEASE, commit: HOSTED_COMMIT, source: "release", pin: NEWER_COMMIT, behind: false, moved: false });
  assert.doesNotMatch(past.stderr(), /moving the pin first/);
});

test("without --out, a pin that could not be compared is reported as unknown, not as safe", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const reason = "cloudflare-os/ is not checked out, so its pin can be neither compared nor moved. Run `git submodule update --init cloudflare-os`, then run this again.";
  const { code, json, stderr } = await importing(root, ["acme"], {
    flags: { account: FAKE_ACCOUNT },
    pin: { status: "blocked", cause: "checkout", reason, behind: false, command: undefined, from: undefined, to: undefined },
  });
  assert.equal(code, 0);
  assert.match(stderr(), new RegExp(`Whether this project's cloudflare-os pin is behind release ${HOSTED_RELEASE} could not be told:\\n` +
    "cloudflare-os/ is not checked out"));
  // The commit is as far as the release id gives it: upstream's history was never reached.
  assert.deepEqual(resultOf(json).release,
    { id: HOSTED_RELEASE, commit: "6c8d301", source: "release", pin: null, behind: null, moved: false });
});

test("--out moves the pin forward first, then reads the catalog, then writes", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const { code, json, stderr, moves, events, configAtMove } = await importing(root, ["acme"], {
    out: "deployment.jsonc", flags: { account: FAKE_ACCOUNT }, pin: behindRelease,
  });
  assert.equal(code, 0);
  // One move, unasked, of the pin alone: the stand-in is `movePin`, which never merges the starter.
  assert.deepEqual(moves, [{ to: "6c8d301", dryRun: false, root, asks: false }]);
  // The catalog is the submodule's at the moved pin, and the file was untouched when the pin moved.
  assert.deepEqual(events, ["move", "catalog"]);
  assert.deepEqual(configAtMove, [TEMPLATE]);
  assert.match(stderr(), new RegExp(`Moved the cloudflare-os pin from ${OLD_PIN} forward to it by 12 commits, staged and not committed, ` +
    "as `pnpm cf-os update --to` leaves it\\. \\.cf-os/update\\.md says what the move brings"));
  assert.match(stderr(), /Wrote \d+ values to deployment\.jsonc \(local file only[\s\S]*The cloudflare-os pin moved with it, staged and not committed/);
  // The account is checked before anything is deployed over the instance.
  assert.match(stderr(), /then run `pnpm cf-os check` and, once it passes, `pnpm cf-os deploy`\./);
  assert.deepEqual(resultOf(json).release,
    { id: HOSTED_RELEASE, commit: HOSTED_COMMIT, source: "release", pin: HOSTED_COMMIT, behind: false, moved: true });
  assert.equal(valueAtPath(parseDeployment(readFileSync(join(root, "deployment.jsonc"), "utf8")), ["workers", "workshop", "name"]), "acme-backend");
});

test("--out with a pin already at or past the release changes no pin, says deploying is an upgrade, and writes", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const { code, stderr, json } = await importing(root, ["acme"], {
    out: "deployment.jsonc", flags: { account: FAKE_ACCOUNT },
    pin: { status: "current", path: "cloudflare-os", from: NEWER_COMMIT, to: HOSTED_COMMIT, past: true },
  });
  assert.equal(code, 0);
  assert.match(stderr(), /the project is already at or past the instance's release; deploying is an upgrade\./);
  assert.doesNotMatch(stderr(), /The cloudflare-os pin moved with it/);
  assert.equal(resultOf(json).release.moved, false);
  assert.equal(valueAtPath(parseDeployment(readFileSync(join(root, "deployment.jsonc"), "utf8")), ["accountId"]), FAKE_ACCOUNT);
});

test("--out stops with nothing written when the pin cannot be moved, giving the exact command when one is safe", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const dirty = "The checkout has uncommitted changes, and updating needs a clean one. Commit or stash them (`git stash`), " +
    "then run this again:\n   M deployment.jsonc";
  const blocked = await importing(root, ["acme"], {
    out: "filled.jsonc", flags: { account: FAKE_ACCOUNT },
    pin: {
      status: "blocked", cause: "checkout", reason: dirty, behind: true, command: `pnpm cf-os update --to ${HOSTED_COMMIT}`,
      from: OLD_PIN, to: HOSTED_COMMIT,
    },
  });
  assert.equal(blocked.code, 1);
  assert.deepEqual(blocked.json, []);
  // Stopped before the catalog was read.
  assert.deepEqual(blocked.events, ["move"]);
  assert.match(blocked.stderr(), new RegExp(`This project pins cloudflare-os at ${OLD_PIN}, which is behind release ${HOSTED_RELEASE}, ` +
    "and the pin could not be moved forward:\\nThe checkout has uncommitted changes"));
  assert.match(blocked.stderr(), /The project is not safe to deploy over the instance yet\. Nothing was written\./);
  // The command named is the command-line update: what it does beyond the take-over's own move is said, not left to "offers".
  assert.match(blocked.stderr(), new RegExp(`Deal with the above, then run this again, or move the pin with \`pnpm cf-os update --to ${HOSTED_COMMIT}\`\\. ` +
    "That is the command-line `update`, which merges the starter's main as well as moving the pin: at a terminal it asks first, " +
    "and without one it merges unasked\\. Running this again moves the pin alone\\."));
  assert.doesNotMatch(blocked.stderr(), /offers to merge/);

  // The two were never compared, so `update --to` might roll the pin back: no command is offered.
  const uncompared = await importing(root, ["acme"], {
    out: "filled.jsonc", flags: { account: FAKE_ACCOUNT },
    pin: {
      status: "blocked", cause: "checkout", behind: false, command: undefined, from: undefined, to: undefined,
      reason: "cloudflare-os/ is not checked out, so its pin can be neither compared nor moved. Run `git submodule update --init cloudflare-os`, then run this again.",
    },
  });
  assert.equal(uncompared.code, 1);
  assert.deepEqual(uncompared.json, []);
  assert.match(uncompared.stderr(), /This project's cloudflare-os pin is not known to be at or past release r004945-6c8d301, and could not be moved there:\ncloudflare-os\/ is not checked out/);
  assert.match(uncompared.stderr(), /The project is not safe to deploy over the instance yet\. Nothing was written\.\nDeal with the above, then run this again\.$/);
  assert.doesNotMatch(uncompared.stderr(), /pnpm cf-os update --to/);

  // A move that left work undone, or one that was declined, stops the same way.
  const undone = await importing(root, ["acme"], {
    out: "filled.jsonc", flags: { account: FAKE_ACCOUNT },
    pin: {
      status: "moved", path: "cloudflare-os", from: OLD_PIN, to: HOSTED_COMMIT, commits: 12, brief: join(root, BRIEF), installed: false,
      problems: ["`pnpm install` failed. Fix what it reports, then run it again."],
    },
  });
  assert.equal(undone.code, 1);
  assert.match(undone.stderr(), /but the move left work undone:\n {2}`pnpm install` failed\.[\s\S]*Nothing was written: deal with it, then run this again\./);
  const declined = await importing(root, ["acme"], {
    out: "filled.jsonc", flags: { account: FAKE_ACCOUNT },
    pin: { status: "declined", path: "cloudflare-os", from: OLD_PIN, to: HOSTED_COMMIT, command: `pnpm cf-os update --to ${HOSTED_COMMIT}` },
  });
  assert.equal(declined.code, 1);
  assert.match(declined.stderr(), /The pin was not moved[\s\S]*The project is not safe to deploy over the instance yet\. Nothing was written\./);
  // A comparison that came back where a move was asked for leaves the pin behind: no write either.
  const compared = await importing(root, ["acme"], {
    out: "filled.jsonc", flags: { account: FAKE_ACCOUNT },
    pin: { status: "behind", path: "cloudflare-os", from: OLD_PIN, to: HOSTED_COMMIT, commits: 12 },
  });
  assert.equal(compared.code, 1);
  assert.match(compared.stderr(), new RegExp(`which is behind release ${HOSTED_RELEASE} by 12 commits: [^\\n]*cannot be undone\\.\\n` +
    "The project is not safe to deploy over the instance yet\\. Nothing was written\\.$"));
  assert.doesNotMatch(compared.stderr(), /--out moves the pin forward to it first/);

  for (const { json } of [undone, declined, compared]) assert.deepEqual(json, []);
  assert.equal(readFileSync(join(root, "deployment.jsonc"), "utf8"), TEMPLATE);
  assert.deepEqual(readdirSync(root).toSorted(), ["cloudflare-os", "deployment.jsonc"]);
});

test("mixed releases across Workers: the highest run number is the release to pin", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const account = hostedAccountLive({ "acme-gk-github": { release: NEWER_RELEASE, operation: "gk-github" } });
  const { code, json, stderr, moves } = await importing(root, ["acme"], { out: "filled.jsonc", flags: { account: FAKE_ACCOUNT }, account, pin: behindRelease });
  assert.equal(code, 0);
  assert.deepEqual(moves.map(({ to }) => to), ["9f8e7d6"]);
  assert.match(stderr(), /The instance runs release r005012-9f8e7d6, the newest of its Workers'/);
  assert.deepEqual(resultOf(json).release,
    { id: NEWER_RELEASE, commit: NEWER_COMMIT, source: "release", pin: NEWER_COMMIT, behind: false, moved: true });
});

test("--commit is what is pinned, with the release it was made for", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const { code, json, stderr, moves } = await importing(root, ["acme"], {
    out: "filled.jsonc", flags: { account: FAKE_ACCOUNT }, values: { release: HOSTED_RELEASE, commit: HOSTED_COMMIT }, pin: behindRelease,
  });
  assert.equal(code, 0);
  assert.deepEqual(moves.map(({ to, dryRun }) => [to, dryRun]), [[HOSTED_COMMIT, false]]);
  assert.match(stderr(), new RegExp(`Release ${HOSTED_RELEASE} was built from cloudflare-os commit ${HOSTED_COMMIT}, which --commit names\\.`));
  assert.equal(resultOf(json).release.source, "flag");
});

test("a command made before the instance moved on stops: nothing is pinned behind what the account shows", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const account = hostedAccountLive({ "acme-gk-github": { release: NEWER_RELEASE, operation: "gk-github" } });
  for (const out of [undefined, "filled.jsonc"]) {
    const { code, json, stderr, moves, events } = await importing(root, ["acme"], {
      out, flags: { account: FAKE_ACCOUNT }, account, values: { release: HOSTED_RELEASE, commit: HOSTED_COMMIT },
    });
    assert.equal(code, 1);
    assert.match(stderr(), new RegExp(`the instance moved to ${NEWER_RELEASE} since this command was made; get a fresh one from the deploy flow\\.\\n` +
      "Nothing was moved or written\\."));
    assert.deepEqual([json, moves, events], [[], [], []]);
  }
  // A --commit that is not the commit --release ends in is refused the same way.
  const mismatched = await importing(root, ["acme"], {
    out: "filled.jsonc", flags: { account: FAKE_ACCOUNT }, values: { release: HOSTED_RELEASE, commit: NEWER_COMMIT },
  });
  assert.equal(mismatched.code, 1);
  assert.match(mismatched.stderr(), /is not the commit of --release r004945-6c8d301/);
  assert.deepEqual([mismatched.json, mismatched.moves], [[], []]);
  assert.deepEqual(readdirSync(root).toSorted(), ["cloudflare-os", "deployment.jsonc"]);
});

/** {@link hostedAccountLive} with every Worker of the instance running release `release`. */
function everyWorkerAt(release: string, overrides: Record<string, HostedWorkerOptions> = {}): Record<string, FakeReply> {
  const workers = ["acme", "acme-backend", "acme-gk-context", "acme-gk-scheduler", "acme-gk-github"];
  return hostedAccountLive(Object.fromEntries(workers.map((name) => [name, { release, ...overrides[name] }])));
}

test("a release id that names no commit, or ids that cannot be ordered, stop and ask for --commit", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const handBuilt = await importing(root, ["acme"], { out: "filled.jsonc", flags: { account: FAKE_ACCOUNT }, account: everyWorkerAt("dev-k3x9") });
  assert.equal(handBuilt.code, 1);
  assert.match(handBuilt.stderr(), /Release dev-k3x9 does not say which commit it was built from: could not determine the commit; pass --commit, or copy the command from the deploy flow\./);
  const unorderable = await importing(root, ["acme"], {
    out: "filled.jsonc", flags: { account: FAKE_ACCOUNT }, account: everyWorkerAt("dev-k3x9", { "acme-gk-github": { release: "dev-m7q2" } }),
  });
  assert.equal(unorderable.code, 1);
  assert.match(unorderable.stderr(), /cannot be put in order[\s\S]*could not determine the commit; pass --commit, or copy the command from the deploy flow\./);
  for (const { json, moves, events, stderr } of [handBuilt, unorderable]) {
    assert.deepEqual([json, moves, events], [[], [], []]);
    assert.match(stderr(), /Nothing was moved or written\./);
  }
  // With --commit, the hand-built release has its commit, and the take-over goes on.
  const given = await importing(root, ["acme"], {
    out: "filled.jsonc", flags: { account: FAKE_ACCOUNT }, account: everyWorkerAt("dev-k3x9"), values: { commit: NEWER_COMMIT },
  });
  assert.equal(given.code, 0);
  assert.deepEqual(given.moves.map(({ to }) => to), [NEWER_COMMIT]);
  assert.deepEqual(resultOf(given.json).release,
    { id: "dev-k3x9", commit: NEWER_COMMIT, source: "flag", pin: NEWER_COMMIT, behind: false, moved: false });
});

test("lists the Workers changed by hand, on stderr with what a deploy does to them and on stdout as handEdited", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const account = hostedAccountLive({ "acme-backend": { handEdited: true, vars: { STRAY_SETTING: "typed-into-the-dashboard" } } });
  const { code, json, stderr } = await importing(root, ["acme"], { flags: { account: FAKE_ACCOUNT }, account });
  assert.equal(code, 0);
  assert.match(stderr(), /Workers changed by hand since the hosted flow deployed them:\n {2}acme-backend {2}its live version is not one the hosted flow uploaded \(version [0-9a-f-]{36}, source dash, triggered by upload, created 2026-10-20T14:30:00\.000Z\)/);
  assert.match(stderr(), /A deploy replaces each of these Workers' code, vars and bindings with the project's, so a change made by hand must go into deployment\.jsonc or the source first, or it is lost\./);
  const { handEdited, release } = resultOf(json);
  assert.deepEqual(handEdited.map(({ name, source, trigger, createdOn }) => ({ name, source, trigger, createdOn })),
    [{ name: "acme-backend", source: "dash", trigger: "upload", createdOn: "2026-10-20T14:30:00.000Z" }]);
  // Its release is still read, off the variable the dashboard edit kept.
  assert.equal(release.id, HOSTED_RELEASE);
  // What a Worker's variables hold is never printed wholesale: only the values read by name.
  assert.doesNotMatch(stderr() + JSON.stringify(json), /typed-into-the-dashboard|STRAY_SETTING/);
});

test("writes the backend's own admins, providers, origin and push identity, and lists only what no read supplies", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const account = hostedAccountLive({ "acme-backend": { vars: { PUBLIC_BASE_URL: "https://os.acme.example" }, json: { ADMINS: ["admin@example.com", "second@example.com"] } } });
  const { code, json, stderr, calls } = await importing(root, ["acme"], { out: "deployment.jsonc", flags: { account: FAKE_ACCOUNT }, account });
  assert.equal(code, 0);
  const file = parseDeployment(readFileSync(join(root, "deployment.jsonc"), "utf8"));
  assert.deepEqual(valueAtPath(file, ["access", "admins"]), ["admin@example.com", "second@example.com"]);
  assert.deepEqual(valueAtPath(file, ["aiGateway", "providers"]), ["cloudflare", "anthropic"]);
  // The origin is the one the backend carries, not the Access application's hostname.
  assert.deepEqual(valueAtPath(file, ["workers", "router", "route"]), { customDomain: "os.acme.example" });
  assert.equal(valueAtPath(file, ["publicBaseUrl"]), null);
  assert.match(stderr(), /found {4}Public origin +https:\/\/os\.acme\.example {2}-> workers\.router\.route \/ publicBaseUrl\n.*\(from the backend's PUBLIC_BASE_URL\)/);
  assert.match(stderr(), /Note: The backend's PUBLIC_BASE_URL is https:\/\/os\.acme\.example, but the Access application protects acme\.acme-sub\.workers\.dev\./);
  // The four notification variables, in the block a deploy sends them again from.
  assert.deepEqual(valueAtPath(file, ["pushIdentity"]), {
    serviceUrl: "https://push.example.com", installId: "install-acme", keyId: "key-1", webPushPublicKey: "BFixtureWebPushPublicKey",
  });
  assert.deepEqual((json[0] as Record<string, unknown>).pushIdentity, valueAtPath(file, ["pushIdentity"]));
  // The signing key is named, as the secret that stays on the Worker, and nothing asks the account for a secret.
  assert.match(stderr(), /Note: The push identity's signing key is the secret CFOS_INSTALL_PRIVATE_KEY on acme-backend\. It is not read and not written/);
  assert.ok(!calls.some(({ args }) => args.includes("secrets") || args.includes("secret")));
  assert.doesNotMatch(readFileSync(join(root, "deployment.jsonc"), "utf8"), /CFOS_INSTALL_PRIVATE_KEY|PRIVATE/);
  // CLOUDFLARE_OS_DEPLOYMENT is not carried over, and the report says what goes with it.
  assert.equal((json[0] as Record<string, unknown>).CLOUDFLARE_OS_DEPLOYMENT, undefined);
  assert.doesNotMatch(readFileSync(join(root, "deployment.jsonc"), "utf8"), /CLOUDFLARE_OS_DEPLOYMENT|deploy\.example\.com/);
  assert.match(stderr(), /Note: The backend's CLOUDFLARE_OS_DEPLOYMENT variable[\s\S]*is not carried over/);
  const undiscoverable = stderr().slice(stderr().indexOf("Not part of the hosted deploy"), stderr().indexOf("Note:"));
  assert.deepEqual([...undiscoverable.matchAll(/^ {2}(\S+) /gm)].map((match) => match[1]),
    ["workers.customGatekeeper", "workers.errorReporter", "customGatekeeper.*"]);
});

test("--out writes the push identity as check holds it: the service address trimmed, an unusable one left for a hand edit", async (t) => {
  const spaced = scratchProject(t, TEMPLATE);
  const trailing = await importing(spaced, ["acme"], {
    out: "deployment.jsonc", flags: { account: FAKE_ACCOUNT },
    account: hostedAccountLive({ "acme-backend": { vars: { NOTIFICATION_SERVICE_URL: "https://push.example.com " } } }),
  });
  assert.equal(trailing.code, 0);
  const written = valueAtPath(parseDeployment(readFileSync(join(spaced, "deployment.jsonc"), "utf8")), ["pushIdentity"]);
  assert.equal((written as { serviceUrl: string }).serviceUrl, "https://push.example.com");
  assert.doesNotThrow(() => validatePushIdentity(written));
  assert.match(trailing.stderr(), /Note: The backend's NOTIFICATION_SERVICE_URL has whitespace around it/);

  const inner = scratchProject(t, TEMPLATE);
  const unusable = await importing(inner, ["acme"], {
    out: "deployment.jsonc", flags: { account: FAKE_ACCOUNT },
    account: hostedAccountLive({ "acme-backend": { vars: { CFOS_INSTALL_ID: "install acme" } } }),
  });
  assert.equal(unusable.code, 0);
  // Left as the file had it: the template sets none.
  assert.equal(valueAtPath(parseDeployment(readFileSync(join(inner, "deployment.jsonc"), "utf8")), ["pushIdentity"]), undefined);
  assert.match(unusable.stderr(), /\(not carried over: `cf-os check` would refuse it, see below\)/);
  assert.match(unusable.stderr(), /Note: The backend's push identity is not carried over[^\n]*pushIdentity\.installId[^\n]*The backend's CFOS_INSTALL_ID is "install acme"\. Set pushIdentity by hand/);
});

test("a backend that carries no admins, providers or push identity leaves them to the operator, and says so", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const account = hostedAccountLive({
    "acme-backend": {
      vars: { CF_AI_GATEWAY_PROVIDERS: undefined, NOTIFICATION_SERVICE_URL: undefined, CFOS_INSTALL_ID: undefined, PUBLIC_BASE_URL: undefined },
      json: { ADMINS: undefined },
    },
  });
  const { code, json, stderr } = await importing(root, ["acme"], { out: "deployment.jsonc", flags: { account: FAKE_ACCOUNT }, account });
  assert.equal(code, 0);
  const file = parseDeployment(readFileSync(join(root, "deployment.jsonc"), "utf8"));
  assert.deepEqual(valueAtPath(file, ["access", "admins"]), ["<ADMIN_EMAIL>"]);
  assert.deepEqual(valueAtPath(file, ["aiGateway", "providers"]), ["cloudflare"]);
  assert.equal(valueAtPath(file, ["pushIdentity"]), undefined);
  assert.equal((json[0] as Record<string, unknown>).pushIdentity, undefined);
  assert.match(stderr(), /missing {2}Admins +looked for the backend's ADMINS variable {2}-> access\.admins/);
  assert.match(stderr(), /missing {2}Push identity[\s\S]*the instance has none, so it sends no push notifications/);
  // Without PUBLIC_BASE_URL the origin is the Access application's, as read from the account.
  assert.match(stderr(), /found {4}Public origin +https:\/\/acme\.acme-sub\.workers\.dev[\s\S]*\(from the Access application\)/);
  assert.match(stderr(), /\n {2}access\.admins {2,}the admin emails/);
  assert.match(stderr(), /\n {2}aiGateway\.providers {2,}add anthropic\/openai/);
});

test("--out removes a push identity the file holds for another deployment when the instance has none", async (t) => {
  const foreign = TEMPLATE.replace('"<ROUTER_WORKER_NAME>"', '"beta"').replace('"<CLOUDFLARE_ACCOUNT_ID>"', JSON.stringify(FAKE_ACCOUNT))
    .replace('"gatekeepers": {},', '"gatekeepers": {},\n  "pushIdentity": { "serviceUrl": "https://push.example.com", "installId": "install-beta", "keyId": "key-9", "webPushPublicKey": null },');
  const without = hostedAccountLive({ "acme-backend": { vars: { NOTIFICATION_SERVICE_URL: undefined } } });
  const root = scratchProject(t, foreign);
  const { code, stderr } = await importing(root, ["acme"], { out: "acme.jsonc", flags: { account: FAKE_ACCOUNT }, account: without });
  assert.equal(code, 0);
  assert.equal(valueAtPath(parseDeployment(readFileSync(join(root, "acme.jsonc"), "utf8")), ["pushIdentity"]), undefined);
  assert.match(stderr(), /Note: The file is not acme's in account [0-9a-f]{32}, so the push identity its pushIdentity block holds is another deployment's, and this instance has none\. --out removes the block\./);
  assert.match(stderr(), /Wrote \d+ values to acme\.jsonc, removing pushIdentity \(local file only/);
  // The instance's own identity is written over another's, whole, and the instance's own file keeps its block.
  const replaced = scratchProject(t, foreign);
  assert.equal((await importing(replaced, ["acme"], { out: "acme.jsonc", flags: { account: FAKE_ACCOUNT } })).code, 0);
  assert.deepEqual(valueAtPath(parseDeployment(readFileSync(join(replaced, "acme.jsonc"), "utf8")), ["pushIdentity"]), {
    serviceUrl: "https://push.example.com", installId: "install-acme", keyId: "key-1", webPushPublicKey: "BFixtureWebPushPublicKey",
  });
  const own = scratchProject(t, foreign.replace('"beta"', '"acme"'));
  const kept = await importing(own, ["acme"], { out: "acme.jsonc", flags: { account: FAKE_ACCOUNT }, account: without });
  assert.equal((valueAtPath(parseDeployment(readFileSync(join(own, "acme.jsonc"), "utf8")), ["pushIdentity"]) as { installId: string }).installId, "install-beta");
  assert.doesNotMatch(kept.stderr(), /removing pushIdentity/);
});

/**
 * What each Worker of {@link mossAccount} runs, by Worker name. `backend` changes the plain
 * variables its backend carries; one set to `undefined` is left out. `backendName` is what its
 * backend Worker is called, and `github` the Worker its backend binds as the GitHub Gatekeeper.
 */
function mossLive(backend: Record<string, string | undefined> = {}, backendName = "moss-api", github = "moss-hub") {
  return {
    "moss-os": hostedWorkerLive("moss-os", { services: { WORKSHOP_BACKEND: backendName } }),
    [backendName]: hostedWorkerLive(backendName, {
      vars: { PUBLIC_BASE_URL: "https://os.moss.example", CF_AI_GATEWAY_PROVIDERS: "cloudflare", CF_ACCESS_AUD: "aud-moss", ...backend },
      json: { ADMINS: ["root@moss.example"] },
      services: {
        GATEKEEPER_CONTEXT: "moss-gk-context", GATEKEEPER_SCHEDULER: "moss-gk-scheduler", GATEKEEPER_WEBSEARCH: "moss-gk-websearch",
        GATEKEEPER_GITHUB: github,
      },
    }),
    "moss-gk-context": hostedWorkerLive("moss-gk-context"),
    "moss-gk-scheduler": hostedWorkerLive("moss-gk-scheduler"),
    "moss-gk-websearch": hostedWorkerLive("moss-gk-websearch"),
    [github]: hostedWorkerLive(github, { operation: "gk-github" }),
    moss: hostedWorkerLive("moss", { services: { WORKSHOP_BACKEND: "other-api" } }),
  };
}

/**
 * An instance "moss" deployed under Worker names of its own: its router is `moss-os`, its backend
 * `moss-api`, and its GitHub Gatekeeper `moss-hub`. A Worker `moss-gk-github`, which the backend
 * does not bind, is in the account too, as is another deployment's router `moss`. `live` is what its
 * Workers run, where that is not {@link mossLive}'s own.
 */
function mossAccount(live: ReturnType<typeof mossLive> = mossLive()): Record<string, FakeReply> {
  return {
    "zero-trust organization get": { auth_domain: "moss-team.cloudflareaccess.com" },
    "workers list": [...Object.keys(live), "moss-gk-github"].map((name) => ({ name })),
    "kv namespaces list": [
      { id: "kv-moss-blueprints", title: "moss-blueprints" },
      { id: "kv-moss-avatars", title: "moss-avatars" },
      { id: "kv-moss-context", title: "moss-context-collections" },
    ],
    "r2 buckets list": { buckets: [{ name: "moss-blueprint-content" }] },
    "ai-gateway gateways list": [{ id: "moss-ai" }],
    "zero-trust access applications list": [{ name: "Cloudflare OS moss 1a2b3c4d", aud: "aud-moss", domain: "os.moss.example" }],
    ...workerLiveReplies(live),
  };
}

test("--router and --backend take over an instance deployed under Worker names of its own", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const values = { router: "moss-os", backend: "moss-api", release: HOSTED_RELEASE, commit: HOSTED_COMMIT };
  const { code, stderr, moves } = await importing(root, ["moss"], { out: "deployment.jsonc", flags: { account: FAKE_ACCOUNT }, account: mossAccount(), values });
  assert.equal(code, 0);
  assert.deepEqual(moves.map(({ to }) => to), [HOSTED_COMMIT]);
  const file = parseDeployment(readFileSync(join(root, "deployment.jsonc"), "utf8"));
  assert.deepEqual(valueAtPath(file, ["workers", "router"]), { name: "moss-os", route: { customDomain: "os.moss.example" } });
  assert.equal(valueAtPath(file, ["workers", "workshop", "name"]), "moss-api");
  // Everything else is named after the instance, and the Gatekeepers are the Workers the backend binds.
  assert.equal(valueAtPath(file, ["workers", "context", "name"]), "moss-gk-context");
  assert.equal(valueAtPath(file, ["workers", "websearch", "name"]), "moss-gk-websearch");
  assert.equal(valueAtPath(file, ["resources", "blueprintsKvNamespaceId"]), "kv-moss-blueprints");
  assert.equal(valueAtPath(file, ["aiGateway", "name"]), "moss-ai");
  assert.equal(valueAtPath(file, ["access", "audience"]), "aud-moss");
  assert.deepEqual(valueAtPath(file, ["gatekeepers"]), { github: { name: "moss-hub" } });
  assert.match(stderr(), /Note: Named like this instance's Gatekeepers, but not bound by its backend, so no part of it, and left alone: moss-gk-github\./);
  // Written, the file reads as the instance's own, by its router's name.
  const again = await importing(root, ["moss"], { out: "deployment.jsonc", flags: { account: FAKE_ACCOUNT }, account: mossAccount(), values });
  assert.equal(again.code, 0);
  assert.doesNotMatch(again.stderr(), /another deployment's/);
});

test("under Worker names of its own, the instance's file is known by its router's name, not the instance's", async (t) => {
  const values = { router: "moss-os", backend: "moss-api" };
  // An instance with no push identity of its own, so one in the file is the file's alone.
  const account = mossAccount(mossLive({ NOTIFICATION_SERVICE_URL: undefined }));
  const push = { serviceUrl: "https://push.example.com", installId: "install-file", keyId: "key-4", webPushPublicKey: null };
  const fileFor = (router: string) => namedWorkersTemplate(router)
    .replace('"gatekeepers": {', `"pushIdentity": ${JSON.stringify(push)},\n  "gatekeepers": {`);
  const written = async (router: string) => {
    const root = scratchProject(t, fileFor(router));
    const { code, stderr } = await importing(root, ["moss"], { out: "deployment.jsonc", flags: { account: FAKE_ACCOUNT }, account, values });
    assert.equal(code, 0, stderr());
    return { file: parseDeployment(readFileSync(join(root, "deployment.jsonc"), "utf8")), stderr: stderr() };
  };

  // The file a take-over of moss wrote, run again: its router is moss-os, so everything it added is its own and stays.
  const own = await written("moss-os");
  assert.equal(valueAtPath(own.file, ["workers", "customGatekeeper", "name"]), "shared-custom");
  assert.equal(valueAtPath(own.file, ["workers", "errorReporter", "name"]), "shared-errors");
  assert.deepEqual(valueAtPath(own.file, ["gatekeepers"]), { github: { name: "moss-hub" }, homeassistant: { name: "beta-gk-homeassistant" } });
  assert.deepEqual(valueAtPath(own.file, ["pushIdentity"]), push);
  assert.doesNotMatch(own.stderr, /another deployment's|that deployment's|back to placeholders|removing/);

  // A file whose router is `moss`, the other deployment's Worker: the instance's name alone does not make it this one's.
  const other = await written("moss");
  assert.equal(valueAtPath(other.file, ["workers", "router", "name"]), "moss-os");
  assert.equal(valueAtPath(other.file, ["workers", "customGatekeeper", "name"]), "<CUSTOM_GATEKEEPER_WORKER_NAME>");
  assert.equal(valueAtPath(other.file, ["workers", "errorReporter", "name"]), "<ERROR_REPORTER_WORKER_NAME>");
  assert.deepEqual(valueAtPath(other.file, ["gatekeepers"]), { github: { name: "moss-hub" } });
  assert.equal(valueAtPath(other.file, ["pushIdentity"]), undefined);
  // Said without calling the file moss's and not moss's in one breath.
  assert.match(other.stderr, new RegExp(`Note: The file is the deployment's whose router is moss, not moss's in account ${FAKE_ACCOUNT}, ` +
    "whose router is moss-os, so the Worker names it gives the rest may be that deployment's: "));
  assert.doesNotMatch(other.stderr, /The file is moss's, not moss's/);
});

test("the command to run next repeats every flag given", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const values = { router: "moss-os", backend: "moss-api", release: HOSTED_RELEASE, commit: HOSTED_COMMIT };
  const { code, stderr } = await importing(root, ["moss"], { flags: { account: FAKE_ACCOUNT }, account: mossAccount(), values });
  assert.equal(code, 0);
  assert.match(stderr(), new RegExp(`\\n {2}pnpm cf-os import moss --account ${FAKE_ACCOUNT} --router moss-os --backend moss-api ` +
    `--release ${HOSTED_RELEASE} --commit ${HOSTED_COMMIT} --out deployment\\.jsonc$`));
  // And where the account or the instance is still to be chosen.
  const accounts = [{ id: FAKE_ACCOUNT, name: "Acme" }, { id: "f".repeat(32), name: "Acme Staging" }];
  const unchosen = await importing(root, ["moss"], { account: { "accounts list": accounts }, values });
  assert.match(unchosen.stderr(), new RegExp(`Then: pnpm cf-os import moss --account <id> --router moss-os --backend moss-api --release ${HOSTED_RELEASE} --commit ${HOSTED_COMMIT}`));
  const listed = await importing(root, [], { flags: { account: FAKE_ACCOUNT }, values: { release: HOSTED_RELEASE } });
  assert.match(listed.stderr(), new RegExp(`Then: pnpm cf-os import <instance> --account ${FAKE_ACCOUNT} --release ${HOSTED_RELEASE}\\n`));
});

test("an instance under names of its own is not found by name, nor half-matched: both names are the operator's to give", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  // By name alone "moss" is another deployment's router with no backend beside it.
  const cases: [Record<string, string>, RegExp][] = [
    [{}, /The account has no backend Worker named moss-backend for the instance: pass --backend <name>/],
    [{ router: "moss-os" }, /The account has no backend Worker named moss-backend for the instance: pass --backend <name>/],
    [{ backend: "moss-api" }, /"moss" cannot be taken over as it was read:\n {2}Worker moss is not the router of moss-api: its WORKSHOP_BACKEND service binding points at other-api/],
  ];
  for (const [values, refusal] of cases) {
    const { code, json, stderr, moves, events } = await importing(root, ["moss"], { out: "filled.jsonc", flags: { account: FAKE_ACCOUNT }, account: mossAccount(), values });
    assert.equal(code, 1, JSON.stringify(values));
    assert.match(stderr(), refusal);
    assert.match(stderr(), /Nothing was moved or written\./);
    assert.deepEqual([json, moves, events], [[], [], []]);
  }
  assert.match((await importing(root, ["moss"], { flags: { account: FAKE_ACCOUNT }, account: mossAccount() })).stderr(),
    /No hosted instance "moss" here[\s\S]*pass its name with --router <name> and --backend <name>/);
  assert.deepEqual(readdirSync(root).toSorted(), ["cloudflare-os", "deployment.jsonc"]);
});

/**
 * One account holding both fixture instances: "acme" under the hosted flow's names, with its storage,
 * gateway and Access application, and "moss" under Worker names of its own ({@link mossAccount}).
 * `backend` changes the plain variables moss's backend carries.
 */
function acmeAndMoss(backend: Record<string, string | undefined> = {}): Record<string, FakeReply> {
  const acme = hostedAccountLive();
  const moss = mossAccount();
  const both = (key: string) => [...acme[key] as object[], ...moss[key] as object[]];
  return {
    ...acme,
    "workers list": both("workers list"),
    "kv namespaces list": both("kv namespaces list"),
    "r2 buckets list": { buckets: [{ name: "acme-blueprint-content" }, { name: "moss-blueprint-content" }] },
    "ai-gateway gateways list": both("ai-gateway gateways list"),
    "zero-trust access applications list": both("zero-trust access applications list"),
    ...workerLiveReplies({ ...hostedInstanceLive(), ...mossLive(backend) }),
  };
}

test("Workers named with --router and --backend are not taken over under another instance's name, or a mistyped one", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const values = { router: "moss-os", backend: "moss-api" };
  // "acme" is an instance of the account too: its storage, gateway and Access application would all match by name.
  const cases: [string, Record<string, string | undefined>, RegExp][] = [
    ["acme", {}, /\n {2}the backend's CF_ACCESS_AUD is the audience of the Access application "Cloudflare OS moss 1a2b3c4d", which names instance moss\n/],
    // Nothing on the backend names a gateway, an origin or an audience: its Workers still say whose they are.
    ["acme", { CF_ACCESS_AUD: undefined, CF_AI_GATEWAY: undefined, PUBLIC_BASE_URL: undefined }, /which names instance moss\n/],
    // A name typed wrong, and the router's name given as the instance's, match no storage at all.
    ["mos", {}, /If the instance is moss, run this for moss, with --router moss-os --backend moss-api\./],
    ["moss-os", {}, /which names instance moss\n/],
  ];
  for (const [instance, backend, refusal] of cases) {
    for (const out of [undefined, "filled.jsonc"]) {
      const { code, json, stderr, moves, events } = await importing(root, [instance], {
        out, flags: { account: FAKE_ACCOUNT }, account: acmeAndMoss(backend), values: instance === "moss-os" ? { backend: "moss-api" } : values,
      });
      assert.equal(code, 1, instance);
      assert.match(stderr(), new RegExp(`"${instance}" is not the name of the instance moss-os and moss-api belong to, by what they carry:`));
      assert.match(stderr(), refusal);
      assert.match(stderr(), /An instance's storage, AI Gateway and Access application are found by its name/);
      assert.match(stderr(), /Nothing was moved or written\.$/);
      // Stopped before the pin was looked at, the catalog read, or a value matched under the name.
      assert.deepEqual([json, moves, events], [[], [], []]);
      assert.doesNotMatch(stderr(), /found {4}|kv-blueprints|aud-acme/);
    }
  }
  // Under its own name the same Workers are taken over, with its own storage and Access application.
  const own = await importing(root, ["moss"], { out: "moss.jsonc", flags: { account: FAKE_ACCOUNT }, account: acmeAndMoss(), values });
  assert.equal(own.code, 0);
  const file = parseDeployment(readFileSync(join(root, "moss.jsonc"), "utf8"));
  assert.equal(valueAtPath(file, ["resources", "blueprintsKvNamespaceId"]), "kv-moss-blueprints");
  assert.equal(valueAtPath(file, ["access", "audience"]), "aud-moss");
  assert.deepEqual(readdirSync(root).toSorted(), ["cloudflare-os", "deployment.jsonc", "moss.jsonc"]);
  assert.equal(readFileSync(join(root, "deployment.jsonc"), "utf8"), TEMPLATE);
});

/**
 * {@link mossAccount} with moss's backend called `moss-os-backend`: by name alone its router and
 * backend are an instance "moss-os", which has no storage, no gateway and no Access application.
 */
function mossPairAccount(): Record<string, FakeReply> {
  return mossAccount(mossLive({}, "moss-os-backend"));
}

/** Holds `stderr` to the refusal of {@link mossPairAccount}'s Workers under the name "moss-os", with nothing matched under it. */
function assertNotMossOs(stderr: string): void {
  assert.match(stderr, /"moss-os" is not the name of the instance moss-os and moss-os-backend belong to, by what they carry:\n/);
  assert.match(stderr, /\n {2}the backend's CF_ACCESS_AUD is the audience of the Access application "Cloudflare OS moss 1a2b3c4d", which names instance moss\n/);
  assert.match(stderr, /If the instance is moss, run this for moss, with --router moss-os --backend moss-os-backend\.\nNothing was moved or written\.$/);
  assert.doesNotMatch(stderr, /found {4}|missing {2}/);
}

test("a router and a backend named X and X-backend by the operator are not taken over as an instance X", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const named: Record<string, string>[] = [{}, { router: "moss-os", backend: "moss-os-backend" }];
  for (const out of [undefined, "filled.jsonc"]) {
    for (const values of named) {
      const { code, json, stderr, moves, events } = await importing(root, ["moss-os"], {
        out, flags: { account: FAKE_ACCOUNT }, account: mossPairAccount(), values, pin: behindRelease,
      });
      assert.equal(code, 1);
      assertNotMossOs(stderr());
      assert.deepEqual([json, moves, events], [[], [], []]);
    }
  }
  // The list of instances found by name offers it, and picking it there stops the same way.
  const prompter = scriptedPrompter([["Which hosted instance?", "moss-os"]]);
  const picked = await importing(root, [], { out: "filled.jsonc", flags: { account: FAKE_ACCOUNT }, account: mossPairAccount(), prompter, pin: behindRelease });
  assert.deepEqual(prompter.asked.map((asked) => asked.choices), [["moss-os"]]);
  assert.equal(picked.code, 1);
  assertNotMossOs(picked.stderr());
  assert.deepEqual([picked.json, picked.moves, picked.events], [[], [], []]);
  assert.deepEqual(readdirSync(root).toSorted(), ["cloudflare-os", "deployment.jsonc"]);

  // Under its own name, with the two Workers named, it is taken over with its own storage and Access application.
  const own = await importing(root, ["moss"], {
    out: "moss.jsonc", flags: { account: FAKE_ACCOUNT }, account: mossPairAccount(), values: { router: "moss-os", backend: "moss-os-backend" },
  });
  assert.equal(own.code, 0);
  const file = parseDeployment(readFileSync(join(root, "moss.jsonc"), "utf8"));
  assert.equal(valueAtPath(file, ["workers", "workshop", "name"]), "moss-os-backend");
  assert.equal(valueAtPath(file, ["resources", "blueprintsKvNamespaceId"]), "kv-moss-blueprints");
  assert.equal(valueAtPath(file, ["aiGateway", "name"]), "moss-ai");
  assert.equal(valueAtPath(file, ["access", "audience"]), "aud-moss");
});

test("a Gatekeeper Worker named after something else does not stop the take-over of the instance its Access application names", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const values = { router: "moss-os", backend: "moss-api" };
  // The GitHub Gatekeeper's Worker is `zed-gk-github`: the hosted flow's form, under a stem that is not the instance's.
  const account = mossAccount(mossLive({}, "moss-api", "zed-gk-github"));
  const { code } = await importing(root, ["moss"], { out: "moss.jsonc", flags: { account: FAKE_ACCOUNT }, account, values });
  assert.equal(code, 0);
  const file = parseDeployment(readFileSync(join(root, "moss.jsonc"), "utf8"));
  assert.deepEqual(valueAtPath(file, ["gatekeepers"]), { github: { name: "zed-gk-github" } });
  assert.equal(valueAtPath(file, ["resources", "blueprintsKvNamespaceId"]), "kv-moss-blueprints");
  // The stem of that Worker is no name to take the instance over under.
  const under = await importing(root, ["zed"], { out: "zed.jsonc", flags: { account: FAKE_ACCOUNT }, account, values });
  assert.equal(under.code, 1);
  assert.match(under.stderr(), /"zed" is not the name of the instance moss-os and moss-api belong to[\s\S]*which names instance moss\n/);
  assert.deepEqual([under.json, under.moves, under.events], [[], [], []]);
  assert.deepEqual(readdirSync(root).toSorted(), ["cloudflare-os", "deployment.jsonc", "moss.jsonc"]);
});

test("an instance under the hosted flow's own names whose backend carries no instance's name is taken over by those names", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  // Every Gatekeeper Worker renamed, and no audience or gateway on the backend: nothing but the two Workers' names says "acme".
  const account = hostedAccountWith(["ctx", "sched", "hub"], {
    "acme-backend": { services: { GATEKEEPER_CONTEXT: "ctx", GATEKEEPER_SCHEDULER: "sched", GATEKEEPER_GITHUB: "hub" } },
    ctx: {}, sched: {}, hub: { operation: "gk-github" },
  });
  const { code } = await importing(root, ["acme"], { out: "acme.jsonc", flags: { account: FAKE_ACCOUNT }, account });
  assert.equal(code, 0);
  const file = parseDeployment(readFileSync(join(root, "acme.jsonc"), "utf8"));
  assert.equal(valueAtPath(file, ["workers", "context", "name"]), "ctx");
  assert.equal(valueAtPath(file, ["resources", "blueprintsKvNamespaceId"]), "kv-blueprints");
});

test("a gateway alone does not put Workers named with --router and --backend under an instance whose own router and backend the account has", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  // moss's Workers as a hand left them: no audience on the backend, its Gatekeepers renamed, its gateway pointed at acme's.
  const borrowed = {
    "moss-os": hostedWorkerLive("moss-os", { services: { WORKSHOP_BACKEND: "moss-api" } }),
    "moss-api": hostedWorkerLive("moss-api", {
      vars: { CF_AI_GATEWAY: "acme-ai" }, services: { GATEKEEPER_CONTEXT: "ctx", GATEKEEPER_SCHEDULER: "sched" },
    }),
    ctx: hostedWorkerLive("ctx"),
    sched: hostedWorkerLive("sched"),
  };
  const acme = hostedAccountLive();
  const account = {
    ...acme,
    "workers list": [...acme["workers list"] as object[], ...Object.keys(borrowed).map((name) => ({ name }))],
    ...workerLiveReplies({ ...hostedInstanceLive(), ...borrowed }),
  };
  for (const out of [undefined, "filled.jsonc"]) {
    const { code, json, stderr, moves, events } = await importing(root, ["acme"], {
      out, flags: { account: FAKE_ACCOUNT }, account, values: { router: "moss-os", backend: "moss-api" }, pin: behindRelease,
    });
    assert.equal(code, 1, stderr());
    assert.match(stderr(), new RegExp('Whether "acme" is the name of the instance moss-os and moss-api belong to cannot be told from what they carry:\\n' +
      " {2}the backend's CF_AI_GATEWAY is acme-ai, which names instance acme\\n" +
      " {2}the account has Workers acme and acme-backend, named as the hosted flow names instance acme's own router and backend\\n"));
    assert.match(stderr(), /If acme and acme-backend are the instance, run this for acme without --router and --backend\.\nNothing was moved or written\.$/);
    // Stopped before the pin was looked at, the catalog read, or acme's storage matched under the name.
    assert.deepEqual([json, moves, events], [[], [], []]);
    assert.doesNotMatch(stderr(), /found {4}|kv-blueprints|aud-acme/);
  }
  assert.deepEqual(readdirSync(root).toSorted(), ["cloudflare-os", "deployment.jsonc"]);
  // The instance those two Workers are is still taken over, as itself.
  const own = await importing(root, ["acme"], { out: "acme.jsonc", flags: { account: FAKE_ACCOUNT }, account });
  assert.equal(own.code, 0, own.stderr());
  assert.equal(valueAtPath(parseDeployment(readFileSync(join(root, "acme.jsonc"), "utf8")), ["workers", "workshop", "name"]), "acme-backend");
});

test("Workers named with --router and --backend that carry no instance's name are not taken over under any", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const bare = {
    "moss-os": hostedWorkerLive("moss-os", { services: { WORKSHOP_BACKEND: "moss-api" } }),
    "moss-api": hostedWorkerLive("moss-api", { services: { GATEKEEPER_CONTEXT: "ctx" } }),
    ctx: hostedWorkerLive("ctx"),
  };
  const account = {
    ...mossAccount(),
    "workers list": Object.keys(bare).map((name) => ({ name })),
    "zero-trust access applications list": [{ name: "Moss", aud: "aud-moss", domain: "os.moss.example" }],
    ...workerLiveReplies(bare),
  };
  const { code, json, stderr, moves, events } = await importing(root, ["moss"], {
    out: "filled.jsonc", flags: { account: FAKE_ACCOUNT }, account, values: { router: "moss-os", backend: "moss-api" },
  });
  assert.equal(code, 1);
  assert.match(stderr(), /Nothing moss-os and moss-api carry says they are instance "moss"'s: /);
  assert.match(stderr(), /One of those has to name "moss" before the instance is taken over under --router and --backend\.\nNothing was moved or written\.$/);
  assert.deepEqual([json, moves, events], [[], [], []]);
  assert.deepEqual(readdirSync(root).toSorted(), ["cloudflare-os", "deployment.jsonc"]);
});

test("stops before the pin when the account's Worker list lacks a Worker that was read", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const hosted = hostedAccountLive();
  const account = { ...hosted, "workers list": (hosted["workers list"] as { name: string }[]).filter(({ name }) => name !== "acme-backend") };
  const { code, json, stderr, moves, events } = await importing(root, ["acme"], { out: "filled.jsonc", flags: { account: FAKE_ACCOUNT }, account, pin: behindRelease });
  assert.equal(code, 1);
  assert.match(stderr(), /The account's list of Workers does not have acme-backend, read a moment ago as "acme"'s: the account changed while it was being read\. Run this again\.\nNothing was moved or written\.$/);
  assert.deepEqual([json, moves, events], [[], [], []]);
  assert.deepEqual(readdirSync(root).toSorted(), ["cloudflare-os", "deployment.jsonc"]);
});

test("--out to a path that cannot be a file is a usage error before anything is read or moved", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  mkdirSync(join(root, "configs"));
  const cases: [string, RegExp][] = [
    ["nope/dir/x.jsonc", /^--out nope\/dir\/x\.jsonc: nope\/dir is not a directory\. Nothing was moved or written\.$/],
    ["configs", /^--out configs is a directory, not a file to write\. Nothing was moved or written\.$/],
  ];
  for (const [out, message] of cases) {
    const cf = fakeCf(hostedAccountLive());
    const mover = recordingPinMove(behindRelease);
    const { ctx, json } = testContext({ root, client: cfClient({ spawn: cf.spawn }), flags: { account: FAKE_ACCOUNT } });
    await assert.rejects(run({ command: "import", values: { out }, positionals: ["acme"] }, ctx, async () => testCatalog(), mover.move),
      (error) => error instanceof UsageError && message.test(error.message), out);
    assert.deepEqual([cf.calls, mover.calls, json], [[], [], []]);
  }
  // A directory that is there takes the file.
  assert.equal((await importing(root, ["acme"], { out: "configs/acme.jsonc", flags: { account: FAKE_ACCOUNT } })).code, 0);
  assert.deepEqual(readdirSync(join(root, "configs")), ["acme.jsonc"]);
});

/** What `movePin` answers for a pin that would be left behind a commit it is held to. */
const behindFloor = ({ to }: PinMoveCall): PinMove => ({
  status: "blocked", cause: "floor", behind: false, command: undefined, from: OLD_PIN, to,
  reason: "6c8d301 is ahead of 1111111, where this would leave cloudflare-os's pin, so the pin would be behind it, and nothing was moved.",
});

test("holds the pin to the commit the Workers' own release names, whatever --release and --commit say", async (t) => {
  // A release no Worker reports, numbered above the one they all do, with an older commit: by the
  // flags alone it would read as the newest, and a pin past its commit as at or past the instance.
  const older = `1111111${"0".repeat(33)}`;
  const given: Record<string, string>[] = [{ release: "r999999-1111111", commit: older }, { release: "r999999-1111111" }];
  for (const values of given) {
    for (const out of [undefined, "acme.jsonc"]) {
      const root = scratchProject(t, TEMPLATE);
      const { code, json, stderr, moves, events } = await importing(root, ["acme"], { out, values, flags: { account: FAKE_ACCOUNT }, pin: behindFloor });
      // A refusal with --out or without: the command is not one for what the instance runs.
      assert.equal(code, 1);
      assert.deepEqual(moves, [{ to: values.commit ?? "1111111", dryRun: out === undefined, root, asks: false, atLeast: ["6c8d301"] }]);
      assert.deepEqual(events, [out ? "move" : "compare"], "the catalog is not read past a refusal");
      assert.deepEqual(json, []);
      assert.deepEqual(readdirSync(root).toSorted(), ["cloudflare-os", "deployment.jsonc"]);
      assert.equal(readFileSync(join(root, "deployment.jsonc"), "utf8"), TEMPLATE);
      assert.match(stderr(), /The instance's Workers themselves report r004945-6c8d301 \(commit 6c8d301, reported by acme, acme-backend[^)]*\), and where commit 1111111[0-9a-f]* leaves the pin is not shown to be at or past that commit:\n6c8d301 is ahead of 1111111, /);
      assert.match(stderr(), /Get a fresh one from the deploy flow, pass a --commit that is at or past every commit its Workers name, or leave --release and --commit out/);
      assert.match(stderr(), /\nNothing was moved or written\.$/);
      assert.doesNotMatch(stderr(), /already at or past the instance's release|update --to/);
    }
  }

  // Held and found at or past it, the take-over goes on, and says what the pin was held to.
  const root = scratchProject(t, TEMPLATE);
  const held = await importing(root, ["acme"], {
    out: "acme.jsonc", values: { release: "r999999-1111111", commit: older }, flags: { account: FAKE_ACCOUNT },
  });
  assert.equal(held.code, 0);
  assert.deepEqual(held.moves.map(({ atLeast }) => atLeast), [["6c8d301"]]);
  assert.match(held.stderr(), /The instance's Workers themselves report r004945-6c8d301 \([^)]*\): where this leaves the pin is at or past that commit too\./);
  // The deploy flow's own command names the release the Workers report: there is nothing more to hold to.
  const usual = await importing(scratchProject(t, TEMPLATE), ["acme"], {
    out: "acme.jsonc", values: { release: HOSTED_RELEASE, commit: HOSTED_COMMIT }, flags: { account: FAKE_ACCOUNT },
  });
  assert.equal(usual.code, 0);
  assert.deepEqual(usual.moves, [{ to: HOSTED_COMMIT, dryRun: false, root: usual.moves[0].root, asks: false }]);
  assert.doesNotMatch(usual.stderr(), /themselves report/);
});

test("a write that fails after the pin moved says the pin stays moved, and prints no result", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root writes a read-only file");
  const root = scratchProject(t, TEMPLATE);
  writeFileSync(join(root, "locked.jsonc"), "{}\n");
  chmodSync(join(root, "locked.jsonc"), 0o444);
  const cf = fakeCf(hostedAccountLive());
  const mover = recordingPinMove(behindRelease);
  const { ctx, json, stderr } = testContext({ root, client: cfClient({ spawn: cf.spawn }), flags: { account: FAKE_ACCOUNT } });
  await assert.rejects(run({ command: "import", values: { out: "locked.jsonc" }, positionals: ["acme"] }, ctx, async () => testCatalog(), mover.move),
    /EACCES|EPERM/);
  assert.deepEqual(mover.calls.map(({ dryRun }) => dryRun), [false]);
  assert.match(stderr(), new RegExp(`locked\\.jsonc could not be written, and nothing was\\. The cloudflare-os pin had moved to ${HOSTED_COMMIT}, ` +
    "staged and not committed, and stays there: run this again once the file can be written\\."));
  assert.deepEqual(json, []);
  assert.equal(readFileSync(join(root, "locked.jsonc"), "utf8"), "{}\n");
});

test("--out at a terminal moves the pin unasked: the command itself asked for the move", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const prompter = scriptedPrompter([]);
  const { code, moves } = await importing(root, ["acme"], { out: "deployment.jsonc", flags: { account: FAKE_ACCOUNT }, prompter, pin: behindRelease });
  assert.equal(code, 0);
  // The mover is handed no prompter, so it has nothing to ask with.
  assert.deepEqual(moves, [{ to: "6c8d301", dryRun: false, root, asks: false }]);
  assert.deepEqual(prompter.asked, []);
  // The comparison of a run without --out asks nothing either.
  const compared = await importing(root, ["acme"], { flags: { account: FAKE_ACCOUNT }, prompter: scriptedPrompter([]), pin: behindRelease });
  assert.deepEqual(compared.moves, [{ to: "6c8d301", dryRun: true, root, asks: false }]);
});

test("refuses Workers that are not one instance's: a router of another backend, or of another installation", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  // A Worker with no binding to the backend, and one the hosted flow uploaded for another installation.
  const foreignTag = { "workers/tag": "gd:4945:deadbeef", "workers/message": `Cloudflare OS core from release ${HOSTED_RELEASE}`, "workers/triggered_by": "upload" };
  const account = hostedAccountWith(["other-os"], {
    unrelated: {},
    "other-os": { annotations: foreignTag, services: { WORKSHOP_BACKEND: "acme-backend" } },
  });
  const cases: [string, RegExp][] = [
    ["unrelated", /Worker unrelated is not the router of acme-backend: it has no WORKSHOP_BACKEND service binding/],
    ["other-os", /These Workers are not one installation's: other-os \(deadbeef\); acme-backend, .*\(1a2b3c4d\)/],
  ];
  for (const [router, refusal] of cases) {
    const { code, json, stderr, moves, events } = await importing(root, ["acme"], {
      out: "filled.jsonc", flags: { account: FAKE_ACCOUNT }, account, values: { router },
    });
    assert.equal(code, 1, router);
    assert.match(stderr(), /"acme" cannot be taken over as it was read:/);
    assert.match(stderr(), refusal);
    assert.deepEqual([json, moves, events], [[], [], []]);
  }
  assert.deepEqual(readdirSync(root).toSorted(), ["cloudflare-os", "deployment.jsonc"]);
});

test("refuses a flag that is not of the form it takes, as a usage error, before reading anything", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const cases: [Record<string, string>, RegExp][] = [
    [{ commit: "6c8d301" }, /--commit "6c8d301" is not a full commit SHA: all 40 hex digits\./],
    [{ commit: `${HOSTED_COMMIT} --upstream` }, /--commit .* is not a full commit SHA/],
    [{ release: "r004945 6c8d301" }, /--release "r004945 6c8d301" is not a release id/],
    [{ release: "-rf" }, /--release "-rf" is not a release id/],
    [{ router: "Moss_OS" }, /--router "Moss_OS" is not a Worker name/],
    [{ backend: "moss api" }, /--backend "moss api" is not a Worker name/],
    [{ router: "moss-os", backend: "moss-os" }, /--router and --backend both name Worker moss-os/],
  ];
  for (const [values, message] of cases) {
    const cf = fakeCf(hostedAccountLive());
    const { ctx } = testContext({ root, client: cfClient({ spawn: cf.spawn }), flags: { account: FAKE_ACCOUNT } });
    await assert.rejects(run({ command: "import", values, positionals: ["acme"] }, ctx, async () => testCatalog(), recordingPinMove().move),
      (error) => error instanceof UsageError && message.test(error.message), JSON.stringify(values));
    assert.deepEqual(cf.calls, []);
  }
});

/**
 * `movePin` itself over recorded git, as update.test.ts runs it: `root` made a starter project whose
 * submodule is checked out at a pin behind `target`, a commit of upstream's main, with nothing in
 * the way. `commands` lists what ran; `configAt` holds the config as it was when each command ran.
 */
function recordedPinMove(root: string, target: string) {
  writeFileSync(join(root, "cloudflare-os", ".git"), "gitdir: ../.git/modules/cloudflare-os\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  const fetchHeads = [target, "e".repeat(40)];
  const replies: Record<string, { status?: number; stdout?: string }> = {
    "git rev-parse --show-toplevel": { stdout: `${root}\n` },
    "git config -f .gitmodules --get-regexp": {
      stdout: "submodule.cloudflare-os.path cloudflare-os\nsubmodule.cloudflare-os.url https://github.com/cloudflare/cloudflare-os.git\n",
    },
    "git rev-parse -q --verify MERGE_HEAD": { status: 1 },
    "git rev-parse HEAD": { stdout: `${"a".repeat(40)}\n` },
    "git rev-parse HEAD:cloudflare-os": { stdout: `${OLD_PIN}\n` },
    "git -C cloudflare-os rev-parse --is-shallow-repository": { stdout: "true\n" },
    [`git -C cloudflare-os log -1 --format=%ct ${OLD_PIN}`]: { stdout: "1760000000\n" },
  };
  const commands: string[] = [];
  const configAt = new Map<string, string>();
  const deps: UpdateDeps = {
    spawn: (tool, args) => {
      const line = `${tool} ${args.join(" ")}`;
      commands.push(line);
      configAt.set(line, readFileSync(join(root, "deployment.jsonc"), "utf8"));
      // The commit fetched first is the target, then upstream's main.
      if (line.startsWith("git -C cloudflare-os rev-parse FETCH_HEAD")) return { status: 0, stdout: `${fetchHeads.length > 1 ? fetchHeads.shift() : fetchHeads[0]}\n` };
      const key = Object.keys(replies).filter((candidate) => line.startsWith(candidate)).toSorted((a, b) => b.length - a.length).at(0);
      const reply = key === undefined ? {} : replies[key];
      return { status: reply.status ?? 0, stdout: reply.stdout ?? "" };
    },
    now: () => new Date("2026-11-02T12:00:00Z"),
  };
  const move = (to: string, ctx: Parameters<typeof movePin>[1], options?: { dryRun?: boolean }) => movePin(to, ctx, options, deps);
  return { move, commands, configAt };
}

/** Whether a recorded command fetches or merges the starter, or changes the checkout: what a comparison must never run. */
const mergesStarter = (line: string) => /^git (fetch|merge|pull) /.test(line) || line.includes("cloudflare-os-starter");
const changesCheckout = (line: string) => /^git (merge |submodule|add|commit|stash|reset)|checkout --detach|^pnpm/.test(line);

test("with the real pin move: no --out runs nothing that changes the checkout, and --out moves the pin alone before the write", async (t) => {
  const overGit = async (out: string | undefined) => {
    const root = scratchProject(t, TEMPLATE);
    const git = recordedPinMove(root, HOSTED_COMMIT);
    const cf = fakeCf(hostedAccountLive());
    const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }), flags: { account: FAKE_ACCOUNT } });
    const code = await run({ command: "import", values: { out, release: HOSTED_RELEASE, commit: HOSTED_COMMIT }, positionals: ["acme"] },
      harness.ctx, async () => testCatalog(), git.move);
    return { code, root, ...git, ...harness };
  };

  const reported = await overGit(undefined);
  assert.equal(reported.code, 0);
  // What it fetched is upstream's history, into the submodule: the commit and main, to compare the pin with.
  assert.deepEqual(reported.commands.filter((line) => line.includes(" fetch ")).map((line) => line.replace(/--shallow-since=\S+/, "--shallow-since=<pin>")), [
    `git -C cloudflare-os fetch --no-tags --depth=1 https://github.com/cloudflare/cloudflare-os ${HOSTED_COMMIT}`,
    "git -C cloudflare-os fetch --no-tags --shallow-since=<pin> https://github.com/cloudflare/cloudflare-os main",
  ]);
  assert.deepEqual(reported.commands.filter(changesCheckout), []);
  assert.deepEqual(reported.commands.filter(mergesStarter), []);
  assert.deepEqual(resultOf(reported.json).release,
    { id: HOSTED_RELEASE, commit: HOSTED_COMMIT, source: "flag", pin: OLD_PIN, behind: true, moved: false });
  assert.equal(readFileSync(join(reported.root, "deployment.jsonc"), "utf8"), TEMPLATE);
  assert.equal(existsSync(join(reported.root, BRIEF)), false);

  const written = await overGit("deployment.jsonc");
  assert.equal(written.code, 0);
  // The pin alone: checked out and staged, uncommitted, with the brief written; the starter never fetched or merged.
  assert.deepEqual(written.commands.filter(changesCheckout), [
    "git submodule update --init --recursive -- cloudflare-os",
    `git -C cloudflare-os checkout --detach ${HOSTED_COMMIT}`,
    "git add cloudflare-os",
    "pnpm install",
  ]);
  assert.deepEqual(written.commands.filter(mergesStarter), []);
  assert.equal(existsSync(join(written.root, BRIEF)), true);
  // The config was still as it was when the pin was staged: the write comes after the move.
  assert.equal(written.configAt.get("git add cloudflare-os"), TEMPLATE);
  assert.equal(written.configAt.get("pnpm install"), TEMPLATE);
  assert.deepEqual(resultOf(written.json).release,
    { id: HOSTED_RELEASE, commit: HOSTED_COMMIT, source: "flag", pin: HOSTED_COMMIT, behind: false, moved: true });
  assert.equal(valueAtPath(parseDeployment(readFileSync(join(written.root, "deployment.jsonc"), "utf8")), ["workers", "workshop", "name"]), "acme-backend");
});
