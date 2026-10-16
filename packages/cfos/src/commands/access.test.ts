import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cfClient } from "../cf-client.ts";
import { applicationBody } from "../core/access.ts";
import { parseDeployment, valueAtPath } from "../deployment-file.ts";
import { FAKE_ACCOUNT, fakeCf, flag, type FakeReply } from "../fake-cf.ts";
import { scratchProject, testContext } from "../test-support.ts";
import { run } from "./access.ts";

/** A deployment file ready for `cfos access`: everything but issuer and audience filled in. */
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

async function access(root: string, account: Record<string, FakeReply>, dryRun = false) {
  const cf = fakeCf(account);
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }) });
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
    "zero-trust access applications list": (args) => flag(args, "--domain") === "os.example.com"
      ? [{ name: "Existing", aud: "aud-existing", domain: "os.example.com" }] : [],
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
