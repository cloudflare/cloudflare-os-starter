import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { CancelledError, concurrencyLimit, mapConcurrent, runCaptured } from "./run-tasks.ts";

test("runs at most `limit` tasks at once and keeps the input's order", async () => {
  let running = 0;
  let peak = 0;
  const results = await mapConcurrent([30, 5, 20, 1, 10], 2, async (ms, index) => {
    running++;
    peak = Math.max(peak, running);
    await sleep(ms);
    running--;
    return index;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
});

test("awaits every task before rejecting, and reports every failure", async () => {
  const finished: number[] = [];
  const one = mapConcurrent([0, 1, 2], 3, async (index) => {
    if (index === 0) throw new Error("first");
    await sleep(10);
    finished.push(index);
  });
  await assert.rejects(one, /^Error: first$/);
  assert.deepEqual(finished, [1, 2]);

  const several = mapConcurrent([0, 1, 2], 3, async (index) => {
    if (index < 2) throw new Error(`failed ${index}`);
  });
  await assert.rejects(several, (error: unknown) =>
    error instanceof AggregateError && error.errors.map((e: Error) => e.message).join() === "failed 0,failed 1");
});

test("stops claiming items once aborted", async () => {
  const abort = new AbortController();
  const started: number[] = [];
  const run = mapConcurrent([0, 1, 2, 3], 1, async (index) => {
    started.push(index);
    if (index === 1) abort.abort(new Error("stop"));
  }, abort.signal);
  await assert.rejects(run, /stop/);
  assert.deepEqual(started, [0, 1]);
});

test("never picks fewer than two at a time", () => {
  assert.ok(concurrencyLimit() >= 2);
});

function node(script: string): [string, string[]] {
  return [process.execPath, ["-e", script]];
}

test("prints a command's output once, as one labelled block", async () => {
  const log: string[] = [];
  await runCaptured("hello", ...node("console.log('out'); console.error('err')"), { cwd: process.cwd(), log: (text) => log.push(text) });
  assert.equal(log.length, 1);
  assert.match(log[0], /^\n----- hello \(\d+\.\ds\) -----\nout\nerr$/);
});

test("names the label when a command fails, after printing its output", async () => {
  const log: string[] = [];
  await assert.rejects(
    runCaptured("broken", ...node("console.error('type error'); process.exit(3)"), { cwd: process.cwd(), log: (text) => log.push(text) }),
    /^Error: broken failed \(exit 3\)\. Its output is above\.$/);
  assert.match(log.join("\n"), /----- broken .*\ntype error/);
});

test("kills a running command when aborted", async () => {
  const log: string[] = [];
  const abort = new AbortController();
  const startedAt = Date.now();
  const run = runCaptured("slow", ...node("setInterval(() => {}, 1000)"), { cwd: process.cwd(), signal: abort.signal, log: (text) => log.push(text) });
  setTimeout(() => abort.abort(), 100);
  await assert.rejects(run, CancelledError);
  assert.ok(Date.now() - startedAt < 5_000, "the command outlived its cancellation");
  assert.deepEqual(log.map((line) => line.replace(/\(.*\)/, "")), ["cancelled: slow "]);
  // Aborted before it starts, nothing is spawned or printed.
  await assert.rejects(runCaptured("never", ...node(""), { cwd: process.cwd(), signal: abort.signal, log: (text) => log.push(text) }),
    CancelledError);
  assert.equal(log.length, 1);
});
