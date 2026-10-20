import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localBin } from "./local-bin.ts";

test("runs an installed CLI's entry with node, and falls back to pnpm exec", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cf-os-bin-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(await localBin(root, "wrangler", ["whoami", "--json"]), ["pnpm", ["exec", "wrangler", "whoami", "--json"]]);

  const installed = join(root, "node_modules", "wrangler");
  mkdirSync(join(installed, "bin"), { recursive: true });
  writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "wrangler", bin: { wrangler: "./bin/wrangler.js" } }));
  writeFileSync(join(installed, "bin", "wrangler.js"), "");
  assert.deepEqual(await localBin(root, "wrangler", ["whoami", "--json"]),
    [process.execPath, [join(installed, "bin", "wrangler.js"), "whoami", "--json"]]);
});
