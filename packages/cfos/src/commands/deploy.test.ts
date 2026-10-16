import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { cfClient } from "../cf-client.ts";
import { FAKE_ACCOUNT, fakeCf } from "../fake-cf.ts";
import { CANCEL, DEFAULT, scratchProject, scriptedPrompter, TEMPLATE, testContext } from "../test-support.ts";
import { run } from "./deploy.ts";
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
  const declined = testContext({ root, prompter: scriptedPrompter([["Run `cfos init` now?", false]]) });
  await assert.rejects(run({ command: "check", values: {}, positionals: [] }, declined.ctx), /Replace deployment placeholder/);

  // Accepted, it is init that asks next -- here cancelled at its first question.
  const prompter = scriptedPrompter([["Run `cfos init` now?", true], ["What are you setting up?", CANCEL]]);
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
    ["Run `cfos init` now?", true],
    ["What are you setting up?", "new"],
    ["Base name", "acme-os"],
    ["Where will people reach it?", "workersDev"],
    ["Admin emails", DEFAULT],
    ["Which AI Gateway", "default"],
    ["Which model providers?", ["cloudflare"]],
    ["Organization name", DEFAULT],
    ["What it tells agents", DEFAULT],
  ]);
  const harness = testContext({ root, prompter, client: cfClient({ spawn: cf.spawn }) });
  // Past validation, the fixture has no Worker base configs to generate from: proof it carried on.
  await assert.rejects(run({ command: "deploy", values: {}, positionals: [] }, harness.ctx),
    /cloudflare-os[\\/]packages[\\/][\w-]+[\\/]wrangler\.jsonc/);
  assert.deepEqual(prompter.remaining(), []);
  assert.match(harness.stderr(), /Continuing with `cfos deploy`/);
  assert.doesNotMatch(harness.stderr(), /Deploy now\?|Next:/);
});

test("refuses before reading the file when the submodule is not installed", async (t) => {
  const harness = testContext({ root: scratchProject(t, TEMPLATE), prompter: scriptedPrompter([]) });
  await assert.rejects(run({ command: "check", values: {}, positionals: [] }, harness.ctx), /not initialized/);
});
