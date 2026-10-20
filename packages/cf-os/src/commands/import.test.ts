import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cfClient } from "../cf-client.ts";
import { parseDeployment, valueAtPath } from "../deployment-file.ts";
import { FAKE_ACCOUNT, fakeCf, type FakeReply } from "../fake-cf.ts";
import type { GatekeeperCatalog } from "../core/gatekeepers.ts";
import { CANCEL, hostedAccount, scratchProject, scriptedPrompter, TEMPLATE, testCatalog, testContext } from "../test-support.ts";
import { INVENTORY_LABEL } from "../cached-reads.ts";
import { run } from "./import.ts";

/**
 * Runs `cf-os import <positionals>` in `root` against `account`, with {@link testCatalog} by default,
 * each `cf` call settling after `delay`.
 */
async function importing(
  root: string,
  positionals: string[],
  { out, account = hostedAccount(), flags = {}, prompter = null, catalog = testCatalog(), delay }:
    {
      out?: string; account?: Record<string, FakeReply>; flags?: object;
      prompter?: ReturnType<typeof scriptedPrompter> | null; catalog?: GatekeeperCatalog;
      delay?: (args: string[]) => number;
    } = {},
) {
  // Each `cf` call stamped with how many questions had been answered when it started.
  const cf = fakeCf(account, { delay, stamp: () => prompter?.answered.length });
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }), flags, prompter });
  const code = await run({ command: "import", values: { out }, positionals }, harness.ctx, async () => catalog);
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
  assert.match(stderr(), /pnpm cf-os import acme --account [0-9a-f]{32} --out deployment\.jsonc/);
  assert.equal(readFileSync(join(root, "deployment.jsonc"), "utf8"), TEMPLATE);
});

test("includes the optional Gatekeepers the starter can deploy over, and lists the rest with why", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const hosted = hostedAccount();
  const account = {
    ...hosted,
    "workers list": [...hosted["workers list"] as object[], { name: "acme-gk-github2" }, { name: "acme-gk-weather" }],
  };
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

test("without an account, lists the ones cf can reach and stops", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const accounts = [{ id: FAKE_ACCOUNT, name: "Acme" }, { id: "f".repeat(32), name: "Acme Staging" }];
  const { code, stderr, json, calls } = await importing(root, ["acme"], { account: { "accounts list": accounts } });
  assert.equal(code, 1);
  assert.match(stderr(), new RegExp(`${FAKE_ACCOUNT}  Acme\\n`));
  assert.match(stderr(), /Then: pnpm cf-os import acme --account <id>/);
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

test("refuses an instance the account does not have, though its Access issuer is there", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  for (const out of [undefined, "init.jsonc"]) {
    const { code, json, stderr } = await importing(root, ["acmee"], { out, flags: { account: FAKE_ACCOUNT } });
    assert.equal(code, 1);
    assert.deepEqual(json, []);
    assert.match(stderr(), /No hosted instance "acmee" here/);
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
  const { code, stderr } = await importing(root, [], { account: { ...hostedAccount(), "accounts list": accounts }, prompter });
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

/** The command words of a `cf` call, before its first flag. */
function command(args: string[]): string {
  const end = args.findIndex((arg) => arg.startsWith("-"));
  return args.slice(0, end < 0 ? undefined : end).join(" ");
}

/** A `delay` settling the `cf` calls in the reverse of the order they started: the first waits longest. */
function reversing(): (args: string[]) => number {
  let started = 0;
  return () => 60 - 10 * started++;
}

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
  const account = { ...hostedAccount(), "kv namespaces list": { fail: "[10013] internal error" } };
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
  assert.deepEqual(calls.map(({ args, at }) => [command(args), at]), [
    ["workers list", 0],
    ["zero-trust organization get", 0],
    ["kv namespaces list", 0],
    ["r2 buckets list", 0],
    ["ai-gateway gateways list", 0],
    ["zero-trust access applications list", 0],
  ]);
  // The Workers' list shown once, while it was in flight; settled, it shows nothing. The rest share
  // one spinner.
  assert.deepEqual(prompter.waited, ["Listing the account's Workers", INVENTORY_LABEL]);
});

test("at a terminal, reads nothing ahead when the account has no hosted instance", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const account = { ...hostedAccount(), "workers list": [{ name: "unrelated" }] };
  const prompter = scriptedPrompter([]);
  const { code, calls, stderr } = await importing(root, [], { flags: { account: FAKE_ACCOUNT }, account, prompter });
  assert.equal(code, 1);
  assert.match(stderr(), /No hosted instances in account/);
  assert.deepEqual(calls.map(({ args }) => command(args)), ["workers list"]);
});

test("at a terminal, clears the spinner when a read fails, though later ones are still in flight", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const account = { ...hostedAccount(), "zero-trust organization get": { fail: "[10000] Authentication error" } };
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
  const account = { ...hostedAccount(), "accounts list": [{ id: FAKE_ACCOUNT, name: "Acme" }] };
  const listed = await importing(root, [], { account });
  assert.equal(listed.code, 1);
  assert.deepEqual(listed.calls.map(({ args }) => command(args)), ["accounts list", "workers list"]);

  // Given, the instance is not asked for, and each step is shown while its reads are in flight.
  const prompter = scriptedPrompter([]);
  const given = await importing(root, ["acme"], { account, prompter });
  assert.equal(given.code, 0);
  assert.deepEqual(given.calls.map(({ args }) => command(args)), [
    "accounts list",
    "zero-trust organization get",
    "workers list",
    "kv namespaces list",
    "r2 buckets list",
    "ai-gateway gateways list",
    "zero-trust access applications list",
  ]);
  assert.deepEqual(prompter.waited, ["Listing your accounts", INVENTORY_LABEL]);
});
