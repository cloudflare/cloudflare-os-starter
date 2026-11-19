import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { cfClient } from "../cf-client.ts";
import type { CfWorkerBinding, CfWorkerVersion } from "../core/client.ts";
import type { DeploymentConfig, ProdWranglerConfig } from "../core/deployment-config.ts";
import { generateConfigs, PACKAGE_DIRS } from "../core/deployment.ts";
import { backendValues, readWorker } from "../core/hosted-release.ts";
import { durableObjectNamespacesReply, FAKE_ACCOUNT, fakeCf, workerLiveReplies, workerSecretsReply, type FakeReply } from "../fake-cf.ts";
import {
  CANCEL,
  DEFAULT,
  fixtureVersionId,
  hostedWorkerLive,
  pinnedDurableObjects,
  scratchProject,
  scriptedPrompter,
  TEMPLATE,
  testCatalog,
  testCatalogWithGoogle,
  testContext,
  type WorkerLive,
} from "../test-support.ts";
import type { PendingSecrets } from "../gatekeeper-secrets.ts";
import { readBaseConfigs, run, type DeployDeps } from "./deploy.ts";
import { INSTALL_MARKER } from "./install.ts";

/** A project whose submodule is checked out and installed, holding the unconfigured template. */
function installedProject(t: Parameters<typeof scratchProject>[0]): string {
  const root = scratchProject(t, TEMPLATE);
  const lockfile = "lockfileVersion: '9.0'\n";
  writeFileSync(join(root, "cloudflare-os", "package.json"), "{}");
  writeFileSync(join(root, "cloudflare-os", "pnpm-lock.yaml"), lockfile);
  const marker = join(root, "cloudflare-os", INSTALL_MARKER);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({ lockfileSha256: createHash("sha256").update(lockfile).digest("hex") }));
  return root;
}

test("on an unconfigured file without a terminal, fails as before", async (t) => {
  const harness = testContext({ root: installedProject(t) });
  await assert.rejects(run({ command: "check", values: {}, positionals: [] }, harness.ctx),
    /deployment\.jsonc: Replace deployment placeholder <CLOUDFLARE_ACCOUNT_ID>\./);
});

test("on an unconfigured file at a terminal, offers init in place of the error", async (t) => {
  const root = installedProject(t);
  const declined = testContext({ root, prompter: scriptedPrompter([["Run `cf-os init` now?", false]]) });
  await assert.rejects(run({ command: "check", values: {}, positionals: [] }, declined.ctx), /Replace deployment placeholder/);

  // Accepted, it is init that asks next -- here cancelled at its first question.
  const prompter = scriptedPrompter([["Run `cf-os init` now?", true], ["What are you setting up?", CANCEL]]);
  const accepted = testContext({
    root,
    prompter,
    client: {
      whoami: async () => ({ authenticated: true, email: "me@example.com" }),
      listAccounts: async () => [{ id: "0123456789abcdef0123456789abcdef", name: "Acme" }],
      listWorkers: async () => [],
    } as never,
  });
  await assert.rejects(run({ command: "deploy", values: {}, positionals: [] }, accepted.ctx), /Cancelled/);
  assert.deepEqual(prompter.remaining(), []);
});

test("once init has configured the file, carries on with the deploy", async (t) => {
  const root = installedProject(t);
  const cf = fakeCf({
    "auth whoami": { authenticated: true, email: "me@example.com" },
    "accounts list": [{ id: FAKE_ACCOUNT, name: "Acme" }],
    "workers list": [{ name: "other", subdomain: { url: "https://other.acme-sub.workers.dev" } }],
    "zones list": [],
    "ai-gateway gateways list": [],
    "zero-trust organization get": { auth_domain: "acme.cloudflareaccess.com" },
    "zero-trust identity-providers list": [{ id: "idp", type: "github" }],
    "zero-trust access applications list": [{ name: "Existing", aud: "aud-existing", domain: "acme-os.acme-sub.workers.dev" }],
  });
  const prompter = scriptedPrompter([
    ["Run `cf-os init` now?", true],
    ["What are you setting up?", "new"],
    ["Base name", "acme-os"],
    ["Where will people reach it?", "workersDev"],
    ["Admin emails", DEFAULT],
    ["Which AI Gateway", "default"],
    ["Which model providers?", ["cloudflare"]],
    ["Which Gatekeepers?", DEFAULT],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
  ]);
  const harness = testContext({ root, prompter, client: cfClient({ spawn: cf.spawn }) });
  // Past validation, the fixture has no Worker base configs to generate from: proof it carried on.
  await assert.rejects(run({ command: "deploy", values: {}, positionals: [] }, harness.ctx),
    /cloudflare-os[\\/]packages[\\/][\w-]+[\\/]wrangler\.jsonc/);
  assert.deepEqual(prompter.remaining(), []);
  assert.match(harness.stderr(), /Continuing with `cf-os deploy`/);
  assert.doesNotMatch(harness.stderr(), /Deploy now\?|Next:/);
  // The fixture has no upstream packages, so init offered only the custom Gatekeeper, and said why.
  assert.match(harness.stderr(), /The Gatekeeper catalog could not be read, so only the example custom Gatekeeper is offered/);
});

/** {@link TEMPLATE} with every placeholder filled in. */
const FILLED = TEMPLATE
  .replace("<CLOUDFLARE_ACCOUNT_ID>", FAKE_ACCOUNT)
  .replace(/<([A-Z_]+)_WORKER_NAME>/g, (_, name: string) => `acme-${name.toLowerCase().replace(/_/g, "-")}`)
  .replace("<TEAM_NAME>", "acme")
  .replace("<ACCESS_AUDIENCE>", "aud-1")
  .replace("<ADMIN_EMAIL>", "me@example.com")
  .replace("<ORGANIZATION_DISPLAY_NAME>", "Acme")
  .replace("<ORGANIZATION_GUIDANCE>", "Be kind.");

test("refuses an --account other than the file's, before reading the account or building", async (t) => {
  const root = installedProject(t);
  writeFileSync(join(root, "deployment.jsonc"), FILLED);
  const cf = fakeCf({});
  const other = "fedcba9876543210fedcba9876543210";
  for (const command of ["check", "deploy"]) {
    const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }), flags: { account: other } });
    await assert.rejects(run({ command, values: {}, positionals: [] }, harness.ctx),
      new RegExp(`--account ${other} is not deployment\\.jsonc's accountId \\(${FAKE_ACCOUNT}\\)`));
  }
  assert.deepEqual(cf.calls, []);
  // The same account, in another case, is the file's.
  const same = testContext({ root, client: cfClient({ spawn: cf.spawn }), flags: { account: FAKE_ACCOUNT.toUpperCase() } });
  await assert.rejects(run({ command: "check", values: {}, positionals: [] }, same.ctx),
    /cloudflare-os[\\/]packages[\\/][\w-]+[\\/]wrangler\.jsonc/);
});

test("refuses before reading the file when the submodule is not installed", async (t) => {
  const harness = testContext({ root: scratchProject(t, TEMPLATE), prompter: scriptedPrompter([]) });
  await assert.rejects(run({ command: "check", values: {}, positionals: [] }, harness.ctx), /not initialized/);
});

test("refuses a Gatekeeper the catalog excludes, with upstream's reason, before reading the account", async (t) => {
  const root = installedProject(t);
  // The real packages, so the real catalog: Email is a Worker upstream will not install.
  symlinkSync(join(import.meta.dirname, "..", "..", "..", "..", "cloudflare-os", "packages"),
    join(root, "cloudflare-os", "packages"), "junction");
  writeFileSync(join(root, "deployment.jsonc"),
    FILLED.replace('"gatekeepers": {}', '"gatekeepers": { "email": { "name": "acme-gk-email" } }'));
  const cf = fakeCf({});
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }) });
  await assert.rejects(run({ command: "check", values: {}, positionals: [] }, harness.ctx),
    /^Error: deployment\.jsonc: gatekeepers\.email: the starter cannot deploy gatekeeper-email: upstream marks it not installable\.$/);
  assert.deepEqual(cf.calls, []);
});

test("refuses any optional Gatekeeper when the catalog cannot be read", async (t) => {
  const root = installedProject(t);
  writeFileSync(join(root, "deployment.jsonc"),
    FILLED.replace('"gatekeepers": {}', '"gatekeepers": { "github": { "name": "acme-gk-github" } }'));
  const harness = testContext({ root, client: cfClient({ spawn: fakeCf({}).spawn }) });
  await assert.rejects(run({ command: "check", values: {}, positionals: [] }, harness.ctx),
    /deployment\.jsonc: gatekeepers: the Gatekeeper catalog could not be read, so none can be deployed: cloudflare-os\/packages could not be read/);
});

/**
 * Every base config the pin has, from the repository root: all of {@link PACKAGE_DIRS}, but for the
 * PDF renderer's on a pin from before upstream had it, which a deployment without Google never reads.
 */
function pinnedBaseConfigs(repository: string): string[] {
  return Object.values(PACKAGE_DIRS).map((dir) => `${dir}/wrangler.jsonc`)
    .filter((file) => file !== `${PACKAGE_DIRS.pdfRenderer}/wrangler.jsonc` || existsSync(join(repository, file)));
}

/** An installed project with the real base configs and GitHub's package, {@link FILLED} selecting GitHub. */
function githubProject(t: Parameters<typeof scratchProject>[0]): { root: string; github: string } {
  const root = installedProject(t);
  const repository = join(import.meta.dirname, "..", "..", "..", "..");
  const github = "cloudflare-os/packages/gatekeeper-github";
  for (const file of [
    ...pinnedBaseConfigs(repository),
    ...["wrangler.jsonc", "package.json", "deploy-inputs.json"].map((name) => `${github}/${name}`),
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(repository, file), join(root, file));
  }
  writeFileSync(join(root, "deployment.jsonc"),
    FILLED.replace('"gatekeepers": {}', '"gatekeepers": { "github": { "name": "acme-gk-github" } }'));
  return { root, github };
}

/**
 * What `cf` prints of what the account's Workers run: the deployments and versions of each Worker
 * of `live`, and the Durable Object classes each stores. A Worker not in `live` is one the account
 * does not have.
 */
function liveReplies(live: Record<string, WorkerLive>): Record<string, FakeReply> {
  return {
    ...workerLiveReplies(live),
    "durable-objects namespaces list": durableObjectNamespacesReply(
      Object.fromEntries(Object.entries(live).map(([name, { durableObjects }]) => [name, durableObjects]))),
  };
}

/**
 * An account matching {@link FILLED}, whose Worker secrets are `secrets` and whose Workers run
 * `live`: by default none is deployed yet.
 */
function filledAccount(
  secrets: Record<string, string[]>,
  delay?: (args: string[]) => number,
  live: Record<string, WorkerLive> = {},
) {
  return fakeCf({
    "zero-trust organization get": { auth_domain: "acme.cloudflareaccess.com" },
    "zero-trust access applications list": [{ name: "Cloudflare OS", aud: "aud-1", domain: "os.example.com" }],
    "workers secrets list": workerSecretsReply(secrets),
    ...liveReplies(live),
  }, { delay });
}

/** A `delay` for `fakeCf` under which the first call waits longest and each later one less, never below nothing. */
function lateFirst(): (args: string[]) => number {
  let started = 0;
  return () => Math.max(0, 150 - 10 * started++);
}

test("check warns on stderr about a Gatekeeper secret that is not set, and carries on", async (t) => {
  const { root, github } = githubProject(t);
  // A directory where GitHub's generated config goes stops the run at that write, just past the
  // account checks.
  mkdirSync(join(root, github, "wrangler.prod.jsonc"));
  const cf = filledAccount({ "acme-gk-github": ["CLIENT_ID"] });
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }) });
  await assert.rejects(run({ command: "check", values: {}, positionals: [] }, harness.ctx), /EISDIR|is a directory/);
  assert.match(harness.stderr(), /Cloudflare-side checks passed/);
  assert.deepEqual(harness.log.filter((line) => line.includes("acme-gk-github")),
    ["\nWarning: acme-gk-github has no CLIENT_SECRET; nobody can connect the github Gatekeeper until " +
      "`pnpm cf-os secrets github` sets it."]);
  assert.deepEqual(harness.json, []);
  assert.deepEqual(cf.calls.filter((call) => call.args[1] === "secrets").map((call) => call.args),
    [["workers", "secrets", "list", "--script-name", "acme-gk-github"]]);
  // Read beside the account check rather than after it, though printed after its verdict.
  const at = (words: string) => cf.calls.findIndex((call) => call.args.join(" ").startsWith(words));
  assert.ok(at("workers secrets list") < at("zero-trust access applications list"), "read after the account check");
});

test("check and deploy warn about an MCP portal with no endpoint, and deploy it anyway", async (t) => {
  const root = installedProject(t);
  const repository = join(import.meta.dirname, "..", "..", "..", "..");
  const portal = "cloudflare-os/packages/gatekeeper-mcp-portal";
  for (const file of [
    ...pinnedBaseConfigs(repository),
    ...["wrangler.jsonc", "package.json"].map((name) => `${portal}/${name}`),
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(repository, file), join(root, file));
  }
  const deployWith = async (entry: string) => {
    writeFileSync(join(root, "deployment.jsonc"), FILLED.replace('"gatekeepers": {}', `"gatekeepers": { "mcpportal": ${entry} }`));
    const harness = testContext({ root, client: cfClient({ spawn: filledAccount({}).spawn }) });
    const { deps, steps } = recordingDeploy({});
    assert.equal(await run({ command: "deploy", values: {}, positionals: [] }, harness.ctx, {}, deps), 0);
    assert.deepEqual(steps, ["build", "deploy"]);
    return harness.log.filter((line) => line.includes("MCP_PORTAL_URL"));
  };
  assert.deepEqual(await deployWith('{ "name": "acme-gk-mcpportal" }'), [
    "\nWarning: gatekeepers.mcpportal.vars.MCP_PORTAL_URL is not set, so the app hides the mcpportal Gatekeeper. " +
      "Set it to the MCP server portal endpoint.",
  ]);
  assert.deepEqual(
    await deployWith('{ "name": "acme-gk-mcpportal", "vars": { "MCP_PORTAL_URL": "https://portal.example.com/mcp" } }'), []);
});

/** Obviously fake OAuth credentials, as init would hand them over. */
const PENDING: PendingSecrets[] = [
  { gatekeeper: "github", worker: "acme-gk-github", values: { CLIENT_ID: "gh-id-123", CLIENT_SECRET: "gh-secret-456" } },
];

/**
 * Deploy deps recording each step in `steps`, whose `wrangler secret bulk` adds to `secrets` unless
 * `parses` is false.
 */
function recordingDeploy(secrets: Record<string, string[]>, { deployFails = false, parses = true } = {}) {
  const steps: string[] = [];
  const inputs: { input: string; accountId?: string }[] = [];
  const deps: DeployDeps = {
    build: async () => {
      steps.push("build");
    },
    deploy: async (_ctx, _config, _catalog, check) => {
      steps.push(check ? "dry-run" : "deploy");
      if (deployFails) throw new Error("acme-gk-router: wrangler deploy failed. Its output is above.");
    },
    spawn: (command, args, { env, input }) => {
      steps.push([command, ...args].join(" "));
      if (input !== undefined) {
        inputs.push({ input, accountId: env?.CLOUDFLARE_ACCOUNT_ID });
        const worker = args[args.indexOf("--name") + 1];
        if (parses) secrets[worker] = [...secrets[worker] ?? [], ...Object.keys(JSON.parse(input))];
      }
      return { status: 0, stdout: "" };
    },
  };
  return { deps, steps, inputs };
}

/** Asserts no secret value reached the output. */
function assertNoValues(harness: { stderr: () => string; json: unknown[] }): void {
  for (const where of [harness.stderr(), JSON.stringify(harness.json)]) {
    for (const value of Object.values(PENDING[0].values)) {
      assert.ok(!where.includes(value), `a secret value leaked into ${where}`);
    }
  }
}

test("deploy warns, in one line, about a Gatekeeper not deployed yet when no secrets come with it", async (t) => {
  const { root } = githubProject(t);
  const secrets: Record<string, string[]> = {};
  const harness = testContext({ root, client: cfClient({ spawn: filledAccount(secrets).spawn }) });
  const { deps, steps } = recordingDeploy(secrets);
  assert.equal(await run({ command: "deploy", values: {}, positionals: [] }, harness.ctx, {}, deps), 0);
  assert.deepEqual(steps, ["build", "deploy"]);
  assert.deepEqual(harness.log.filter((line) => line.includes("acme-gk-github")),
    ["\nWarning: acme-gk-github is not deployed yet; after the deploy, `pnpm cf-os secrets github` sets its " +
      "CLIENT_ID and CLIENT_SECRET."]);
});

test("the cf-os secrets command a warning names reads the deployment file the deploy did", async (t) => {
  const { root } = githubProject(t);
  copyFileSync(join(root, "deployment.jsonc"), join(root, "staging.jsonc"));
  const secrets: Record<string, string[]> = { "acme-gk-github": ["CLIENT_ID"] };
  const harness = testContext({ root, client: cfClient({ spawn: filledAccount(secrets).spawn }), flags: { config: "staging.jsonc" } });
  const { deps } = recordingDeploy(secrets);
  assert.equal(await run({ command: "deploy", values: {}, positionals: [] }, harness.ctx, {}, deps), 0);
  assert.deepEqual(harness.log.filter((line) => line.includes("acme-gk-github")),
    ["\nWarning: acme-gk-github has no CLIENT_SECRET; nobody can connect the github Gatekeeper until " +
      "`pnpm cf-os secrets github --config staging.jsonc` sets it."]);
});

test("deploy sets the secrets init asked for once every Worker has deployed, and confirms them", async (t) => {
  const { root } = githubProject(t);
  const secrets: Record<string, string[]> = {};
  const cf = filledAccount(secrets);
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }) });
  const { deps, steps, inputs } = recordingDeploy(secrets);
  assert.equal(await run({ command: "deploy", values: {}, positionals: [] }, harness.ctx, { secrets: PENDING }, deps), 0);
  assert.deepEqual(steps, ["build", "deploy", "pnpm exec wrangler secret bulk --name acme-gk-github"]);
  assert.deepEqual(inputs.map(({ input, accountId }) => [JSON.parse(input), accountId]),
    [[PENDING[0].values, FAKE_ACCOUNT]]);
  // Not looked up for the warnings, which leave it out, but listed after the upload to confirm it.
  assert.equal(cf.calls.filter((call) => call.args.join(" ") === "workers secrets list --script-name acme-gk-github").length, 1);
  // Not warned about: its secrets are about to be set.
  assert.doesNotMatch(harness.stderr(), /Warning: acme-gk-github/);
  assert.match(harness.stderr(), /\nacme-gk-github's CLIENT_ID and CLIENT_SECRET will be set once it is deployed\./);
  assert.match(harness.stderr(), /\nSet CLIENT_ID and CLIENT_SECRET on acme-gk-github\./);
  assert.deepEqual(harness.json, []);
  assertNoValues(harness);
});

test("a failed deploy sets no secret, and names the cf-os secrets command that sets them", async (t) => {
  const { root } = githubProject(t);
  const secrets: Record<string, string[]> = {};
  const harness = testContext({ root, client: cfClient({ spawn: filledAccount(secrets).spawn }) });
  const { deps, steps } = recordingDeploy(secrets, { deployFails: true });
  await assert.rejects(run({ command: "deploy", values: {}, positionals: [] }, harness.ctx, { secrets: PENDING }, deps),
    /wrangler deploy failed/);
  assert.deepEqual(steps, ["build", "deploy"]);
  assert.deepEqual(secrets, {});
  assert.ok(harness.log.includes("\nThe github Gatekeeper's OAuth credentials were not set, as the deploy did not " +
    "finish: once it is fixed, `pnpm cf-os secrets github` sets them."));
  assertNoValues(harness);
});

test("the cf-os secrets command named after a failure reads the deployment file the deploy did", async (t) => {
  const { root } = githubProject(t);
  copyFileSync(join(root, "deployment.jsonc"), join(root, "staging.jsonc"));
  const secrets: Record<string, string[]> = {};
  const harness = testContext({ root, client: cfClient({ spawn: filledAccount(secrets).spawn }), flags: { config: "staging.jsonc" } });
  const { deps } = recordingDeploy(secrets, { deployFails: true });
  await assert.rejects(run({ command: "deploy", values: {}, positionals: [] }, harness.ctx, { secrets: PENDING }, deps),
    /wrangler deploy failed/);
  assert.ok(harness.log.includes("\nThe github Gatekeeper's OAuth credentials were not set, as the deploy did not " +
    "finish: once it is fixed, `pnpm cf-os secrets github --config staging.jsonc` sets them."));
});

test("deploy exits 1, naming cf-os secrets, when an upload does not show up on the Worker", async (t) => {
  const { root } = githubProject(t);
  const secrets: Record<string, string[]> = {};
  const harness = testContext({ root, client: cfClient({ spawn: filledAccount(secrets).spawn }) });
  const { deps, steps } = recordingDeploy(secrets, { parses: false });
  assert.equal(await run({ command: "deploy", values: {}, positionals: [] }, harness.ctx, { secrets: PENDING }, deps), 1);
  assert.deepEqual(steps, ["build", "deploy", "pnpm exec wrangler secret bulk --name acme-gk-github"]);
  assert.ok(harness.log.includes("\nDeployed, but the github Gatekeeper's OAuth credentials were not set: Wrangler " +
    "finished, but acme-gk-github has no CLIENT_ID or CLIENT_SECRET. `pnpm cf-os secrets github` tries again."));
  assertNoValues(harness);
});

test("prints the same whichever account read finishes first, and with a spinner over each check", async (t) => {
  const { root } = githubProject(t);
  const deploy = async (prompter: ReturnType<typeof scriptedPrompter> | null, delay?: (args: string[]) => number) => {
    const secrets: Record<string, string[]> = { "acme-gk-github": ["CLIENT_ID"] };
    const harness = testContext({ root, prompter, client: cfClient({ spawn: filledAccount(secrets, delay).spawn }) });
    const { deps } = recordingDeploy(secrets);
    const code = await run({ command: "deploy", values: {}, positionals: [] }, harness.ctx, {}, deps);
    return { code, stderr: harness.stderr(), json: harness.json };
  };
  const plain = await deploy(null);
  assert.equal(plain.code, 0);
  assert.match(plain.stderr, /Cloudflare-side checks passed[\s\S]*Durable Object migrations checked[\s\S]*Warning: acme-gk-github has no CLIENT_SECRET/);
  assert.deepEqual(await deploy(null, lateFirst()), plain);
  const prompter = scriptedPrompter([]);
  assert.deepEqual(await deploy(prompter), plain);
  assert.deepEqual(prompter.waited, ["Checking the account against the deployment file", "Checking the Gatekeepers' secrets"]);
});

test("the account checks that fail print the same whichever read finishes first", async (t) => {
  const { root } = githubProject(t);
  writeFileSync(join(root, "deployment.jsonc"), FILLED
    .replace('"gatekeepers": {}', '"gatekeepers": { "github": { "name": "acme-gk-github" } }')
    .replace('"blueprintContentBucket": null', '"blueprintContentBucket": "acme-content"')
    .replace('"blueprintsKvNamespaceId": null', '"blueprintsKvNamespaceId": "kv-blueprints"'));
  const check = async (delay?: (args: string[]) => number) => {
    const cf = fakeCf({
      "zero-trust organization get": { auth_domain: "other.cloudflareaccess.com" },
      "zero-trust access applications list": [],
      "kv namespaces list": [],
      "r2 buckets list": { buckets: [] },
      ...liveReplies({}),
    }, { delay });
    const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }) });
    const message = await run({ command: "deploy", values: {}, positionals: [] }, harness.ctx, {}, recordingDeploy({}).deps)
      .then(() => "", (error: Error) => error.message);
    return { message, stderr: harness.stderr(), calls: cf.calls.length };
  };
  const plain = await check();
  assert.match(plain.message, /does not match the account:\n {2}- access\.issuer is .*\n {2}- access\.audience: .*\n {2}- resources\.blueprintsKvNamespaceId: .*\n {2}- resources\.blueprintContentBucket: /);
  // The four the account check reads, the GitHub Worker's secrets, read beside them, and what the
  // migration check reads: the Durable Object namespaces, and the deployments of each of the eight Workers.
  assert.equal(plain.calls, 5 + 1 + 8);
  assert.deepEqual(await check(lateFirst()), plain);
});

/** Every `cf` command `check` and `deploy` may run: reads, each one. */
const READS = /^(?:zero-trust organization get|zero-trust access applications list|kv namespaces list|r2 buckets list|ai-gateway gateways list|workers secrets list|workers deployments list|workers versions get|durable-objects namespaces list)(?: |$)/;

/** Asserts `calls` wrote nothing to the account. */
function assertReadOnly(calls: { args: string[] }[]): void {
  for (const { args } of calls) assert.match(args.join(" "), READS);
}

/** The Durable Object classes the pinned Workshop's migrations create: what a backend on this project's release stores. */
const WORKSHOP_CLASSES = pinnedDurableObjects("acme-backend");

test("check and deploy refuse a Worker whose storage is ahead of this project, before building or deploying", async (t) => {
  const { root, github } = githubProject(t);
  // The Workshop was updated through the hosted flow to a release that added a class this pin does not have.
  const ahead = {
    "acme-workshop": hostedWorkerLive("acme-workshop", {
      release: "r005100-abcdef1",
      durableObjects: [...WORKSHOP_CLASSES, "AddedByALaterRelease"],
    }),
  };
  const secrets = { "acme-gk-github": ["CLIENT_ID", "CLIENT_SECRET"] };
  for (const command of ["check", "deploy"]) {
    const cf = filledAccount(secrets, undefined, ahead);
    const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }) });
    const { deps, steps } = recordingDeploy({});
    await assert.rejects(run({ command, values: {}, positionals: [] }, harness.ctx, { secrets: PENDING }, deps), (error: Error) => {
      assert.equal(error.message,
        "This project's pinned cloudflare-os is behind the Durable Object storage of Workers it would deploy over:\n" +
        "  - Worker acme-workshop stores Durable Objects of a class no migration in this project's configuration for it " +
        "creates (AddedByALaterRelease).\n" +
        "Deploying would put older code over storage a newer release has already migrated, which cannot be undone, so " +
        "nothing was built or deployed. Move the pin to what those Workers run, or past it, first: " +
        "`pnpm cf-os update --to <commit>`, with the cloudflare-os commit those Workers were deployed from or a newer one " +
        "(their live versions, which the hosted flow uploaded, name release r005100-abcdef1, built from commit abcdef1: " +
        "pass it only where this project's pin is behind that commit, as `update --to` an older commit moves the pin " +
        "back); or take the instance over again with a fresh command from the hosted deploy flow, which moves the pin " +
        "forward only (docs/migrate-from-hosted.md).");
      return true;
    }, command);
    // Nothing built, nothing deployed, no secret set, nothing but reads; and no generated config is left behind.
    assert.deepEqual(steps, [], command);
    for (const dir of [...Object.values(PACKAGE_DIRS), github]) {
      assert.equal(existsSync(join(root, dir, "wrangler.prod.jsonc")), false, `${command}: ${dir}`);
    }
    assertReadOnly(cf.calls);
    assert.doesNotMatch(harness.stderr(), /Durable Object migrations checked|Building|Deploying /);
    assert.deepEqual(harness.json, []);
    assertNoValues(harness);
  }

  // Beside a deployment file that does not match the account, both are said, in one failure.
  const cf = fakeCf({
    "zero-trust organization get": { auth_domain: "acme.cloudflareaccess.com" },
    "zero-trust access applications list": [],
    "workers secrets list": workerSecretsReply(secrets),
    ...liveReplies(ahead),
  });
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }) });
  const { deps, steps } = recordingDeploy({});
  await assert.rejects(run({ command: "deploy", values: {}, positionals: [] }, harness.ctx, {}, deps),
    /^Error: deployment\.jsonc does not match the account:\n {2}- access\.audience: .*\nThis project's pinned cloudflare-os is behind .*\n {2}- Worker acme-workshop stores /);
  assert.deepEqual(steps, []);
});

test("check and deploy refuse storage under a Worker whose configuration has no migrations at all", async (t) => {
  const { root } = githubProject(t);
  // Neither the router nor the Error Reporter has a Durable Object in this project, so any class one stores is ahead of it.
  for (const worker of ["acme-router", "acme-error-reporter"]) {
    const stray = { [worker]: hostedWorkerLive(worker, { durableObjects: ["AddedByALaterRelease"] }) };
    for (const command of ["check", "deploy"]) {
      const cf = filledAccount({ "acme-gk-github": ["CLIENT_ID", "CLIENT_SECRET"] }, undefined, stray);
      const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }) });
      const { deps, steps } = recordingDeploy({});
      await assert.rejects(run({ command, values: {}, positionals: [] }, harness.ctx, {}, deps),
        new RegExp(`^Error: This project's pinned cloudflare-os is behind .*\\n {2}- Worker ${worker} stores Durable Objects of ` +
          "a class no migration in this project's configuration for it creates \\(AddedByALaterRelease\\)\\.\\n"),
        `${command} over ${worker}`);
      assert.deepEqual(steps, [], `${command} over ${worker}`);
      assertReadOnly(cf.calls);
    }
  }
});

test("stops where the wizard it handed an unconfigured project to stopped, with nothing built or deployed", async (t) => {
  const { root } = githubProject(t);
  const configured = readFileSync(join(root, "deployment.jsonc"), "utf8");
  for (const command of ["check", "deploy"]) {
    writeFileSync(join(root, "deployment.jsonc"), TEMPLATE);
    const cf = fakeCf({});
    const prompter = scriptedPrompter([["Run `cf-os init` now?", true]]);
    const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }), prompter });
    const { deps, steps } = recordingDeploy({});
    const handed: string[] = [];
    // The wizard as it ends when it stops with the file already whole: a file that would deploy, and
    // exit 1 all the same. Its exit code is what stops this run, not what the file is left holding.
    const code = await run({ command, values: {}, positionals: [] }, harness.ctx, {}, {
      ...deps,
      configure: async (ctx) => {
        handed.push(ctx.root);
        writeFileSync(join(ctx.root, "deployment.jsonc"), configured);
        return 1;
      },
    });
    assert.equal(code, 1, command);
    assert.deepEqual(handed, [root]);
    assert.deepEqual(steps, [], command);
    assert.deepEqual(cf.calls, []);
    assert.deepEqual(prompter.remaining(), []);
    assert.equal(readFileSync(join(root, "deployment.jsonc"), "utf8"), configured);
    assert.doesNotMatch(harness.stderr(), /Continuing with/);
  }
});

/** What `deploy` fails with when credentials kept it from checking the Workers' migrations, the reason matching `reason`. */
function uncheckedMigrations(reason: string): RegExp {
  return new RegExp(
    "^Error: Whether the Durable Object storage of the Workers this deploys over is ahead of this project's pinned " +
    `cloudflare-os could not be checked:\\n {2}- ${reason}\\n` +
    "Deploying older code over storage a newer release has migrated cannot be undone, and wrangler does not refuse it, " +
    "so nothing was built or deployed\\. Run this again once `cf` can read the account; of a token, this check needs " +
    "Workers Scripts Read alone\\.$");
}

/** Every `cf` read `check` and `deploy` make, each failing as `cf` does when it is signed out. */
function signedOutAccount() {
  const signedOut = { fail: "No authentication token found." };
  return fakeCf(Object.fromEntries([
    "zero-trust organization get", "zero-trust access applications list", "workers secrets list",
    "workers deployments list", "durable-objects namespaces list",
  ].map((command) => [command, signedOut])));
}

test("deploy refuses, before building, when credentials keep it from checking the Workers' migrations", async (t) => {
  const { root, github } = githubProject(t);
  const cf = signedOutAccount();
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }) });
  const { deps, steps } = recordingDeploy({});
  // Signed out, nothing says the Workers' storage is not ahead of the pin, and wrangler uploads
  // over a live migration tag its config lacks with a warning: the refusal is this command's to make.
  await assert.rejects(run({ command: "deploy", values: {}, positionals: [] }, harness.ctx, { secrets: PENDING }, deps),
    uncheckedMigrations("cf durable-objects namespaces list .*No authentication token found.*"));
  assert.deepEqual(steps, []);
  for (const dir of [...Object.values(PACKAGE_DIRS), github]) {
    assert.equal(existsSync(join(root, dir, "wrangler.prod.jsonc")), false, dir);
  }
  assertReadOnly(cf.calls);
  // The Access checks it could not make are still said, as a line; the migration check is the failure.
  assert.deepEqual(harness.log.filter((line) => line.startsWith("\nSkipped ")).map((line) => line.slice(0, 33)),
    ["\nSkipped Cloudflare-side checks: "]);
  assert.doesNotMatch(harness.stderr(), /checks passed|migrations checked|Building|Deploying /);
  assert.deepEqual(harness.json, []);
  assertNoValues(harness);

  // Access checked and passed, the Workers not readable: still no deploy.
  const notPermitted = { fail: "[10000] Authentication error" };
  const accessOnly = fakeCf({
    "zero-trust organization get": { auth_domain: "acme.cloudflareaccess.com" },
    "zero-trust access applications list": [{ name: "Cloudflare OS", aud: "aud-1", domain: "os.example.com" }],
    "workers secrets list": workerSecretsReply({ "acme-gk-github": ["CLIENT_ID", "CLIENT_SECRET"] }),
    "workers deployments list": notPermitted,
    "durable-objects namespaces list": notPermitted,
  });
  const passed = testContext({ root, client: cfClient({ spawn: accessOnly.spawn }) });
  const unread = recordingDeploy({});
  await assert.rejects(run({ command: "deploy", values: {}, positionals: [] }, passed.ctx, {}, unread.deps),
    uncheckedMigrations("cf durable-objects namespaces list .*10000.*"));
  assert.deepEqual(unread.steps, []);
  assert.doesNotMatch(passed.stderr(), /Skipped|checks passed|migrations checked/);

  // The namespaces read and showing nothing ahead, the Workers' deployments not readable: half a check is not one.
  const half = fakeCf({
    "zero-trust organization get": { auth_domain: "acme.cloudflareaccess.com" },
    "zero-trust access applications list": [{ name: "Cloudflare OS", aud: "aud-1", domain: "os.example.com" }],
    "workers secrets list": workerSecretsReply({ "acme-gk-github": ["CLIENT_ID", "CLIENT_SECRET"] }),
    ...liveReplies({ "acme-workshop": hostedWorkerLive("acme-workshop", { durableObjects: WORKSHOP_CLASSES }) }),
    "workers deployments list": notPermitted,
  });
  const halfChecked = testContext({ root, client: cfClient({ spawn: half.spawn }) });
  const halfSteps = recordingDeploy({});
  await assert.rejects(run({ command: "deploy", values: {}, positionals: [] }, halfChecked.ctx, {}, halfSteps.deps),
    uncheckedMigrations("cf workers deployments list --script-name acme-router: .*10000.*"));
  assert.deepEqual(halfSteps.steps, []);
});

test("check and deploy refuse a class the namespaces show ahead of this project, though the Workers could not be read", async (t) => {
  const { root } = githubProject(t);
  for (const command of ["check", "deploy"]) {
    // The namespaces list answers and shows the Workshop storing a class this pin does not have;
    // each Worker's deployments are not permitted to the token.
    const cf = fakeCf({
      "zero-trust organization get": { auth_domain: "acme.cloudflareaccess.com" },
      "zero-trust access applications list": [{ name: "Cloudflare OS", aud: "aud-1", domain: "os.example.com" }],
      "workers secrets list": workerSecretsReply({ "acme-gk-github": ["CLIENT_ID", "CLIENT_SECRET"] }),
      ...liveReplies({
        "acme-workshop": hostedWorkerLive("acme-workshop", { durableObjects: [...WORKSHOP_CLASSES, "AddedByALaterRelease"] }),
      }),
      "workers deployments list": { fail: "[10000] Authentication error" },
    });
    const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }) });
    const { deps, steps } = recordingDeploy({});
    await assert.rejects(run({ command, values: {}, positionals: [] }, harness.ctx, {}, deps),
      /^Error: This project's pinned cloudflare-os is behind .*\n {2}- Worker acme-workshop stores Durable Objects of a class .* \(AddedByALaterRelease\)\.\n.* first: `pnpm cf-os update --to <commit>`, /,
      command);
    assert.deepEqual(steps, [], command);
    assertReadOnly(cf.calls);
  }
});

test("check says each check it could not make without credentials and carries on, and judges the Workers apart from Access", async (t) => {
  const { root, github } = githubProject(t);
  // A directory where GitHub's generated config goes stops the run at that write, just past the
  // account checks: a check uploads nothing, so one it could not make is said and no more.
  mkdirSync(join(root, github, "wrangler.prod.jsonc"));
  const cf = signedOutAccount();
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }) });
  await assert.rejects(run({ command: "check", values: {}, positionals: [] }, harness.ctx, {}, recordingDeploy({}).deps),
    /EISDIR|is a directory/);
  const skipped = harness.log.filter((line) => line.startsWith("\nSkipped "));
  assert.equal(skipped.length, 2);
  assert.match(skipped[0], /^\nSkipped Cloudflare-side checks: cf zero-trust organization get: .*No authentication token found/);
  assert.match(skipped[1], /^\nSkipped the Durable Object migration check: cf durable-objects namespaces list .*No authentication token found.*\nWhether the account's Workers run a newer cloudflare-os than this project pins was not checked; deploying an older one over their storage cannot be undone, and `pnpm cf-os deploy` refuses until it can make this check\.$/);
  assert.doesNotMatch(harness.stderr(), /checks passed|migrations checked/);
  assertReadOnly(cf.calls);

  // A token that may read Workers and not Access: the Access checks are skipped, the Workers are still held.
  const notPermitted = { fail: "[10000] Authentication error" };
  for (const command of ["check", "deploy"]) {
    const partial = fakeCf({
      "zero-trust organization get": notPermitted,
      "zero-trust access applications list": notPermitted,
      "workers secrets list": workerSecretsReply({}),
      ...liveReplies({
        "acme-context": hostedWorkerLive("acme-context", { durableObjects: ["ContextCollectionDurableObject", "AddedByALaterRelease"] }),
      }),
    });
    const held = testContext({ root, client: cfClient({ spawn: partial.spawn }) });
    const refused = recordingDeploy({});
    await assert.rejects(run({ command, values: {}, positionals: [] }, held.ctx, {}, refused.deps),
      /^Error: This project's pinned cloudflare-os is behind .*\n {2}- Worker acme-context stores Durable Objects of a class .* \(AddedByALaterRelease\)\./,
      command);
    assert.deepEqual(refused.steps, [], command);
    assert.match(held.stderr(), /Skipped Cloudflare-side checks: cf zero-trust organization get/);
  }

  // With the Workers readable and nothing ahead, a deploy goes on without the Access checks, which it says it skipped.
  const workersOnly = fakeCf({
    "zero-trust organization get": notPermitted,
    "zero-trust access applications list": notPermitted,
    "workers secrets list": workerSecretsReply({}),
    ...liveReplies({}),
  });
  const { root: clean } = githubProject(t);
  const deployed = testContext({ root: clean, client: cfClient({ spawn: workersOnly.spawn }) });
  const went = recordingDeploy({});
  assert.equal(await run({ command: "deploy", values: {}, positionals: [] }, deployed.ctx, {}, went.deps), 0);
  assert.deepEqual(went.steps, ["build", "deploy"]);
  assert.match(deployed.stderr(), /Skipped Cloudflare-side checks: [\s\S]*Durable Object migrations checked/);
  assert.doesNotMatch(deployed.stderr(), /Skipped the Durable Object migration check|could not be checked/);
});

/** The push identity a take-over wrote into the project: a hosted backend's four variables. */
const PUSH = {
  serviceUrl: "https://push.example.com",
  installId: "install-acme",
  keyId: "key-1",
  webPushPublicKey: "BFixtureWebPushPublicKey",
};

/** The name of the secret holding the key the push identity signs with, as the pinned backend reads it. */
const PUSH_KEY = "CFOS_INSTALL_PRIVATE_KEY";

/** The Workshop of {@link FILLED} as the hosted flow left it: the push identity, its signing key, and the install description. */
function hostedWorkshop(): WorkerLive {
  return hostedWorkerLive("acme-workshop", {
    vars: {
      PUBLIC_BASE_URL: "https://os.example.com",
      NOTIFICATION_SERVICE_URL: PUSH.serviceUrl,
      CFOS_INSTALL_ID: PUSH.installId,
      CFOS_INSTALL_KEY_ID: PUSH.keyId,
      NOTIFICATION_WEB_PUSH_PUBLIC_KEY: PUSH.webPushPublicKey,
    },
    json: { ADMINS: ["me@example.com"], CLOUDFLARE_OS_DEPLOYMENT: { releaseId: "r004945-6c8d301" } },
    secrets: [PUSH_KEY],
    durableObjects: WORKSHOP_CLASSES,
  });
}

/**
 * Stands in for `wrangler deploy` and the Workers API behind it, over the account `live` describes:
 * each of the starter's own Workers whose generated config the deploy wrote becomes a new live
 * version of the Worker that config names, and `uploaded` keeps each config as it was read.
 *
 * The version's bindings are the API's rule for the upload wrangler makes. Its variables and service
 * bindings are the config's and no others, none of the previous version's surviving; and the previous
 * version's secrets are carried over, since `wrangler deploy` uploads with `keep_bindings` for
 * `secret_text` and `secret_key`, except one the config itself binds something under the name of.
 * That rule is written here, not exercised: what this stand-in can show is what this CLI hands to
 * wrangler.
 */
function uploadingDeploy(
  root: string,
  live: Record<string, WorkerLive>,
  uploaded: Record<string, ProdWranglerConfig>,
): DeployDeps["deploy"] {
  return async (_ctx, _config, _catalog, check) => {
    if (check) return;
    for (const dir of Object.values(PACKAGE_DIRS)) {
      const path = join(root, dir, "wrangler.prod.jsonc");
      if (!existsSync(path)) continue;
      const config: ProdWranglerConfig = JSON.parse(readFileSync(path, "utf8"));
      const name = config.name;
      assert.ok(name, `${path} names no Worker`);
      uploaded[name] = config;
      const before = live[name];
      const previous = before?.versions.find((version) => version.id === before.deployments[0]?.versions[0]?.version_id);
      const bindings: CfWorkerBinding[] = [
        ...Object.entries(config.vars ?? {}).map(([key, value]): CfWorkerBinding =>
          typeof value === "string" ? { name: key, type: "plain_text", text: value } : { name: key, type: "json", json: value }),
        ...(config.services ?? []).map(({ binding, service }): CfWorkerBinding => ({ name: binding, type: "service", service })),
      ];
      const kept = (previous?.bindings ?? []).filter((binding) =>
        ["secret_text", "secret_key"].includes(binding.type) && !bindings.some((bound) => bound.name === binding.name));
      const number = (before?.versions.length ?? 0) + 1;
      const version: CfWorkerVersion = {
        id: fixtureVersionId(name, number),
        number,
        created_on: "2026-11-01T10:00:00.000Z",
        source: "wrangler",
        annotations: { "workers/triggered_by": "upload" },
        bindings: [...bindings, ...kept],
        migration_tag: null,
      };
      live[name] = {
        deployments: [
          { id: fixtureVersionId(`${name} deployment`, number), source: "wrangler", versions: [{ version_id: version.id, percentage: 100 }] },
          ...(before?.deployments ?? []),
        ],
        versions: [version, ...(before?.versions ?? [])],
        durableObjects: before?.durableObjects ?? [],
      };
    }
  };
}

/**
 * Deploys the project at `root` over an account whose Workshop is {@link hostedWorkshop}, through
 * {@link uploadingDeploy}, and reads the Workshop back the way a take-over reads a backend.
 */
async function deployOverHosted(root: string) {
  const live: Record<string, WorkerLive> = { "acme-workshop": hostedWorkshop() };
  const uploaded: Record<string, ProdWranglerConfig> = {};
  const cf = filledAccount({ "acme-gk-github": ["CLIENT_ID", "CLIENT_SECRET"] }, undefined, live);
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }) });
  const recording = recordingDeploy({});
  const upload = uploadingDeploy(root, live, uploaded);
  const deps: DeployDeps = {
    ...recording.deps,
    deploy: async (...args) => {
      await recording.deps.deploy(...args);
      await upload(...args);
    },
  };
  const code = await run({ command: "deploy", values: {}, positionals: [] }, harness.ctx, {}, deps);
  const after = await readWorker(cfClient({ spawn: fakeCf(liveReplies(live)).spawn }), FAKE_ACCOUNT, "acme-workshop");
  assert.ok(after, "the Workshop is gone");
  return { code, harness, steps: recording.steps, inputs: recording.inputs, calls: cf.calls, uploaded, after };
}

/**
 * A deploy over a taken-over instance keeps push working: the four variables are sent again, and the
 * key that signs with them is still bound afterwards.
 *
 * What is proved here is this CLI's part, at the one seam it has with wrangler: the Workshop config
 * it generates carries the four variables and binds nothing under the key's name, and the deploy
 * runs no command that sets or deletes a secret on the Workshop and makes no write through `cf`. That
 * the secret then survives rests on wrangler and the Workers API: `wrangler deploy` uploads with
 * `keep_bindings` for secrets (wrangler 4's `keepSecrets: true` on every deploy), which makes the new
 * version inherit each secret the config does not name. {@link uploadingDeploy} applies that rule;
 * no test here runs wrangler or reaches an account.
 */
test("a deploy over a taken-over instance sends the push identity again and leaves its signing key bound", async (t) => {
  const { root } = githubProject(t);
  const file = readFileSync(join(root, "deployment.jsonc"), "utf8");
  writeFileSync(join(root, "deployment.jsonc"), file.replace('"gatekeepers": {', `"pushIdentity": ${JSON.stringify(PUSH)},\n  "gatekeepers": {`));

  const { code, harness, steps, inputs, calls, uploaded, after } = await deployOverHosted(root);
  assert.equal(code, 0);
  // The whole of what ran: the builds and the deploys. No `wrangler secret` command, and `cf` only read.
  assert.deepEqual(steps, ["build", "deploy"]);
  assert.deepEqual(inputs, []);
  assertReadOnly(calls);
  assert.match(harness.stderr(), /Durable Object migrations checked: no Worker this deploys over shows storage ahead of the pinned cloudflare-os\./);

  // What was handed to wrangler for the Workshop: the four variables, and nothing under the key's name.
  const workshop = uploaded["acme-workshop"];
  assert.deepEqual(
    Object.fromEntries(Object.entries(workshop.vars ?? {}).filter(([name]) => /^(?:NOTIFICATION_|CFOS_)/.test(name))),
    {
      NOTIFICATION_SERVICE_URL: PUSH.serviceUrl,
      CFOS_INSTALL_ID: PUSH.installId,
      CFOS_INSTALL_KEY_ID: PUSH.keyId,
      NOTIFICATION_WEB_PUSH_PUBLIC_KEY: PUSH.webPushPublicKey,
    });
  for (const [name, config] of Object.entries(uploaded)) assert.ok(!JSON.stringify(config).includes(PUSH_KEY), name);
  assert.equal(workshop.secrets, undefined);

  // The Workshop afterwards, read as a take-over reads a backend: the same identity, the key still bound.
  const [version] = after.versions;
  assert.equal(version.source, "wrangler");
  const values = backendValues(after);
  assert.deepEqual(values.push, PUSH);
  assert.equal(values.pushKeyBound, true);
  assert.deepEqual(version.bindings?.filter((binding) => binding.name === PUSH_KEY), [{ name: PUSH_KEY, type: "secret_text" }]);
  // What the hosted flow's install description was is gone with the variables the project does not send.
  assert.deepEqual(version.bindings?.filter((binding) => binding.name.startsWith("CLOUDFLARE_OS_")), []);
  // The key is never named in anything printed, and no generated config outlives the run.
  assert.ok(!harness.stderr().includes(PUSH_KEY));
  assert.deepEqual(harness.json, []);
  assert.equal(existsSync(join(root, PACKAGE_DIRS.workshop, "wrangler.prod.jsonc")), false);
});

test("a deploy of a project without a push identity sends none, and still leaves the Worker's secrets alone", async (t) => {
  const { root } = githubProject(t);
  const file = readFileSync(join(root, "deployment.jsonc"), "utf8");
  const results = [];
  for (const block of ["", '"pushIdentity": null,\n  ']) {
    writeFileSync(join(root, "deployment.jsonc"), file.replace('"gatekeepers": {', `${block}"gatekeepers": {`));
    const { code, steps, inputs, calls, uploaded, after } = await deployOverHosted(root);
    assert.equal(code, 0);
    assert.deepEqual(steps, ["build", "deploy"]);
    assert.deepEqual(inputs, []);
    assertReadOnly(calls);
    // A deploy leaves the Worker with the variables it sends and no others: without the block, the identity is gone.
    const values = backendValues(after);
    assert.equal(values.push, null);
    assert.equal(values.pushKeyBound, true);
    assert.deepEqual(Object.keys(uploaded["acme-workshop"].vars ?? {}).toSorted(), [
      "ADMINS", "CF_ACCESS_AUD", "CF_ACCESS_ISS", "CF_AI_GATEWAY", "CF_AI_GATEWAY_ACCOUNT_ID", "CF_AI_GATEWAY_PROVIDERS",
      "PUBLIC_BASE_URL",
    ]);
    results.push(uploaded);
  }
  // Absent or null, every Worker's config is the same.
  assert.deepEqual(results[0], results[1]);
});

test("reads no PDF renderer base on a pin without one, unless a selected Gatekeeper binds it", async (t) => {
  // A pin from before upstream had the renderer, as one rolled back to: every other base config.
  const root = scratchProject(t, TEMPLATE);
  const repo = join(import.meta.dirname, "..", "..", "..", "..");
  for (const [key, dir] of Object.entries(PACKAGE_DIRS)) {
    if (key === "pdfRenderer") continue;
    mkdirSync(join(root, dir), { recursive: true });
    copyFileSync(join(repo, dir, "wrangler.jsonc"), join(root, dir, "wrangler.jsonc"));
  }
  const config: DeploymentConfig = {
    accountId: "0123456789abcdef0123456789abcdef",
    publicBaseUrl: null,
    workers: {
      router: { name: "acme-os", route: { customDomain: "os.example.com" } },
      workshop: { name: "acme-os-backend" },
      context: { name: "acme-os-context" },
      scheduler: { name: "acme-os-scheduler" },
      websearch: { name: "acme-os-websearch" },
      customGatekeeper: { name: "acme-os-custom" },
      errorReporter: { name: "acme-os-errors" },
    },
    access: { issuer: "https://acme.cloudflareaccess.com", audience: "access-audience", admins: ["admin@example.com"] },
    aiGateway: { enabled: false, name: "cloudflare-os", accountId: null, providers: [] },
    context: { sharingDomain: null, kvNamespaceId: null, artifacts: { enabled: false } },
    customGatekeeper: { name: "Acme", message: "Use the company handbook." },
    errorReporting: { enabled: true, environment: "production", release: null },
    resources: { blueprintsKvNamespaceId: null, avatarsKvNamespaceId: null, blueprintContentBucket: null },
    observability: { enabled: true, headSamplingRate: 1, logs: { invocationLogs: true }, traces: { enabled: false, headSamplingRate: 1 } },
  } as DeploymentConfig;

  const catalog = testCatalog();
  const bases = await readBaseConfigs(root, config, catalog);
  assert.equal(bases.pdfRenderer, undefined);
  assert.equal(generateConfigs(config, bases, catalog).pdfRenderer, undefined);

  // With Google, the file it needs is named, and what the pin lacks.
  const withGoogle = { ...config, gatekeepers: { google: { name: "acme-os-google" } } } as DeploymentConfig;
  const googleCatalog = testCatalogWithGoogle();
  await assert.rejects(readBaseConfigs(root, withGoogle, googleCatalog), /pdf-renderer[/\\]wrangler\.jsonc/);
  assert.throws(() => generateConfigs(withGoogle, bases, googleCatalog),
    /cloudflare-os\/packages\/pdf-renderer\/wrangler\.jsonc is missing: the pinned cloudflare-os has no PDF renderer/);
});
