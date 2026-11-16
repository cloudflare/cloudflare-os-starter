import assert from "node:assert/strict";
import test from "node:test";
import { cfClient } from "../cf-client.ts";
import { FAKE_ACCOUNT, fakeCf } from "../fake-cf.ts";
import {
  hostedAccount as fakeHostedAccount,
  hostedMemoryAccount,
  hostedWorkerLive,
  reversing,
  type HostedWorkerOptions,
} from "../test-support.ts";
import { CfAuthError } from "./client.ts";
import { discover, fetchInventory, instanceNameProblem, nameEvidence, type Discovery, type Inventory } from "./discovery.ts";
import { editsAsFragment, PUSH_IDENTITY_PATH } from "./edits.ts";
import { readInstance } from "./hosted-release.ts";
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

/**
 * {@link discover} for instance "acme" of `account` with what its Workers run read off the account,
 * under the router and backend names `names` gives.
 */
async function discoverRead(
  account: MemoryAccount,
  { names = {}, offered = ["github"] }: { names?: { router?: string; backend?: string }; offered?: string[] } = {},
): Promise<Discovery> {
  const client = memoryClient(account);
  const instance = await readInstance(client, ACCOUNT, { router: names.router ?? "acme", backend: names.backend ?? "acme-backend" });
  return discover("acme", await fetchInventory(client, ACCOUNT), offered, [], { names, instance });
}

/** {@link hostedMemoryAccount} with more Workers in the account, each running what `overrides` gives it. */
function hostedWith(names: string[], overrides: Record<string, HostedWorkerOptions | null> = {}): MemoryAccount {
  const account = hostedMemoryAccount(overrides);
  return { ...account, workers: [...account.workers ?? [], ...names.map((name) => ({ name }))] };
}

test("with the instance read, writes what its backend carries: admins, providers, the origin and the push identity", async () => {
  const discovery = await discoverRead(hostedMemoryAccount());
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
    aiGateway: { name: "acme-ai", enabled: true, accountId: null, providers: ["cloudflare", "anthropic"] },
    access: { audience: "aud-acme", issuer: "https://acme-team.cloudflareaccess.com", admins: ["admin@example.com"] },
    publicBaseUrl: "https://acme.acme-sub.workers.dev",
    pushIdentity: {
      serviceUrl: "https://push.example.com", installId: "install-acme", keyId: "key-1", webPushPublicKey: "BFixtureWebPushPublicKey",
    },
    gatekeepers: { github: { name: "acme-gk-github" } },
  });
  // The push identity is one edit of the whole block, at the path a deploy reads it from.
  assert.deepEqual(discovery.edits.filter((edit) => edit.path[0] === "pushIdentity").map((edit) => edit.path), [[...PUSH_IDENTITY_PATH]]);
  // The signing key is named as the secret that stays put, and the install description is not carried over.
  assert.match(discovery.notes.join("\n"), /signing key is the secret CFOS_INSTALL_PRIVATE_KEY on acme-backend\. It is not read and not written/);
  assert.match(discovery.notes.join("\n"), /CLOUDFLARE_OS_DEPLOYMENT variable[\s\S]*is not carried over/);
  assert.ok(!discovery.edits.some((edit) => JSON.stringify(edit).includes("CLOUDFLARE_OS_DEPLOYMENT") || JSON.stringify(edit).includes("PRIVATE_KEY")));
  assert.deepEqual(discovery.rows.filter((row) => row.found === null).map((row) => [row.path, row.expected]),
    [["workers.websearch.name", "the backend's GATEKEEPER_WEBSEARCH service binding"]]);
});

test("with the instance read, the origin is the backend's PUBLIC_BASE_URL, whatever else names a hostname", async () => {
  const custom = await discoverRead(hostedMemoryAccount({ "acme-backend": { vars: { PUBLIC_BASE_URL: "https://os.acme.example/" } } }));
  const fragment = editsAsFragment(custom.edits) as { workers: { router: { route: unknown } }; publicBaseUrl: unknown };
  assert.deepEqual(fragment.workers.router.route, { customDomain: "os.acme.example" });
  assert.equal(fragment.publicBaseUrl, null);
  assert.deepEqual(custom.rows.filter((row) => row.label === "Public origin").map(({ found, note }) => [found, note]),
    [["https://os.acme.example", "from the backend's PUBLIC_BASE_URL"]]);
  assert.match(custom.notes.join("\n"), /PUBLIC_BASE_URL is https:\/\/os\.acme\.example, but the Access application protects acme\.acme-sub\.workers\.dev/);
  // One no route expresses is said and not used: the hostname the Access application protects stands.
  const plain = await discoverRead(hostedMemoryAccount({ "acme-backend": { vars: { PUBLIC_BASE_URL: "http://os.acme.example:8080" } } }));
  assert.equal(editsAsFragment(plain.edits).publicBaseUrl, "https://acme.acme-sub.workers.dev");
  assert.match(plain.notes.join("\n"), /PUBLIC_BASE_URL is http:\/\/os\.acme\.example:8080, which no route in deployment\.jsonc expresses/);
  // Without the variable, the origin is read as it is without the instance.
  const absent = await discoverRead(hostedMemoryAccount({ "acme-backend": { vars: { PUBLIC_BASE_URL: undefined } } }));
  assert.deepEqual(absent.rows.filter((row) => row.label === "Public origin").map(({ found, note }) => [found, note]),
    [["https://acme.acme-sub.workers.dev", "from the Access application"]]);
});

test("with the instance read, values the backend does not carry are missing, never made up", async () => {
  const discovery = await discoverRead(hostedMemoryAccount({
    "acme-backend": {
      vars: { CF_AI_GATEWAY_PROVIDERS: "", CFOS_INSTALL_KEY_ID: undefined },
      json: { ADMINS: [] },
      secrets: [],
    },
  }));
  const paths = discovery.edits.map((edit) => edit.path.join("."));
  for (const path of ["access.admins", "aiGateway.providers", "pushIdentity"]) assert.ok(!paths.includes(path), path);
  assert.deepEqual(discovery.rows.filter((row) => row.found === null).map((row) => row.path),
    ["workers.websearch.name", "access.admins", "aiGateway.providers", "pushIdentity"]);
  // A provider the starter does not serve is written as read, and said, so nothing is dropped unseen.
  const odd = await discoverRead(hostedMemoryAccount({ "acme-backend": { vars: { CF_AI_GATEWAY_PROVIDERS: "cloudflare, mistral" } } }));
  assert.deepEqual((editsAsFragment(odd.edits).aiGateway as { providers: string[] }).providers, ["cloudflare", "mistral"]);
  assert.match(odd.notes.join("\n"), /The backend advertises mistral, which the starter does not serve/);
  // An identity with no key bound is carried over, and the missing key said.
  const keyless = await discoverRead(hostedMemoryAccount({ "acme-backend": { secrets: [] } }));
  assert.ok(keyless.edits.some((edit) => edit.path.join(".") === "pushIdentity"));
  assert.match(keyless.notes.join("\n"), /carries a push identity but no CFOS_INSTALL_PRIVATE_KEY secret to sign with/);
});

test("with the instance read, Gatekeepers are the Workers its backend binds, whatever they are called", async () => {
  const account = hostedWith(["hub", "ctx", "acme-gk-google", "acme-gk-google2", "acme-gk-weather", "acme-gk-custom"], {
    "acme-backend": {
      services: {
        // GitHub and Context under names of their own; the default-named Workers are not bound.
        GATEKEEPER_GITHUB: "hub",
        GATEKEEPER_CONTEXT: "ctx",
        GATEKEEPER_GOOGLE: "acme-gk-google",
        GATEKEEPER_GOOGLE2: "acme-gk-google2",
        GATEKEEPER_WEATHER: "acme-gk-weather",
        GATEKEEPER_CUSTOM: "acme-gk-custom",
        GATEKEEPER_GONE: "acme-gk-gone",
        "GATEKEEPER_my-own": "unrelated",
      },
    },
    hub: { operation: "gk-github" },
    ctx: {},
    "acme-gk-google": {},
    "acme-gk-google2": {},
    "acme-gk-weather": {},
    "acme-gk-custom": {},
    unrelated: {},
  });
  const discovery = await discoverRead(account, { offered: ["github", "google"] });
  assert.deepEqual(discovery.foundGatekeepers, [{ slug: "github", name: "hub" }, { slug: "google", name: "acme-gk-google" }]);
  assert.deepEqual(editsAsFragment(discovery.edits).gatekeepers, { github: { name: "hub" }, google: { name: "acme-gk-google" } });
  assert.deepEqual(discovery.rows.filter((row) => row.path === "workers.context.name").map((row) => row.found), ["ctx"]);
  assert.deepEqual(discovery.orphanedGatekeepers.map(({ name, kind }) => [name, kind]),
    [["acme-gk-google2", "repeat"], ["acme-gk-weather", "unknown"]]);
  const notes = discovery.notes.join("\n");
  // The Workers named the hosted way that the backend does not bind are no part of the instance.
  assert.match(notes, /Named like this instance's Gatekeepers, but not bound by its backend, so no part of it, and left alone: acme-gk-github\./);
  assert.match(notes, /The backend binds GATEKEEPER_GONE to Worker acme-gk-gone, which the account does not have/);
  assert.match(notes, /service binding GATEKEEPER_my-own, to Worker unrelated, names no Gatekeeper the hosted flow installs/);
  assert.ok(!discovery.edits.some((edit) => JSON.stringify(edit.value).includes("unrelated") || JSON.stringify(edit.value).includes("acme-gk-gone")));
  // A built-in the backend does not bind is missing, though a Worker carries the name it would have.
  const unboundContext = await discoverRead(hostedWith([], { "acme-backend": { services: { GATEKEEPER_CONTEXT: undefined } } }));
  assert.deepEqual(unboundContext.rows.filter((row) => row.path === "workers.context.name").map(({ found, note }) => [found, note]),
    [[null, "Worker acme-gk-context is in the account, but the backend does not bind it, so it is not this instance's; naming it here deploys over it"]]);
  assert.ok(!unboundContext.edits.some((edit) => edit.path.join(".") === "workers.context.name"));
});

test("with the instance read, a gateway the backend names otherwise is said, and the one named after the instance written", async () => {
  const same = await discoverRead(hostedMemoryAccount({ "acme-backend": { vars: { CF_AI_GATEWAY: "acme-ai" } } }));
  assert.doesNotMatch(same.notes.join("\n"), /CF_AI_GATEWAY/);
  const other = await discoverRead(hostedMemoryAccount({ "acme-backend": { vars: { CF_AI_GATEWAY: "default" } } }));
  assert.equal((editsAsFragment(other.edits).aiGateway as { name: string }).name, "acme-ai");
  assert.match(other.notes.join("\n"), /The backend's CF_AI_GATEWAY is default, not acme-ai, the gateway the hosted flow names after the instance, which is the one written\. Check aiGateway\.name before deploying\./);
});

test("with the instance read, an audience the backend checks that is not the named application's is said", async () => {
  const same = await discoverRead(hostedMemoryAccount({ "acme-backend": { vars: { CF_ACCESS_AUD: "aud-acme" } } }));
  assert.doesNotMatch(same.notes.join("\n"), /CF_ACCESS_AUD/);
  // The application named after the instance is not the one the backend checks sign-ins against: renamed by hand, say.
  const other = await discoverRead(hostedMemoryAccount({ "acme-backend": { vars: { CF_ACCESS_AUD: "aud-live" } } }));
  assert.equal((editsAsFragment(other.edits).access as { audience: string }).audience, "aud-acme");
  assert.match(other.notes.join("\n"), /The backend's CF_ACCESS_AUD is aud-live, not aud-acme, the AUD of the Access application "Cloudflare OS acme [0-9a-f]{8}", which is the one written\. The instance checks sign-ins against the first, so a deploy with the second may turn its users away: check access\.audience /);
  // A backend that carries no audience says nothing either way.
  const unsaid = await discoverRead(hostedMemoryAccount({ "acme-backend": { vars: { CF_ACCESS_AUD: undefined } } }));
  assert.doesNotMatch(unsaid.notes.join("\n"), /CF_ACCESS_AUD/);
});

test("with a router and a backend named by the operator, matches those two and reads the router's own address", async () => {
  const base = hostedMemoryAccount();
  const live = {
    "moss-os": hostedWorkerLive("moss-os", { services: { WORKSHOP_BACKEND: "moss-api" } }),
    "moss-api": hostedWorkerLive("moss-api", { services: { GATEKEEPER_CONTEXT: "acme-gk-context" } }),
  };
  const account: MemoryAccount = {
    ...base,
    workers: [...base.workers ?? [], { name: "moss-os", subdomain: { enabled: true, url: "https://moss-os.acme-sub.workers.dev" } }, { name: "moss-api" }],
    accessApps: [],
    deployments: { ...base.deployments, "moss-os": live["moss-os"].deployments, "moss-api": live["moss-api"].deployments },
    versions: { ...base.versions, "moss-os": live["moss-os"].versions, "moss-api": live["moss-api"].versions },
  };
  const names = { router: "moss-os", backend: "moss-api" };
  const discovery = await discoverRead(account, { names });
  assert.equal(discovery.matched, true);
  const fragment = editsAsFragment(discovery.edits) as { workers: Record<string, { name: string }>; publicBaseUrl: unknown };
  assert.equal(fragment.workers.router.name, "moss-os");
  assert.equal(fragment.workers.workshop.name, "moss-api");
  // No PUBLIC_BASE_URL and no Access application: the workers.dev address is the named router's.
  assert.equal(fragment.publicBaseUrl, "https://moss-os.acme-sub.workers.dev");
  // Names alone, with nothing read of the instance, match the same two Workers.
  const byName = discover("acme", await fetchInventory(memoryClient(account), ACCOUNT), [], [], { names });
  assert.equal(byName.matched, true);
  assert.deepEqual(byName.rows.slice(0, 2).map((row) => row.found), ["moss-os", "moss-api"]);
  // A router that happens to be named like one of the instance's Gatekeepers is still its router.
  const named = { ...account, workers: [...account.workers ?? [], { name: "acme-gk-context2" }] };
  const odd = discover("acme", await fetchInventory(memoryClient(named), ACCOUNT), [], [],
    { names: { router: "acme-gk-context2", backend: "moss-api" }, instance: await readInstance(memoryClient(account), ACCOUNT, names) });
  assert.deepEqual(odd.rows.slice(0, 2).map((row) => row.found), ["acme-gk-context2", "moss-api"]);
  // And a name the account lacks is no match.
  assert.equal(discover("acme", await fetchInventory(memoryClient(account), ACCOUNT), [], [], { names: { router: "moss-os", backend: "nope" } }).matched, false);
});

/** A version as the hosted flow tags one for another installation (`5e6f7a8b`) than the hosted fixtures'. */
const OTHER_INSTALLATION: HostedWorkerOptions = {
  annotations: {
    "workers/tag": "gd:4945:5e6f7a8b",
    "workers/message": "Cloudflare OS core from release r004945-6c8d301",
    "workers/triggered_by": "upload",
  },
};

/**
 * An account holding the instance "acme" under the hosted flow's names and, beside it, an instance
 * "moss" deployed under Worker names of its own: router `moss-os`, backend `moss-api`, of another
 * installation (`5e6f7a8b`). `backend` overrides what moss's backend carries.
 */
function twoInstances(backend: HostedWorkerOptions = {}): MemoryAccount {
  const base = hostedMemoryAccount();
  const live = {
    "moss-os": hostedWorkerLive("moss-os", { ...OTHER_INSTALLATION, services: { WORKSHOP_BACKEND: "moss-api" } }),
    "moss-api": hostedWorkerLive("moss-api", {
      ...OTHER_INSTALLATION,
      ...backend,
      vars: { CF_ACCESS_AUD: "aud-moss", CF_AI_GATEWAY: "moss-ai", ...backend.vars },
      services: { GATEKEEPER_CONTEXT: "moss-gk-context", GATEKEEPER_SCHEDULER: "moss-gk-scheduler", ...backend.services },
    }),
    "moss-gk-context": hostedWorkerLive("moss-gk-context", OTHER_INSTALLATION),
    "moss-gk-scheduler": hostedWorkerLive("moss-gk-scheduler", OTHER_INSTALLATION),
  };
  return {
    ...base,
    workers: [...base.workers ?? [], ...Object.keys(live).map((name) => ({ name }))],
    kvNamespaces: [...base.kvNamespaces ?? [], { id: "kv-moss-blueprints", title: "moss-blueprints" }],
    gateways: [...base.gateways ?? [], { id: "moss-ai" }],
    accessApps: [...base.accessApps ?? [], { name: "Cloudflare OS moss 5e6f7a8b", aud: "aud-moss", domain: "os.moss.example" }],
    deployments: { ...base.deployments, ...Object.fromEntries(Object.entries(live).map(([name, { deployments }]) => [name, deployments])) },
    versions: { ...base.versions, ...Object.fromEntries(Object.entries(live).map(([name, { versions }]) => [name, versions])) },
  };
}

const MOSS = { router: "moss-os", backend: "moss-api" };

/** {@link instanceNameProblem} for instance `n` of `account`, read under the router and backend names `names`. */
async function nameProblem(n: string, account: MemoryAccount, names: { router?: string; backend?: string } = MOSS): Promise<string | null> {
  const client = memoryClient(account);
  const core = { router: names.router ?? n, backend: names.backend ?? `${n}-backend` };
  return instanceNameProblem(n, await fetchInventory(client, ACCOUNT), names, await readInstance(client, ACCOUNT, core));
}

test("Workers named by the operator must carry the instance's name: another instance's name is refused", async () => {
  // The right name passes on every source at once.
  assert.equal(await nameProblem("moss", twoInstances()), null);
  // Another instance of the account, whose storage and Access application the name would match.
  const other = await nameProblem("acme", twoInstances());
  assert.match(other!, /^"acme" is not the name of the instance moss-os and moss-api belong to, by what they carry:\n/);
  assert.match(other!, /\n {2}the backend's CF_ACCESS_AUD is the audience of the Access application "Cloudflare OS moss 5e6f7a8b", which names instance moss\n/);
  // The command to run instead names both Workers, whichever of the two flags this one was given.
  assert.match(other!, /An instance's storage, AI Gateway and Access application are found by its name[\s\S]*If the instance is moss, run this for moss, with --router moss-os --backend moss-api\.$/);
  // A name typed wrong, and the router's own name given as the instance's, are refused the same way.
  for (const typed of ["mos", "moss-os"]) assert.match((await nameProblem(typed, twoInstances()))!, /which names instance moss\n/, typed);
  // Only one of the two named by the operator: the question still arises.
  const routerOnly = (await nameProblem("moss-os", twoInstances(), { backend: "moss-api" }))!;
  assert.match(routerOnly, /^"moss-os" is not the name of the instance moss-os and moss-api belong to/);
  assert.match(routerOnly, /If the instance is moss, run this for moss, with --router moss-os --backend moss-api\.$/);
});

/** The instance names each source of {@link nameEvidence} gives for `account`'s Workers `moss-os` and `moss-api`. */
async function evidence(account: MemoryAccount): Promise<string[][]> {
  const client = memoryClient(account);
  return nameEvidence(await fetchInventory(client, ACCOUNT), await readInstance(client, ACCOUNT, MOSS))
    .map((source) => source.map(({ name }) => name));
}

test("the instance's name is held against what its backend carries: its Access application, then its Gatekeepers, then its gateway", async () => {
  // The audience's application, each bound Gatekeeper, then the gateway.
  assert.deepEqual(await evidence(twoInstances()), [["moss"], ["moss", "moss"], ["moss"]]);
  // The application names the instance, so a gateway shared with another instance does not unsettle it.
  const shared = twoInstances({ vars: { CF_AI_GATEWAY: "acme-ai" } });
  assert.deepEqual(await evidence(shared), [["moss"], ["moss", "moss"], ["acme"]]);
  assert.equal(await nameProblem("moss", shared), null);
  assert.match((await nameProblem("acme", shared))!, /which names instance moss\n/);

  // Without the audience, or with an application not named the hosted way, the Gatekeeper Workers the backend binds.
  const renamed = { ...twoInstances(), accessApps: [{ name: "Moss", aud: "aud-moss", domain: "os.moss.example" }] };
  for (const account of [twoInstances({ vars: { CF_ACCESS_AUD: undefined } }), renamed]) {
    assert.deepEqual(await evidence(account), [[], ["moss", "moss"], ["moss"]]);
    assert.match((await nameProblem("acme", account))!,
      /^"acme" is not[^\n]*\n {2}the backend's GATEKEEPER_CONTEXT service binding points at Worker moss-gk-context, which names instance moss\n/);
    assert.equal(await nameProblem("moss", account), null);
  }
  // An application named for another instance that ends in the Workers' fingerprint is no evidence: only the audience picks one.
  const sameFingerprint = twoInstances({ vars: { CF_ACCESS_AUD: undefined }, services: { GATEKEEPER_CONTEXT: "ctx", GATEKEEPER_SCHEDULER: "sched" } });
  const twin = { ...sameFingerprint, accessApps: [...sameFingerprint.accessApps ?? [], { name: "Cloudflare OS acme 5e6f7a8b", aud: "aud-twin" }] };
  assert.deepEqual(await evidence(twin), [[], [], ["moss"]]);
  assert.match((await nameProblem("acme", twin))!, /the backend's CF_AI_GATEWAY is moss-ai, which names instance moss\n/);

  // Failing the application and the Gatekeepers, the gateway the backend names.
  const bare = { vars: { CF_ACCESS_AUD: undefined }, services: { GATEKEEPER_CONTEXT: "ctx", GATEKEEPER_SCHEDULER: "sched" } };
  assert.deepEqual(await evidence(twoInstances(bare)), [[], [], ["moss"]]);
  assert.match((await nameProblem("acme", twoInstances(bare)))!, /the backend's CF_AI_GATEWAY is moss-ai, which names instance moss\n/);
  assert.equal(await nameProblem("moss", twoInstances(bare)), null);

  // The gateway alone, pointed at another instance's, beside that instance's own router and backend:
  // the name would pass on a gateway a hand can point anywhere, and pair these Workers with acme's storage.
  const borrowed = twoInstances({ ...bare, vars: { CF_ACCESS_AUD: undefined, CF_AI_GATEWAY: "acme-ai" } });
  assert.deepEqual(await evidence(borrowed), [[], [], ["acme"]]);
  assert.equal(await nameProblem("acme", borrowed), [
    'Whether "acme" is the name of the instance moss-os and moss-api belong to cannot be told from what they carry:',
    "  the backend's CF_AI_GATEWAY is acme-ai, which names instance acme",
    "  the account has Workers acme and acme-backend, named as the hosted flow names instance acme's own router and backend",
    "A gateway is shared, or pointed at another instance's, by hand, so alone it does not show that moss-os and moss-api are " +
      "instance acme's and acme and acme-backend are not. An Access application named `Cloudflare OS <instance> <fp8>` that the " +
      "backend's CF_ACCESS_AUD is the audience of would settle it; there is none.",
    "An instance's storage, AI Gateway and Access application are found by its name, so under another name these Workers " +
      "would be paired with another deployment's, or with none, and a deploy would bind them to it. If acme and acme-backend " +
      "are the instance, run this for acme without --router and --backend.",
  ].join("\n"));
  assert.match((await nameProblem("moss", borrowed))!, /the backend's CF_AI_GATEWAY is acme-ai, which names instance acme\n/);
  // With only one of acme's two Workers in the account there is no such instance beside these, and the gateway is all there is.
  for (const absent of ["acme", "acme-backend"]) {
    const without = { ...borrowed, workers: (borrowed.workers ?? []).filter((worker) => worker.name !== absent) };
    assert.equal(await nameProblem("acme", without), null, absent);
  }
  // A Gatekeeper Worker or an Access application that names the instance decides before the gateway is asked.
  const bound = twoInstances({ vars: { CF_ACCESS_AUD: undefined, CF_AI_GATEWAY: "acme-ai" }, services: { GATEKEEPER_CONTEXT: "acme-gk-context", GATEKEEPER_SCHEDULER: "sched" } });
  assert.equal(await nameProblem("acme", bound), null);

  // And with nothing that names any instance, there is nothing to hold the name against: refused.
  const nothing = twoInstances({ ...bare, vars: { CF_ACCESS_AUD: undefined, CF_AI_GATEWAY: "default" } });
  assert.deepEqual(await evidence(nothing), [[], [], []]);
  for (const name of ["moss", "acme"]) {
    assert.match((await nameProblem(name, nothing))!, new RegExp(`^Nothing moss-os and moss-api carry says they are instance "${name}"'s: `), name);
  }
  // The audience is never printed: the application it names is.
  for (const account of [twoInstances(), shared, nothing]) assert.doesNotMatch(String(await nameProblem("acme", account)), /aud-moss/);
});

test("a Gatekeeper Worker named after something else does not unsettle the instance its Access application names", async () => {
  // The hosted flow lets a Gatekeeper's Worker be named by the operator: one under another stem beside the default ones.
  const stray = twoInstances({ services: { GATEKEEPER_GITHUB: "zed-gk-github" } });
  assert.deepEqual(await evidence(stray), [["moss"], ["moss", "zed", "moss"], ["moss"]]);
  assert.equal(await nameProblem("moss", stray), null);
  // The application decides alone: neither the Gatekeeper's stem nor another instance's name passes.
  for (const name of ["zed", "acme"]) {
    const problem = (await nameProblem(name, stray))!;
    assert.match(problem, /^"[a-z]+" is not the name of[^\n]*\n {2}the backend's CF_ACCESS_AUD is the audience of the Access application "Cloudflare OS moss 5e6f7a8b", which names instance moss\n/, name);
    assert.doesNotMatch(problem, /GATEKEEPER_/, name);
    assert.doesNotMatch(problem, /aud-moss/, name);
  }

  // With no application to decide, Gatekeepers that name two instances settle nothing: the name is refused, whichever it is.
  const unsettled = twoInstances({ vars: { CF_ACCESS_AUD: undefined }, services: { GATEKEEPER_GITHUB: "acme-gk-github" } });
  assert.deepEqual(await evidence(unsettled), [[], ["moss", "acme", "moss"], ["moss"]]);
  for (const name of ["moss", "acme"]) {
    const problem = (await nameProblem(name, unsettled))!;
    assert.match(problem, new RegExp(`^Whether "${name}" is the name of the instance moss-os and moss-api belong to cannot be told from what they carry:\\n`), name);
    assert.match(problem, /\n {2}the backend's GATEKEEPER_GITHUB service binding points at Worker acme-gk-github, which names instance acme\n/, name);
    assert.match(problem, /\nAn Access application named `Cloudflare OS <instance> <fp8>` that the backend's CF_ACCESS_AUD is the audience of would settle it; there is none\.\n/, name);
    assert.match(problem, /What they carry names more than one instance, so there is no saying which it is: check --router and --backend\.$/, name);
  }
});

/**
 * An account holding one instance, "moss", whose operator named its router `moss-os` and its backend
 * `moss-os-backend`: the two read as the hosted flow's own pair for an instance "moss-os", which the
 * account does not have. Its Access application, gateway, storage and Gatekeepers are named after
 * "moss". `backend` overrides what the backend carries.
 */
function pairedUnderAnotherStem(backend: HostedWorkerOptions = {}): MemoryAccount {
  const live = {
    "moss-os": hostedWorkerLive("moss-os", { services: { WORKSHOP_BACKEND: "moss-os-backend" } }),
    "moss-os-backend": hostedWorkerLive("moss-os-backend", {
      ...backend,
      vars: { CF_ACCESS_AUD: "aud-moss", CF_AI_GATEWAY: "moss-ai", ...backend.vars },
      services: { GATEKEEPER_CONTEXT: "moss-gk-context", GATEKEEPER_SCHEDULER: "moss-gk-scheduler", ...backend.services },
    }),
    "moss-gk-context": hostedWorkerLive("moss-gk-context"),
    "moss-gk-scheduler": hostedWorkerLive("moss-gk-scheduler"),
  };
  return {
    organization: { auth_domain: "moss-team.cloudflareaccess.com" },
    workers: Object.keys(live).map((name) => ({ name })),
    kvNamespaces: [{ id: "kv-moss-blueprints", title: "moss-blueprints" }],
    buckets: ["moss-blueprint-content"],
    gateways: [{ id: "moss-ai" }],
    accessApps: [{ name: "Cloudflare OS moss 1a2b3c4d", aud: "aud-moss", domain: "os.moss.example" }],
    deployments: Object.fromEntries(Object.entries(live).map(([name, { deployments }]) => [name, deployments])),
    versions: Object.fromEntries(Object.entries(live).map(([name, { versions }]) => [name, versions])),
  };
}

const PAIRED = { router: "moss-os", backend: "moss-os-backend" };

test("a router and a backend that read as another instance's default pair are not taken for that instance", async () => {
  // Found by name alone the two are an instance "moss-os"; what the backend carries says "moss".
  for (const names of [{}, PAIRED, { backend: "moss-os-backend" }]) {
    const problem = (await nameProblem("moss-os", pairedUnderAnotherStem(), names))!;
    assert.match(problem, /^"moss-os" is not the name of the instance moss-os and moss-os-backend belong to, by what they carry:\n/);
    assert.match(problem, /\n {2}the backend's CF_ACCESS_AUD is the audience of the Access application "Cloudflare OS moss 1a2b3c4d", which names instance moss\n/);
    // The command that takes it over names both Workers, as neither is "moss"'s by default.
    assert.match(problem, /If the instance is moss, run this for moss, with --router moss-os --backend moss-os-backend\.$/);
  }
  assert.equal(await nameProblem("moss", pairedUnderAnotherStem(), PAIRED), null);

  // With no application to decide, the two Workers' names say one instance and its Gatekeepers another:
  // there is no telling an instance "moss-os" whose Gatekeepers were renamed from an instance "moss"
  // whose router and backend were, so neither name is taken.
  const unsettled = pairedUnderAnotherStem({ vars: { CF_ACCESS_AUD: undefined } });
  for (const [name, names] of [["moss-os", {}], ["moss", PAIRED]] as const) {
    const problem = (await nameProblem(name, unsettled, names))!;
    assert.match(problem, new RegExp(`^Whether "${name}" is the name of the instance moss-os and moss-os-backend belong to cannot be told`), name);
    assert.match(problem, /\n {2}Workers moss-os and moss-os-backend are named as the hosted flow names an instance's router and backend, which names instance moss-os\n/, name);
    assert.match(problem, /\n {2}the backend's GATEKEEPER_CONTEXT service binding points at Worker moss-gk-context, which names instance moss\n/, name);
    assert.match(problem, /would settle it; there is none\.\n/, name);
  }
  // The same of the gateway, where no Gatekeeper Worker names an instance either.
  const gatewayOnly = pairedUnderAnotherStem({
    vars: { CF_ACCESS_AUD: undefined }, services: { GATEKEEPER_CONTEXT: "ctx", GATEKEEPER_SCHEDULER: "sched" },
  });
  for (const [name, names] of [["moss-os", {}], ["moss", PAIRED]] as const) {
    assert.match((await nameProblem(name, gatewayOnly, names))!,
      /\n {2}Workers moss-os and moss-os-backend are named[^\n]*which names instance moss-os\n {2}the backend's CF_AI_GATEWAY is moss-ai, which names instance moss\n/, name);
  }
  // Under names that read as an instance's own, no other name passes on nothing but the operator's word.
  const silent = pairedUnderAnotherStem({
    vars: { CF_ACCESS_AUD: undefined, CF_AI_GATEWAY: "default" }, services: { GATEKEEPER_CONTEXT: "ctx", GATEKEEPER_SCHEDULER: "sched" },
  });
  assert.match((await nameProblem("moss", silent, PAIRED))!,
    /^"moss" is not the name of[^\n]*\n {2}Workers moss-os and moss-os-backend are named[^\n]*which names instance moss-os\n[^\n]*If the instance is moss-os, run this for moss-os, with --router moss-os --backend moss-os-backend\.$/);
  assert.equal(await nameProblem("moss-os", silent, {}), null);
});

test("an instance under the hosted flow's own names is held against what its Workers carry, and is itself where they carry nothing", async () => {
  // Its Gatekeepers name it, so a gateway and an audience a hand has changed since unsettle nothing.
  const edited = hostedMemoryAccount({ "acme-backend": { vars: { CF_AI_GATEWAY: "moss-ai", CF_ACCESS_AUD: "aud-elsewhere" } } });
  assert.equal(await nameProblem("acme", edited, {}), null);
  assert.equal(await nameProblem("acme", edited, { router: "acme", backend: "acme-backend" }), null);

  // Nothing its backend carries names any instance: the router and the backend carry the name themselves.
  const renamedGatekeepers = { GATEKEEPER_CONTEXT: "ctx", GATEKEEPER_SCHEDULER: "sched", GATEKEEPER_GITHUB: "hub" };
  const silent = hostedWith(["ctx", "sched", "hub"], {
    "acme-backend": { services: renamedGatekeepers }, ctx: {}, sched: {}, hub: { operation: "gk-github" },
  });
  const client = memoryClient(silent);
  assert.deepEqual(
    nameEvidence(await fetchInventory(client, ACCOUNT), await readInstance(client, ACCOUNT, { router: "acme", backend: "acme-backend" })),
    [[], [], []]);
  assert.equal(await nameProblem("acme", silent, {}), null);
  // But not under another name, however the two are passed.
  assert.match((await nameProblem("moss", silent, { router: "acme", backend: "acme-backend" }))!,
    /^"moss" is not the name of the instance acme and acme-backend belong to[\s\S]*If the instance is acme, run this for acme, with --router acme --backend acme-backend\.$/);

  // Its application names another instance: refused, as for Workers named by the operator.
  const elsewhere = hostedMemoryAccount({ "acme-backend": { vars: { CF_ACCESS_AUD: "aud-zed" } } });
  const misnamed = { ...elsewhere, accessApps: [{ name: "Cloudflare OS zed 1a2b3c4d", aud: "aud-zed" }] };
  assert.match((await nameProblem("acme", misnamed, {}))!,
    /^"acme" is not the name of the instance acme and acme-backend belong to[\s\S]*If the instance is zed, run this for zed, with --router acme --backend acme-backend\.$/);

  // A gateway alone that names another instance, with nothing else to say which it is, settles nothing.
  const gatewayOnly = hostedWith(["ctx", "sched", "hub"], {
    "acme-backend": { services: renamedGatekeepers, vars: { CF_AI_GATEWAY: "moss-ai" } }, ctx: {}, sched: {}, hub: { operation: "gk-github" },
  });
  assert.match((await nameProblem("acme", gatewayOnly, {}))!,
    /^Whether "acme" is the name of the instance acme and acme-backend belong to cannot be told[\s\S]*What they carry names more than one instance, so there is no saying which it is\.$/);
  // One of no instance's form is no evidence, and the instance is itself.
  const plainGateway = hostedWith(["ctx", "sched", "hub"], {
    "acme-backend": { services: renamedGatekeepers, vars: { CF_AI_GATEWAY: "default" } }, ctx: {}, sched: {}, hub: { operation: "gk-github" },
  });
  assert.equal(await nameProblem("acme", plainGateway, {}), null);
});
