import assert from "node:assert/strict";
import test from "node:test";
import { cfClient } from "../cf-client.ts";
import { fakeCf, workerSecretsReply, type FakeReply } from "../fake-cf.ts";
import {
  hostedAccountLive,
  hostedAnnotations,
  hostedMemoryAccount,
  reversing,
  testCatalog,
  testCatalogWithGitlab,
  type HostedWorkerOptions,
} from "../test-support.ts";
import { CfAuthError, CfUnavailableError, type CloudflareClient } from "./client.ts";
import type { DeploymentConfig } from "./deployment-config.ts";
import type { GatekeeperCatalog } from "./gatekeepers.ts";
import { memoryClient, type MemoryAccount } from "./memory-client.ts";
import {
  gatekeeperSecretWarnings,
  startBounded,
  verifyAccount,
  verifyMigrations,
  type DeployedWorker,
  type MigrationCheck,
} from "./verify-account.ts";

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

/** The Workers a deploy uploads over, with the migrations of the configuration this project generates for each. */
const deployed: DeployedWorker[] = [
  { name: "acme" },
  {
    name: "acme-backend",
    migrations: [{ tag: "v0", new_sqlite_classes: ["Users", "Overseer"] }, { tag: "v1", new_sqlite_classes: ["Settings"] }],
  },
  { name: "acme-gk-context", migrations: [{ tag: "v0", new_sqlite_classes: ["Collections"] }] },
  // One the hosted instance never had: the deploy creates it.
  { name: "acme-gk-websearch", migrations: [{ tag: "v1", new_sqlite_classes: ["WebSearch"] }] },
];

/**
 * What the hosted instance "acme" runs, its backend and Context Gatekeeper storing the classes
 * {@link deployed}'s migrations create unless `backend` or `context` say otherwise. No version
 * reports a migration tag unless one is given, as the API `cf` reads does not.
 */
function instance(backend: HostedWorkerOptions = {}, context: HostedWorkerOptions = {}): Record<string, HostedWorkerOptions> {
  return {
    "acme-backend": { durableObjects: ["Users", "Overseer", "Settings"], ...backend },
    "acme-gk-context": { durableObjects: ["Collections"], ...context },
  };
}

/** {@link verifyMigrations} of {@link deployed} against the in-memory account of `live`. */
function migrationCheck(live: Record<string, HostedWorkerOptions>, workers = deployed): Promise<MigrationCheck> {
  return verifyMigrations(memoryClient(hostedMemoryAccount(live)), ACCOUNT, workers);
}

/** The refusal of `check`, which must be one. */
function refusalOf(check: MigrationCheck): string {
  assert.ok("refusal" in check && check.refusal !== null, `not refused: ${JSON.stringify(check)}`);
  return check.refusal;
}

test("passes Workers whose storage is what this project's migrations leave, reading and writing nothing else", async () => {
  const client = memoryClient(hostedMemoryAccount(instance()));
  assert.deepEqual(await verifyMigrations(client, ACCOUNT, deployed), { refusal: null });
  // The namespaces once, each Worker's deployments, and the live version of each one the account has.
  assert.deepEqual(client.calls.toSorted(), [
    "getWorkerVersion", "getWorkerVersion", "getWorkerVersion",
    "listDurableObjectNamespaces",
    "listWorkerDeployments", "listWorkerDeployments", "listWorkerDeployments", "listWorkerDeployments",
  ]);
  assert.deepEqual(client.created, []);
  // Nothing to deploy over, nothing to read.
  const idle = memoryClient({});
  assert.deepEqual(await verifyMigrations(idle, ACCOUNT, []), { refusal: null });
  assert.deepEqual(idle.calls, []);
});

test("passes a Worker the account does not have yet, and one with no Durable Objects", async () => {
  // A fresh account: every Worker is the deploy's to create.
  assert.deepEqual(await verifyMigrations(memoryClient({}), ACCOUNT, deployed), { refusal: null });
  // The router stores nothing, on either side.
  assert.deepEqual(await migrationCheck(instance(), [{ name: "acme" }]), { refusal: null });
  // Deployed, with migrations in the project, and no storage yet: nothing to be behind.
  assert.deepEqual(await migrationCheck(instance({ durableObjects: [] })), { refusal: null });
});

test("passes a live migration tag that is one of the configuration's, the last or an earlier one", async () => {
  // At the project's last tag: the release the project pins. At an earlier one: the deploy migrates it forward.
  for (const migrationTag of ["v1", "v0"]) {
    assert.deepEqual(await migrationCheck(instance({ migrationTag })), { refusal: null }, migrationTag);
  }
  // The tag decides where the API reports one: a class this project does not create is not looked at.
  assert.deepEqual(await migrationCheck(instance({ migrationTag: "v1", durableObjects: ["Users", "Renamed"] })), { refusal: null });
});

test("refuses a Worker whose live migration tag is none of the configuration's, naming it, the tag and the fix", async () => {
  const refusal = refusalOf(await migrationCheck(instance({ migrationTag: "v2" })));
  assert.equal(refusal,
    "This project's pinned cloudflare-os is behind the Durable Object storage of Workers it would deploy over:\n" +
    "  - Worker acme-backend's live Durable Object migration tag is v2, which is not among the tags of this project's " +
    "configuration for it (v0, v1).\n" +
    "Deploying would put older code over storage a newer release has already migrated, which cannot be undone, so " +
    "nothing was built or deployed. Move the pin to what those Workers run, or past it, first: " +
    "`pnpm cf-os update --to <commit>`, with the cloudflare-os commit those Workers were deployed from or a newer one " +
    "(their live versions, which the hosted flow uploaded, name release r004945-6c8d301, built from commit 6c8d301: pass " +
    "it only where this project's pin is behind that commit, as `update --to` an older commit moves the pin back); " +
    "or take the instance over again with a fresh command from the hosted deploy flow, which moves the pin forward " +
    "only (docs/migrate-from-hosted.md).");
  // A tag the project has, on a Worker whose configuration has no migrations at all, is still not one of its tags.
  const bare = refusalOf(await migrationCheck(instance({ migrationTag: "v1" }), [{ name: "acme-backend" }]));
  assert.match(bare, /Worker acme-backend's live Durable Object migration tag is v1, .* \(it has no migrations\)\./);
});

test("refuses a Worker storing a class no migration of the configuration creates, where the API reports no tag", async () => {
  const refusal = refusalOf(await migrationCheck(instance({ durableObjects: ["Users", "Overseer", "Settings", "AddedLater"] })));
  assert.match(refusal, /\n {2}- Worker acme-backend stores Durable Objects of a class no migration in this project's configuration for it creates \(AddedLater\)\.\n/);
  assert.match(refusal, /nothing was built or deployed/);
  // The widest gap: a Worker with storage, under a configuration with no migrations at all.
  const bare = refusalOf(await migrationCheck(instance(), [{ name: "acme-gk-context" }]));
  assert.match(bare, /Worker acme-gk-context stores Durable Objects of a class .* \(Collections\)\./);
});

/** The fix a refusal names when it cannot say which commit the refused Workers run. */
const GENERIC_FIX = /first: `pnpm cf-os update --to <commit>`, with the cloudflare-os commit those Workers were deployed from or a newer one; or take/;

/**
 * The fix a refusal names when the refused Workers' live versions name release `id`, built from
 * `sha7`: the same command, the commit still the operator's to supply, and the release beside it
 * with the one case it is the commit to pass in.
 */
const namedFix = (id: string, sha7: string) => new RegExp("first: `pnpm cf-os update --to <commit>`, with the cloudflare-os commit " +
  "those Workers were deployed from or a newer one \\(their live versions, which the hosted flow uploaded, name release " +
  `${id}, built from commit ${sha7}: pass it only where this project's pin is behind that commit, as \`update --to\` an ` +
  "older commit moves the pin back\\); or take");

/** A command line that moves the pin to a commit it names: what no refusal may hand over ready to run. */
const READY_TO_RUN = /update --to [0-9a-f]{7,40}\b/;

test("names every Worker that is ahead, in the order they deploy, and the commit of the release they all name", async () => {
  const later: HostedWorkerOptions = { release: "r005100-abcdef1" };
  const refusal = refusalOf(await migrationCheck({
    ...instance({ ...later, migrationTag: "v9" }, { ...later, durableObjects: ["Collections", "Shares"] }),
    // Passes, so it is no evidence of what the refused Workers run, though its release is the newest in the account.
    acme: { release: "r005200-1234abc" },
  }));
  assert.match(refusal, /:\n {2}- Worker acme-backend's live Durable Object migration tag is v9, .*\n {2}- Worker acme-gk-context stores .* \(Shares\)\.\nDeploying would/);
  assert.match(refusal, namedFix("r005100-abcdef1", "abcdef1"));
  assert.doesNotMatch(refusal, /6c8d301|1234abc/);
  assert.doesNotMatch(refusal, READY_TO_RUN);
});

test("names no commit unless every refused Worker's own live version names that release", async () => {
  // The backend was deployed from a newer checkout, so its version names no release; the Workers
  // beside it are still the hosted flow's, at a release that is not what the backend runs.
  const fromCheckout: HostedWorkerOptions = { annotations: { "workers/triggered_by": "upload" }, releaseVar: false };
  const mixed = refusalOf(await migrationCheck(
    instance({ ...fromCheckout, durableObjects: ["Users", "Overseer", "Settings", "AddedLater"] })));
  assert.match(mixed, /Worker acme-backend stores Durable Objects of a class .* \(AddedLater\)\./);
  assert.match(mixed, GENERIC_FIX);
  assert.doesNotMatch(mixed, /6c8d301|r004945/);

  // Two refused Workers at two releases: the commit of the newer is not shown to be what the older's storage is at.
  const apart = refusalOf(await migrationCheck(
    instance({ migrationTag: "v9" }, { release: "r005100-abcdef1", durableObjects: ["Collections", "Shares"] })));
  assert.match(apart, GENERIC_FIX);
  assert.doesNotMatch(apart, /6c8d301|abcdef1/);

  // A refused Worker part-way through a rollout names both releases, and the newer is the one to reach.
  const account = hostedMemoryAccount(instance({ migrationTag: "v9" }));
  const [first] = account.versions?.["acme-backend"] ?? [];
  const second = {
    ...first,
    id: "0c0ffee0-0000-4000-8000-000000000002",
    annotations: hostedAnnotations("r005100-abcdef1"),
    bindings: [{ name: "CLOUDFLARE_OS_RELEASE_ID", type: "plain_text", text: "r005100-abcdef1" }],
  };
  const rollout = refusalOf(await verifyMigrations(memoryClient({
    ...account,
    versions: { ...account.versions, "acme-backend": [first, second] },
    deployments: {
      ...account.deployments,
      "acme-backend": [{ id: "rollout", versions: [{ version_id: first.id, percentage: 90 }, { version_id: second.id, percentage: 10 }] }],
    },
  }), ACCOUNT, deployed));
  assert.match(rollout, namedFix("r005100-abcdef1", "abcdef1"));
});

test("never hands over a pin move ready to run, and names no release a version made by hand carries", async () => {
  // Deployed by hand over the hosted flow's upload, keeping its variables: the release variable is
  // left over from that upload, and the class is one the hand deploy added. A project pinned past
  // r004945 is refused all the same, and `update --to 6c8d301` would roll its pin back.
  const byHand = refusalOf(await migrationCheck(
    instance({ handEdited: true, durableObjects: ["Users", "Overseer", "Settings", "HandMade"] })));
  assert.match(byHand, /Worker acme-backend stores Durable Objects of a class .* \(HandMade\)\./);
  assert.match(byHand, GENERIC_FIX);
  assert.doesNotMatch(byHand, /6c8d301|r004945/);
  const tagged = refusalOf(await migrationCheck(instance({ handEdited: true, migrationTag: "hand-1" })));
  assert.match(tagged, GENERIC_FIX);
  assert.doesNotMatch(tagged, /6c8d301|r004945/);

  // A Worker of another kind under the name, still the hosted flow's upload: its release is named,
  // as what it runs, and the commit is left out of the command.
  const misnamed = refusalOf(await migrationCheck({ acme: { release: "r000100-aaaaaaa", durableObjects: ["Users", "Overseer"] } },
    [{ name: "acme" }]));
  assert.match(misnamed, namedFix("r000100-aaaaaaa", "aaaaaaa"));
  for (const refusal of [byHand, tagged, misnamed]) {
    assert.doesNotMatch(refusal, READY_TO_RUN);
    assert.match(refusal, /a fresh command from the hosted deploy flow, which moves the pin forward only/);
  }
});

test("leaves the commit to the operator when no Worker names a release that carries one", async () => {
  // Deployed from a project like this one: no version is the hosted flow's, so none names a release.
  const own: HostedWorkerOptions = { annotations: { "workers/triggered_by": "upload" }, releaseVar: false };
  const taken = await migrationCheck({
    acme: own,
    ...instance({ ...own, migrationTag: "v9" }, own),
    "acme-gk-scheduler": own,
    "acme-gk-github": own,
  }, deployed);
  assert.match(refusalOf(taken), GENERIC_FIX);
  // A hand-built release: an id with no commit in it.
  const handBuilt: HostedWorkerOptions = { release: "dev-k3x9" };
  const staging = await migrationCheck({
    acme: handBuilt,
    ...instance({ ...handBuilt, migrationTag: "v9" }, handBuilt),
    "acme-gk-scheduler": handBuilt,
    "acme-gk-github": handBuilt,
  });
  assert.match(refusalOf(staging), GENERIC_FIX);
});

/** A read the token is not permitted to make: what a client method rejects with for the lack of a permission. */
function notPermitted(): Promise<never> {
  return Promise.reject(new CfAuthError("[10000] Authentication error"));
}

test("skips the migration check without credentials, and refuses when a read fails for any other reason", async () => {
  const signedOut = await verifyMigrations(memoryClient({ signedOut: true }), ACCOUNT, deployed);
  assert.deepEqual(signedOut, { skipped: "No authentication token found." });
  const unavailable = {
    ...memoryClient(hostedMemoryAccount(instance())),
    listDurableObjectNamespaces: () => Promise.reject(new CfUnavailableError("could not run cf: ENOENT")),
  } satisfies CloudflareClient;
  assert.deepEqual(await verifyMigrations(unavailable, ACCOUNT, deployed), { skipped: "could not run cf: ENOENT" });
  // A token that lists namespaces and may not read a Worker's deployments: the classes show no gap,
  // the tags were not read, and that is no pass.
  const partial = {
    ...memoryClient(hostedMemoryAccount(instance({ migrationTag: "v9" }))),
    listWorkerDeployments: notPermitted,
  } satisfies CloudflareClient;
  assert.deepEqual(await verifyMigrations(partial, ACCOUNT, deployed), { skipped: "[10000] Authentication error" });
  // And the other way about: the tags are among the project's, the classes were not read.
  const tagsOnly = {
    ...memoryClient(hostedMemoryAccount(instance({ migrationTag: "v1", durableObjects: ["Users", "AddedLater"] }))),
    listDurableObjectNamespaces: notPermitted,
  } satisfies CloudflareClient;
  assert.deepEqual(await verifyMigrations(tagsOnly, ACCOUNT, deployed), { skipped: "[10000] Authentication error" });

  // Any other failure leaves the question open, and an open question is a refusal.
  for (const method of ["listDurableObjectNamespaces", "listWorkerDeployments", "getWorkerVersion"] as const) {
    const failing = memoryClient({ ...hostedMemoryAccount(instance()), failing: { [method]: "[10013] internal error" } });
    assert.equal(refusalOf(await verifyMigrations(failing, ACCOUNT, deployed)),
      "What the account's Workers run could not be read, so whether their Durable Object storage is ahead of this " +
      "project's pinned cloudflare-os is not known:\n  - [10013] internal error\n" +
      "Deploying older code over storage a newer release has migrated cannot be undone, so nothing was built or " +
      "deployed. Run this again once the read works.", method);
  }
});

test("judges what it could read when credentials stop the other read, and refuses a gap it shows", async () => {
  // The namespaces were read and show a class this project does not create; no Worker could be read.
  const classes = {
    ...memoryClient(hostedMemoryAccount(instance({ durableObjects: ["Users", "Overseer", "Settings", "AddedLater"] }))),
    listWorkerDeployments: notPermitted,
  } satisfies CloudflareClient;
  const stored = refusalOf(await verifyMigrations(classes, ACCOUNT, deployed));
  assert.match(stored, /^This project's pinned cloudflare-os is behind .*:\n {2}- Worker acme-backend stores Durable Objects of a class .* \(AddedLater\)\.\nDeploying would/);
  // No Worker was read, so none names a release.
  assert.match(stored, GENERIC_FIX);
  // A Worker under a configuration with no migrations is held to the same, unread or not.
  const bare = refusalOf(await verifyMigrations(classes, ACCOUNT, [{ name: "acme-gk-context" }]));
  assert.match(bare, /Worker acme-gk-context stores Durable Objects of a class .* \(Collections\)\./);

  // The Workers were read and one reports a tag this project does not have; the namespaces could not be.
  const tags = {
    ...memoryClient(hostedMemoryAccount(instance({ migrationTag: "v9" }))),
    listDurableObjectNamespaces: notPermitted,
  } satisfies CloudflareClient;
  const tagged = refusalOf(await verifyMigrations(tags, ACCOUNT, deployed));
  assert.match(tagged, /\n {2}- Worker acme-backend's live Durable Object migration tag is v9, /);
  assert.match(tagged, namedFix("r004945-6c8d301", "6c8d301"));

  // A read that failed for another reason is a refusal, whichever read credentials stopped beside it.
  for (const [unpermitted, failing] of [
    ["listDurableObjectNamespaces", "listWorkerDeployments"],
    ["listWorkerDeployments", "listDurableObjectNamespaces"],
  ] as const) {
    const client = {
      ...memoryClient({ ...hostedMemoryAccount(instance()), failing: { [failing]: "[10013] internal error" } }),
      [unpermitted]: notPermitted,
    } satisfies CloudflareClient;
    assert.match(refusalOf(await verifyMigrations(client, ACCOUNT, deployed)),
      /^What the account's Workers run could not be read, .*:\n {2}- \[10013\] internal error\n/, failing);
  }
});

/** {@link verifyMigrations} of {@link deployed} against `replies`, the calls settling as `delay` says. */
function verifyFakeMigrations(replies: Record<string, FakeReply>, delay?: (args: string[]) => number) {
  const cf = fakeCf(replies, { delay });
  return { result: verifyMigrations(cfClient({ spawn: cf.spawn }), ACCOUNT, deployed), calls: cf.calls };
}

/**
 * A `delay` for `fakeCf` under which the first call waits longest and each later one less, never
 * below nothing: `reversing`, for more calls than it has steps for.
 */
function lateFirst(): (args: string[]) => number {
  let started = 0;
  return () => Math.max(0, 150 - 10 * started++);
}

test("reads the Workers at once, and gives the same verdict whichever read finishes first", async () => {
  const cases: Record<string, FakeReply>[] = [
    hostedAccountLive(instance()),
    hostedAccountLive(instance({ migrationTag: "v9" }, { durableObjects: ["Collections", "Shares"] })),
    // The namespaces are not permitted, and a Worker's deployments fail outright: the failure that is not credentials decides.
    { ...hostedAccountLive(instance()), "durable-objects namespaces list": { fail: "[10000] Authentication error" }, "workers deployments list": { fail: "[10013] internal error" } },
    { ...hostedAccountLive(instance()), "workers deployments list": { fail: "[10013] internal error" } },
    // Neither read is permitted: the namespaces' is the reason given.
    { ...hostedAccountLive(instance()), "durable-objects namespaces list": { fail: "[10000] Authentication error" }, "workers deployments list": { fail: "[10000] Authentication error" } },
    // The Workers are not permitted, and the namespaces show a class this project does not create.
    { ...hostedAccountLive(instance({}, { durableObjects: ["Collections", "Shares"] })), "workers deployments list": { fail: "[10000] Authentication error" } },
  ];
  for (const replies of cases) {
    const reversed = verifyFakeMigrations(replies, lateFirst());
    // The namespaces and the deployments of all four Workers, started before any settled.
    assert.deepEqual(reversed.calls.map(({ args }) => args.slice(0, 3).join(" ")).toSorted(), [
      "durable-objects namespaces list",
      "workers deployments list", "workers deployments list", "workers deployments list", "workers deployments list",
    ]);
    assert.deepEqual(await reversed.result, await verifyFakeMigrations(replies).result);
  }
  assert.deepEqual(await verifyFakeMigrations(cases[0], lateFirst()).result, { refusal: null });
  const ahead = refusalOf(await verifyFakeMigrations(cases[1], lateFirst()).result);
  assert.match(ahead, /Worker acme-backend's live Durable Object migration tag is v9[\s\S]*Worker acme-gk-context stores/);
  assert.match(refusalOf(await verifyFakeMigrations(cases[2], lateFirst()).result), /could not be read[\s\S]*cf workers deployments list --script-name acme: .*10013/);
  const unread = await verifyFakeMigrations(cases[4], lateFirst()).result;
  assert.ok("skipped" in unread && unread.skipped.startsWith("cf durable-objects namespaces list"));
  assert.match(refusalOf(await verifyFakeMigrations(cases[5], lateFirst()).result), /^This project's pinned cloudflare-os is behind [\s\S]*Worker acme-gk-context stores .* \(Shares\)\./);
  // Of the Workers whose read failed, the first in deploy order is the one named.
  assert.match(refusalOf(await verifyFakeMigrations(cases[3], lateFirst()).result), /could not be read[\s\S]*cf workers deployments list --script-name acme: .*10013/);
});
