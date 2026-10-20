import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { defaultSpawn } from "./tools.ts";

test("a shown tool's stdout goes to stderr, leaving stdout to the command's results", () => {
  // In a child of its own, so this process's stdout is the one under test.
  const script = `
    import { defaultSpawn } from ${JSON.stringify(new URL("./tools.ts", import.meta.url).href)};
    const result = defaultSpawn()(process.execPath, ["-e", "process.stdout.write('from the tool')"],
      { cwd: process.cwd(), capture: false });
    process.exitCode = result.status;
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "from the tool");
});

test("writes input to the tool's stdin, shown or captured", () => {
  const captured = defaultSpawn()(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"],
    { cwd: process.cwd(), capture: true, input: '{"A":"a-123"}' });
  assert.equal(captured.status, 0, captured.stderr ?? "");
  assert.equal(captured.stdout, '{"A":"a-123"}');

  // Shown, in a child of its own, as above.
  const script = `
    import { defaultSpawn } from ${JSON.stringify(new URL("./tools.ts", import.meta.url).href)};
    const result = defaultSpawn()(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"],
      { cwd: process.cwd(), capture: false, input: "piped-value-123" });
    process.exitCode = result.status;
  `;
  const shown = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, "");
  assert.equal(shown.stderr, "piped-value-123");
});
