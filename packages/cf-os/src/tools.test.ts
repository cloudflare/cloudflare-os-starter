import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultCapture, defaultSpawn } from "./tools.ts";

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

test("captures a status read's output and exit status, the event loop turning while it runs", async () => {
  let turned = false;
  setImmediate(() => turned = true);
  const result = await defaultCapture()(process.execPath, ["-e", "process.stdout.write('me'); process.stderr.write('why'); process.exitCode = 3"],
    { cwd: process.cwd() });
  assert.deepEqual(result, { status: 3, stdout: "me", stderr: "why" });
  assert.ok(turned, "blocked the event loop");
});

test("reports a command that cannot run as an error, without throwing", async () => {
  const result = await defaultCapture()("cf-os-no-such-command", [], { cwd: process.cwd() });
  assert.equal(result.status, null);
  assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "ENOENT");
});

test("stops waiting on a status read when its signal aborts, leaving it to finish without holding the process", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cf-os-capture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, "finished");
  // The read, left to finish, writes the marker; the process waiting on it stops waiting and exits.
  const read = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, ""), 1500)`;
  const script = `
    import { defaultCapture } from ${JSON.stringify(new URL("./tools.ts", import.meta.url).href)};
    const stop = new AbortController();
    const reading = defaultCapture()(process.execPath, ["-e", ${JSON.stringify(read)}], { cwd: process.cwd(), signal: stop.signal });
    setTimeout(() => stop.abort(), 50);
    const result = await reading;
    process.stdout.write(result.error ? "stopped" : "finished");
  `;
  const started = performance.now();
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(run.stdout, "stopped", run.stderr);
  assert.ok(performance.now() - started < 1400, "waited for the read to finish");
  assert.ok(!existsSync(marker), "the read finished before it was stopped");
  for (let waited = 0; !existsSync(marker) && waited < 5000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(marker), "the read was killed rather than left to finish");
});
