import assert from "node:assert/strict";
import test from "node:test";
import { CF_AUTH_HINT, cfClient, cfJson, cfList, listR2Buckets } from "./cf-client.ts";
import {
  CfAuthError,
  CfError,
  CfUnavailableError,
  accessAppCoverage,
  accessAppCovers,
  accessAppFor,
  accessAppHosts,
  issuerOf,
  workersDevSubdomainOf,
} from "./core/client.ts";
import { FAKE_ACCOUNT, fakeCf, flag, workerSecretsReply, type FakeReply } from "./fake-cf.ts";

test("pins the account and quiets the CLI on every call", () => {
  const { spawn, calls } = fakeCf({ "zero-trust organization get": { auth_domain: "acme.cloudflareaccess.com" } });
  const previous = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_ACCOUNT_ID = "ffffffffffffffffffffffffffffffff";
  try {
    cfJson(["zero-trust", "organization", "get"], { accountId: FAKE_ACCOUNT, spawn });
  } finally {
    if (previous === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = previous;
  }
  // An ambient account must not redirect a call meant for deployment.jsonc's.
  assert.equal(calls[0].env.CLOUDFLARE_ACCOUNT_ID, FAKE_ACCOUNT);
  assert.equal(calls[0].env.CF_QUIET, "1");
  assert.equal(calls[0].env.NO_COLOR, "1");
  assert.deepEqual(calls[0].args, ["zero-trust", "organization", "get"]);
});

test("returns the bare result, and unwraps an API envelope if one is printed", () => {
  const bare = fakeCf({ "kv namespaces list": [{ id: "a", title: "t" }] });
  assert.deepEqual(cfJson(["kv", "namespaces", "list"], { accountId: FAKE_ACCOUNT, spawn: bare.spawn }),
    [{ id: "a", title: "t" }]);
  const enveloped = fakeCf({
    "zero-trust organization get": { success: true, errors: [], messages: [], result: { auth_domain: "x" } },
  });
  assert.deepEqual(
    cfJson(["zero-trust", "organization", "get"], { accountId: FAKE_ACCOUNT, spawn: enveloped.spawn }),
    { auth_domain: "x" });
});

/** Options for a `cf workers list` that answers with `reply`. */
function workersListAnswering(reply: FakeReply) {
  return { accountId: FAKE_ACCOUNT, spawn: fakeCf({ "workers list": reply }).spawn };
}

test("maps missing or rejected credentials to the login hint, and other failures to CfError", () => {
  const options = workersListAnswering;
  for (const fail of [
    "No authentication token found.",
    "[9106] Authentication failed (status: 400)",
    "[10000] Authentication error",
  ]) {
    assert.throws(() => cfJson(["workers", "list"], options({ fail })), (error: unknown) => {
      assert.ok(error instanceof CfAuthError, `${fail} was not an auth error`);
      assert.ok(error.message.includes(CF_AUTH_HINT));
      return true;
    });
  }
  assert.throws(
    () => cfJson(["workers", "list"], options({ fail: "[7003] Could not route to /accounts/x" })),
    (error: unknown) => error instanceof CfError && !(error instanceof CfAuthError) &&
      /cf workers list: APIError \[7003\] Could not route/.test(error.message));
  assert.throws(
    () => cfJson(["workers", "list"], {
      accountId: FAKE_ACCOUNT,
      spawn: () => ({ status: 0, stdout: "not json", stderr: "" }),
    }),
    /printed something other than JSON/);
  assert.throws(
    () => cfJson(["workers", "list"], {
      accountId: FAKE_ACCOUNT,
      spawn: () => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") }),
    }),
    (error: unknown) => error instanceof CfUnavailableError && /could not run cf: ENOENT/.test(error.message));
});

/** A client whose `cf workers secrets list` fails with `fail`. */
function failingSecretsList(fail: string) {
  return cfClient({ spawn: fakeCf({ "workers secrets list": { fail } }).spawn });
}

test("lists a Worker's secret names, and reads a Worker the account does not have as null", async () => {
  const { spawn, calls } = fakeCf({ "workers secrets list": workerSecretsReply({ "acme-gk-github": ["CLIENT_ID"] }) });
  const client = cfClient({ spawn });
  assert.deepEqual(await client.listWorkerSecrets(FAKE_ACCOUNT, "acme-gk-github"), ["CLIENT_ID"]);
  assert.deepEqual(calls[0].args, ["workers", "secrets", "list", "--script-name", "acme-gk-github"]);
  assert.equal(calls[0].env.CLOUDFLARE_ACCOUNT_ID, FAKE_ACCOUNT);
  // `cf`'s own words for a missing Worker: the API's code 10007, boxed on stderr.
  assert.equal(await client.listWorkerSecrets(FAKE_ACCOUNT, "acme-gk-slack"), null);
  // Any other failure is still one.
  await assert.rejects(failingSecretsList("[10000] Authentication error").listWorkerSecrets(FAKE_ACCOUNT, "acme-gk-github"),
    (error: unknown) => error instanceof CfAuthError);
  await assert.rejects(failingSecretsList("[10013] internal error").listWorkerSecrets(FAKE_ACCOUNT, "acme-gk-github"),
    (error: unknown) => error instanceof CfError && /\[10013\]/.test(error.message));
  await assert.rejects(
    cfClient({ spawn: fakeCf({ "workers secrets list": { name: "CLIENT_ID" } }).spawn })
      .listWorkerSecrets(FAKE_ACCOUNT, "acme-gk-github"),
    /expected a JSON array/);
});

test("lists every page, not just the first", () => {
  const workers = Array.from({ length: 230 }, (_, i) => ({ name: `w${i}` }));
  const { spawn, calls } = fakeCf({ "workers list": workers });
  const listed = cfList<{ name: string }>(["workers", "list"], { accountId: FAKE_ACCOUNT, spawn });
  assert.equal(listed.length, 230);
  assert.deepEqual(calls.map((call) => call.args.slice(-4)), [
    ["--page", "1", "--per-page", "100"],
    ["--page", "2", "--per-page", "100"],
    ["--page", "3", "--per-page", "100"],
  ]);
});

test("pages accounts within the API's 50-per-page ceiling", async () => {
  const accounts = Array.from({ length: 120 }, (_, i) => ({ id: `a${i}`, name: `Account ${i}` }));
  const { spawn, calls } = fakeCf({ "accounts list": accounts });
  assert.equal((await cfClient({ spawn }).listAccounts()).length, 120);
  // Past the ceiling, a capped page of 50 would read as the last one.
  assert.deepEqual(calls.map((call) => flag(call.args, "--per-page")), ["50", "50", "50"]);
});

test("lists Access applications unfiltered, so a covering wildcard one is among them", async () => {
  const apps = [{ name: "w", aud: "a", domain: "*.example.com" }];
  const { spawn, calls } = fakeCf({ "zero-trust access applications list": apps });
  assert.deepEqual(await cfClient({ spawn }).listAccessApps(FAKE_ACCOUNT), apps);
  assert.ok(!calls[0].args.includes("--domain") && !calls[0].args.includes("--exact"));
});

test("reads R2's wrapped bucket list", () => {
  const { spawn } = fakeCf({ "r2 buckets list": { buckets: [{ name: "a" }, { name: "b" }] } });
  assert.deepEqual(listR2Buckets({ accountId: FAKE_ACCOUNT, spawn }), ["a", "b"]);
});

test("pages R2 by name, since cf prints no cursor", () => {
  // Unpaged, the API returns 20; a bucket past the first page would read as missing.
  const all = Array.from({ length: 2500 }, (_, i) => ({ name: `bucket-${String(i).padStart(4, "0")}` }));
  const { spawn, calls } = fakeCf({
    "r2 buckets list": (args) => {
      const after = flag(args, "--start-after");
      const start = after ? all.findIndex((bucket) => bucket.name === after) + 1 : 0;
      return { buckets: all.slice(start, start + Number(flag(args, "--per-page") ?? 20)) };
    },
  });
  const names = listR2Buckets({ accountId: FAKE_ACCOUNT, spawn });
  assert.equal(names.length, 2500);
  assert.equal(names.at(-1), "bucket-2499");
  assert.deepEqual(calls.map((call) => flag(call.args, "--start-after")), [undefined, "bucket-0999", "bucket-1999"]);
});

test("derives the issuer from the team domain", () => {
  assert.equal(issuerOf({ auth_domain: "acme.cloudflareaccess.com" }), "https://acme.cloudflareaccess.com");
  assert.equal(issuerOf({}), undefined);
});

test("knows which hostnames an Access application gates, and on which paths", () => {
  const app = {
    domain: "os.example.com/admin",
    self_hosted_domains: ["os.example.com/admin", "*.preview.example.com"],
    destinations: [{ type: "public", uri: "https://OS2.example.com/" }, { type: "private", uri: "10.0.0.1" }],
  };
  assert.deepEqual(accessAppHosts(app), ["os.example.com", "*.preview.example.com", "os2.example.com"]);
  // `/admin` alone leaves the rest of the origin open.
  assert.ok(!accessAppCovers(app, "os.example.com"));
  assert.equal(accessAppCoverage(app, "OS2.example.com"), "exact");
  assert.equal(accessAppCoverage(app, "pr-1.preview.example.com"), "wildcard");
  // A `*` matches one label, as Access's does.
  assert.ok(!accessAppCovers(app, "a.pr-1.preview.example.com"));
  assert.ok(accessAppCovers({ domain: "*.*.example.com" }, "os.team.example.com"));
  assert.ok(accessAppCovers({ domain: "os-*.example.com" }, "os-acme.example.com"));
  assert.ok(!accessAppCovers({ domain: "os-*.example.com" }, "acme.example.com"));
  assert.ok(!accessAppCovers(app, "preview.example.com"));
  assert.ok(!accessAppCovers(app, "other.example.com"));
  assert.ok(!accessAppCovers({}, "os.example.com"));
  assert.ok(accessAppCovers({ domain: "os.example.com/*" }, "os.example.com"));
  assert.ok(accessAppCovers({ type: "ssh", domain: "os.example.com" }, "os.example.com"));
  assert.ok(!accessAppCovers({ type: "bookmark", domain: "os.example.com" }, "os.example.com"));
});

test("picks the application Access applies: an exact hostname ahead of a wildcard", () => {
  const wildcard = { name: "w", domain: "*.example.com" };
  const exact = { name: "e", domain: "os.example.com" };
  assert.equal(accessAppFor([wildcard, exact], "os.example.com"), exact);
  assert.equal(accessAppFor([wildcard], "os.example.com"), wildcard);
  assert.equal(accessAppFor([{ domain: "os.example.com/admin" }], "os.example.com"), undefined);
  // Between wildcards, the one matching more of the hostname, whichever comes first.
  const team = { name: "t", domain: "*.team.example.com" };
  const broad = { name: "b", domain: "*.*.example.com" };
  assert.equal(accessAppFor([broad, team], "os.team.example.com"), team);
  assert.equal(accessAppFor([team, broad], "os.team.example.com"), team);
});

test("pages zones too, and lists only the account's active ones", async () => {
  const zones = Array.from({ length: 150 }, (_, i) => ({ id: `z${i}`, name: `zone${i}.example`, status: "active" }));
  const { spawn, calls } = fakeCf({ "zones list": zones });
  const listed = await cfClient({ spawn }).listZones(FAKE_ACCOUNT);
  assert.equal(listed.length, 150);
  // 50 at a time, the most zones list returns, and an empty fourth page to end on.
  assert.deepEqual(calls.map((call) => flag(call.args, "--page")), ["1", "2", "3", "4"]);
  // `zones list` lists every zone the credentials reach unless told which account.
  assert.equal(flag(calls[0].args, "--account-id"), FAKE_ACCOUNT);
  assert.equal(flag(calls[0].args, "--status"), "active");
});

test("looks up a hostname's DNS records by exact name", async () => {
  const { spawn, calls } = fakeCf({
    "dns records list": (args) => flag(args, "--name-exact") === "os.example.com"
      ? [{ name: "os.example.com", type: "CNAME" }] : [],
  });
  const client = cfClient({ spawn });
  assert.deepEqual(await client.findDnsRecords(FAKE_ACCOUNT, "example.com", "os.example.com"),
    [{ name: "os.example.com", type: "CNAME" }]);
  assert.deepEqual(await client.findDnsRecords(FAKE_ACCOUNT, "example.com", "free.example.com"), []);
  assert.equal(flag(calls[0].args, "--zone"), "example.com");
});

test("derives the workers.dev subdomain from any Worker's address", async () => {
  assert.equal(workersDevSubdomainOf([
    { name: "no-url" },
    { name: "acme", subdomain: { enabled: false, url: "https://acme.acme-sub.workers.dev/" } },
  ]), "acme-sub");
  assert.equal(workersDevSubdomainOf([{ name: "elsewhere", subdomain: { url: "https://os.example.com" } }]), null);
  assert.equal(workersDevSubdomainOf([]), null);
  const { spawn } = fakeCf({ "workers list": [{ name: "w", subdomain: { url: "https://w.team.workers.dev" } }] });
  assert.equal(await cfClient({ spawn }).workersDevSubdomain(FAKE_ACCOUNT), "team");
});

test("reports signed out as an answer, not an error", async () => {
  const signedOut = fakeCf({ "auth whoami": { authenticated: false, error: "Not logged in" } });
  assert.deepEqual(await cfClient({ spawn: signedOut.spawn }).whoami(), { authenticated: false, email: undefined });
  // Account-less: an ambient account must not leak into it.
  assert.equal(signedOut.calls[0].env.CLOUDFLARE_ACCOUNT_ID, undefined);
  const signedIn = fakeCf({ "auth whoami": { authenticated: true, email: "me@example.com" } });
  assert.deepEqual(await cfClient({ spawn: signedIn.spawn }).whoami(), { authenticated: true, email: "me@example.com" });
});

test("passes --profile to every call", async () => {
  const { spawn, calls } = fakeCf({
    "auth whoami": { authenticated: true },
    "workers list": [],
    "zero-trust access applications create": { aud: "a" },
  });
  const client = cfClient({ spawn, profile: "work" });
  await client.whoami();
  await client.listWorkers(FAKE_ACCOUNT);
  await client.createAccessApp(FAKE_ACCOUNT, { name: "x" });
  assert.deepEqual(calls.map((call) => call.profile), ["work", "work", "work"]);
});

test("creates through --body, and dry-runs with --dry-run", async () => {
  const { spawn, calls } = fakeCf({
    "zero-trust identity-providers create": (args) => args.includes("--dry-run")
      ? { method: "POST", body: JSON.parse(flag(args, "--body")!) } : { id: "idp", type: "onetimepin" },
  });
  const client = cfClient({ spawn });
  const body = { name: "One-time PIN", type: "onetimepin", config: {} };
  assert.deepEqual(await client.dryRunCreateIdentityProvider(FAKE_ACCOUNT, body), { method: "POST", body });
  assert.deepEqual(await client.createIdentityProvider(FAKE_ACCOUNT, body), { id: "idp", type: "onetimepin" });
  assert.deepEqual(calls.map((call) => call.args.includes("--dry-run")), [true, false]);
});
