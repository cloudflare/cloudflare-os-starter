import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cfClient } from "../cf-client.ts";
import { parseDeployment, valueAtPath } from "../deployment-file.ts";
import { FAKE_ACCOUNT, fakeCf, flag, type FakeReply } from "../fake-cf.ts";
import {
  DEFAULT,
  hostedAccount,
  scratchProject,
  scriptedPrompter,
  TEMPLATE,
  testContext,
  type Step,
} from "../test-support.ts";
import type { Context } from "../context.ts";
import { configure, NO_TERMINAL, run, type InitDeps } from "./init.ts";

const ZONE = { id: "zone-1", name: "example.com", status: "active" };

/** A signed-in account with one zone, an existing Worker to read the workers.dev subdomain off. */
function account(overrides: Record<string, FakeReply> = {}): Record<string, FakeReply> {
  return {
    "auth whoami": { authenticated: true, email: "me@example.com" },
    "accounts list": [{ id: FAKE_ACCOUNT, name: "Acme" }],
    "workers list": [{ name: "other", subdomain: { url: "https://other.acme-sub.workers.dev" } }],
    "zones list": [ZONE],
    "dns records list": (args) => flag(args, "--name-exact") === "os.example.com"
      ? [{ name: "os.example.com", type: "CNAME" }] : [],
    "ai-gateway gateways list": [{ id: "acme-ai" }],
    "zero-trust organization get": { auth_domain: "acme.cloudflareaccess.com" },
    "zero-trust access applications list": [],
    "zero-trust access applications create": (args) => ({ ...JSON.parse(flag(args, "--body")!), aud: "aud-new" }),
    "zero-trust identity-providers list": [{ id: "idp", type: "github" }],
    ...overrides,
  };
}

/** What the recording tools report, by `<command> <args>` prefix: an exit status and output. */
type ToolReplies = Record<string, { status?: number; stdout?: string }>;

/** Deps that record every tool run and every deploy, instead of running them. */
function recording(tools: ToolReplies = {}) {
  const ran: string[] = [];
  const deployed: Context[] = [];
  const deps: InitDeps = {
    spawn: (command, args) => {
      const line = [command, ...args].join(" ");
      ran.push(line);
      const key = Object.keys(tools).filter((candidate) => line.startsWith(candidate))
        .toSorted((a, b) => b.length - a.length)[0];
      return { status: key ? tools[key].status ?? 0 : 0, stdout: key ? tools[key].stdout ?? "" : "" };
    },
    deploy: async (ctx) => {
      deployed.push(ctx);
      return 0;
    },
  };
  return { deps, ran, deployed };
}

/** Runs `cfos init --out init.jsonc` in a scratch project, answering from `script`. */
async function init(
  t: Parameters<typeof scratchProject>[0],
  script: Step[],
  replies = account(),
  { flags = {}, tools, values = { out: "init.jsonc" }, offerDeploy }:
    { flags?: object; tools?: ToolReplies; values?: Record<string, string>; offerDeploy?: boolean } = {},
) {
  const root = scratchProject(t, TEMPLATE);
  const cf = fakeCf(replies);
  const prompter = scriptedPrompter(script);
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }), prompter, flags });
  const recorded = recording(tools);
  const code = await configure({ command: "init", values, positionals: [] }, harness.ctx, recorded.deps,
    { offerDeploy });
  assert.deepEqual(prompter.remaining(), [], "the script was not used up");
  const out = values.out ?? "deployment.jsonc";
  const written = (): Record<string, unknown> => parseDeployment(readFileSync(join(root, out), "utf8"));
  return { code, root, prompter, written, calls: cf.calls, ...recorded, ...harness };
}

/** The steps from the AI Gateway question to the end of a new deployment, all defaults. */
const REST: Step[] = [
  ["Admin emails", DEFAULT],
  ["Which AI Gateway", "default"],
  ["Which model providers?", ["cloudflare"]],
  ["Organization name", DEFAULT],
  ["What it tells agents", DEFAULT],
];

test("configures a new deployment on a custom domain, steering around a taken hostname", async (t) => {
  const { code, root, prompter, written, stderr, calls } = await init(t, [
    ["What are you setting up?", "new"],
    ["Base name", "acme-os"],
    ["Where will people reach it?", "custom"],
    ["Which zone?", "zone-1"],
    ["Hostname", DEFAULT],
    ["Pick a different hostname?", true],
    ["Which zone?", "zone-1"],
    ["Hostname", "cfos.example.com"],
    ...REST,
    ["No Access application covers cfos.example.com", "create"],
    ["Deploy now?", false],
  ]);
  assert.equal(code, 0);
  // Defaults the account supplied.
  const hostname = prompter.asked.find((asked) => asked.message === "Hostname")!;
  assert.equal(hostname.initial, "os.example.com");
  assert.match(stderr(), /os\.example\.com already has a DNS record \(CNAME\)/);
  assert.equal(prompter.asked.find((asked) => asked.message.startsWith("Admin emails"))!.initial, "me@example.com");
  assert.deepEqual(prompter.asked.find((asked) => asked.message.startsWith("Which AI Gateway"))!.choices,
    ["default", "acme-ai"]);

  const file = written();
  assert.equal(valueAtPath(file, ["accountId"]), FAKE_ACCOUNT);
  assert.equal(valueAtPath(file, ["publicBaseUrl"]), null);
  assert.deepEqual(valueAtPath(file, ["workers", "router"]), { name: "acme-os", route: { customDomain: "cfos.example.com" } });
  assert.equal(valueAtPath(file, ["workers", "errorReporter", "name"]), "acme-os-errors");
  assert.deepEqual(valueAtPath(file, ["access", "admins"]), ["me@example.com"]);
  assert.equal(valueAtPath(file, ["access", "issuer"]), "https://acme.cloudflareaccess.com");
  assert.equal(valueAtPath(file, ["access", "audience"]), "aud-new");
  assert.deepEqual(valueAtPath(file, ["customGatekeeper"]), {
    name: "Acme", message: "This is Acme's Cloudflare OS deployment.",
  });
  // Storage left to automatic provisioning, as the template has it.
  assert.equal(valueAtPath(file, ["resources", "blueprintsKvNamespaceId"]), null);

  const text = readFileSync(join(root, "init.jsonc"), "utf8");
  assert.ok(text.includes("// Worker names are permanent service identities."));
  assert.ok(text.includes("// Production: use a hostname in an active Cloudflare zone."));
  assert.equal(readFileSync(join(root, "deployment.jsonc"), "utf8"), TEMPLATE, "--out wrote in place");
  const create = calls.find((call) => call.args.includes("create"))!;
  assert.equal(JSON.parse(flag(create.args, "--body")!).domain, "cfos.example.com");
});

test("derives the workers.dev subdomain, and reuses an Access application already covering it", async (t) => {
  const { code, written, calls, stderr } = await init(t, [
    ["What are you setting up?", "new"],
    ["Base name", "acme-os"],
    ["Where will people reach it?", "workersDev"],
    ...REST,
    ["Deploy now?", false],
  ], account({
    "zero-trust access applications list": (args) => flag(args, "--domain") === "acme-os.acme-sub.workers.dev"
      ? [{ name: "Existing", aud: "aud-existing", domain: "acme-os.acme-sub.workers.dev" }] : [],
  }));
  assert.equal(code, 0);
  assert.match(stderr(), /answer on https:\/\/acme-os\.acme-sub\.workers\.dev/);
  const file = written();
  assert.equal(valueAtPath(file, ["publicBaseUrl"]), "https://acme-os.acme-sub.workers.dev");
  assert.deepEqual(valueAtPath(file, ["workers", "router", "route"]), { workersDev: true });
  assert.equal(valueAtPath(file, ["access", "audience"]), "aud-existing");
  assert.ok(!calls.some((call) => call.args.includes("create")), "created a duplicate");
});

test("asks for the subdomain when no Worker carries it, and can leave Access for later", async (t) => {
  const { code, written, stderr } = await init(t, [
    ["What are you setting up?", "new"],
    ["Base name", "acme-os"],
    ["Where will people reach it?", "workersDev"],
    ["workers.dev subdomain", "typed-sub"],
    ...REST,
    ["Add a One-time PIN provider?", false],
    ["No Access application covers", "skip"],
  ], account({ "workers list": [], "zero-trust identity-providers list": [] }));
  assert.equal(code, 0);
  assert.match(stderr(), /dash\.cloudflare\.com\/[0-9a-f]{32}\/workers-and-pages/);
  assert.match(stderr(), /no identity providers, so nobody could sign in/);
  const file = written();
  assert.equal(valueAtPath(file, ["publicBaseUrl"]), "https://acme-os.typed-sub.workers.dev");
  assert.equal(valueAtPath(file, ["access", "audience"]), "<ACCESS_AUDIENCE>");
  assert.match(stderr(), /Still placeholders in init\.jsonc:\n {2}access\.issuer\n {2}access\.audience\n/);
  assert.match(stderr(), /`pnpm cfos access --config init\.jsonc` fills access\.issuer and access\.audience\./);
  assert.doesNotMatch(stderr(), /Fill in/);
});

test("adds a One-time PIN provider, validating it first", async (t) => {
  const created: boolean[] = [];
  const { code } = await init(t, [
    ["What are you setting up?", "new"],
    ["Base name", "acme-os"],
    ["Where will people reach it?", "workersDev"],
    ...REST,
    ["Add a One-time PIN provider?", true],
    ["No Access application covers", "skip"],
  ], account({
    "zero-trust identity-providers list": [],
    "zero-trust identity-providers create": (args) => {
      created.push(args.includes("--dry-run"));
      assert.equal(JSON.parse(flag(args, "--body")!).type, "onetimepin");
      return { id: "otp", type: "onetimepin" };
    },
  }));
  assert.equal(code, 0);
  assert.deepEqual(created, [true, false]);
});

test("switches to a takeover when the name is a hosted instance", async (t) => {
  const { code, written, prompter, stderr } = await init(t, [
    ["What are you setting up?", "new"],
    ["Base name", "acme"],
    ['"acme" looks like a hosted instance', "takeover"],
    ["Admin emails", DEFAULT],
    ["Web Search Gatekeeper Worker name", DEFAULT],
    ["Custom Gatekeeper Worker name", DEFAULT],
    ["Error Reporter Worker name", DEFAULT],
    ["Which model providers?", ["cloudflare", "anthropic"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
    ["Deploy now?", false],
  ], { ...account(), ...hostedAccount(), "auth whoami": { authenticated: true, email: "me@example.com" } });
  assert.equal(code, 0);
  assert.equal(prompter.asked.find((asked) => asked.message.startsWith("What are you setting up?"))!.hints!.takeover,
    "1 in this account");
  const file = written();
  assert.equal(valueAtPath(file, ["workers", "workshop", "name"]), "acme-backend");
  assert.equal(valueAtPath(file, ["workers", "websearch", "name"]), "acme-gk-websearch");
  assert.equal(valueAtPath(file, ["workers", "customGatekeeper", "name"]), "acme-gk-custom");
  assert.equal(valueAtPath(file, ["workers", "errorReporter", "name"]), "acme-errors");
  assert.deepEqual(valueAtPath(file, ["access", "admins"]), ["me@example.com"]);
  assert.equal(valueAtPath(file, ["access", "audience"]), "aud-acme");
  assert.equal(valueAtPath(file, ["resources", "blueprintsKvNamespaceId"]), "kv-blueprints");
  assert.equal(valueAtPath(file, ["accountId"]), FAKE_ACCOUNT);
  // What the hosted deploy never had is asked for too, so nothing is left as a placeholder.
  assert.deepEqual(valueAtPath(file, ["aiGateway", "providers"]), ["cloudflare", "anthropic"]);
  assert.deepEqual(valueAtPath(file, ["customGatekeeper"]), {
    name: "Acme", message: "This is Acme's Cloudflare OS deployment.",
  });
  assert.match(stderr(), /Next: `pnpm cfos deploy --config init\.jsonc`\./);
});

test("refuses to overwrite a taken name that is not an instance", async (t) => {
  const { code, written } = await init(t, [
    ["What are you setting up?", "new"],
    ["Base name", "other"],
    ["Base name", "fresh"],
    ["Where will people reach it?", "workersDev"],
    ...REST,
    ["No Access application covers", "skip"],
  ]);
  assert.equal(code, 0);
  assert.equal(valueAtPath(written(), ["workers", "router", "name"]), "fresh");
});

test("takes over a hosted instance chosen from the menu", async (t) => {
  const { code, written } = await init(t, [
    ["What are you setting up?", "takeover"],
    ["Which hosted instance?", "acme"],
    ["Admin emails", "ops@example.com, me@example.com"],
    ["Web Search Gatekeeper Worker name", "acme-search"],
    ["Custom Gatekeeper Worker name", DEFAULT],
    ["Error Reporter Worker name", DEFAULT],
    ["Which model providers?", ["cloudflare"]],
    ["Organization name", "Acme Corp"],
    ["What it tells agents", DEFAULT],
    ["Deploy now?", false],
  ], { ...account(), ...hostedAccount(), "auth whoami": { authenticated: true, email: "me@example.com" } });
  assert.equal(code, 0);
  const file = written();
  assert.equal(valueAtPath(file, ["workers", "websearch", "name"]), "acme-search");
  // The message default follows the name just given.
  assert.equal(valueAtPath(file, ["customGatekeeper", "message"]), "This is Acme Corp's Cloudflare OS deployment.");
  assert.deepEqual(valueAtPath(file, ["access", "admins"]), ["ops@example.com", "me@example.com"]);
});

test("skips Access, with the setup link, when the account has no Zero Trust organization", async (t) => {
  const { code, stderr } = await init(t, [
    ["What are you setting up?", "new"],
    ["Base name", "acme-os"],
    ["Where will people reach it?", "workersDev"],
    ...REST,
  ], account({ "zero-trust organization get": { fail: "[12000] organization not found" } }));
  assert.equal(code, 0);
  assert.match(stderr(), /cloudflare-one\/setup/);
});

test("signed out and declining to sign in, asks for everything it cannot look up", async (t) => {
  const { code, written, stderr, ran } = await init(t, [
    ["Sign in to cf?", false],
    ["Cloudflare account ID", FAKE_ACCOUNT],
    ["Base name", "acme-os"],
    ["Where will people reach it?", "custom"],
    ["Hostname (in an active zone", "os.example.com"],
    ["Admin emails", "me@example.com"],
    ["Which AI Gateway", "default"],
    ["Which model providers?", ["cloudflare"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
  ], { "auth whoami": { authenticated: false, error: "Not logged in" } });
  assert.equal(code, 0);
  assert.deepEqual(ran, [], "signed in anyway");
  assert.match(stderr(), /cf is not signed in/);
  assert.match(stderr(), /pnpm cfos access/);
  const file = written();
  assert.equal(valueAtPath(file, ["accountId"]), FAKE_ACCOUNT);
  assert.deepEqual(valueAtPath(file, ["workers", "router", "route"]), { customDomain: "os.example.com" });
  assert.equal(valueAtPath(file, ["customGatekeeper", "name"]), "Cloudflare OS");
});

test("refuses without a terminal, naming the commands that take flags instead", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const harness = testContext({ root, prompter: null });
  assert.equal(await run({ command: "init", values: {}, positionals: [] }, harness.ctx), 1);
  assert.equal(harness.stderr(), NO_TERMINAL);
  assert.match(NO_TERMINAL, /cfos import <instance> --account <id> --out/);
  assert.match(NO_TERMINAL, /cfos access/);
  assert.equal(readFileSync(join(root, "deployment.jsonc"), "utf8"), TEMPLATE);
});

/** A new deployment on workers.dev reusing an existing Access application: complete when written. */
const COMPLETE: Step[] = [
  ["What are you setting up?", "new"],
  ["Base name", "acme-os"],
  ["Where will people reach it?", "workersDev"],
  ...REST,
];

/** {@link COMPLETE}'s account, with the Access application already there. */
function completeAccount(overrides: Record<string, FakeReply> = {}): Record<string, FakeReply> {
  return account({
    "zero-trust access applications list": [{ name: "Existing", aud: "aud-existing", domain: "acme-os.acme-sub.workers.dev" }],
    ...overrides,
  });
}

test("deploys the file it just wrote, once asked, after checking Wrangler is signed in", async (t) => {
  const { code, root, ran, deployed, stderr } = await init(t, [...COMPLETE, ["Deploy now?", true]], completeAccount());
  assert.equal(code, 0);
  assert.deepEqual(ran, ["pnpm exec wrangler whoami --json"]);
  assert.equal(deployed.length, 1);
  assert.equal(deployed[0].flags.config, join(root, "init.jsonc"));
  assert.doesNotMatch(stderr(), /Next:/);
});

test("takes no for an answer, printing the deploy command instead", async (t) => {
  const { code, deployed, stderr } = await init(t, [...COMPLETE, ["Deploy now?", false]], completeAccount());
  assert.equal(code, 0);
  assert.deepEqual(deployed, []);
  assert.match(stderr(), /Next: `pnpm cfos deploy --config init\.jsonc`\./);
});

test("in place, says to commit the file, and the deploy reads it from the default path", async (t) => {
  const { root, deployed, stderr } = await init(t, [...COMPLETE, ["Deploy now?", true]], completeAccount(),
    { values: {} });
  assert.match(stderr(), /deployment\.jsonc belongs in your repository: commit it\./);
  assert.equal(deployed[0].flags.config, join(root, "deployment.jsonc"));
});

test("offers no deploy while placeholders are left", async (t) => {
  const { code, ran, deployed } = await init(t, [
    ...COMPLETE,
    ["No Access application covers", "skip"],
  ]);
  assert.equal(code, 0);
  assert.deepEqual(ran, [], "checked Wrangler for a deploy it did not offer");
  assert.deepEqual(deployed, []);
});

test("offers the Wrangler sign-in before the deploy question", async (t) => {
  const { ran, deployed } = await init(t, [
    ...COMPLETE,
    ["Sign in to Wrangler?", true],
    ["Deploy now?", true],
  ], completeAccount(), { tools: { "pnpm exec wrangler whoami": { status: 1 } } });
  assert.deepEqual(ran, ["pnpm exec wrangler whoami --json", "pnpm exec wrangler login"]);
  assert.equal(deployed.length, 1);
});

test("offers the cf sign-in when signed out, and looks the account up once signed in", async (t) => {
  let signedIn = false;
  const root = scratchProject(t, TEMPLATE);
  const cf = fakeCf(completeAccount({
    "auth whoami": () => signedIn
      ? { authenticated: true, email: "me@example.com" } : { authenticated: false, error: "Not logged in" },
  }));
  const prompter = scriptedPrompter([["Sign in to cf?", true], ...COMPLETE, ["Deploy now?", false]]);
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }), prompter, flags: { profile: "work" } });
  const recorded = recording();
  const spawn = recorded.deps.spawn;
  recorded.deps.spawn = (command, args, options) => {
    if (args.includes("login")) signedIn = true;
    return spawn(command, args, options);
  };
  assert.equal(await configure({ command: "init", values: { out: "init.jsonc" }, positionals: [] }, harness.ctx,
    recorded.deps), 0);
  assert.deepEqual(prompter.remaining(), []);
  assert.equal(recorded.ran[0], "pnpm exec cf auth login --profile work");
  assert.ok(cf.calls.some((call) => call.args.join(" ").startsWith("workers list")), "no account lookups");
  assert.doesNotMatch(harness.stderr(), /cf is not signed in/);
});

test("asks nothing about deploying when its caller deploys", async (t) => {
  const { code, ran, deployed, stderr } = await init(t, COMPLETE, completeAccount(), { offerDeploy: false });
  assert.equal(code, 0);
  assert.deepEqual(ran, []);
  assert.deepEqual(deployed, []);
  assert.doesNotMatch(stderr(), /Next:/);
});
