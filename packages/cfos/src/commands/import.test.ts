import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cfClient } from "../cf-client.ts";
import { parseDeployment, valueAtPath } from "../deployment-file.ts";
import { FAKE_ACCOUNT, fakeCf, type FakeReply } from "../fake-cf.ts";
import { CANCEL, hostedAccount, scratchProject, scriptedPrompter, TEMPLATE, testContext } from "../test-support.ts";
import { run } from "./import.ts";

/** Runs `cfos import <positionals>` in `root` against `account`. */
async function importing(
  root: string,
  positionals: string[],
  { out, account = hostedAccount(), flags = {}, prompter = null }:
    { out?: string; account?: Record<string, FakeReply>; flags?: object; prompter?: ReturnType<typeof scriptedPrompter> | null } = {},
) {
  const cf = fakeCf(account);
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }), flags, prompter });
  const code = await run({ command: "import", values: { out }, positionals }, harness.ctx);
  return { code, ...harness, calls: cf.calls };
}

test("prints the fragment as JSON on stdout and the report on stderr, writing nothing", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const { code, json, stderr } = await importing(root, ["acme"], { flags: { account: FAKE_ACCOUNT } });
  assert.equal(code, 0);
  assert.equal(json.length, 1);
  // Parseable, and exactly what `--out` would write.
  const fragment = JSON.parse(JSON.stringify(json[0])) as Record<string, any>;
  assert.equal(fragment.accountId, FAKE_ACCOUNT);
  assert.equal(fragment.workers.workshop.name, "acme-backend");
  assert.match(stderr(), /found {4}Workshop Worker/);
  assert.match(stderr(), /pnpm cfos import acme --account [0-9a-f]{32} --out deployment\.jsonc/);
  assert.equal(readFileSync(join(root, "deployment.jsonc"), "utf8"), TEMPLATE);
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
  // Not discoverable, so untouched: still the placeholders a later check will name.
  assert.deepEqual(valueAtPath(file, ["access", "admins"]), ["<ADMIN_EMAIL>"]);
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

test("without an account, lists the ones cf can reach and stops", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const accounts = [{ id: FAKE_ACCOUNT, name: "Acme" }, { id: "f".repeat(32), name: "Acme Staging" }];
  const { code, stderr, json, calls } = await importing(root, ["acme"], { account: { "accounts list": accounts } });
  assert.equal(code, 1);
  assert.match(stderr(), new RegExp(`${FAKE_ACCOUNT}  Acme\\n`));
  assert.match(stderr(), /Then: pnpm cfos import acme --account <id>/);
  assert.deepEqual(json, []);
  // Account-less, so an ambient CLOUDFLARE_ACCOUNT_ID cannot narrow the list.
  assert.equal(calls[0].env.CLOUDFLARE_ACCOUNT_ID, undefined);
});

test("uses the only account cf can reach, and records it", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const account = { ...hostedAccount(), "accounts list": [{ id: FAKE_ACCOUNT, name: "Acme" }] };
  const { code } = await importing(root, ["acme"], { out: "deployment.jsonc", account });
  assert.equal(code, 0);
  assert.equal(valueAtPath(parseDeployment(readFileSync(join(root, "deployment.jsonc"), "utf8")), ["accountId"]), FAKE_ACCOUNT);
});

test("without an instance, lists the account's hosted instances", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const { code, stderr } = await importing(root, [], { flags: { account: FAKE_ACCOUNT } });
  assert.equal(code, 1);
  assert.match(stderr(), /\n {2}acme\n/);
  assert.match(stderr(), new RegExp(`Then: pnpm cfos import <instance> --account ${FAKE_ACCOUNT}`));
});

test("asks for the account and then the instance at a terminal", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const accounts = [{ id: "f".repeat(32), name: "Acme Staging" }, { id: FAKE_ACCOUNT, name: "Acme" }];
  const prompter = scriptedPrompter([
    ["Which account is the hosted instance in?", FAKE_ACCOUNT],
    ["Which hosted instance?", "acme"],
  ]);
  const { code, stderr } = await importing(root, [], { account: { ...hostedAccount(), "accounts list": accounts }, prompter });
  assert.equal(code, 0);
  assert.deepEqual(prompter.asked.map((asked) => asked.choices), [["f".repeat(32), FAKE_ACCOUNT], ["acme"]]);
  // The choices carry into the command it suggests, so they need not be made twice.
  assert.match(stderr(), new RegExp(`pnpm cfos import acme --account ${FAKE_ACCOUNT} --out deployment\\.jsonc`));
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
