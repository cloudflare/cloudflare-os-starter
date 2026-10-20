import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cfClient } from "../cf-client.ts";
import { parseDeployment, valueAtPath } from "../deployment-file.ts";
import { FAKE_ACCOUNT, fakeCf, flag, workerSecretsReply, type FakeCall, type FakeCfOptions, type FakeReply } from "../fake-cf.ts";
import { BACK_HINT } from "../back.ts";
import {
  BACK,
  CANCEL,
  DEFAULT,
  hostedAccount,
  scratchProject,
  scriptedPrompter,
  TEMPLATE,
  testCatalog,
  testContext,
  type Step,
} from "../test-support.ts";
import type { Context } from "../context.ts";
import { Cancelled, type Prompter } from "../prompt.ts";
import type { GatekeeperCatalog } from "../core/gatekeepers.ts";
import type { PendingSecrets } from "../gatekeeper-secrets.ts";
import { run as importInstance } from "./import.ts";
import { configure, NO_TERMINAL, run, type InitDeps } from "./init.ts";

const ZONE = { id: "zone-1", name: "example.com", status: "active" };

/** Obviously fake OAuth credentials. */
const ID = "gh-id-123";
const SECRET = "gh-secret-456";

/** Both secrets GitHub reads. */
const GITHUB_SECRETS = ["CLIENT_ID", "CLIENT_SECRET"];

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
    // The GitHub Gatekeeper Workers the takeover fixtures run, every secret set; any other is not deployed.
    "workers secrets list": workerSecretsReply({
      "acme-gk-github": GITHUB_SECRETS, "acme-github": GITHUB_SECRETS, "other-gk-github": GITHUB_SECRETS,
    }),
    ...overrides,
  };
}

/** What the recording tools report, by `<command> <args>` prefix: an exit status and output. */
type ToolReplies = Record<string, { status?: number; stdout?: string }>;

/**
 * Deps recording every tool run and deploy instead of running them, whose `wrangler secret bulk` adds
 * to `secrets`.
 */
function recording(tools: ToolReplies = {}, catalog: GatekeeperCatalog = testCatalog(), secrets: Record<string, string[]> = {}) {
  const ran: string[] = [];
  const inputs: { line: string; input: string; accountId?: string }[] = [];
  const deployed: Context[] = [];
  const deployOptions: ({ secrets?: PendingSecrets[] } | undefined)[] = [];
  const deps: InitDeps = {
    spawn: (command, args, { env, input }) => {
      const line = [command, ...args].join(" ");
      ran.push(line);
      const key = Object.keys(tools).filter((candidate) => line.startsWith(candidate))
        .toSorted((a, b) => b.length - a.length)[0];
      const status = key ? tools[key].status ?? 0 : 0;
      if (input !== undefined) {
        inputs.push({ line, input, accountId: env?.CLOUDFLARE_ACCOUNT_ID });
        const worker = args[args.indexOf("--name") + 1];
        if (status === 0) secrets[worker] = [...secrets[worker] ?? [], ...Object.keys(JSON.parse(input))];
      }
      return { status, stdout: key ? tools[key].stdout ?? "" : "" };
    },
    // Recorded with the rest, through `spawn`, so a test standing in for `spawn` covers it too.
    capture: async (command, args, { cwd, env }) => deps.spawn(command, args, { cwd, env, capture: true }),
    deploy: async (ctx, options) => {
      deployed.push(ctx);
      deployOptions.push(options);
      return 0;
    },
    catalog: async () => catalog,
  };
  return { deps, ran, inputs, deployed, deployOptions };
}

/**
 * Runs `cf-os init --out init.jsonc` in a scratch project, answering from `script`, each `cf` call and
 * line printed stamped with the questions answered by then.
 */
async function init(
  t: Parameters<typeof scratchProject>[0],
  script: Step[],
  replies = account(),
  { flags = {}, tools, values = { out: "init.jsonc" }, offerDeploy, catalog, template = TEMPLATE, secrets, delay }: {
    flags?: object; tools?: ToolReplies; values?: Record<string, string>; offerDeploy?: boolean;
    catalog?: GatekeeperCatalog; template?: string;
    /** The account's Worker secrets, which `wrangler secret bulk` adds to: replies' must read the same object. */
    secrets?: Record<string, string[]>;
    delay?: FakeCfOptions["delay"];
  } = {},
) {
  const root = scratchProject(t, template);
  const prompter = scriptedPrompter(script);
  const cf = fakeCf(replies, { delay, stamp: () => [...prompter.answered] });
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }), prompter, flags });
  const logged: { text: string; at: string[] }[] = [];
  const log = harness.ctx.out.log;
  harness.ctx.out.log = (text) => {
    logged.push({ text, at: [...prompter.answered] });
    log(text);
  };
  const recorded = recording(tools, catalog, secrets);
  const code = await configure({ command: "init", values, positionals: [] }, harness.ctx, recorded.deps,
    { offerDeploy });
  assert.deepEqual(prompter.remaining(), [], "the script was not used up");
  const out = values.out ?? "deployment.jsonc";
  const written = (): Record<string, unknown> => parseDeployment(readFileSync(join(root, out), "utf8"));
  return { code, root, prompter, written, calls: cf.calls, logged, ...recorded, ...harness };
}

/** A call's command words, before its first flag: `workers list`. */
function commandOf(call: FakeCall): string {
  const firstFlag = call.args.findIndex((arg) => arg.startsWith("-"));
  return (firstFlag < 0 ? call.args : call.args.slice(0, firstFlag)).join(" ");
}

/** The calls running `words`. */
function callsOf(calls: FakeCall[], words: string): FakeCall[] {
  return calls.filter((call) => commandOf(call) === words);
}

/** The questions answered when the one call running `words` started. */
function startedAt(calls: FakeCall[], words: string): string[] {
  const [call, ...more] = callsOf(calls, words);
  assert.ok(call, `no ${words} call`);
  assert.deepEqual(more, [], `more than one ${words} call`);
  return call.at as string[];
}

/** The base name question. */
const BASE_NAME = "Base name: the router Worker's, and the root of every other Worker's";

/** The steps from the AI Gateway question to the end of a new deployment, all defaults. */
const REST: Step[] = [
  ["Admin emails", DEFAULT],
  ["Which AI Gateway", "default"],
  ["Which model providers?", ["cloudflare"]],
  ["Which Gatekeepers?", DEFAULT],
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
    ["Hostname", "cf-os.example.com"],
    ...REST,
    ["No Access application covers cf-os.example.com", "create"],
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
  assert.deepEqual(valueAtPath(file, ["workers", "router"]), { name: "acme-os", route: { customDomain: "cf-os.example.com" } });
  assert.equal(valueAtPath(file, ["workers", "errorReporter", "name"]), "acme-os-errors");
  assert.deepEqual(valueAtPath(file, ["access", "admins"]), ["me@example.com"]);
  assert.equal(valueAtPath(file, ["access", "issuer"]), "https://acme.cloudflareaccess.com");
  assert.equal(valueAtPath(file, ["access", "audience"]), "aud-new");
  assert.deepEqual(valueAtPath(file, ["customGatekeeper"]), {
    enabled: true, name: "Acme", message: "This is Acme's Cloudflare OS deployment.",
  });
  // Storage left to automatic provisioning, as the template has it.
  assert.equal(valueAtPath(file, ["resources", "blueprintsKvNamespaceId"]), null);

  const text = readFileSync(join(root, "init.jsonc"), "utf8");
  assert.ok(text.includes("// Worker names are permanent service identities."));
  assert.ok(text.includes("// Production: use a hostname in an active Cloudflare zone."));
  assert.equal(readFileSync(join(root, "deployment.jsonc"), "utf8"), TEMPLATE, "--out wrote in place");
  const create = calls.find((call) => call.args.includes("create"))!;
  assert.equal(JSON.parse(flag(create.args, "--body")!).domain, "cf-os.example.com");
});

test("lists the accounts beside the sign-in check, and the Workers while asking what is being set up", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const cf = fakeCf(account());
  const prompter = scriptedPrompter([["What are you setting up?", CANCEL]]);
  const { ctx } = testContext({ root, client: cfClient({ spawn: cf.spawn }), prompter });
  await assert.rejects(configure({ command: "init", values: { out: "init.jsonc" }, positionals: [] }, ctx, recording().deps),
    Cancelled);
  assert.deepEqual(prompter.remaining(), []);
  // Cancelled at the first question, so whatever was read started before any answer.
  assert.deepEqual(cf.calls.map(commandOf).toSorted(), ["accounts list", "auth whoami", "workers list"]);
});

test("derives the workers.dev subdomain, and reuses an Access application already covering it", async (t) => {
  const { code, written, calls, stderr } = await init(t, [
    ["What are you setting up?", "new"],
    ["Base name", "acme-os"],
    ["Where will people reach it?", "workersDev"],
    ...REST,
    ["Deploy now?", false],
  ], account({
    "zero-trust access applications list": [
      { name: "Unrelated", aud: "aud-other", domain: "other.example.com" },
      { name: "Existing", aud: "aud-existing", domain: "acme-os.acme-sub.workers.dev" },
    ],
  }));
  assert.equal(code, 0);
  assert.match(stderr(), /answer on https:\/\/acme-os\.acme-sub\.workers\.dev/);
  const file = written();
  assert.equal(valueAtPath(file, ["publicBaseUrl"]), "https://acme-os.acme-sub.workers.dev");
  assert.deepEqual(valueAtPath(file, ["workers", "router", "route"]), { workersDev: true });
  assert.equal(valueAtPath(file, ["access", "audience"]), "aud-existing");
  assert.ok(!calls.some((call) => call.args.includes("create")), "created a duplicate");
  assert.ok(!calls.some((call) => call.args.join(" ").startsWith("zones list")), "listed zones for workers.dev");
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
  assert.match(stderr(), /`pnpm cf-os access --config init\.jsonc` fills access\.issuer and access\.audience\./);
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

test("on a takeover, asks again for a Worker it would add that another application has", async (t) => {
  const hosted = hostedAccount();
  const replies = {
    ...account(), ...hosted, "auth whoami": { authenticated: true, email: "me@example.com" },
    "workers list": [...hosted["workers list"] as object[], { name: "acme-errors" }, { name: "acme-gk-custom" }],
  };
  const { code, written, stderr } = await init(t, [
    ["What are you setting up?", "takeover"],
    ["Which hosted instance?", "acme"],
    ["Admin emails", DEFAULT],
    ["Web Search Gatekeeper Worker name", DEFAULT],
    ["Which Gatekeepers?", DEFAULT],
    ["Custom Gatekeeper Worker name", DEFAULT],
    ["Is acme-gk-custom this deployment's own", true],
    ["Error Reporter Worker name", DEFAULT],
    ["Is acme-errors this deployment's own", false],
    ["Error Reporter Worker name", "acme-reporter"],
    ["Which model providers?", ["cloudflare"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
    ["Deploy now?", false],
  ], replies);
  assert.equal(code, 0);
  assert.match(stderr(), /Already in the account: acme-errors\. Deploying would overwrite it\./);
  const file = written();
  assert.equal(valueAtPath(file, ["workers", "customGatekeeper", "name"]), "acme-gk-custom");
  assert.equal(valueAtPath(file, ["workers", "errorReporter", "name"]), "acme-reporter");
});

test("switches to a takeover when the name is a hosted instance", async (t) => {
  const { code, written, prompter, stderr } = await init(t, [
    ["What are you setting up?", "new"],
    ["Base name", "acme"],
    ['"acme" looks like a hosted instance', "takeover"],
    ["Admin emails", DEFAULT],
    ["Web Search Gatekeeper Worker name", DEFAULT],
    ["Which Gatekeepers?", DEFAULT],
    ["Custom Gatekeeper Worker name", DEFAULT],
    ["Error Reporter Worker name", DEFAULT],
    ["Which model providers?", ["cloudflare", "anthropic"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
    ["Deploy now?", false],
  ], { ...account(), ...hostedAccount(), "auth whoami": { authenticated: true, email: "me@example.com" } });
  assert.equal(code, 0);
  assert.equal(prompter.asked.find((asked) => asked.message.startsWith("What are you setting up?"))!.hints!.takeover,
    "one the hosted deploy created");
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
    enabled: true, name: "Acme", message: "This is Acme's Cloudflare OS deployment.",
  });
  assert.match(stderr(), /Next: `pnpm cf-os deploy --config init\.jsonc`\./);
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
    ["Which Gatekeepers?", DEFAULT],
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

test("offers a covering wildcard application, creating a dedicated one unless told to use it", async (t) => {
  const wildcard = account({
    "zero-trust access applications list": [{ name: "Corp", aud: "aud-corp", domain: "*.acme-sub.workers.dev" }],
  });
  const steps: Step[] = [
    ["What are you setting up?", "new"],
    ["Base name", "acme-os"],
    ["Where will people reach it?", "workersDev"],
    ...REST,
  ];
  const created = await init(t, [...steps, ['"Corp" covers acme-os.acme-sub.workers.dev with a wildcard', "create"], ["Deploy now?", false]], wildcard);
  assert.equal(valueAtPath(created.written(), ["access", "audience"]), "aud-new");
  const used = await init(t, [...steps, ['"Corp" covers acme-os.acme-sub.workers.dev with a wildcard', "reuse"], ["Deploy now?", false]], wildcard);
  assert.equal(valueAtPath(used.written(), ["access", "audience"]), "aud-corp");
  assert.match(used.stderr(), /Its policy, not access\.admins, decides who gets in/);
});

test("writes the other answers when Access fails, leaving it to cf-os access", async (t) => {
  const failures: Record<string, FakeReply>[] = [
    { "zero-trust access applications list": { fail: "[10000] Authentication error" } },
    { "zero-trust access applications create": { fail: "[12130] access.api.error.invalid_request" } },
  ];
  for (const failing of failures) {
    const { code, written, stderr } = await init(t, [
      ["What are you setting up?", "new"],
      ["Base name", "acme-os"],
      ["Where will people reach it?", "workersDev"],
      ...REST,
      ...("zero-trust access applications create" in failing ? [["No Access application covers", "create"] as Step] : []),
    ], account(failing));
    assert.equal(code, 0);
    assert.match(stderr(), /Access was not set up: .*\nFix that, then run `pnpm cf-os access`/);
    const file = written();
    assert.equal(valueAtPath(file, ["workers", "router", "name"]), "acme-os");
    assert.equal(valueAtPath(file, ["access", "audience"]), "<ACCESS_AUDIENCE>");
  }
});

test("checks --account is an account ID when signed out too", async (t) => {
  await assert.rejects(init(t, [["Sign in to cf?", false]], { "auth whoami": { authenticated: false } },
    { flags: { account: "acme" } }), /--account must be a 32-hex account ID, not "acme"/);
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
    ["Which Gatekeepers?", DEFAULT],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
  ], { "auth whoami": { authenticated: false, error: "Not logged in" } });
  assert.equal(code, 0);
  assert.ok(!ran.some((line) => line.includes("auth login")), "signed in anyway");
  assert.match(stderr(), /cf is not signed in/);
  assert.match(stderr(), /pnpm cf-os access/);
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
  assert.match(NO_TERMINAL, /cf-os import <instance> --account <id> --out/);
  assert.match(NO_TERMINAL, /cf-os access/);
  // The Gatekeeper question's config equivalents.
  assert.match(NO_TERMINAL, /`gatekeepers`/);
  assert.match(NO_TERMINAL, /`customGatekeeper\.enabled: false`/);
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
  const { code, root, ran, deployed, stderr, prompter } = await init(t, [...COMPLETE, ["Deploy now?", true]], completeAccount());
  assert.equal(code, 0);
  assert.deepEqual(ran, ["pnpm exec wrangler whoami --json"]);
  assert.ok(prompter.waited.includes("Checking the Wrangler sign-in"));
  assert.equal(deployed.length, 1);
  assert.equal(deployed[0].flags.config, join(root, "init.jsonc"));
  assert.doesNotMatch(stderr(), /Next:/);
});

test("takes no for an answer, printing the deploy command instead", async (t) => {
  const { code, deployed, stderr } = await init(t, [...COMPLETE, ["Deploy now?", false]], completeAccount());
  assert.equal(code, 0);
  assert.deepEqual(deployed, []);
  assert.match(stderr(), /Next: `pnpm cf-os deploy --config init\.jsonc`\./);
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
  // Only Wrangler's sign-in check, started at the outset in case there is a deploy to offer.
  assert.deepEqual(ran, ["pnpm exec wrangler whoami --json"]);
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
  assert.ok(recorded.ran.includes("pnpm exec cf auth login --profile work"));
  assert.ok(cf.calls.some((call) => call.args.join(" ").startsWith("workers list")), "no account lookups");
  assert.doesNotMatch(harness.stderr(), /cf is not signed in/);
  // Checked again after the sign-in, not answered from before it, and the accounts listed again.
  assert.equal(cf.calls.filter((call) => call.args.join(" ").startsWith("auth whoami")).length, 2);
  assert.equal(callsOf(cf.calls, "accounts list").length, 2);
});

test("asks nothing about deploying when its caller deploys, and ends Wrangler's sign-in check", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const cf = fakeCf(completeAccount());
  const prompter = scriptedPrompter(COMPLETE);
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }), prompter });
  const recorded = recording();
  const signals: (AbortSignal | undefined)[] = [];
  const capture = recorded.deps.capture;
  recorded.deps.capture = (command, args, options) => {
    signals.push(options.signal);
    return capture(command, args, options);
  };
  assert.equal(await configure({ command: "init", values: { out: "init.jsonc" }, positionals: [] }, harness.ctx,
    recorded.deps, { offerDeploy: false }), 0);
  assert.deepEqual(prompter.remaining(), []);
  assert.deepEqual(recorded.ran, ["pnpm exec wrangler whoami --json"]);
  assert.deepEqual(recorded.deployed, []);
  assert.doesNotMatch(harness.stderr(), /Next:/);
  // Started at the outset; with nothing to deploy it is not left running.
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, true);
});

/** {@link COMPLETE} up to the Gatekeeper question, which each test answers itself. */
const UP_TO_GATEKEEPERS: Step[] = [
  ["What are you setting up?", "new"],
  ["Base name", "acme-os"],
  ["Where will people reach it?", "workersDev"],
  ["Admin emails", DEFAULT],
  ["Which AI Gateway", "default"],
  ["Which model providers?", ["cloudflare"]],
];

test("offers the custom Gatekeeper, preselected, then the catalog's, none required", async (t) => {
  const { prompter } = await init(t, [...COMPLETE, ["Deploy now?", false]], completeAccount());
  const asked = prompter.asked.find((question) => question.message.startsWith("Which Gatekeepers?"))!;
  assert.match(asked.message, /Context, Scheduler and Web Search are always deployed; \/admin turns each off\./);
  assert.deepEqual(asked.choices, ["custom", "github", "homeassistant", "mcpportal"]);
  assert.deepEqual(asked.initial, ["custom"]);
  assert.equal(asked.required, false);
  assert.equal(asked.hints!.github, "needs CLIENT_ID, CLIENT_SECRET");
  assert.equal(asked.hints!.homeassistant, "no credentials, one install only");
  assert.equal(asked.hints!.mcpportal, "no credentials, vars MCP_PORTAL_URL, one install only");
});

/** The question for the MCP portal's endpoint, which upstream declares no input for. */
const PORTAL_URL = "The mcpportal Gatekeeper's MCP server portal endpoint (gatekeepers.mcpportal.vars.MCP_PORTAL_URL)";

/** {@link UP_TO_GATEKEEPERS}, then the MCP portal alone, its endpoint answered `url`. */
const withPortal = (url: string): Step[] => [
  ...UP_TO_GATEKEEPERS,
  ["Which Gatekeepers?", ["mcpportal"]],
  [PORTAL_URL, url],
];

test("asks for a new MCP portal's endpoint, without which the app hides it, and records it", async (t) => {
  const { written, prompter } = await init(t, [...withPortal("https://portal.example.com/mcp "), ["Deploy now?", false]],
    completeAccount());
  assert.deepEqual(valueAtPath(written(), ["gatekeepers"]), {
    mcpportal: { name: "acme-os-gk-mcpportal", vars: { MCP_PORTAL_URL: "https://portal.example.com/mcp" } },
  });
  assert.match(prompter.asked.find((question) => question.message.startsWith(PORTAL_URL))!.message,
    /empty to set it later, the Gatekeeper hidden until then$/);
  // Upstream's rule: https, no credentials in the URL.
  for (const url of ["http://portal.example.com/mcp", "https://me:pw@portal.example.com/mcp", "portal.example.com"]) {
    await assert.rejects(init(t, [...withPortal(url), ["Deploy now?", false]], completeAccount()),
      (error: Error) => error.message.includes(`"${url}" fails "${PORTAL_URL}`));
  }
});

test("left empty, the MCP portal's endpoint stays unset, and the deploy is still offered", async (t) => {
  const { written, prompter } = await init(t, [...withPortal(""), ["Deploy now?", false]], completeAccount());
  assert.deepEqual(valueAtPath(written(), ["gatekeepers"]), { mcpportal: { name: "acme-os-gk-mcpportal" } });
  assert.ok(prompter.asked.some((question) => question.message.startsWith("Deploy now?")));
});

test("on a rerun, keeps the file's usable MCP portal endpoint unasked, and asks again for an unusable one", async (t) => {
  const withUrl = (url: string) => TEMPLATE.replace('"gatekeepers": {},',
    `"gatekeepers": { "mcpportal": { "name": "old-gk-mcpportal", "vars": { "MCP_PORTAL_URL": "${url}" } } },`);
  const kept = await init(t, [...UP_TO_GATEKEEPERS, ["Which Gatekeepers?", ["mcpportal"]], ["Deploy now?", false]],
    completeAccount(), { template: withUrl("https://portal.example.com/mcp") });
  assert.deepEqual(valueAtPath(kept.written(), ["gatekeepers", "mcpportal", "vars"]), { MCP_PORTAL_URL: "https://portal.example.com/mcp" });

  const fixed = await init(t, [...withPortal("https://portal.example.com/mcp"), ["Deploy now?", false]],
    completeAccount(), { template: withUrl("http://portal.example.com/mcp") });
  assert.match(fixed.stderr(), /gatekeepers\.mcpportal\.vars\.MCP_PORTAL_URL is http:\/\/portal\.example\.com\/mcp, which the Gatekeeper cannot use\. The portal's endpoint must be an https:\/\/ URL\./);
  assert.deepEqual(valueAtPath(fixed.written(), ["gatekeepers", "mcpportal", "vars"]), { MCP_PORTAL_URL: "https://portal.example.com/mcp" });
});

test("on a takeover, asks for the endpoint of an MCP portal it adds", async (t) => {
  const { written } = await init(t, [
    ["What are you setting up?", "takeover"],
    ["Which hosted instance?", "acme"],
    ["Admin emails", DEFAULT],
    ["Web Search Gatekeeper Worker name", DEFAULT],
    ["Which Gatekeepers?", ["custom", "github", "mcpportal"]],
    ["Custom Gatekeeper Worker name", DEFAULT],
    ["Error Reporter Worker name", DEFAULT],
    ["Which model providers?", ["cloudflare"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
    [PORTAL_URL, "https://portal.example.com/mcp"],
    ["Deploy now?", false],
  ], { ...account(), ...hostedAccount(), "auth whoami": { authenticated: true, email: "me@example.com" } });
  assert.deepEqual(valueAtPath(written(), ["gatekeepers", "mcpportal"]),
    { name: "acme-gk-mcpportal", vars: { MCP_PORTAL_URL: "https://portal.example.com/mcp" } });
});

test("without the custom Gatekeeper, asks nothing about its text and leaves it disabled", async (t) => {
  const { code, written, prompter } = await init(t, [
    ...UP_TO_GATEKEEPERS,
    ["Which Gatekeepers?", []],
    ["Deploy now?", false],
  ], completeAccount());
  assert.equal(code, 0);
  assert.ok(!prompter.asked.some((question) => /Organization name|What it tells agents/.test(question.message)));
  const file = written();
  assert.deepEqual(valueAtPath(file, ["customGatekeeper"]), {
    enabled: false, name: "<ORGANIZATION_DISPLAY_NAME>", message: "<ORGANIZATION_GUIDANCE>",
  });
  assert.equal(valueAtPath(file, ["workers", "customGatekeeper", "name"]), "<CUSTOM_GATEKEEPER_WORKER_NAME>");
  assert.deepEqual(valueAtPath(file, ["gatekeepers"]), {});
});

/** {@link UP_TO_GATEKEEPERS}, then the custom Gatekeeper, GitHub and Home Assistant, which takes no credentials. */
const WITH_GITHUB: Step[] = [
  ...UP_TO_GATEKEEPERS,
  ["Which Gatekeepers?", ["custom", "github", "homeassistant"]],
  ["Organization name", DEFAULT],
  ["What it tells agents", DEFAULT],
];

/** What init says, for a new GitHub Gatekeeper, when nothing is deployed now: the command names `--out`'s file. */
const SECRETS_LATER = "\nAfter deploying, `pnpm cf-os secrets github --config init.jsonc` sets the github Gatekeeper's " +
  "OAuth credentials (redirect URI: https://acme-os.acme-sub.workers.dev/gatekeeper/github/oauth).";

/** Asserts no secret value, and no `wrangler secret put` command, reached the output. */
function assertNoSecretsShown(log: string, json: unknown[]): void {
  assert.doesNotMatch(log, /secret put/);
  for (const where of [log, JSON.stringify(json)]) {
    assert.ok(!where.includes(ID) && !where.includes(SECRET), `a secret value leaked into ${where}`);
  }
}

test("records an OAuth Gatekeeper and, the deploy declined, names cf-os secrets instead of asking", async (t) => {
  const { code, written, json, stderr, log, prompter, ran } = await init(t, [...WITH_GITHUB, ["Deploy now?", false]],
    completeAccount());
  assert.equal(code, 0);
  assert.deepEqual(valueAtPath(written(), ["gatekeepers"]), {
    github: { name: "acme-os-gk-github" },
    homeassistant: { name: "acme-os-gk-homeassistant" },
  });
  assert.deepEqual(json, [], "wrote to stdout");
  assert.ok(!prompter.asked.some(({ kind, message }) => kind === "password" || /OAuth credentials/.test(message)));
  assert.ok(!ran.some((line) => line.includes("secret")));
  // One line, with the redirect URI to register, and none of upstream's setup steps.
  assert.deepEqual(log.filter((line) => line.includes("cf-os secrets")), [SECRETS_LATER]);
  assert.doesNotMatch(stderr(), /needs an OAuth app|Console:/);
  // Home Assistant takes no credentials, so it has nothing to set.
  assert.doesNotMatch(stderr(), /homeassistant Gatekeeper/);
  assertNoSecretsShown(stderr(), json);
});

test("with no deploy offered, names cf-os secrets for a new OAuth Gatekeeper", async (t) => {
  const { log, prompter } = await init(t, WITH_GITHUB, completeAccount(), { offerDeploy: false });
  assert.deepEqual(log.filter((line) => line.includes("cf-os secrets")), [SECRETS_LATER]);
  assert.ok(!prompter.asked.some(({ kind }) => kind === "password"));
  // Writing deployment.jsonc itself, the command needs no --config.
  const inPlace = await init(t, WITH_GITHUB, completeAccount(), { offerDeploy: false, values: {} });
  assert.deepEqual(inPlace.log.filter((line) => line.includes("cf-os secrets")),
    [SECRETS_LATER.replace(" --config init.jsonc", "")]);
});

test("once the deploy is agreed to, asks for a new OAuth Gatekeeper's credentials and hands them to it", async (t) => {
  const { code, deployOptions, ran, prompter, stderr, json } = await init(t, [
    ...WITH_GITHUB,
    ["Deploy now?", true],
    ["Set the github Gatekeeper's OAuth credentials now?", "now"],
    ["OAuth client ID (CLIENT_ID)", ID],
    ["OAuth client secret (CLIENT_SECRET)", SECRET],
  ], completeAccount());
  assert.equal(code, 0);
  assert.deepEqual(deployOptions, [{
    secrets: [{ gatekeeper: "github", worker: "acme-os-gk-github", values: { CLIENT_ID: ID, CLIENT_SECRET: SECRET } }],
  }]);
  // Nothing uploaded yet: the Worker does not exist until the deploy creates it.
  assert.deepEqual(ran, ["pnpm exec wrangler whoami --json"]);
  const log = stderr();
  assert.match(log, /The github Gatekeeper \(acme-os-gk-github\) needs an OAuth app before anyone can connect it:\n/);
  assert.match(log, /\n {2}Redirect URI: https:\/\/acme-os\.acme-sub\.workers\.dev\/gatekeeper\/github\/oauth$/m);
  assert.doesNotMatch(log, /After deploying/);
  assert.ok(!JSON.stringify(prompter.asked).includes(SECRET));
  assertNoSecretsShown(log, json);
});

test("left for later at the credentials question, deploys without them", async (t) => {
  const { deployed, deployOptions, prompter } = await init(t, [
    ...WITH_GITHUB,
    ["Deploy now?", true],
    ["Set the github Gatekeeper's OAuth credentials now?", "later"],
  ], completeAccount());
  assert.equal(deployed.length, 1);
  assert.deepEqual(deployOptions, [{ secrets: [] }]);
  assert.ok(!prompter.asked.some(({ kind }) => kind === "password"));
});

test("asks again for an optional Gatekeeper's name another application's Worker has", async (t) => {
  const { written, stderr, prompter } = await init(t, [
    ...UP_TO_GATEKEEPERS,
    ["Which Gatekeepers?", ["github", "homeassistant"]],
    ["github Gatekeeper Worker name", DEFAULT],
    ["Is acme-os-gk-github this deployment's own", false],
    ["github Gatekeeper Worker name", "acme-os-github"],
    ["Deploy now?", false],
  ], completeAccount({
    "workers list": [{ name: "other", subdomain: { url: "https://other.acme-sub.workers.dev" } }, { name: "acme-os-gk-github" }],
  }));
  assert.equal(prompter.asked.find((question) => question.message.startsWith("github Gatekeeper"))!.initial, "acme-os-gk-github");
  assert.match(stderr(), /Already in the account: acme-os-gk-github\. Deploying would overwrite it\./);
  assert.deepEqual(valueAtPath(written(), ["gatekeepers"]), {
    github: { name: "acme-os-github" },
    homeassistant: { name: "acme-os-gk-homeassistant" },
  });
  assert.match(stderr(), /After deploying, `pnpm cf-os secrets github --config init\.jsonc` sets the github Gatekeeper's OAuth credentials \(redirect URI: https:\/\/acme-os\.acme-sub\.workers\.dev\/gatekeeper\/github\/oauth\)\./);
});

test("on a rerun, preselects the file's Gatekeepers, keeps their vars, and removes a deselected one", async (t) => {
  const template = TEMPLATE.replace('"gatekeepers": {},', `"gatekeepers": {
    "github": { "name": "old-gk-github", "vars": { "TEAM": "acme" } },
    "homeassistant": { "name": "old-gk-homeassistant" },
    "weather": { "name": "old-gk-weather" }
  },`);
  const { written, prompter, stderr } = await init(t, [
    ...UP_TO_GATEKEEPERS,
    ["Which Gatekeepers?", ["custom", "github"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
    ["Deploy now?", false],
  ], completeAccount(), { template });
  // weather is not on offer: never a choice, so neither preselected nor removed.
  assert.deepEqual(prompter.asked.find((question) => question.message.startsWith("Which Gatekeepers?"))!.initial,
    ["custom", "github", "homeassistant"]);
  assert.deepEqual(valueAtPath(written(), ["gatekeepers"]), {
    github: { name: "acme-os-gk-github", vars: { TEAM: "acme" } },
    weather: { name: "old-gk-weather" },
  });
  assert.match(stderr(), /\nRemoved: gatekeepers\.homeassistant\n/);
  assert.match(stderr(), /Wrote \d+ values to init\.jsonc, removing 1 entry, comments intact\./);
});

test("on a takeover, preselects the instance's Gatekeepers, which keep their secrets", async (t) => {
  const { written, prompter, stderr } = await init(t, [
    ["What are you setting up?", "takeover"],
    ["Which hosted instance?", "acme"],
    ["Admin emails", DEFAULT],
    ["Web Search Gatekeeper Worker name", DEFAULT],
    ["Which Gatekeepers?", DEFAULT],
    ["Custom Gatekeeper Worker name", DEFAULT],
    ["Error Reporter Worker name", DEFAULT],
    ["Which model providers?", ["cloudflare"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
    ["Deploy now?", false],
  ], { ...account(), ...hostedAccount(), "auth whoami": { authenticated: true, email: "me@example.com" } });
  assert.deepEqual(prompter.asked.find((question) => question.message.startsWith("Which Gatekeepers?"))!.initial,
    ["custom", "github"]);
  assert.deepEqual(valueAtPath(written(), ["gatekeepers"]), { github: { name: "acme-gk-github" } });
  assert.match(stderr(), /acme-gk-github already runs in the account and keeps its secrets: a deploy leaves them as they are\. It does replace the Worker's plain vars, with the package's own, BASE_URL and gatekeepers\.github\.vars: copy any the Worker relies on \(GITLAB_URL for a self-managed GitLab, MCP_PORTAL_URL for an MCP portal\) into gatekeepers\.github\.vars before deploying\. Its OAuth app must list https:\/\/acme\.acme-sub\.workers\.dev\/gatekeeper\/github\/oauth as a redirect URI, which follows the public origin: if the instance moves hostname, add the new one\./);
  assert.doesNotMatch(stderr(), /secret put/);
  assert.doesNotMatch(stderr(), /Warning: leaving out/);
});

test("on a takeover, asks for a live Gatekeeper's missing secret before the deploy question, and sets it at once", async (t) => {
  // Wrangler's bulk upload adds to this object, and the account's listing reads it.
  const secrets: Record<string, string[]> = { "acme-gk-github": ["CLIENT_ID"] };
  const { ran, inputs, calls, deployed, prompter, stderr, json } = await init(t, [
    ["What are you setting up?", "takeover"],
    ["Which hosted instance?", "acme"],
    ["Admin emails", DEFAULT],
    ["Web Search Gatekeeper Worker name", DEFAULT],
    ["Which Gatekeepers?", DEFAULT],
    ["Custom Gatekeeper Worker name", DEFAULT],
    ["Error Reporter Worker name", DEFAULT],
    ["Which model providers?", ["cloudflare"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
    ["Set the github Gatekeeper's OAuth credentials now?", "now"],
    ["OAuth client secret (CLIENT_SECRET)", SECRET],
    ["Deploy now?", false],
  ], {
    ...account(),
    ...hostedAccount(),
    "auth whoami": { authenticated: true, email: "me@example.com" },
    "workers secrets list": workerSecretsReply(secrets),
  }, { secrets });
  assert.deepEqual(deployed, []);
  assert.deepEqual(ran, ["pnpm exec wrangler whoami --json", "pnpm exec wrangler secret bulk --name acme-gk-github"]);
  assert.deepEqual(inputs.map(({ input, accountId }) => [JSON.parse(input), accountId]),
    [[{ CLIENT_SECRET: SECRET }, FAKE_ACCOUNT]]);
  // Listed to find what is missing, then again to confirm the upload.
  assert.equal(calls.filter((call) => call.args.join(" ") === "workers secrets list --script-name acme-gk-github").length, 2);
  assert.deepEqual(secrets, { "acme-gk-github": ["CLIENT_ID", "CLIENT_SECRET"] });
  // The one secret it lacks, not the one it has.
  assert.deepEqual(prompter.asked.filter(({ kind }) => kind === "password").map(({ message }) => message),
    ["OAuth client secret (CLIENT_SECRET)"]);
  const log = stderr();
  assert.match(log, /\nSet CLIENT_SECRET on acme-gk-github\./);
  assert.ok(log.indexOf("Set CLIENT_SECRET") > log.indexOf("Wrote "));
  // Live and set, so nothing is left for later.
  assert.doesNotMatch(log, /After deploying/);
  assertNoSecretsShown(log, json);
});

for (const deploy of [true, false]) {
  test(`on a takeover, reports a failed upload with the command that tries again, still offers the deploy, and exits 1 (deploy ${deploy ? "accepted" : "declined"})`, async (t) => {
    const secrets: Record<string, string[]> = { "acme-gk-github": [] };
    const { code, deployed, stderr } = await init(t, [
      ["What are you setting up?", "takeover"],
      ["Which hosted instance?", "acme"],
      ["Admin emails", DEFAULT],
      ["Web Search Gatekeeper Worker name", DEFAULT],
      ["Which Gatekeepers?", DEFAULT],
      ["Custom Gatekeeper Worker name", DEFAULT],
      ["Error Reporter Worker name", DEFAULT],
      ["Which model providers?", ["cloudflare"]],
      ["Organization name", DEFAULT],
      ["What it tells agents", DEFAULT],
      ["Set the github Gatekeeper's OAuth credentials now?", "now"],
      ["OAuth client ID (CLIENT_ID)", ID],
      ["OAuth client secret (CLIENT_SECRET)", SECRET],
      ["Deploy now?", deploy],
    ], {
      ...account(),
      ...hostedAccount(),
      "auth whoami": { authenticated: true, email: "me@example.com" },
      "workers secrets list": workerSecretsReply(secrets),
    }, { secrets, tools: { "pnpm exec wrangler secret bulk": { status: 1 } } });
    const log = stderr();
    assert.match(log, /\nThe github Gatekeeper's OAuth credentials were not set: `wrangler secret bulk --name acme-gk-github` failed\. Its output is above\. `pnpm cf-os secrets github --config init\.jsonc` tries again\./);
    assert.equal(deployed.length, deploy ? 1 : 0);
    // The values entered are gone, so the run does not report success, whatever the deploy did.
    assert.equal(code, 1);
    // After a deploy's log, the failure is repeated at the end.
    const repeated = "\nThe github Gatekeeper's OAuth credentials were not set: `pnpm cf-os secrets github --config init.jsonc` sets them.";
    if (deploy) assert.ok(log.endsWith(repeated), log.slice(-300));
    else assert.ok(!log.includes(repeated));
  });
}

test("on a takeover that finds no public origin, prints no redirect URI on the template's domain", async (t) => {
  const hosted = hostedAccount();
  const { written, stderr } = await init(t, [
    ["What are you setting up?", "takeover"],
    ["Which hosted instance?", "acme"],
    ["Admin emails", DEFAULT],
    ["Web Search Gatekeeper Worker name", DEFAULT],
    ["Which Gatekeepers?", ["custom", "github"]],
    ["Custom Gatekeeper Worker name", DEFAULT],
    ["Error Reporter Worker name", DEFAULT],
    ["Which model providers?", ["cloudflare"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
  ], {
    ...account(),
    ...hosted,
    "auth whoami": { authenticated: true, email: "me@example.com" },
    // The router serves no workers.dev URL, and no Access application names the instance.
    "workers list": (hosted["workers list"] as { name: string }[])
      .filter(({ name }) => name !== "acme-gk-github")
      .map(({ name }) => ({ name })),
    "zero-trust access applications list": [],
  });
  assert.deepEqual(valueAtPath(written(), ["workers", "router", "route"]), { customDomain: "os.example.com" });
  assert.deepEqual(valueAtPath(written(), ["gatekeepers"]), { github: { name: "acme-gk-github" } });
  const log = stderr();
  assert.match(log, /No public origin was found for the instance, so <PUBLIC_ORIGIN> stands for it below\. Set workers\.router\.route and publicBaseUrl in init\.jsonc/);
  assert.match(log, /\nAfter deploying, `pnpm cf-os secrets github --config init\.jsonc` sets the github Gatekeeper's OAuth credentials \(redirect URI: <PUBLIC_ORIGIN>\/gatekeeper\/github\/oauth\)\./);
  assert.doesNotMatch(log, /example\.com\/gatekeeper|secret put/);
});

test("on a takeover, warns that leaving out a live Gatekeeper unbinds it, and can drop the custom one", async (t) => {
  const { written, prompter, stderr } = await init(t, [
    ["What are you setting up?", "takeover"],
    ["Which hosted instance?", "acme"],
    ["Admin emails", DEFAULT],
    ["Web Search Gatekeeper Worker name", DEFAULT],
    ["Which Gatekeepers?", []],
    ["Error Reporter Worker name", DEFAULT],
    ["Which model providers?", ["cloudflare"]],
    ["Deploy now?", false],
  ], { ...account(), ...hostedAccount(), "auth whoami": { authenticated: true, email: "me@example.com" } });
  assert.match(stderr(), /Warning: leaving out acme-gk-github removes its binding, so it disappears from the app along with every user's connection to it\. The Worker keeps running/);
  assert.ok(!prompter.asked.some((question) => /Custom Gatekeeper Worker name|Organization name/.test(question.message)));
  const file = written();
  assert.deepEqual(valueAtPath(file, ["gatekeepers"]), {});
  assert.equal(valueAtPath(file, ["customGatekeeper", "enabled"]), false);
});

/** The hosted account, with `extra` Workers beside the instance's. */
function hostedWith(...extra: string[]): Record<string, FakeReply> {
  const hosted = hostedAccount();
  return {
    ...account(),
    ...hosted,
    "auth whoami": { authenticated: true, email: "me@example.com" },
    "workers list": [...hosted["workers list"] as object[], ...extra.map((name) => ({ name }))],
  };
}

/** A takeover of acme that leaves out the custom Gatekeeper and keeps GitHub. */
const WITHOUT_CUSTOM: Step[] = [
  ["What are you setting up?", "takeover"],
  ["Which hosted instance?", "acme"],
  ["Admin emails", DEFAULT],
  ["Web Search Gatekeeper Worker name", DEFAULT],
  ["Which Gatekeepers?", ["github"]],
  ["Error Reporter Worker name", DEFAULT],
  ["Which model providers?", ["cloudflare"]],
  ["Deploy now?", false],
];

test("on a takeover, warns that leaving out a live custom Gatekeeper unbinds it", async (t) => {
  const { written, stderr } = await init(t, WITHOUT_CUSTOM, hostedWith("acme-gk-custom"));
  assert.match(stderr(), /Warning: leaving out acme-gk-custom removes its binding, so it disappears from the app along with every user's connection to it\. The Worker keeps running; `CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef pnpm exec wrangler delete --name acme-gk-custom` removes it\./);
  assert.doesNotMatch(stderr(), /Warning: leaving out acme-gk-github/);
  assert.equal(valueAtPath(written(), ["customGatekeeper", "enabled"]), false);
});

test("on a takeover, names the file's own custom Gatekeeper Worker when leaving it out unbinds it", async (t) => {
  const own = TEMPLATE.replace('"<ROUTER_WORKER_NAME>"', '"acme"').replace('"<CLOUDFLARE_ACCOUNT_ID>"', `"${FAKE_ACCOUNT}"`)
    .replace('"<CUSTOM_GATEKEEPER_WORKER_NAME>"', '"acme-example"');
  const { stderr } = await init(t, WITHOUT_CUSTOM, hostedWith("acme-example", "acme-gk-custom"), { template: own });
  assert.match(stderr(), /Warning: leaving out acme-example removes its binding/);
  assert.doesNotMatch(stderr(), /Warning: leaving out acme-gk-custom/);
});

/** A takeover of acme that keeps the custom Gatekeeper, naming its Worker `worker`, and GitHub. */
function withCustom(worker: string | typeof DEFAULT): Step[] {
  return [
    ["What are you setting up?", "takeover"],
    ["Which hosted instance?", "acme"],
    ["Admin emails", DEFAULT],
    ["Web Search Gatekeeper Worker name", DEFAULT],
    ["Which Gatekeepers?", DEFAULT],
    ["Custom Gatekeeper Worker name", worker],
    ["Error Reporter Worker name", DEFAULT],
    ["Which model providers?", ["cloudflare"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
    ["Deploy now?", false],
  ];
}

/** The instance's own file, naming `acme-example` as its custom Gatekeeper's Worker. */
const OWN_CUSTOM = TEMPLATE.replace('"<ROUTER_WORKER_NAME>"', '"acme"').replace('"<CLOUDFLARE_ACCOUNT_ID>"', `"${FAKE_ACCOUNT}"`)
  .replace('"<CUSTOM_GATEKEEPER_WORKER_NAME>"', '"acme-example"');

test("on a takeover rerun, keeps the custom Gatekeeper on the Worker the file names", async (t) => {
  const { written, prompter, stderr } = await init(t, withCustom(DEFAULT), hostedWith("acme-example"),
    { template: OWN_CUSTOM });
  assert.equal(prompter.asked.find((question) => question.message === "Custom Gatekeeper Worker name")!.initial,
    "acme-example");
  assert.ok(!prompter.asked.some((question) => /Is acme-example this deployment's own/.test(question.message)));
  assert.equal(valueAtPath(written(), ["workers", "customGatekeeper", "name"]), "acme-example");
  assert.doesNotMatch(stderr(), /Warning: leaving out/);
});

test("on a takeover rerun, warns that moving the custom Gatekeeper to another Worker unbinds the file's", async (t) => {
  const { written, stderr } = await init(t, withCustom("acme-custom"), hostedWith("acme-example"),
    { template: OWN_CUSTOM });
  assert.equal(valueAtPath(written(), ["workers", "customGatekeeper", "name"]), "acme-custom");
  assert.match(stderr(), /Warning: leaving out acme-example removes its binding, so it disappears from the app along with every user's connection to it\. The Worker keeps running; `CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef pnpm exec wrangler delete --name acme-example` removes it\./);
});

test("on a takeover, leaving out the custom Gatekeeper warns of nothing when nothing binds it", async (t) => {
  // Another router's file: the instance's default name decides, and the account has no such Worker.
  const { stderr } = await init(t, WITHOUT_CUSTOM, hostedWith("acme-example"), {
    template: TEMPLATE.replace('"<CUSTOM_GATEKEEPER_WORKER_NAME>"', '"acme-example"'),
  });
  assert.doesNotMatch(stderr(), /Warning: leaving out/);
});

/** The hosted account, its GitHub Gatekeeper's Worker named `acme-github`, as a file's own name can have it. */
function renamedGithubAccount(): Record<string, FakeReply> {
  const hosted = hostedAccount();
  return {
    ...account(),
    ...hosted,
    "auth whoami": { authenticated: true, email: "me@example.com" },
    "workers list": (hosted["workers list"] as { name: string }[])
      .map((worker) => worker.name === "acme-gk-github" ? { ...worker, name: "acme-github" } : worker),
  };
}

/**
 * A template for router `router` in account `accountId`, whose `gatekeepers` block names `worker` as
 * the GitHub Gatekeeper's Worker.
 */
function githubTemplate(router: string, worker: string, accountId = FAKE_ACCOUNT): string {
  return TEMPLATE.replace('"<ROUTER_WORKER_NAME>"', JSON.stringify(router))
    .replace('"<CLOUDFLARE_ACCOUNT_ID>"', JSON.stringify(accountId))
    .replace('"gatekeepers": {},', `"gatekeepers": { "github": { "name": ${JSON.stringify(worker)} } },`);
}

/** acme's own file, naming the GitHub Gatekeeper's Worker `acme-github`. */
const RENAMED_GITHUB = githubTemplate("acme", "acme-github");

test("on a takeover, treats the file's own Gatekeeper the account runs as live, under its name", async (t) => {
  const { written, prompter, stderr } = await init(t, [
    ["What are you setting up?", "takeover"],
    ["Which hosted instance?", "acme"],
    ["Admin emails", DEFAULT],
    ["Web Search Gatekeeper Worker name", DEFAULT],
    ["Which Gatekeepers?", DEFAULT],
    ["Custom Gatekeeper Worker name", DEFAULT],
    ["Error Reporter Worker name", DEFAULT],
    ["Which model providers?", ["cloudflare"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
    ["Deploy now?", false],
  ], renamedGithubAccount(), { template: RENAMED_GITHUB });
  assert.deepEqual(prompter.asked.find((question) => question.message.startsWith("Which Gatekeepers?"))!.initial,
    ["custom", "github"]);
  assert.deepEqual(valueAtPath(written(), ["gatekeepers"]), { github: { name: "acme-github" } });
  const log = stderr();
  assert.match(log, /acme-github already runs in the account and keeps its secrets/);
  assert.doesNotMatch(log, /secret put|acme-gk-github|Removed: gatekeepers/);
});

test("on a takeover, warns that leaving out the file's own live Gatekeeper unbinds it", async (t) => {
  const { written, stderr } = await init(t, [
    ["What are you setting up?", "takeover"],
    ["Which hosted instance?", "acme"],
    ["Admin emails", DEFAULT],
    ["Web Search Gatekeeper Worker name", DEFAULT],
    ["Which Gatekeepers?", ["custom"]],
    ["Custom Gatekeeper Worker name", DEFAULT],
    ["Error Reporter Worker name", DEFAULT],
    ["Which model providers?", ["cloudflare"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
    ["Deploy now?", false],
  ], renamedGithubAccount(), { template: RENAMED_GITHUB });
  assert.match(stderr(), /Warning: leaving out acme-github removes its binding/);
  assert.deepEqual(valueAtPath(written(), ["gatekeepers"]), {});
});

/** The hosted account, plus another deployment's GitHub Gatekeeper Worker, `other-gk-github`. */
function otherGithubAccount(): Record<string, FakeReply> {
  const hosted = hostedAccount();
  return {
    ...account(),
    ...hosted,
    "auth whoami": { authenticated: true, email: "me@example.com" },
    "workers list": [...hosted["workers list"] as { name: string }[], { name: "other-gk-github" }],
  };
}

/** acme's own file, naming another GitHub Gatekeeper Worker than the instance's, `other-gk-github`. */
const OTHER_GITHUB = githubTemplate("acme", "other-gk-github");

/** A takeover of `acme` up to the Gatekeeper question, then its defaults, with `pick` for the GitHub Worker. */
function otherGithubTakeover(pick: string | typeof DEFAULT): Step[] {
  return [
    ["What are you setting up?", "takeover"],
    ["Which hosted instance?", "acme"],
    ["Admin emails", DEFAULT],
    ["Web Search Gatekeeper Worker name", DEFAULT],
    ["Which Worker is this deployment's github Gatekeeper?", pick],
    ["Which Gatekeepers?", DEFAULT],
    ["Custom Gatekeeper Worker name", DEFAULT],
    ["Error Reporter Worker name", DEFAULT],
    ["Which model providers?", ["cloudflare"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
    ["Deploy now?", false],
  ];
}

test("on a takeover where the file names another GitHub Worker than the instance's, asks, defaulting to the instance's", async (t) => {
  const { written, prompter, stderr } = await init(t, otherGithubTakeover(DEFAULT), otherGithubAccount(),
    { template: OTHER_GITHUB });
  const question = prompter.asked.find((asked) => asked.message.startsWith("Which Worker is"))!;
  assert.equal(question.initial, "acme-gk-github");
  assert.deepEqual(question.choices, ["acme-gk-github", "other-gk-github"]);
  assert.deepEqual(valueAtPath(written(), ["gatekeepers"]), { github: { name: "acme-gk-github" } });
  const log = stderr();
  assert.match(log, /The file names other-gk-github as the github Gatekeeper's Worker, but the instance runs acme-gk-github\./);
  assert.match(log, /acme-gk-github already runs in the account and keeps its secrets/);
  assert.doesNotMatch(log, /Warning: leaving out/);
});

test("on a takeover that keeps the file's GitHub Worker over the instance's, warns that the instance's loses its binding", async (t) => {
  const { written, stderr } = await init(t, otherGithubTakeover("other-gk-github"), otherGithubAccount(),
    { template: OTHER_GITHUB });
  assert.deepEqual(valueAtPath(written(), ["gatekeepers"]), { github: { name: "other-gk-github" } });
  const log = stderr();
  assert.match(log, /Warning: leaving out acme-gk-github removes its binding/);
  assert.doesNotMatch(log, /Warning: leaving out other-gk-github/);
});

test("on a takeover with another deployment's file, leaves the GitHub Worker it names alone", async (t) => {
  const hosted = hostedAccount();
  const { written, prompter, stderr } = await init(t, [
    ["What are you setting up?", "takeover"],
    ["Which hosted instance?", "acme"],
    ["Admin emails", DEFAULT],
    ["Web Search Gatekeeper Worker name", DEFAULT],
    ["Which Gatekeepers?", DEFAULT],
    ["Custom Gatekeeper Worker name", DEFAULT],
    ["Error Reporter Worker name", DEFAULT],
    ["Which model providers?", ["cloudflare"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
    ["Deploy now?", false],
  ], {
    ...account(),
    ...hosted,
    "auth whoami": { authenticated: true, email: "me@example.com" },
    // acme has no GitHub Gatekeeper; zeta, another deployment in the account, has one.
    "workers list": (hosted["workers list"] as { name: string }[])
      .map((worker) => worker.name === "acme-gk-github" ? { ...worker, name: "zeta-gk-github" } : worker),
  }, { template: githubTemplate("zeta", "zeta-gk-github") });
  assert.deepEqual(prompter.asked.find((question) => question.message.startsWith("Which Gatekeepers?"))!.initial,
    ["custom"]);
  assert.ok(!prompter.asked.some((question) => question.message.startsWith("Which Worker is")));
  assert.deepEqual(valueAtPath(written(), ["gatekeepers"]), {});
  const log = stderr();
  assert.match(log, new RegExp(`The file is not acme's in account ${FAKE_ACCOUNT} \\(its workers\\.router\\.name or accountId differs\\), so the Gatekeeper Workers its gatekeepers block names may be another deployment's, and are left alone: zeta-gk-github\\.`));
  assert.doesNotMatch(log, /zeta-gk-github already runs|Warning: leaving out/);
});

test("on a takeover, a file for the same router in another account binds none of the Workers it names", async (t) => {
  // The account runs a Worker by the name the file gives its GitHub Gatekeeper, but the file is
  // another account's: not asked about, not bound, and the custom Gatekeeper keeps the instance's name.
  const { written, prompter, stderr } = await init(t, withCustom(DEFAULT), {
    ...otherGithubAccount(),
    "workers list": [...otherGithubAccount()["workers list"] as { name: string }[], { name: "acme-example" }],
  }, {
    flags: { account: FAKE_ACCOUNT },
    template: githubTemplate("acme", "other-gk-github", "f".repeat(32))
      .replace('"<CUSTOM_GATEKEEPER_WORKER_NAME>"', '"acme-example"'),
  });
  assert.ok(!prompter.asked.some((question) => question.message.startsWith("Which Worker is")));
  assert.equal(prompter.asked.find((question) => question.message === "Custom Gatekeeper Worker name")!.initial,
    "acme-gk-custom");
  assert.deepEqual(valueAtPath(written(), ["gatekeepers"]), { github: { name: "acme-gk-github" } });
  assert.match(stderr(), /accountId differs\), so the Gatekeeper Workers its gatekeepers block names may be another deployment's, and are left alone: other-gk-github\./);
});

test("a takeover after importing over another account's file asks for the Workers that file named", async (t) => {
  // The file is acme's in another account, naming a custom Gatekeeper Worker this account also runs.
  const root = scratchProject(t, githubTemplate("acme", "acme-gk-github", "f".repeat(32))
    .replace('"<CUSTOM_GATEKEEPER_WORKER_NAME>"', '"shared-custom"')
    .replace('"<ERROR_REPORTER_WORKER_NAME>"', '"shared-errors"'));
  const hosted: Record<string, FakeReply> = {
    ...account(), ...hostedAccount(), "auth whoami": { authenticated: true, email: "me@example.com" },
  };
  const replies = {
    ...hosted,
    "workers list": [...hosted["workers list"] as { name: string }[], { name: "shared-custom" }, { name: "shared-errors" }],
  };
  const imported = testContext({ root, client: cfClient({ spawn: fakeCf(replies).spawn }), flags: { account: FAKE_ACCOUNT } });
  assert.equal(await importInstance({ command: "import", values: { out: "acme.jsonc" }, positionals: ["acme"] }, imported.ctx,
    async () => testCatalog()), 0);

  // The written file reads as acme's in this account, so it is now trusted: its names must not be the other's.
  const { prompter, written } = await init(t, withCustom(DEFAULT), replies,
    { template: readFileSync(join(root, "acme.jsonc"), "utf8") });
  assert.equal(prompter.asked.find((question) => question.message === "Custom Gatekeeper Worker name")!.initial,
    "acme-gk-custom");
  assert.ok(!prompter.asked.some((question) => /Is shared-/.test(question.message)));
  assert.equal(valueAtPath(written(), ["workers", "customGatekeeper", "name"]), "acme-gk-custom");
  assert.equal(valueAtPath(written(), ["workers", "errorReporter", "name"]), "acme-errors");
});

test("without a Gatekeeper catalog, still asks about the custom Gatekeeper", async (t) => {
  const { code, prompter, stderr, written } = await init(t, [...COMPLETE, ["Deploy now?", false]], completeAccount(),
    { catalog: { offered: [], excluded: [], unavailable: "no submodule install" } });
  assert.equal(code, 0);
  assert.deepEqual(prompter.asked.find((question) => question.message.startsWith("Which Gatekeepers?"))!.choices, ["custom"]);
  assert.match(stderr(), /The Gatekeeper catalog could not be read, so only the example custom Gatekeeper is offered: no submodule install/);
  assert.equal(valueAtPath(written(), ["customGatekeeper", "enabled"]), true);
});

test("Esc at the route question goes back to the base name, offering the old one, and the new one names every Worker", async (t) => {
  const tail: Step[] = [["Where will people reach it?", "workersDev"], ...REST, ["No Access application covers", "skip"]];
  const { code, prompter, written, stderr, calls } = await init(t, [
    ["What are you setting up?", "new"],
    ["Base name", "acme-os"],
    ["Where will people reach it?", BACK],
    ["Base name", "acme-two"],
    ...tail,
  ]);
  assert.equal(code, 0);
  assert.deepEqual(prompter.asked.filter(({ message }) => message.startsWith("Base name")).map(({ initial }) => initial),
    ["cloudflare-os", "acme-os"]);
  const file = written();
  assert.equal(valueAtPath(file, ["workers", "router", "name"]), "acme-two");
  assert.equal(valueAtPath(file, ["workers", "errorReporter", "name"]), "acme-two-errors");
  assert.equal(stderr().split(BACK_HINT).length, 2, "the hint once");
  // The way back reads nothing again: as many `cf` calls as going straight there.
  const straight = await init(t, [["What are you setting up?", "new"], ["Base name", "acme-two"], ...tail]);
  assert.equal(calls.length, straight.calls.length);
});

test("Esc at the Gatekeeper question goes back to the model providers, offering the earlier choice", async (t) => {
  const { code, prompter, written } = await init(t, [
    ["What are you setting up?", "new"],
    ["Base name", "acme-os"],
    ["Where will people reach it?", "workersDev"],
    ["Admin emails", DEFAULT],
    ["Which AI Gateway", "default"],
    ["Which model providers?", ["cloudflare", "anthropic"]],
    ["Which Gatekeepers?", BACK],
    ["Which model providers?", DEFAULT],
    ["Which Gatekeepers?", DEFAULT],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
    ["No Access application covers", "skip"],
  ]);
  assert.equal(code, 0);
  assert.deepEqual(prompter.asked.filter(({ message }) => message === "Which model providers?").map(({ initial }) => initial),
    [["cloudflare"], ["cloudflare", "anthropic"]]);
  assert.deepEqual(valueAtPath(written(), ["aiGateway", "providers"]), ["cloudflare", "anthropic"]);
});

test("on a takeover, Esc goes back through the questions after the discovery report without printing it again", async (t) => {
  const replies = { ...account(), ...hostedAccount(), "auth whoami": { authenticated: true, email: "me@example.com" } };
  const rest: Step[] = [
    ["Custom Gatekeeper Worker name", DEFAULT],
    ["Error Reporter Worker name", DEFAULT],
    ["Which model providers?", ["cloudflare"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
    ["Deploy now?", false],
  ];
  const { code, prompter, written, stderr } = await init(t, [
    ["What are you setting up?", "takeover"],
    ["Which hosted instance?", "acme"],
    ["Admin emails", "ops@example.com"],
    ["Web Search Gatekeeper Worker name", "acme-search"],
    ["Which Gatekeepers?", BACK],
    ["Web Search Gatekeeper Worker name", DEFAULT],
    ["Which Gatekeepers?", DEFAULT],
    ...rest,
  ], replies);
  assert.equal(code, 0);
  assert.equal(prompter.asked.filter(({ message }) => message.startsWith("Web Search"))[1].initial, "acme-search");
  assert.equal(valueAtPath(written(), ["workers", "websearch", "name"]), "acme-search");
  assert.deepEqual(valueAtPath(written(), ["access", "admins"]), ["ops@example.com"]);
  assert.equal(stderr().split('Hosted instance "acme"').length, 2, "the report once");

  // Back from the first question after the instance, to the instance.
  const again = await init(t, [
    ["What are you setting up?", "takeover"],
    ["Which hosted instance?", "acme"],
    ["Admin emails", BACK],
    ["Which hosted instance?", DEFAULT],
    ["Admin emails", DEFAULT],
    ["Web Search Gatekeeper Worker name", DEFAULT],
    ["Which Gatekeepers?", DEFAULT],
    ...rest,
  ], replies);
  assert.equal(again.code, 0);
  assert.deepEqual(again.prompter.asked.filter(({ message }) => message === "Which hosted instance?").map(({ initial }) => initial),
    [undefined, "acme"]);
});

test("the Access step creates the One-time PIN provider only after its last question, so Esc there creates nothing", async (t) => {
  const created: boolean[] = [];
  const replies = account({
    "zero-trust identity-providers list": [],
    "zero-trust identity-providers create": (args) => {
      created.push(args.includes("--dry-run"));
      return { id: "otp", type: "onetimepin" };
    },
  });
  const start: Step[] = [
    ["What are you setting up?", "new"],
    ["Base name", "acme-os"],
    ["Where will people reach it?", "workersDev"],
    ...REST,
    ["Add a One-time PIN provider?", true],
    ["No Access application covers", BACK],
  ];
  const declined = await init(t, [...start, ["Add a One-time PIN provider?", false], ["No Access application covers", "skip"]], replies);
  assert.equal(declined.code, 0);
  assert.equal(declined.prompter.asked.filter(({ message }) => message.startsWith("Add a One-time PIN"))[1].initial, true);
  assert.deepEqual(created, []);
  assert.ok(!declined.calls.some((call) => call.args.join(" ").includes("access applications create")));

  const accepted = await init(t, [...start, ["Add a One-time PIN provider?", DEFAULT], ["No Access application covers", "create"], ["Deploy now?", false]], replies);
  assert.equal(accepted.code, 0);
  assert.deepEqual(created, [true, false]);
  assert.equal(valueAtPath(accepted.written(), ["access", "audience"]), "aud-new");
});

test("Esc cancels at the first question, and once the file is written", async (t) => {
  await assert.rejects(init(t, [["What are you setting up?", BACK]]), Cancelled);
  await assert.rejects(init(t, [...COMPLETE, ["Deploy now?", BACK]], completeAccount()), Cancelled);
});

test("starts each read once an answer makes it certain, while later questions are answered", async (t) => {
  // The gateways take a while, so the reads chained after the organization's start meanwhile.
  const { calls, prompter } = await init(t, [...COMPLETE, ["Deploy now?", false]], completeAccount(),
    { delay: (args) => args.join(" ").startsWith("ai-gateway gateways list") ? 300 : 0 });
  // Beside the sign-in check, and while "What are you setting up?" is open: before any answer.
  assert.deepEqual(startedAt(calls, "accounts list"), []);
  assert.deepEqual(startedAt(calls, "workers list"), []);
  // Both ways a new deployment can go read this, so it starts as soon as it is chosen.
  assert.deepEqual(startedAt(calls, "zero-trust organization get"), ["What are you setting up?"]);
  // Once the base name is settled, before the route and admin questions it waits behind.
  assert.deepEqual(startedAt(calls, "ai-gateway gateways list"), ["What are you setting up?", BASE_NAME]);
  // Access's reads, before the last question ahead of the Access step is answered.
  assert.ok(prompter.answered.includes("What it tells agents"));
  for (const words of ["zero-trust access applications list", "zero-trust identity-providers list"]) {
    assert.ok(!startedAt(calls, words).includes("What it tells agents"), `${words} waited for the last question`);
  }
  // A new deployment never takes stock of storage, as a takeover does.
  assert.deepEqual([...callsOf(calls, "kv namespaces list"), ...callsOf(calls, "r2 buckets list")], []);
});

test("lists the Workers once on workers.dev, reading the subdomain off the list the base name was checked against", async (t) => {
  const { calls, stderr } = await init(t, [...COMPLETE, ["Deploy now?", false]], completeAccount());
  assert.match(stderr(), /answer on https:\/\/acme-os\.acme-sub\.workers\.dev/);
  assert.equal(callsOf(calls, "workers list").length, 1);
});

test("reads nothing for a path not taken", async (t) => {
  // No team domain: Access is skipped, so neither its applications nor its providers are listed.
  const noTeam = await init(t, COMPLETE, completeAccount({ "zero-trust organization get": {} }));
  assert.equal(noTeam.code, 0);
  assert.match(noTeam.stderr(), /has no team domain/);
  assert.deepEqual([
    ...callsOf(noTeam.calls, "zero-trust access applications list"),
    ...callsOf(noTeam.calls, "zero-trust identity-providers list"),
  ], []);

  // A name colliding with a hosted instance, renamed: no takeover, so no inventory.
  const renamed = await init(t, [
    ["What are you setting up?", "new"],
    ["Base name", "acme"],
    ['"acme" looks like a hosted instance.', "rename"],
    ["Base name", DEFAULT],
    ["Where will people reach it?", "workersDev"],
    ...REST,
    ["No Access application covers", "skip"],
  ], account({ "workers list": hostedAccount()["workers list"] }));
  assert.equal(renamed.code, 0);
  assert.equal(valueAtPath(renamed.written(), ["workers", "router", "name"]), "acme-2");
  assert.deepEqual([...callsOf(renamed.calls, "kv namespaces list"), ...callsOf(renamed.calls, "r2 buckets list")], []);

  // A takeover in an account with no instance: the Workers list, and nothing after it.
  const none = await init(t, [["What are you setting up?", "takeover"]]);
  assert.equal(none.code, 1);
  assert.match(none.stderr(), /No hosted instances in account/);
  assert.deepEqual(none.calls.map(commandOf).toSorted(), ["accounts list", "auth whoami", "workers list"]);

  // With the account passed, the list still names it, for the custom Gatekeeper's default name.
  const named = await init(t, [...COMPLETE, ["Deploy now?", false]], completeAccount(), { flags: { account: FAKE_ACCOUNT } });
  assert.deepEqual(startedAt(named.calls, "accounts list"), []);
  assert.equal(named.prompter.asked.find(({ message }) => message.startsWith("Organization name"))!.initial, "Acme");
});

test("on a takeover, takes stock of the account while the instance question is open", async (t) => {
  const { calls, prompter } = await init(t, [
    ["What are you setting up?", "takeover"],
    ["Which hosted instance?", "acme"],
    ["Admin emails", DEFAULT],
    ["Web Search Gatekeeper Worker name", DEFAULT],
    ["Which Gatekeepers?", DEFAULT],
    ["Custom Gatekeeper Worker name", DEFAULT],
    ["Error Reporter Worker name", DEFAULT],
    ["Which model providers?", ["cloudflare"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
    ["Deploy now?", false],
  ], { ...account(), ...hostedAccount(), "auth whoami": { authenticated: true, email: "me@example.com" } });
  assert.deepEqual(startedAt(calls, "kv namespaces list"), ["What are you setting up?"]);
  assert.deepEqual(startedAt(calls, "r2 buckets list"), ["What are you setting up?"]);
  assert.ok(prompter.waited.includes("Listing the account's Workers"), "no spinner while the instances were listed");
});

test("on a takeover, clears the spinner once the inventory fails, though reads after the failed one are in flight", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const scripted = scriptedPrompter([
    ["What are you setting up?", "new"],
    ["Base name", "acme"],
    ['"acme" looks like a hosted instance', "takeover"],
  ]);
  // How many spinner waits are still showing.
  let showing = 0;
  const busy: NonNullable<Prompter["busy"]> = async (message, work) => {
    showing++;
    try {
      return await work();
    } finally {
      showing--;
    }
  };
  const prompter: Prompter = { ...scripted, busy, backable: () => ({ ...scripted.backable!(), busy }) };
  // The collision reads no storage ahead: the KV list fails while R2 and the AI Gateways still run.
  const cf = fakeCf({
    ...account(), ...hostedAccount(),
    "auth whoami": { authenticated: true, email: "me@example.com" },
    "kv namespaces list": { fail: "[10000] Authentication error" },
  }, { delay: (args) => args[0] === "r2" || args[0] === "ai-gateway" ? 300 : 0 });
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }), prompter });
  await assert.rejects(configure({ command: "init", values: { out: "init.jsonc" }, positionals: [] }, harness.ctx,
    recording().deps), /cf kv namespaces list .*Authentication error/);
  assert.equal(showing, 0, "a spinner is still showing after init failed");
  assert.deepEqual(scripted.remaining(), []);
});

test("Esc replays the questions before it without a cf call or a spinner", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const prompter = scriptedPrompter([
    ["What are you setting up?", "new"],
    ["Base name", "acme-os"],
    ["Where will people reach it?", "workersDev"],
    ["Admin emails", DEFAULT],
    ["Which AI Gateway", BACK],
    ["Admin emails", BACK],
    ["Where will people reach it?", "workersDev"],
    ...REST,
    ["Deploy now?", false],
  ]);
  const cf = fakeCf(completeAccount());
  // What had been called and waited on as each question was asked, every background read settled.
  const seen: { message: string; calls: number; waited: number }[] = [];
  const settle = async (message: string) => {
    for (let turn = 0; turn < 10; turn++) await new Promise((next) => setImmediate(next));
    seen.push({ message, calls: cf.calls.length, waited: prompter.waited.length });
  };
  const backable = prompter.backable!;
  prompter.backable = () => {
    const view = backable();
    return {
      ...view,
      select: async (message, ...rest) => (await settle(message), view.select(message, ...rest)),
      text: async (message, ...rest) => (await settle(message), view.text(message, ...rest)),
    };
  };
  const { ctx } = testContext({ root, client: cfClient({ spawn: cf.spawn }), prompter });
  assert.equal(await configure({ command: "init", values: { out: "init.jsonc" }, positionals: [] }, ctx, recording().deps), 0);
  assert.deepEqual(prompter.remaining(), []);
  const at = (message: string, nth: number) => seen.filter((entry) => entry.message.startsWith(message))[nth];
  // Back from the gateway question to the admins, then from the admins to the route.
  for (const [before, after] of [[at("Which AI Gateway", 0), at("Admin emails", 1)], [at("Admin emails", 1), at("Where will people reach it?", 1)]]) {
    assert.ok(before && after);
    assert.deepEqual({ calls: after.calls, waited: after.waited }, { calls: before.calls, waited: before.waited });
  }
});

test("a background read's failure is reported where its answer is used, with the same line", async (t) => {
  const { logged, prompter } = await init(t, [...COMPLETE, ["Deploy now?", false]],
    completeAccount({ "ai-gateway gateways list": { fail: "Authentication error [10000]" } }));
  const index = logged.findIndex(({ text }) => text.startsWith("Could not list the account's AI Gateways, so you will type it: "));
  assert.ok(index > 0, "no failure line");
  assert.match(logged[index].text, /Authentication error/);
  assert.equal(logged[index - 1].text, "It will answer on https://acme-os.acme-sub.workers.dev.");
  // Printed after the admins were answered, ahead of the gateway question.
  assert.match(logged[index].at.at(-1)!, /^Admin emails/);
  assert.ok(!logged[index].at.some((message) => message.startsWith("Which AI Gateway")));
  assert.deepEqual(prompter.asked.find(({ message }) => message.startsWith("Which AI Gateway"))!.choices, ["default"]);
});

/** An account where `words` fails, after 10 ms, every other call answering at once. */
function failingLate(words: string): { replies: Record<string, FakeReply>; delay: FakeCfOptions["delay"] } {
  return {
    replies: account({ [words]: { fail: "Internal error [10001]" } }),
    delay: (args) => args.join(" ").startsWith(words) ? 10 : 0,
  };
}

/** Long enough for a {@link failingLate} call to fail. */
const outlast = () => new Promise((done) => setTimeout(done, 30));

test("a background read nobody awaits never becomes an unhandled rejection", async (t) => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  t.after(() => process.off("unhandledRejection", listener));

  // Cancelled while the Workers are still being listed.
  const workers = failingLate("workers list");
  await assert.rejects(init(t, [["What are you setting up?", "new"], ["Base name", CANCEL]], workers.replies,
    { delay: workers.delay }), Cancelled);
  await outlast();
  // Esc out from the question after "new", while the organization is still being read.
  const organization = failingLate("zero-trust organization get");
  await assert.rejects(init(t, [["What are you setting up?", "new"], ["Base name", BACK], ["What are you setting up?", BACK]],
    organization.replies, { delay: organization.delay }), Cancelled);
  await outlast();
  assert.deepEqual(unhandled, []);
});

test("shows a step waiting on a read only while it is still in flight", async (t) => {
  const script: Step[] = [
    ["What are you setting up?", "new"],
    ["Base name", "acme-os"],
    ["Where will people reach it?", "custom"],
    ["Which zone?", "zone-1"],
    ["Hostname", "cf-os.example.com"],
    ...REST,
    ["No Access application covers", "skip"],
  ];
  const slow = await init(t, script, account(),
    { delay: (args) => args.join(" ").startsWith("ai-gateway gateways list") ? 300 : 0 });
  assert.ok(slow.prompter.waited.includes("Listing the account's AI Gateways"));
  // Settled while the zones and DNS records were read, so the gateway question waits on nothing.
  const settled = await init(t, script);
  assert.ok(!settled.prompter.waited.includes("Listing the account's AI Gateways"));
  assert.ok(settled.prompter.waited.includes("Listing the account's zones"));
});

test("runs the project's own Wrangler with node rather than through pnpm exec", async (t) => {
  const root = scratchProject(t, TEMPLATE);
  const installed = join(root, "node_modules", "wrangler");
  mkdirSync(join(installed, "bin"), { recursive: true });
  writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "wrangler", bin: { wrangler: "./bin/wrangler.js" } }));
  writeFileSync(join(installed, "bin", "wrangler.js"), "");
  const cf = fakeCf(completeAccount());
  const prompter = scriptedPrompter(COMPLETE);
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }), prompter });
  const recorded = recording();
  assert.equal(await configure({ command: "init", values: { out: "init.jsonc" }, positionals: [] }, harness.ctx,
    recorded.deps, { offerDeploy: false }), 0);
  assert.deepEqual(recorded.ran, [`${process.execPath} ${realpathSync(join(installed, "bin", "wrangler.js"))} whoami --json`]);
});
