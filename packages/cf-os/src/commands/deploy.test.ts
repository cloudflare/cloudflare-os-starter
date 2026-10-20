import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { cfClient } from "../cf-client.ts";
import { PACKAGE_DIRS } from "../core/deployment.ts";
import { FAKE_ACCOUNT, fakeCf, workerSecretsReply } from "../fake-cf.ts";
import { CANCEL, DEFAULT, scratchProject, scriptedPrompter, TEMPLATE, testContext } from "../test-support.ts";
import type { PendingSecrets } from "../gatekeeper-secrets.ts";
import { run, type DeployDeps } from "./deploy.ts";
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

/** An installed project with the real base configs and GitHub's package, {@link FILLED} selecting GitHub. */
function githubProject(t: Parameters<typeof scratchProject>[0]): { root: string; github: string } {
  const root = installedProject(t);
  const repository = join(import.meta.dirname, "..", "..", "..", "..");
  const github = "cloudflare-os/packages/gatekeeper-github";
  for (const file of [
    ...Object.values(PACKAGE_DIRS).map((dir) => `${dir}/wrangler.jsonc`),
    ...["wrangler.jsonc", "package.json", "deploy-inputs.json"].map((name) => `${github}/${name}`),
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(repository, file), join(root, file));
  }
  writeFileSync(join(root, "deployment.jsonc"),
    FILLED.replace('"gatekeepers": {}', '"gatekeepers": { "github": { "name": "acme-gk-github" } }'));
  return { root, github };
}

/** An account matching {@link FILLED}, whose Worker secrets are `secrets`. */
function filledAccount(secrets: Record<string, string[]>, delay?: (args: string[]) => number) {
  return fakeCf({
    "zero-trust organization get": { auth_domain: "acme.cloudflareaccess.com" },
    "zero-trust access applications list": [{ name: "Cloudflare OS", aud: "aud-1", domain: "os.example.com" }],
    "workers secrets list": workerSecretsReply(secrets),
  }, { delay });
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
    ...Object.values(PACKAGE_DIRS).map((dir) => `${dir}/wrangler.jsonc`),
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
  assert.match(plain.stderr, /Cloudflare-side checks passed[\s\S]*Warning: acme-gk-github has no CLIENT_SECRET/);
  let started = 0;
  assert.deepEqual(await deploy(null, () => 60 - 10 * started++), plain);
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
    }, { delay });
    const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }) });
    const message = await run({ command: "deploy", values: {}, positionals: [] }, harness.ctx, {}, recordingDeploy({}).deps)
      .then(() => "", (error: Error) => error.message);
    return { message, stderr: harness.stderr(), calls: cf.calls.length };
  };
  const plain = await check();
  assert.match(plain.message, /does not match the account:\n {2}- access\.issuer is .*\n {2}- access\.audience: .*\n {2}- resources\.blueprintsKvNamespaceId: .*\n {2}- resources\.blueprintContentBucket: /);
  // The four the account check reads, and the GitHub Worker's secrets, read beside them.
  assert.equal(plain.calls, 5);
  let started = 0;
  assert.deepEqual(await check(() => 60 - 10 * started++), plain);
});
