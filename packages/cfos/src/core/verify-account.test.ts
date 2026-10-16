import assert from "node:assert/strict";
import test from "node:test";
import { CfUnavailableError, type CloudflareClient } from "./client.ts";
import type { DeploymentConfig } from "./deployment-config.ts";
import { memoryClient, type MemoryAccount } from "./memory-client.ts";
import { verifyAccount } from "./verify-account.ts";

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

async function problems(account: MemoryAccount, deployment = config): Promise<string[]> {
  const result = await verifyAccount(memoryClient(account), deployment, origin);
  assert.ok("problems" in result, `skipped: ${"skipped" in result ? result.skipped : ""}`);
  return result.problems;
}

test("passes an account that has everything the config names", async () => {
  assert.deepEqual(await problems(matchingAccount()), []);
});

test("rejects an audience no application in the account has, and names cfos access", async () => {
  const found = await problems({ ...matchingAccount(), accessApps: [] });
  assert.equal(found.length, 1);
  assert.match(found[0], /no Access application .* has AUD tag aud-1/);
  assert.match(found[0], /pnpm cfos access/);
});

test("rejects an application that does not cover the router's hostname", async () => {
  const found = await problems({
    ...matchingAccount(),
    accessApps: [{ name: "Elsewhere", aud: "aud-1", domain: "other.example.com" }],
  });
  assert.equal(found.length, 1);
  assert.match(found[0], /"Elsewhere" covers other\.example\.com, not os\.example\.com/);
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

test("fails loudly on an API error that is not about credentials", async () => {
  await assert.rejects(
    problems({ ...matchingAccount(), failing: { listKvNamespaces: "[10013] internal error" } }),
    /10013/);
});
