import assert from "node:assert/strict";
import test from "node:test";
import { cfClient } from "../cf-client.ts";
import { fakeCf, workerSecretsReply, type FakeReply } from "../fake-cf.ts";
import { reversing, testCatalog, testCatalogWithGitlab } from "../test-support.ts";
import { CfAuthError, CfUnavailableError, type CloudflareClient } from "./client.ts";
import type { DeploymentConfig } from "./deployment-config.ts";
import type { GatekeeperCatalog } from "./gatekeepers.ts";
import { memoryClient, type MemoryAccount } from "./memory-client.ts";
import { gatekeeperSecretWarnings, startBounded, verifyAccount } from "./verify-account.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

const config = {
  accountId: ACCOUNT,
  publicBaseUrl: null,
  workers: { router: { name: "acme-os", route: { customDomain: "os.example.com" } } },
  access: { issuer: "https://acme.cloudflareaccess.com", audience: "aud-1", admins: ["a@example.com"] },
  aiGateway: { enabled: true, name: "acme-ai", accountId: null, providers: ["cloudflare"] },
  context: { sharingDomain: null, kvNamespaceId: "kv-context" },
  resources: { blueprintsKvNamespaceId: "kv-blueprints", avatarsKvNamespaceId: null, blueprintContentBucket: "acme-content" },
} as unknown as DeploymentConfig;

const origin = "https://os.example.com";

/** An account that matches {@link config} in every respect; tests break one thing at a time. */
function matchingAccount(): MemoryAccount {
  return {
    organization: { auth_domain: "acme.cloudflareaccess.com" },
    accessApps: [{ name: "Cloudflare OS acme-os", aud: "aud-1", domain: "os.example.com" }],
    kvNamespaces: [{ id: "kv-context", title: "c" }, { id: "kv-blueprints", title: "b" }],
    buckets: ["acme-content"],
    gateways: [{ id: "acme-ai" }],
  };
}

async function problems(account: MemoryAccount, deployment = config, at = origin): Promise<string[]> {
  const result = await verifyAccount(memoryClient(account), deployment, at);
  assert.ok("problems" in result, `skipped: ${"skipped" in result ? result.skipped : ""}`);
  return result.problems;
}

test("passes an account that has everything the config names", async () => {
  assert.deepEqual(await problems(matchingAccount()), []);
});

test("rejects an audience no application in the account has, and names cf-os access", async () => {
  const found = await problems({ ...matchingAccount(), accessApps: [] });
  assert.equal(found.length, 1);
  assert.match(found[0], /no Access application .* has AUD tag aud-1/);
  assert.match(found[0], /pnpm cf-os access/);
});

test("rejects an application that does not cover the router's hostname", async () => {
  const found = await problems({
    ...matchingAccount(),
    accessApps: [{ name: "Elsewhere", aud: "aud-1", domain: "other.example.com" }],
  });
  assert.equal(found.length, 1);
  assert.match(found[0], /"Elsewhere" does not gate every path of os\.example\.com.*names other\.example\.com/);
});

test("rejects an application that gates only a path, or does not gate at all", async () => {
  for (const app of [
    { name: "Admin only", aud: "aud-1", domain: "os.example.com/admin" },
    { name: "Bookmark", aud: "aud-1", type: "bookmark", domain: "os.example.com" },
  ]) {
    const found = await problems({ ...matchingAccount(), accessApps: [app] });
    assert.equal(found.length, 1, app.name);
    assert.match(found[0], new RegExp(`"${app.name}" does not gate every path of os\\.example\\.com`));
  }
  // The whole origin, spelled with a path.
  assert.deepEqual(await problems({
    ...matchingAccount(),
    accessApps: [{ name: "Everything", aud: "aud-1", domain: "os.example.com/*" }],
  }), []);
});

test("rejects a wildcard audience when a more specific application is the one Access applies", async () => {
  const found = await problems({
    ...matchingAccount(),
    accessApps: [
      { name: "Wildcard", aud: "aud-1", domain: "*.example.com" },
      { name: "Specific", aud: "aud-2", domain: "os.example.com" },
    ],
  });
  assert.equal(found.length, 1);
  assert.match(found[0], /"Specific" \(AUD aud-2\) names os\.example\.com more specifically than "Wildcard"/);
  assert.deepEqual(await problems({
    ...matchingAccount(),
    accessApps: [{ name: "Wildcard", aud: "aud-1", domain: "*.example.com" }],
  }), []);
});

test("rejects a wildcard application one level short of the router's hostname", async () => {
  const found = await problems({
    ...matchingAccount(),
    accessApps: [{ name: "Wildcard", aud: "aud-1", domain: "*.example.com" }],
  }, { ...config, workers: { ...config.workers, router: { name: "acme-os", route: { customDomain: "os.team.example.com" } } } } as DeploymentConfig,
  "https://os.team.example.com");
  assert.equal(found.length, 1);
  assert.match(found[0], /"Wildcard" does not gate every path of os\.team\.example\.com/);
});

test("rejects an issuer from another team", async () => {
  const found = await problems({ ...matchingAccount(), organization: { auth_domain: "other.cloudflareaccess.com" } });
  assert.equal(found.length, 1);
  assert.match(found[0], /team domain is https:\/\/other\.cloudflareaccess\.com/);
});

test("rejects storage IDs and names the account does not have", async () => {
  const found = await problems({
    ...matchingAccount(),
    kvNamespaces: [{ id: "kv-context", title: "c" }],
    buckets: [],
    gateways: [{ id: "default" }],
  });
  assert.deepEqual(found.map((problem) => problem.split(":")[0]), [
    "resources.blueprintsKvNamespaceId",
    "resources.blueprintContentBucket",
    "aiGateway.name",
  ]);
});

test("asks nothing about storage left to automatic provisioning, or the default gateway", async () => {
  const client = memoryClient(matchingAccount());
  const provisioned = {
    ...config,
    aiGateway: { ...config.aiGateway, name: "default" },
    context: { sharingDomain: null, kvNamespaceId: null },
    resources: { blueprintsKvNamespaceId: null, avatarsKvNamespaceId: null, blueprintContentBucket: null },
  } as DeploymentConfig;
  assert.deepEqual(await verifyAccount(client, provisioned, origin), { problems: [] });
  assert.deepEqual(client.calls, ["getOrganization", "listAccessApps"]);
});

test("skips, rather than fails, when signed out or the client cannot run", async () => {
  const signedOut = await verifyAccount(memoryClient({ signedOut: true }), config, origin);
  assert.ok("skipped" in signedOut);
  const unavailable = {
    ...memoryClient(matchingAccount()),
    getOrganization: () => Promise.reject(new CfUnavailableError("could not run cf: ENOENT")),
  } satisfies CloudflareClient;
  assert.ok("skipped" in await verifyAccount(unavailable, config, origin));
});

test("keeps the Access problems it found when the storage reads are not permitted", async () => {
  const account = { ...matchingAccount(), accessApps: [] };
  const client = {
    ...memoryClient(account),
    listKvNamespaces: () => Promise.reject(new CfAuthError("[10000] Authentication error")),
  } satisfies CloudflareClient;
  const result = await verifyAccount(client, config, origin);
  assert.ok("problems" in result);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /no Access application/);
  // Within each check too: the issuer before the applications, the KV IDs before the buckets.
  const issuer = {
    ...memoryClient({ ...matchingAccount(), organization: { auth_domain: "other.cloudflareaccess.com" } }),
    listAccessApps: () => Promise.reject(new CfAuthError("[10000] Authentication error")),
  } satisfies CloudflareClient;
  const kept = await verifyAccount(issuer, config, origin);
  assert.ok("problems" in kept && /team domain is/.test(kept.problems[0]));
  const kv = {
    ...memoryClient({ ...matchingAccount(), kvNamespaces: [] }),
    listR2Buckets: () => Promise.reject(new CfAuthError("[10000] Authentication error")),
  } satisfies CloudflareClient;
  const kvKept = await verifyAccount(kv, config, origin);
  assert.ok("problems" in kvKept && /context\.kvNamespaceId/.test(kvKept.problems[0]));
  // Nothing found before it: skipped, as for a token that reads nothing.
  const clean = { ...memoryClient(matchingAccount()), listKvNamespaces: client.listKvNamespaces } satisfies CloudflareClient;
  assert.ok("skipped" in await verifyAccount(clean, config, origin));
});

test("fails loudly on an API error that is not about credentials", async () => {
  await assert.rejects(
    problems({ ...matchingAccount(), failing: { listKvNamespaces: "[10013] internal error" } }),
    /10013/);
});

/** {@link config} with GitHub, which takes OAuth secrets, and Home Assistant, which takes none. */
const withGatekeepers = {
  ...config,
  gatekeepers: { github: { name: "acme-gk-github" }, homeassistant: { name: "acme-gk-homeassistant" } },
} as DeploymentConfig;

const catalog = testCatalog();

test("warns in one line about a Gatekeeper secret that is not set, naming `cf-os secrets`", async () => {
  const client = memoryClient({
    workers: [{ name: "acme-gk-github" }, { name: "acme-gk-homeassistant" }],
    secrets: { "acme-gk-github": ["CLIENT_ID"] },
  });
  assert.deepEqual(await gatekeeperSecretWarnings(client, withGatekeepers, catalog), [
    "Warning: acme-gk-github has no CLIENT_SECRET; nobody can connect the github Gatekeeper until " +
    "`pnpm cf-os secrets github` sets it.",
  ]);
  // Home Assistant takes no secrets, so it is never looked up.
  assert.deepEqual(client.calls, ["listWorkerSecrets"]);

  const none = memoryClient({ workers: [{ name: "acme-gk-github" }] });
  assert.deepEqual(await gatekeeperSecretWarnings(none, withGatekeepers, catalog), [
    "Warning: acme-gk-github has no CLIENT_ID or CLIENT_SECRET; nobody can connect the github Gatekeeper until " +
    "`pnpm cf-os secrets github` sets them.",
  ]);
});

test("tells a Gatekeeper not deployed yet that `cf-os secrets` sets every secret after the deploy", async () => {
  assert.deepEqual(await gatekeeperSecretWarnings(memoryClient({}), withGatekeepers, catalog), [
    "Warning: acme-gk-github is not deployed yet; after the deploy, `pnpm cf-os secrets github` sets its " +
    "CLIENT_ID and CLIENT_SECRET.",
  ]);
});

test("names `cf-os secrets` with the --config flag it is given, so it reads the same deployment file", async () => {
  const client = memoryClient({ workers: [{ name: "acme-gk-github" }], secrets: { "acme-gk-github": ["CLIENT_ID"] } });
  assert.deepEqual(await gatekeeperSecretWarnings(client, withGatekeepers, catalog, " --config staging.jsonc"), [
    "Warning: acme-gk-github has no CLIENT_SECRET; nobody can connect the github Gatekeeper until " +
    "`pnpm cf-os secrets github --config staging.jsonc` sets it.",
  ]);
  assert.deepEqual(await gatekeeperSecretWarnings(memoryClient({}), withGatekeepers, catalog, " --config staging.jsonc"), [
    "Warning: acme-gk-github is not deployed yet; after the deploy, `pnpm cf-os secrets github --config staging.jsonc` " +
    "sets its CLIENT_ID and CLIENT_SECRET.",
  ]);
});

test("says nothing when every secret is set, or no Gatekeeper takes any", async () => {
  const complete = memoryClient({ secrets: { "acme-gk-github": ["CLIENT_ID", "CLIENT_SECRET", "UNRELATED"] } });
  assert.deepEqual(await gatekeeperSecretWarnings(complete, withGatekeepers, catalog), []);
  assert.deepEqual(complete.calls, ["listWorkerSecrets"]);

  const homeAssistant = memoryClient({});
  const onlyHomeAssistant = { ...config, gatekeepers: { homeassistant: { name: "acme-gk-homeassistant" } } } as DeploymentConfig;
  assert.deepEqual(await gatekeeperSecretWarnings(homeAssistant, onlyHomeAssistant, catalog), []);
  assert.deepEqual(homeAssistant.calls, []);
  // No optional Gatekeepers at all.
  assert.deepEqual(await gatekeeperSecretWarnings(homeAssistant, config, catalog), []);
});

test("skips the secret warnings quietly when signed out or the client cannot run", async () => {
  assert.deepEqual(await gatekeeperSecretWarnings(memoryClient({ signedOut: true }), withGatekeepers, catalog), []);
  const unavailable = {
    ...memoryClient({}),
    listWorkerSecrets: () => Promise.reject(new CfUnavailableError("could not run cf: ENOENT")),
  } satisfies CloudflareClient;
  assert.deepEqual(await gatekeeperSecretWarnings(unavailable, withGatekeepers, catalog), []);
});

test("turns any other failure to read a Gatekeeper's secrets into a warning, not an error", async () => {
  const client = memoryClient({ failing: { listWorkerSecrets: "[10013] internal error" } });
  assert.deepEqual(await gatekeeperSecretWarnings(client, withGatekeepers, catalog), [
    "Warning: could not read acme-gk-github's secrets to check for CLIENT_ID and CLIENT_SECRET: [10013] internal error",
  ]);
});

/** {@link matchingAccount} as `cf` prints it, with `changes` on top. */
function fakeAccount(changes: Record<string, FakeReply> = {}): Record<string, FakeReply> {
  return {
    "zero-trust organization get": { auth_domain: "acme.cloudflareaccess.com" },
    "zero-trust access applications list": [{ name: "Cloudflare OS acme-os", aud: "aud-1", domain: "os.example.com" }],
    "kv namespaces list": [{ id: "kv-context", title: "c" }, { id: "kv-blueprints", title: "b" }],
    "r2 buckets list": { buckets: [{ name: "acme-content" }] },
    "ai-gateway gateways list": [{ id: "acme-ai" }],
    ...changes,
  };
}

/** {@link verifyAccount} against `replies`, the calls settling as `delay` says. */
function verifyFake(replies: Record<string, FakeReply>, delay?: (args: string[]) => number) {
  const cf = fakeCf(replies, { delay });
  return { result: verifyAccount(cfClient({ spawn: cf.spawn }), config, origin), calls: cf.calls };
}

test("reads at once, and judges the same whichever read finishes first", async () => {
  const cases: Record<string, FakeReply>[] = [
    // Wrong in every respect.
    fakeAccount({
      "zero-trust organization get": { auth_domain: "other.cloudflareaccess.com" },
      "zero-trust access applications list": [],
      "kv namespaces list": [],
      "r2 buckets list": { buckets: [] },
      "ai-gateway gateways list": [],
    }),
    // No organization, and a token that reads no buckets.
    fakeAccount({
      "zero-trust organization get": { fail: "[12000] organization not found" },
      "r2 buckets list": { fail: "[10000] Authentication error" },
      "ai-gateway gateways list": [],
    }),
    // Signed out.
    fakeAccount({
      "zero-trust organization get": { fail: "No authentication token found." },
      "zero-trust access applications list": { fail: "No authentication token found." },
      "kv namespaces list": { fail: "No authentication token found." },
    }),
  ];
  for (const replies of cases) {
    const reversed = verifyFake(replies, reversing());
    // Every read started before any settled.
    assert.equal(reversed.calls.length, 5);
    assert.deepEqual(await reversed.result, await verifyFake(replies).result);
  }
  const wrong = await verifyFake(cases[0], reversing()).result;
  assert.ok("problems" in wrong);
  assert.deepEqual(wrong.problems.map((problem) => problem.split(/:| is /)[0]), [
    "access.issuer",
    "access.audience",
    "context.kvNamespaceId",
    "resources.blueprintsKvNamespaceId",
    "resources.blueprintContentBucket",
    "aiGateway.name",
  ]);
  assert.deepEqual(await verifyFake(cases[1], reversing()).result, {
    problems: [
      "access.issuer: the account has no readable Zero Trust organization (cf zero-trust organization get: APIError " +
      "[12000] organization not found).",
    ],
  });
  const signedOut = await verifyFake(cases[2], reversing()).result;
  assert.ok("skipped" in signedOut && signedOut.skipped.startsWith("cf zero-trust organization get: "));
});

test("stops at the first read not permitted, in order, though a later one finished sooner", async () => {
  // The organization is missing, a problem; the Access applications are not permitted; the KV list,
  // answering first, lacks both IDs, which is not looked at.
  const { result } = verifyFake(fakeAccount({
    "zero-trust organization get": { fail: "[12000] organization not found" },
    "zero-trust access applications list": { fail: "[10000] Authentication error" },
    "kv namespaces list": [],
  }), (args) => args[0] === "kv" ? 0 : args[0] === "zero-trust" && args[1] === "organization" ? 20 : 40);
  const found = await result;
  assert.ok("problems" in found);
  assert.equal(found.problems.length, 1);
  assert.match(found.problems[0], /^access\.issuer: the account has no readable Zero Trust organization/);
});

/** {@link withGatekeepers} with three OAuth Gatekeepers, the third an imagined one shaped like GitHub. */
const threeOAuth = {
  ...config,
  gatekeepers: {
    github: { name: "acme-gk-github" },
    gitlab: { name: "acme-gk-gitlab" },
    githubenterprise: { name: "acme-gk-githubenterprise" },
  },
} as DeploymentConfig;

/** {@link testCatalogWithGitlab}, offering the imagined third. */
function threeOAuthCatalog(): GatekeeperCatalog {
  const offered = testCatalogWithGitlab();
  offered.offered.push({ ...offered.offered[0], slug: "githubenterprise" });
  return offered;
}

test("reads the Gatekeepers' secrets at once, and warns the same whichever read finishes first", async () => {
  const replies = { "workers secrets list": workerSecretsReply({ "acme-gk-github": ["CLIENT_ID"], "acme-gk-gitlab": [] }) };
  const warn = (delay?: (args: string[]) => number) => {
    const cf = fakeCf(replies, { delay });
    const warnings = gatekeeperSecretWarnings(cfClient({ spawn: cf.spawn }), threeOAuth, threeOAuthCatalog());
    assert.equal(cf.calls.length, 3);
    return warnings;
  };
  const warnings = await warn(reversing());
  assert.deepEqual(warnings, await warn());
  assert.deepEqual(warnings.map((warning) => warning.split(" ")[1]), ["acme-gk-github", "acme-gk-gitlab", "acme-gk-githubenterprise"]);
});

test("keeps only the warnings before a secrets read that is not permitted, though a later one finished sooner", async () => {
  const cf = fakeCf({
    "workers secrets list": (args) => args.includes("acme-gk-gitlab")
      ? { fail: "[10000] Authentication error" }
      : [{ name: "CLIENT_ID", type: "secret_text" }],
  }, { delay: (args) => args.includes("acme-gk-githubenterprise") ? 0 : args.includes("acme-gk-gitlab") ? 20 : 10 });
  assert.deepEqual(await gatekeeperSecretWarnings(cfClient({ spawn: cf.spawn }), threeOAuth, threeOAuthCatalog()), [
    "Warning: acme-gk-github has no CLIENT_SECRET; nobody can connect the github Gatekeeper until " +
    "`pnpm cf-os secrets github` sets it.",
  ]);
});

test("reads no more than four Workers' secrets at once", async () => {
  const slugs = ["a", "b", "c", "d", "e", "f"];
  const offering = testCatalog();
  offering.offered.push(...slugs.map((slug) => ({ ...offering.offered[0], slug })));
  const many = { ...config, gatekeepers: Object.fromEntries(slugs.map((slug) => [slug, { name: `acme-gk-${slug}` }])) } as DeploymentConfig;
  let inFlight = 0;
  let most = 0;
  const read: string[] = [];
  const client = {
    ...memoryClient({}),
    listWorkerSecrets: async (_accountId: string, worker: string) => {
      read.push(worker);
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return [];
    },
  } satisfies CloudflareClient;
  const warnings = await gatekeeperSecretWarnings(client, many, offering);
  assert.equal(most, 4);
  assert.deepEqual(read, slugs.map((slug) => `acme-gk-${slug}`));
  assert.equal(warnings.length, 6);
});

test("startBounded's promises may fail before they are awaited, and still throw when they are", async (t) => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  t.after(() => process.off("unhandledRejection", listener));
  const reads = startBounded(["a", "b", "c"], 2, async (item) => {
    if (item === "a") return item;
    throw new Error(`no ${item}`);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(unhandled, []);
  assert.equal(await reads[0], "a");
  await assert.rejects(reads[1], /^Error: no b$/);
  await assert.rejects(reads[2], /^Error: no c$/);
});
