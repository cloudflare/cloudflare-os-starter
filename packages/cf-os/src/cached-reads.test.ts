import assert from "node:assert/strict";
import test from "node:test";
import { cachedReads } from "./cached-reads.ts";
import { cfClient } from "./cf-client.ts";
import { memoryClient } from "./core/memory-client.ts";
import { FAKE_ACCOUNT, fakeCf, flag } from "./fake-cf.ts";
import { scriptedPrompter } from "./test-support.ts";

test("labels every client method a step can wait on", async () => {
  const client = memoryClient({});
  const prompter = scriptedPrompter([]);
  const loud = cachedReads(client).loud(prompter) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const methods = Object.keys(client).filter((key) => typeof (client as unknown as Record<string, unknown>)[key] === "function");
  assert.ok(methods.length >= 17);
  for (const method of methods) await loud[method](FAKE_ACCOUNT, "zone-1", "os.example.com").catch(() => {});
  assert.equal(prompter.waited.length, methods.length);
  assert.ok(prompter.waited.every((label) => label.trim()), "an empty label");
  assert.equal(new Set(prompter.waited).size, methods.length, "two methods share a label");
});

test("makes each read once across both views, and every create each time it is asked", async () => {
  const cf = fakeCf({
    "workers list": [{ name: "acme" }],
    "zero-trust access applications create": (args) => ({ ...JSON.parse(flag(args, "--body")!), aud: "aud-new" }),
  });
  const { quiet, loud, pending } = cachedReads(cfClient({ spawn: cf.spawn }));
  const prompter = scriptedPrompter([]);
  const started = quiet.listWorkers(FAKE_ACCOUNT);
  assert.ok(pending());
  assert.deepEqual(await loud(prompter).listWorkers(FAKE_ACCOUNT), await started);
  assert.ok(!pending());
  // Settled, it answers without a spinner.
  await loud(prompter).listWorkers(FAKE_ACCOUNT);
  assert.deepEqual(prompter.waited, ["Listing the account's Workers"]);
  const app = { name: "Acme", domain: "os.example.com" };
  await loud(prompter).createAccessApp(FAKE_ACCOUNT, app);
  await quiet.createAccessApp(FAKE_ACCOUNT, app);
  assert.deepEqual(cf.calls.map((call) => call.args.slice(0, 2).join(" ")),
    ["workers list", "zero-trust access", "zero-trust access"]);
});
