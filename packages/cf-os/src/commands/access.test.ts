import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cfClient } from "../cf-client.ts";
import { applicationBody } from "../core/access.ts";
import { parseDeployment, valueAtPath } from "../deployment-file.ts";
import { FAKE_ACCOUNT, fakeCf, flag, type FakeReply } from "../fake-cf.ts";
import { scratchProject, scriptedPrompter, testContext } from "../test-support.ts";
import { run } from "./access.ts";

/** A deployment file ready for `cf-os access`: everything but issuer and audience filled in. */
const READY = `{
  // Comment that must survive.
  "accountId": "${FAKE_ACCOUNT}",
  "publicBaseUrl": null,
  "workers": { "router": { "name": "acme-os", "route": { "customDomain": "os.example.com" } } },
  "access": {
    "issuer": "https://<TEAM_NAME>.cloudflareaccess.com",
    "audience": "<ACCESS_AUDIENCE>",
    "admins": ["admin@example.com"]
  }
}
`;

const organization = { auth_domain: "acme.cloudflareaccess.com" };

async function access(
  root: string,
  account: Record<string, FakeReply>,
  dryRun = false,
  prompter: ReturnType<typeof scriptedPrompter> | null = null,
) {
  const cf = fakeCf(account);
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }), prompter });
  const code = await run({ command: "access", values: { "dry-run": dryRun }, positionals: [] }, harness.ctx);
  return { code, ...harness, calls: cf.calls };
}

test("--dry-run prints the request as JSON on stdout and writes nothing", async (t) => {
  const root = scratchProject(t, READY);
  const { code, json, stderr, calls } = await access(root, {
    "zero-trust organization get": organization,
    "zero-trust access applications list": [],
    "zero-trust access applications create": (args) => {
      assert.ok(args.includes("--dry-run"), "created for real during a dry run");
      return { method: "POST", body: JSON.parse(flag(args, "--body")!) };
    },
  }, true);
  assert.equal(code, 0);
  assert.deepEqual(json, [{
    method: "POST",
    body: applicationBody({ accountId: FAKE_ACCOUNT, routerName: "acme-os", host: "os.example.com", admins: ["admin@example.com"] }),
  }]);
  assert.match(stderr(), /Dry run: nothing created, nothing written/);
  assert.equal(readFileSync(join(root, "deployment.jsonc"), "utf8"), READY);
  assert.equal(calls.filter((call) => call.args.includes("create")).length, 1);
});

test("names a covering wildcard, and how to use it, before and after creating one ahead of it", async (t) => {
  const corp = { name: "Corp", aud: "aud-corp", domain: "*.example.com" };
  const dry = await access(scratchProject(t, READY), {
    "zero-trust organization get": organization,
    "zero-trust access applications list": [corp],
    "zero-trust access applications create": (args) => ({ method: "POST", body: JSON.parse(flag(args, "--body")!) }),
  }, true);
  assert.match(dry.stderr(), /"Corp" covers os\.example\.com with a wildcard[\s\S]*create nothing and set access\.audience to its AUD, aud-corp/);
  const created = await access(scratchProject(t, READY), {
    "zero-trust organization get": organization,
    "zero-trust access applications list": [corp],
    "zero-trust access applications create": { name: "Cloudflare OS acme-os", aud: "aud-new" },
  });
  // Set to the wildcard's AUD with the new one still there, it would fail the next check.
  assert.match(created.stderr(), /delete "Cloudflare OS acme-os" in the Zero Trust dashboard, then set access\.audience/);
});

test("writes issuer and audience back, comments intact, and prints them", async (t) => {
  const root = scratchProject(t, READY);
  const { code, json } = await access(root, {
    "zero-trust organization get": organization,
    "zero-trust access applications list": [],
    "zero-trust access applications create": { name: "Cloudflare OS acme-os", aud: "aud-new" },
  });
  assert.equal(code, 0);
  assert.deepEqual(json, [{ issuer: "https://acme.cloudflareaccess.com", audience: "aud-new" }]);
  const text = readFileSync(join(root, "deployment.jsonc"), "utf8");
  assert.ok(text.includes("// Comment that must survive."));
  assert.equal(valueAtPath(parseDeployment(text), ["access", "audience"]), "aud-new");
});

test("reuses the application already covering the hostname", async (t) => {
  const root = scratchProject(t, READY);
  const existing: Record<string, FakeReply> = {
    "zero-trust organization get": organization,
    "zero-trust access applications list": [
      { name: "Admin only", aud: "aud-admin", domain: "os.example.com/admin" },
      { name: "Existing", aud: "aud-existing", domain: "os.example.com" },
    ],
  };
  // A dry run reports it, and still writes nothing.
  const dry = await access(root, existing, true);
  assert.equal(dry.code, 0);
  assert.deepEqual(dry.json, [{ issuer: "https://acme.cloudflareaccess.com", audience: "aud-existing" }]);
  assert.equal(readFileSync(join(root, "deployment.jsonc"), "utf8"), READY);

  const { code, calls, stderr } = await access(root, existing);
  assert.equal(code, 0);
  assert.match(stderr(), /Reusing Access application "Existing"/);
  assert.ok(!calls.some((call) => call.args.includes("create")), "created a duplicate");
  assert.equal(valueAtPath(parseDeployment(readFileSync(join(root, "deployment.jsonc"), "utf8")), ["access", "audience"]),
    "aud-existing");
});

test("at a terminal, shows one spinner over the lookup, and prints the same", async (t) => {
  const account: Record<string, FakeReply> = {
    "zero-trust organization get": organization,
    "zero-trust access applications list": [],
    "zero-trust access applications create": (args) => args.includes("--dry-run")
      ? { method: "POST", body: JSON.parse(flag(args, "--body")!) }
      : { name: "Cloudflare OS acme-os", aud: "aud-new" },
  };
  for (const [dryRun, label] of [[true, "Looking up Access in the account"], [false, "Finding or creating the Access application"]] as const) {
    const plain = await access(scratchProject(t, READY), account, dryRun);
    const prompter = scriptedPrompter([]);
    const shown = await access(scratchProject(t, READY), account, dryRun, prompter);
    assert.deepEqual(prompter.waited, [label]);
    assert.deepEqual([shown.code, shown.json, shown.stderr()], [plain.code, plain.json, plain.stderr()]);
    assert.deepEqual(shown.calls.map(({ args }) => args), plain.calls.map(({ args }) => args));
  }
});

test("lists the applications while the organization is read, and still stops at a missing team domain", async (t) => {
  const account: Record<string, FakeReply> = {
    "zero-trust organization get": organization,
    "zero-trust access applications list": [{ name: "Existing", aud: "aud-existing", domain: "os.example.com" }],
  };
  const cf = fakeCf(account, {
    delay: (args) => args.join(" ").startsWith("zero-trust organization get") ? 60 : 0,
    stamp: () => performance.now(),
  });
  const harness = testContext({ root: scratchProject(t, READY), client: cfClient({ spawn: cf.spawn }) });
  assert.equal(await run({ command: "access", values: {}, positionals: [] }, harness.ctx), 0);
  // Each read once, the organization first, and the applications without waiting for it.
  assert.deepEqual(cf.calls.map(({ args }) => args.slice(0, 3).join(" ")),
    ["zero-trust organization get", "zero-trust access applications"]);
  const [organizationAt, applicationsAt] = cf.calls.map(({ at }) => at as number);
  assert.ok(applicationsAt - organizationAt < 30, "listed the applications once the organization was in");

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  await assert.rejects(access(scratchProject(t, READY), { ...account, "zero-trust organization get": {} }),
    /has no team domain/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(unhandled, []);
});
