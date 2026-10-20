import assert from "node:assert/strict";
import test from "node:test";
import type { DeploymentConfig } from "./core/deployment-config.ts";
import { memoryClient, type MemoryAccount } from "./core/memory-client.ts";
import { FAKE_ACCOUNT } from "./fake-cf.ts";
import { askAndSetSecrets, putWorkerSecrets, secretsCommand, type SecretsOutcome } from "./gatekeeper-secrets.ts";
import { scriptedPrompter, testCatalog, testContext, type Step } from "./test-support.ts";
import type { SpawnTool } from "./tools.ts";

/** GitHub, which reads CLIENT_ID and CLIENT_SECRET, and Home Assistant, which reads none. */
const config = {
  accountId: FAKE_ACCOUNT,
  publicBaseUrl: "https://os.example.com",
  gatekeepers: { github: { name: "acme-gk-github" }, homeassistant: { name: "acme-gk-homeassistant" } },
} as unknown as DeploymentConfig;

const ID = "gh-id-123";
const SECRET = "gh-secret-456";

/** One recorded tool run. */
interface Ran {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  input?: string;
}

/**
 * A spawn recording every run. `wrangler secret bulk` succeeds and, unless `parses` is false (as
 * when Wrangler cannot read its input and still exits 0), adds the names on its stdin to the
 * Worker's secrets in `account`. `status` makes it fail instead.
 */
function recordingSpawn(account: MemoryAccount, { parses = true, status = 0 } = {}): { spawn: SpawnTool; ran: Ran[] } {
  const ran: Ran[] = [];
  const spawn: SpawnTool = (command, args, { env, input }) => {
    ran.push({ command, args, env, input });
    const worker = args[args.indexOf("--name") + 1];
    if (status === 0 && parses && input !== undefined) {
      account.secrets = { ...account.secrets, [worker]: [...account.secrets?.[worker] ?? [], ...Object.keys(JSON.parse(input))] };
    }
    return { status, stdout: "" };
  };
  return { spawn, ran };
}

/** Runs {@link askAndSetSecrets} for `slugs` against `account`, answering from `script`. */
async function ask(
  account: MemoryAccount,
  script: Step[] | null,
  { slugs = ["github", "homeassistant"], upload = "now" as "now" | "deferred", parses = true, status = 0, flags = {} } = {},
) {
  const client = memoryClient(account);
  const { spawn, ran } = recordingSpawn(account, { parses, status });
  const prompter = script && scriptedPrompter(script);
  const harness = testContext({ root: "/project", prompter, flags });
  const result: Promise<SecretsOutcome> = askAndSetSecrets(harness.ctx, { prompter, client, spawn },
    { config, catalog: testCatalog(), slugs, upload });
  return { result, client, ran, prompter, ...harness };
}

const ENTER: Step[] = [
  ["Set the github Gatekeeper's OAuth credentials now?", "now"],
  ["OAuth client ID (CLIENT_ID)", ID],
  ["OAuth client secret (CLIENT_SECRET)", SECRET],
];

test("uploads the values on wrangler secret bulk's stdin, never in argv, and confirms them", async () => {
  const account: MemoryAccount = { workers: [{ name: "acme-gk-github" }] };
  const { result, client, ran, prompter, stderr, json } = await ask(account, ENTER);
  assert.deepEqual((await result).set, [{ gatekeeper: "github", worker: "acme-gk-github", secrets: ["CLIENT_ID", "CLIENT_SECRET"] }]);

  assert.equal(ran.length, 1);
  assert.equal(ran[0].command, "pnpm");
  assert.deepEqual(ran[0].args, ["exec", "wrangler", "secret", "bulk", "--name", "acme-gk-github"]);
  assert.deepEqual(JSON.parse(ran[0].input!), { CLIENT_ID: ID, CLIENT_SECRET: SECRET });
  assert.equal(ran[0].env?.CLOUDFLARE_ACCOUNT_ID, FAKE_ACCOUNT);
  // Listed once to find what is missing, once to confirm the upload; Home Assistant never.
  assert.deepEqual(client.calls, ["listWorkerSecrets", "listWorkerSecrets"]);

  // The choice offered, and the setup shown before it: the steps and redirect URI, not the commands.
  const choice = prompter!.asked[0];
  assert.deepEqual([choice.kind, choice.choices, choice.initial], ["select", ["now", "later"], "now"]);
  assert.deepEqual(prompter!.asked.slice(1).map(({ kind }) => kind), ["password", "password"]);
  const log = stderr();
  assert.match(log, /The github Gatekeeper \(acme-gk-github\) needs an OAuth app before anyone can connect it:\n {2}Console: https:\/\/github\.com\/settings\/developers\n/);
  assert.match(log, /\n {2}Redirect URI: https:\/\/os\.example\.com\/gatekeeper\/github\/oauth\n/);
  assert.doesNotMatch(log, /secret put/);
  assert.match(log, /Set CLIENT_ID and CLIENT_SECRET on acme-gk-github\./);

  // Nowhere but stdin: not in the log, stdout or what the prompter recorded.
  for (const where of [log, JSON.stringify(json), JSON.stringify(prompter!.asked), JSON.stringify(ran[0].args)]) {
    assert.ok(!where.includes(ID) && !where.includes(SECRET), `a secret value leaked into ${where}`);
  }
});

test("asks only for the secrets the Worker lacks", async () => {
  const account: MemoryAccount = { secrets: { "acme-gk-github": ["CLIENT_ID"] } };
  const { result, ran, prompter } = await ask(account, [ENTER[0], ENTER[2]]);
  assert.deepEqual((await result).set, [{ gatekeeper: "github", worker: "acme-gk-github", secrets: ["CLIENT_SECRET"] }]);
  assert.deepEqual(JSON.parse(ran[0].input!), { CLIENT_SECRET: SECRET });
  assert.equal(prompter!.asked.length, 2);
});

test("never uploads to a Worker that does not exist, nor asks for its values", async () => {
  const { result, ran, client, stderr } = await ask({}, []);
  assert.deepEqual((await result).undeployed, ["github"]);
  assert.deepEqual((await result).set, []);
  assert.deepEqual(ran, []);
  assert.deepEqual(client.calls, ["listWorkerSecrets"]);
  assert.match(stderr(),
    /acme-gk-github is not deployed yet; deploy first \(`pnpm cf-os deploy`\), then `pnpm cf-os secrets github` sets the github Gatekeeper's CLIENT_ID and CLIENT_SECRET\./);
});

test("reports it when the Worker's secrets, listed again, lack a name Wrangler was given", async () => {
  const account: MemoryAccount = { workers: [{ name: "acme-gk-github" }] };
  const { result, ran, stderr } = await ask(account, ENTER, { parses: false });
  const outcome = await result;
  assert.deepEqual([outcome.set, outcome.failed], [[], ["github"]]);
  assert.match(stderr(), new RegExp("\\nThe github Gatekeeper's OAuth credentials were not set: Wrangler finished, but " +
    "acme-gk-github has no CLIENT_ID or CLIENT_SECRET\\. `pnpm cf-os secrets github` tries again\\.$"));
  assert.equal(ran.length, 1);
});

test("reports it when wrangler secret bulk fails", async () => {
  const account: MemoryAccount = { workers: [{ name: "acme-gk-github" }] };
  const { result, stderr } = await ask(account, ENTER, { status: 1 });
  assert.deepEqual((await result).failed, ["github"]);
  assert.match(stderr(), /The github Gatekeeper's OAuth credentials were not set: `wrangler secret bulk --name acme-gk-github` failed\. Its output is above\. `pnpm cf-os secrets github` tries again\./);
  const { spawn, ran } = recordingSpawn({}, { status: 1 });
  assert.throws(() => putWorkerSecrets(spawn, "/project", FAKE_ACCOUNT, "acme-gk-github", { CLIENT_ID: ID }),
    /wrangler secret bulk --name acme-gk-github` failed/);
  assert.equal(ran.length, 1);
});

test("keeps Wrangler from logging the request that carries the values, whatever the shell sets", (t) => {
  const before = process.env.WRANGLER_LOG_SANITIZE;
  t.after(() => {
    if (before === undefined) delete process.env.WRANGLER_LOG_SANITIZE;
    else process.env.WRANGLER_LOG_SANITIZE = before;
  });
  process.env.WRANGLER_LOG_SANITIZE = "false";
  const { spawn, ran } = recordingSpawn({});
  putWorkerSecrets(spawn, "/project", FAKE_ACCOUNT, "acme-gk-github", { CLIENT_ID: ID });
  assert.equal(ran[0].env?.WRANGLER_LOG_SANITIZE, "true");
});

/** A context in /project/sub, a directory of project /project, with `flags`. */
function project(flags: { config?: string }) {
  return testContext({ root: "/project", cwd: "/project/sub", flags }).ctx;
}

test("names the deployment file in the commands it prints, unless it is the project's deployment.jsonc", async () => {
  const { result, stderr } = await ask({}, [], { flags: { config: "staging.jsonc" } });
  await result;
  assert.match(stderr(), /deploy first \(`pnpm cf-os deploy --config staging\.jsonc`\), then `pnpm cf-os secrets github --config staging\.jsonc` sets/);
  assert.equal(secretsCommand(project({}), "github"), "pnpm cf-os secrets github");
  assert.equal(secretsCommand(project({ config: "../deployment.jsonc" }), "github"), "pnpm cf-os secrets github");
  // Outside where the command was run, the path is absolute, as displayPath gives it.
  assert.equal(secretsCommand(project({ config: "/project/staging.jsonc" }), "github"),
    "pnpm cf-os secrets github --config /project/staging.jsonc");
  assert.equal(secretsCommand(project({ config: "staging.jsonc" }), "github"),
    "pnpm cf-os secrets github --config staging.jsonc");
});

test("uploads nothing, and asks for no value, when left for later", async () => {
  const account: MemoryAccount = { workers: [{ name: "acme-gk-github" }] };
  const { result, ran, prompter } = await ask(account, [["Set the github Gatekeeper's OAuth credentials now?", "later"]]);
  assert.deepEqual(await result, { set: [], pending: [], complete: [], undeployed: [], later: ["github"], manual: [], failed: [] });
  assert.deepEqual(ran, []);
  assert.ok(!prompter!.asked.some(({ kind }) => kind === "password"));
});

test("refuses an empty value and asks again, keeping no answer in the record", async () => {
  const account: MemoryAccount = { workers: [{ name: "acme-gk-github" }] };
  const { result, ran, prompter } = await ask(account, [
    ENTER[0],
    ["OAuth client ID", ""],
    ["OAuth client ID", "   "],
    ["OAuth client ID", ` ${ID}\n`],
    ENTER[2],
  ]);
  await result;
  const asked = prompter!.asked.filter(({ kind }) => kind === "password");
  assert.deepEqual(asked.map(({ refused }) => refused), [
    "CLIENT_ID cannot be empty. Paste it, or press Ctrl-C to stop.",
    "CLIENT_ID cannot be empty. Paste it, or press Ctrl-C to stop.",
    undefined,
    undefined,
  ]);
  // Pasted with whitespace around it, sent without.
  assert.deepEqual(JSON.parse(ran[0].input!), { CLIENT_ID: ID, CLIENT_SECRET: SECRET });
  assert.ok(!JSON.stringify(prompter!.asked).includes(ID));
});

test("deferred, returns the values for a Worker not deployed yet without uploading them", async () => {
  const { result, ran, client } = await ask({}, ENTER, { upload: "deferred" });
  assert.deepEqual((await result).pending, [
    { gatekeeper: "github", worker: "acme-gk-github", values: { CLIENT_ID: ID, CLIENT_SECRET: SECRET } },
  ]);
  assert.deepEqual((await result).set, []);
  assert.deepEqual(ran, []);
  assert.deepEqual(client.calls, ["listWorkerSecrets"]);
});

test("asks nothing for a Worker that has every secret", async () => {
  const { result, ran } = await ask({ secrets: { "acme-gk-github": ["CLIENT_ID", "CLIENT_SECRET"] } }, []);
  assert.deepEqual((await result).complete, ["github"]);
  assert.deepEqual(ran, []);
});

test("without a terminal, asks nothing and returns the wrangler secret put commands for what is missing", async () => {
  const account: MemoryAccount = { secrets: { "acme-gk-github": ["CLIENT_ID"] } };
  const { result, ran } = await ask(account, null);
  assert.deepEqual((await result).manual, [{
    gatekeeper: "github",
    worker: "acme-gk-github",
    commands: [`CLOUDFLARE_ACCOUNT_ID=${FAKE_ACCOUNT} pnpm exec wrangler secret put CLIENT_SECRET --name acme-gk-github`],
  }]);
  assert.deepEqual(ran, []);
});
