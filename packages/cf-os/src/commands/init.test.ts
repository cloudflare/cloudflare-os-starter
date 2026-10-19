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
  testCatalog,
  testContext,
  type Step,
} from "../test-support.ts";
import type { Context } from "../context.ts";
import type { GatekeeperCatalog } from "../core/gatekeepers.ts";
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

/** Deps that record every tool run and every deploy, instead of running them, offering `catalog`. */
function recording(tools: ToolReplies = {}, catalog: GatekeeperCatalog = testCatalog()) {
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
    catalog: async () => catalog,
  };
  return { deps, ran, deployed };
}

/** Runs `cf-os init --out init.jsonc` in a scratch project, answering from `script`. */
async function init(
  t: Parameters<typeof scratchProject>[0],
  script: Step[],
  replies = account(),
  { flags = {}, tools, values = { out: "init.jsonc" }, offerDeploy, catalog, template = TEMPLATE }: {
    flags?: object; tools?: ToolReplies; values?: Record<string, string>; offerDeploy?: boolean;
    catalog?: GatekeeperCatalog; template?: string;
  } = {},
) {
  const root = scratchProject(t, template);
  const cf = fakeCf(replies);
  const prompter = scriptedPrompter(script);
  const harness = testContext({ root, client: cfClient({ spawn: cf.spawn }), prompter, flags });
  const recorded = recording(tools, catalog);
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
  assert.deepEqual(ran, [], "signed in anyway");
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

test("records an OAuth Gatekeeper, printing its setup and secret commands on stderr", async (t) => {
  const { code, written, json, stderr } = await init(t, [
    ...UP_TO_GATEKEEPERS,
    ["Which Gatekeepers?", ["custom", "github", "homeassistant"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
    ["Deploy now?", false],
  ], completeAccount());
  assert.equal(code, 0);
  assert.deepEqual(valueAtPath(written(), ["gatekeepers"]), {
    github: { name: "acme-os-gk-github" },
    homeassistant: { name: "acme-os-gk-homeassistant" },
  });
  assert.deepEqual(json, [], "wrote to stdout");
  const log = stderr();
  assert.match(log, /The github Gatekeeper \(acme-os-gk-github\) needs an OAuth app/);
  assert.match(log, /Console: https:\/\/github\.com\/settings\/developers/);
  assert.match(log, /Redirect URI: https:\/\/acme-os\.acme-sub\.workers\.dev\/gatekeeper\/github\/oauth\n/);
  for (const secret of ["CLIENT_ID", "CLIENT_SECRET"]) {
    assert.ok(log.includes(`CLOUDFLARE_ACCOUNT_ID=${FAKE_ACCOUNT} pnpm exec wrangler secret put ${secret} --name acme-os-gk-github`),
      `no command for ${secret}`);
  }
  assert.match(log, /Deploying first is fine/);
  // Home Assistant takes no credentials, so it has nothing to set.
  assert.doesNotMatch(log, /homeassistant Gatekeeper .*needs/);
  // Printed after the file is written, before the deploy question.
  assert.ok(log.indexOf("Wrote ") < log.indexOf("Redirect URI"));
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
  assert.match(stderr(), /secret put CLIENT_ID --name acme-os-github\n/);
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
  assert.match(log, /Redirect URI: <PUBLIC_ORIGIN>\/gatekeeper\/github\/oauth\n/);
  assert.match(log, /wrangler secret put CLIENT_SECRET --name acme-gk-github/);
  assert.doesNotMatch(log, /example\.com\/gatekeeper/);
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
  const own = TEMPLATE.replace('"<ROUTER_WORKER_NAME>"', '"acme"')
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
const OWN_CUSTOM = TEMPLATE.replace('"<ROUTER_WORKER_NAME>"', '"acme"')
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

/** A template for router `router` whose `gatekeepers` block names `worker` as the GitHub Gatekeeper's Worker. */
function githubTemplate(router: string, worker: string): string {
  return TEMPLATE.replace('"<ROUTER_WORKER_NAME>"', JSON.stringify(router))
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
  assert.match(log, /The file's workers\.router\.name is not acme, so the Gatekeeper Workers its gatekeepers block names may be another deployment's, and are left alone: zeta-gk-github\./);
  assert.doesNotMatch(log, /zeta-gk-github already runs|Warning: leaving out/);
});

test("without a Gatekeeper catalog, still asks about the custom Gatekeeper", async (t) => {
  const { code, prompter, stderr, written } = await init(t, [...COMPLETE, ["Deploy now?", false]], completeAccount(),
    { catalog: { offered: [], excluded: [], unavailable: "no submodule install" } });
  assert.equal(code, 0);
  assert.deepEqual(prompter.asked.find((question) => question.message.startsWith("Which Gatekeepers?"))!.choices, ["custom"]);
  assert.match(stderr(), /The Gatekeeper catalog could not be read, so only the example custom Gatekeeper is offered: no submodule install/);
  assert.equal(valueAtPath(written(), ["customGatekeeper", "enabled"]), true);
});
