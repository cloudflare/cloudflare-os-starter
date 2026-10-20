import assert from "node:assert/strict";
import test from "node:test";
import { cfClient } from "../cf-client.ts";
import { FAKE_ACCOUNT, fakeCf, WORKER_NOT_FOUND_FAILURE, workerSecretsReply, type FakeReply } from "../fake-cf.ts";
import {
  scratchProject, scriptedPrompter, TEMPLATE, testCatalog, testCatalogWithGitlab, testContext, type Step,
} from "../test-support.ts";
import type { SpawnTool } from "../tools.ts";
import { setSecrets } from "./secrets.ts";

/** {@link TEMPLATE} filled in, with GitHub, which reads secrets, and Home Assistant, which reads none. */
const FILLED = TEMPLATE
  .replace("<CLOUDFLARE_ACCOUNT_ID>", FAKE_ACCOUNT)
  .replace(/<([A-Z_]+)_WORKER_NAME>/g, (_, name: string) => `acme-${name.toLowerCase().replace(/_/g, "-")}`)
  .replace("<TEAM_NAME>", "acme")
  .replace("<ACCESS_AUDIENCE>", "aud-1")
  .replace("<ADMIN_EMAIL>", "me@example.com")
  .replace("<ORGANIZATION_DISPLAY_NAME>", "Acme")
  .replace("<ORGANIZATION_GUIDANCE>", "Be kind.")
  .replace('"gatekeepers": {}',
    '"gatekeepers": { "github": { "name": "acme-gk-github" }, "homeassistant": { "name": "acme-gk-homeassistant" } }');

const ID = "gh-id-123";
const SECRET = "gh-secret-456";

/** {@link FILLED} selecting GitLab and Home Assistant besides GitHub. */
const WITH_GITLAB = FILLED.replace('"github": { "name": "acme-gk-github" },',
  '"github": { "name": "acme-gk-github" }, "gitlab": { "name": "acme-gk-gitlab" },');

/**
 * Runs `cf-os secrets <positionals>` against a fake account whose Workers have `secrets` (or whose
 * `workers secrets list` answers `list`), answering from `script` (no terminal when null), each `cf`
 * call settling after `delay`. Its `wrangler secret bulk` adds the names on its stdin, but fails for
 * Worker `failing`. With `gitlab`, the file selects GitLab too.
 */
async function secrets(
  t: Parameters<typeof scratchProject>[0],
  { script = [], positionals = [], secrets: present = {}, flags = {}, gitlab = false, failing, list, delay }: {
    script?: Step[] | null; positionals?: string[]; secrets?: Record<string, string[]>; flags?: { account?: string };
    gitlab?: boolean; failing?: string; list?: FakeReply; delay?: (args: string[]) => number;
  } = {},
) {
  const root = scratchProject(t, gitlab ? WITH_GITLAB : FILLED);
  const ran: { args: string[]; input?: string }[] = [];
  // Each `cf` call stamped with how many tools had run when it started.
  const cf = fakeCf({ "workers secrets list": list ?? workerSecretsReply(present) }, { delay, stamp: () => ran.length });
  const spawn: SpawnTool = (_command, args, { input }) => {
    ran.push({ args, input });
    const worker = args[args.indexOf("--name") + 1];
    if (worker === failing) return { status: 1, stdout: "" };
    present[worker] = [...present[worker] ?? [], ...Object.keys(JSON.parse(input ?? "{}"))];
    return { status: 0, stdout: "" };
  };
  const prompter = script && scriptedPrompter(script);
  const harness = testContext({ root, prompter, client: cfClient({ spawn: cf.spawn }), flags });
  const result = setSecrets({ command: "secrets", values: {}, positionals }, harness.ctx,
    { spawn, catalog: async () => gitlab ? testCatalogWithGitlab() : testCatalog() });
  return { result, ran, calls: cf.calls, prompter, ...harness };
}

test("asks for the missing secrets, sets them, and prints their names, never their values, on stdout", async (t) => {
  const { result, ran, json, stderr, prompter } = await secrets(t, {
    secrets: { "acme-gk-github": [] },
    script: [
      ["Set the github Gatekeeper's OAuth credentials now?", "now"],
      ["OAuth client ID (CLIENT_ID)", ID],
      ["OAuth client secret (CLIENT_SECRET)", SECRET],
    ],
  });
  assert.equal(await result, 0);
  assert.deepEqual(prompter!.remaining(), []);
  assert.deepEqual(json, [{ set: [{ gatekeeper: "github", worker: "acme-gk-github", secrets: ["CLIENT_ID", "CLIENT_SECRET"] }] }]);
  assert.deepEqual(ran.map(({ args }) => args), [["exec", "wrangler", "secret", "bulk", "--name", "acme-gk-github"]]);
  assert.deepEqual(JSON.parse(ran[0].input!), { CLIENT_ID: ID, CLIENT_SECRET: SECRET });
  for (const where of [JSON.stringify(json), stderr()]) {
    assert.ok(!where.includes(ID) && !where.includes(SECRET), "a secret value was printed");
  }
  assert.match(stderr(), /Redirect URI: https:\/\/os\.example\.com\/gatekeeper\/github\/oauth/);
});

/** The answers that enter Gatekeeper `slug`'s CLIENT_ID and CLIENT_SECRET, asked for by `labels`. */
function enter(slug: string, id: string, secret: string, labels: [string, string]): Step[] {
  return [
    [`Set the ${slug} Gatekeeper's OAuth credentials now?`, "now"],
    [`${labels[0]} (CLIENT_ID)`, id],
    [`${labels[1]} (CLIENT_SECRET)`, secret],
  ];
}

test("one Gatekeeper's failed upload fails the run, after the rest are asked about, and what was set still goes to stdout", async (t) => {
  // The one set before the failure and the one after it both reach stdout.
  for (const [failing, set] of [["github", "gitlab"], ["gitlab", "github"]]) {
    const { result, ran, json, stderr, prompter } = await secrets(t, {
      gitlab: true,
      failing: `acme-gk-${failing}`,
      secrets: { "acme-gk-github": [], "acme-gk-gitlab": [] },
      script: [
        ...enter("github", ID, SECRET, ["OAuth client ID", "OAuth client secret"]),
        ...enter("gitlab", "gl-id-123", "gl-secret-456", ["OAuth application ID", "OAuth application secret"]),
      ],
    });
    assert.equal(await result, 1);
    assert.deepEqual(prompter!.remaining(), []);
    assert.deepEqual(ran.map(({ args }) => args.at(-1)), ["acme-gk-github", "acme-gk-gitlab"]);
    assert.match(stderr(), new RegExp(`The ${failing} Gatekeeper's OAuth credentials were not set: ` +
      `\`wrangler secret bulk --name acme-gk-${failing}\` failed\\. Its output is above\\. \`pnpm cf-os secrets ${failing}\` tries again\\.`));
    assert.deepEqual(json, [{ set: [{ gatekeeper: set, worker: `acme-gk-${set}`, secrets: ["CLIENT_ID", "CLIENT_SECRET"] }] }]);
  }
});

test("says what is set already, and asks nothing", async (t) => {
  const { result, json, stderr, ran } = await secrets(t, {
    positionals: ["github"], secrets: { "acme-gk-github": ["CLIENT_ID", "CLIENT_SECRET"] },
  });
  assert.equal(await result, 0);
  assert.deepEqual(json, [{ set: [] }]);
  assert.match(stderr(), /acme-gk-github already has every secret the github Gatekeeper reads\./);
  assert.deepEqual(ran, []);
});

test("tells a Gatekeeper not deployed yet to deploy first, and fails without creating anything", async (t) => {
  const { result, ran, json, stderr, calls } = await secrets(t);
  assert.equal(await result, 1);
  assert.match(stderr(), /acme-gk-github is not deployed yet; deploy first \(`pnpm cf-os deploy`\)/);
  assert.deepEqual(ran, []);
  assert.deepEqual(json, [{ set: [] }]);
  assert.deepEqual(calls.map(({ args }) => args), [["workers", "secrets", "list", "--script-name", "acme-gk-github"]]);
});

test("refuses a Gatekeeper the file does not select, or one that reads no secrets, listing those it can set", async (t) => {
  for (const slug of ["weather", "homeassistant"]) {
    const { result, calls } = await secrets(t, { positionals: ["github", slug] });
    await assert.rejects(result,
      new RegExp(`^Error: Not an optional Gatekeeper deployment\\.jsonc selects that reads secrets: ${slug}\\. Available: github\\.$`));
    assert.deepEqual(calls, []);
  }
});

test("refuses an --account other than the file's, before reading the account", async (t) => {
  const other = "fedcba9876543210fedcba9876543210";
  const { result, calls } = await secrets(t, { flags: { account: other } });
  await assert.rejects(result, new RegExp(`--account ${other} is not deployment\\.jsonc's accountId \\(${FAKE_ACCOUNT}\\)`));
  assert.deepEqual(calls, []);
});

test("without a terminal, fails naming the wrangler secret put commands for what is missing", async (t) => {
  const { result, ran, json } = await secrets(t, { script: null, secrets: { "acme-gk-github": ["CLIENT_ID"] } });
  await assert.rejects(result, (error: Error) => {
    assert.equal(error.message, "There is no terminal to ask for the values at. Set each with Wrangler, which asks for it:\n" +
      `  CLOUDFLARE_ACCOUNT_ID=${FAKE_ACCOUNT} pnpm exec wrangler secret put CLIENT_SECRET --name acme-gk-github`);
    return true;
  });
  assert.deepEqual(ran, []);
  assert.deepEqual(json, []);
});

/** A `delay` settling the `cf` calls in the reverse of the order they started: the first waits longest. */
function reversing(): (args: string[]) => number {
  let started = 0;
  return () => 60 - 10 * started++;
}

/** A `workers secrets list` reply: GitHub's Worker is not deployed, and GitLab's read fails. */
const undeployedAndFailing: FakeReply = (args) =>
  ({ fail: args.includes("acme-gk-gitlab") ? "[10013] internal error" : WORKER_NOT_FOUND_FAILURE });

test("without a terminal, prints and fails the same whichever Worker's read finishes first", async (t) => {
  const missing = { "acme-gk-github": ["CLIENT_ID"], "acme-gk-gitlab": [] };
  const manual = async (delay?: (args: string[]) => number) => {
    const { result, stderr, json, calls } = await secrets(t, { script: null, gitlab: true, secrets: { ...missing }, delay });
    const message = await result.then(() => "", (error: Error) => error.message);
    // Both read before either settled.
    assert.equal(calls.length, 2);
    return { message, stderr: stderr(), json };
  };
  const reversed = await manual(reversing());
  assert.deepEqual(reversed, await manual());
  assert.match(reversed.message, /wrangler secret put CLIENT_SECRET --name acme-gk-github\n.*--name acme-gk-gitlab\n.*--name acme-gk-gitlab$/);

  // Not deployed, and a read that fails: each reported at its Gatekeeper's turn, nothing set.
  const failing = async (delay?: (args: string[]) => number) => {
    const { result, stderr, json } = await secrets(t, { script: null, gitlab: true, list: undeployedAndFailing, delay });
    return { code: await result, stderr: stderr(), json };
  };
  const failed = await failing(reversing());
  assert.deepEqual(failed, await failing());
  assert.equal(failed.code, 1);
  assert.deepEqual(failed.json, [{ set: [] }]);
  assert.match(failed.stderr, /acme-gk-github is not deployed yet[\s\S]*The gitlab Gatekeeper's OAuth credentials were not set: cf workers secrets list .*\[10013\] internal error/);
});

test("confirms an upload with a fresh read after wrangler secret bulk, and shows what it waits on", async (t) => {
  const { result, calls, prompter } = await secrets(t, {
    secrets: { "acme-gk-github": [] },
    script: [
      ["Set the github Gatekeeper's OAuth credentials now?", "now"],
      ["OAuth client ID (CLIENT_ID)", ID],
      ["OAuth client secret (CLIENT_SECRET)", SECRET],
    ],
  });
  assert.equal(await result, 0);
  // The first read before any tool ran, the second once wrangler secret bulk had.
  assert.deepEqual(calls.map(({ args, at }) => [args.at(-1), at]), [["acme-gk-github", 0], ["acme-gk-github", 1]]);
  assert.deepEqual(prompter!.waited, ["Reading acme-gk-github's secrets", "Confirming acme-gk-github's secrets"]);
});
