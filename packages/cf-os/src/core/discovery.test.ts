import assert from "node:assert/strict";
import test from "node:test";
import { cfClient } from "../cf-client.ts";
import { FAKE_ACCOUNT, fakeCf } from "../fake-cf.ts";
import { hostedAccount as fakeHostedAccount, reversing } from "../test-support.ts";
import { CfAuthError } from "./client.ts";
import { discover, fetchInventory, type Inventory } from "./discovery.ts";
import { editsAsFragment } from "./edits.ts";
import { memoryClient, type MemoryAccount } from "./memory-client.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

/** A hosted instance "acme" deployed before Web Search shipped, with one wizard-installed extra. */
export function hostedAccount(): MemoryAccount & Required<Pick<MemoryAccount, "workers" | "accessApps">> {
  return {
    organization: { auth_domain: "acme-team.cloudflareaccess.com" },
    workers: [
      { name: "acme", subdomain: { enabled: true, url: "https://acme.acme-sub.workers.dev" } },
      { name: "acme-backend" },
      { name: "acme-gk-context" },
      { name: "acme-gk-scheduler" },
      { name: "acme-gk-github" },
      { name: "acme-staging-gk-context" },
      { name: "unrelated" },
    ],
    kvNamespaces: [
      { id: "kv-blueprints", title: "acme-blueprints" },
      { id: "kv-avatars", title: "acme-avatars" },
      { id: "kv-context", title: "acme-context-collections" },
      { id: "kv-other", title: "acme-staging-blueprints" },
    ],
    buckets: ["acme-blueprint-content"],
    gateways: [{ id: "default" }, { id: "acme-ai" }],
    accessApps: [
      { name: "Cloudflare OS acme 1a2b3c4d", aud: "aud-acme", domain: "acme.acme-sub.workers.dev" },
      { name: "Cloudflare OS acme-staging 9f8e7d6c", aud: "aud-staging", domain: "acme-staging.acme-sub.workers.dev" },
    ],
  };
}

function inventory(account: MemoryAccount = hostedAccount()): Promise<Inventory> {
  return fetchInventory(memoryClient(account), ACCOUNT);
}

test("fills in exactly what it found", async () => {
  const discovery = discover("acme", await inventory());
  assert.deepEqual(editsAsFragment(discovery.edits), {
    workers: {
      router: { name: "acme", route: { workersDev: true } },
      workshop: { name: "acme-backend" },
      context: { name: "acme-gk-context" },
      scheduler: { name: "acme-gk-scheduler" },
    },
    resources: {
      blueprintsKvNamespaceId: "kv-blueprints",
      avatarsKvNamespaceId: "kv-avatars",
      blueprintContentBucket: "acme-blueprint-content",
    },
    context: { kvNamespaceId: "kv-context" },
    aiGateway: { name: "acme-ai", enabled: true, accountId: null },
    access: { audience: "aud-acme", issuer: "https://acme-team.cloudflareaccess.com" },
    publicBaseUrl: "https://acme.acme-sub.workers.dev",
  });
});

test("reports what it did not find instead of guessing, and the Gatekeepers that lose a binding", async () => {
  const discovery = discover("acme", await inventory());
  const missing = discovery.rows.filter((row) => row.found === null);
  assert.deepEqual(missing.map((row) => row.path), ["workers.websearch.name"]);
  assert.match(missing[0].note!, /deployed before Web Search/);
  assert.deepEqual(discovery.orphanedGatekeepers.map((gatekeeper) => gatekeeper.name), ["acme-gk-github"]);
  assert.ok(!discovery.edits.some((edit) => edit.path.join(".") === "workers.websearch.name"));
  // Suggestions are not hosted resources: never looked for, never reported missing.
  assert.ok(!discovery.rows.some((row) => /customGatekeeper|errorReporter/.test(row.path)));
});

test("does not count a starter-deployed custom Gatekeeper as orphaned", async () => {
  const account = hostedAccount();
  account.workers.push({ name: "acme-gk-custom" });
  assert.deepEqual(discover("acme", await inventory(account)).orphanedGatekeepers.map((gatekeeper) => gatekeeper.name),
    ["acme-gk-github"]);
});

test("classifies the other Gatekeepers as deployable, repeat installs, or unknown", async () => {
  const account = hostedAccount();
  account.workers.push({ name: "acme-gk-google2" }, { name: "acme-gk-google" }, { name: "acme-gk-email" },
    { name: "acme-gk-weather" }, { name: "acme-gk-context2" });
  const discovery = discover("acme", await inventory(account), ["github", "google", "slack"],
    [{ package: "gatekeeper-email", slug: "email", reason: "upstream marks it not installable" }]);
  assert.deepEqual(discovery.foundGatekeepers, [
    { slug: "github", name: "acme-gk-github" },
    { slug: "google", name: "acme-gk-google" },
  ]);
  assert.deepEqual(discovery.orphanedGatekeepers.map(({ name, kind }) => [name, kind]), [
    ["acme-gk-context2", "repeat"],
    ["acme-gk-email", "unknown"],
    ["acme-gk-google2", "repeat"],
    ["acme-gk-weather", "unknown"],
  ]);
  const reasons = Object.fromEntries(discovery.orphanedGatekeepers.map(({ name, reason }) => [name, reason]));
  assert.match(reasons["acme-gk-google2"], /second install of google; .*one Worker per Gatekeeper package/);
  assert.match(reasons["acme-gk-email"], /cannot deploy it: upstream marks it not installable/);
  assert.match(reasons["acme-gk-weather"], /no Gatekeeper in the submodule has the slug weather/);
  // The deployable ones are written, and shown as found; the rest are not.
  assert.deepEqual(editsAsFragment(discovery.edits).gatekeepers, {
    github: { name: "acme-gk-github" },
    google: { name: "acme-gk-google" },
  });
  assert.deepEqual(discovery.rows.filter((row) => row.path.startsWith("gatekeepers.")).map((row) => [row.path, row.found]),
    [["gatekeepers.github.name", "acme-gk-github"], ["gatekeepers.google.name", "acme-gk-google"]]);
  // Their vars are not read, and a deploy replaces them: the operator is told to carry them over.
  assert.match(discovery.notes.join("\n"), /replaces their plain vars with the package's own and BASE_URL\. Copy any var a Worker relies on .* into gatekeepers\.<slug>\.vars before deploying/);
});

test("says nothing about Gatekeeper vars when it finds no optional Gatekeeper", async () => {
  const discovery = discover("acme", await inventory(), []);
  assert.deepEqual(discovery.foundGatekeepers, []);
  assert.doesNotMatch(discovery.notes.join("\n"), /plain vars/);
});

test("takes a custom domain from the Access application", async () => {
  const account = hostedAccount();
  account.accessApps[0].domain = "os.example.com";
  const fragment = editsAsFragment(discover("acme", await inventory(account)).edits) as
    { workers: { router: { route: unknown } }; publicBaseUrl: unknown };
  assert.deepEqual(fragment.workers.router.route, { customDomain: "os.example.com" });
  assert.equal(fragment.publicBaseUrl, null);
});

test("falls back to the router's workers.dev address without an Access application", async () => {
  const discovery = discover("acme", await inventory({ ...hostedAccount(), accessApps: [] }));
  assert.equal(editsAsFragment(discovery.edits).publicBaseUrl, "https://acme.acme-sub.workers.dev");
  assert.ok(discovery.rows.some((row) => row.path === "access.audience" && row.found === null));
});

test("does not pick between two applications named for the instance", async () => {
  const account = hostedAccount();
  account.accessApps.push({ name: "Cloudflare OS acme deadbeef", aud: "aud-second", domain: "acme.acme-sub.workers.dev" });
  const discovery = discover("acme", await inventory(account));
  assert.ok(!discovery.edits.some((edit) => edit.path.join(".") === "access.audience"));
  assert.match(discovery.notes.join("\n"), /2 Access applications/);
});

test("survives an account with no Zero Trust organization, but not missing credentials", async () => {
  const discovery = discover("acme", await inventory({ ...hostedAccount(), organization: null }));
  assert.ok(discovery.rows.some((row) => row.path === "access.issuer" && row.found === null));
  await assert.rejects(inventory({ signedOut: true }), CfAuthError);
});

/** The command words of a `cf` call, before its first flag. */
function command(args: string[]): string {
  const end = args.findIndex((arg) => arg.startsWith("-"));
  return args.slice(0, end < 0 ? undefined : end).join(" ");
}

test("reads everything at once, and gives the same inventory whichever read finishes first", async () => {
  const inOrder = fakeCf(fakeHostedAccount());
  const expected = await fetchInventory(cfClient({ spawn: inOrder.spawn }), FAKE_ACCOUNT);
  const reversed = fakeCf(fakeHostedAccount(), { delay: reversing() });
  const reading = fetchInventory(cfClient({ spawn: reversed.spawn }), FAKE_ACCOUNT);
  // All six started before any settled.
  assert.deepEqual(reversed.calls.map(({ args }) => command(args)), [
    "zero-trust organization get",
    "workers list",
    "kv namespaces list",
    "r2 buckets list",
    "ai-gateway gateways list",
    "zero-trust access applications list",
  ]);
  assert.deepEqual(await reading, expected);
  assert.equal(expected.workers.length, 6);
  assert.deepEqual(expected.buckets, ["acme-blueprint-content"]);
});

test("throws the first failure in order, not the first to happen", async () => {
  // The organization is signed out but answers last; the KV list fails first.
  const cf = fakeCf({
    ...fakeHostedAccount(),
    "zero-trust organization get": { fail: "[10000] Authentication error" },
    "kv namespaces list": { fail: "[10013] internal error" },
  }, { delay: reversing() });
  await assert.rejects(fetchInventory(cfClient({ spawn: cf.spawn }), FAKE_ACCOUNT), CfAuthError);
  // The organization merely missing is null, and the KV failure is then the one thrown.
  const missing = fakeCf({
    ...fakeHostedAccount(),
    "zero-trust organization get": { fail: "[12000] organization not found" },
    "kv namespaces list": { fail: "[10013] internal error" },
  }, { delay: reversing() });
  await assert.rejects(fetchInventory(cfClient({ spawn: missing.spawn }), FAKE_ACCOUNT), /cf kv namespaces list .*\[10013\] internal error/);
});

test("leaves no read that fails after the one thrown unhandled", async (t) => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  t.after(() => process.off("unhandledRejection", listener));
  // The organization fails first, while every later read is still in flight and fails after it.
  const failing = Object.fromEntries(Object.keys(fakeHostedAccount()).map((key) => [key, { fail: "[10013] internal error" }]));
  const cf = fakeCf({ ...failing, "zero-trust organization get": { fail: "[10000] Authentication error" } },
    { delay: (args) => command(args) === "zero-trust organization get" ? 0 : 20 });
  await assert.rejects(fetchInventory(cfClient({ spawn: cf.spawn }), FAKE_ACCOUNT), CfAuthError);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(cf.calls.length, 6);
  assert.deepEqual(unhandled, []);
});
