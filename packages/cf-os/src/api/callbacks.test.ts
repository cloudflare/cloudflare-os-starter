import assert from "node:assert/strict";
import test from "node:test";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { callbackStub, callbackTarget, functionStub, ndjsonEvents } from "./callbacks.ts";
import { table } from "./generated/commands.ts";
import type { Remote } from "./session.ts";

/** A server whose `drive` calls each named method of the callback it is given, once, in order. */
class Driver extends RpcTarget {
  async drive(callback: Remote, methods: string[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const method of methods) results.push(await callback[method](method, new Date(0), 1n));
    return results;
  }
  async fire(callback: Remote, value: unknown): Promise<unknown> {
    return callback(value);
  }
}

function session(t: { after: (fn: () => void) => void }): Remote {
  const { port1, port2 } = new MessageChannel();
  newMessagePortRpcSession(port2, new Driver());
  const main = newMessagePortRpcSession(port1);
  t.after(() => {
    main[Symbol.dispose]();
    port1.close();
    port2.close();
  });
  return main;
}

test("a callback target answers every method its table entry lists, as prototype methods", async (t) => {
  // AiChatSubscriber is the widest of upstream's: a subscriber missing `changeApplied` dies the
  // first time a change lands.
  const entry = table.callbacks.AiChatSubscriber;
  const names = entry.methods.map((method) => method.name);
  assert.ok(names.includes("changeApplied"));
  const events: [string, unknown[]][] = [];
  const target = callbackTarget("AiChatSubscriber", entry, (event, args) => events.push([event, args]));
  assert.deepEqual(Object.getOwnPropertyNames(target), []);
  for (const name of names) assert.equal(typeof Object.getPrototypeOf(target)[name], "function");

  const main = session(t);
  const stub = callbackStub("AiChatSubscriber", entry, (event, args) => events.push([event, args]));
  assert.deepEqual(await main.drive(stub, names), names.map(() => undefined));
  stub[Symbol.dispose]();
  assert.deepEqual(events.map(([event]) => event), names);
  assert.deepEqual(events[0][1], [names[0], new Date(0), 1n]);
});

test("every callback interface in the table gets its own complete target", async (t) => {
  const main = session(t);
  for (const [name, entry] of Object.entries(table.callbacks)) {
    const seen: string[] = [];
    const stub = callbackStub(name, entry, (event) => seen.push(event));
    await main.drive(stub, entry.methods.map((method) => method.name));
    stub[Symbol.dispose]();
    assert.deepEqual(seen, entry.methods.map((method) => method.name), name);
  }
});

test("a bare-function callback emits events named after its parameter", async (t) => {
  const main = session(t);
  const events: [string, unknown[]][] = [];
  const stub = functionStub("callback", (event, args) => events.push([event, args]));
  assert.equal(await main.fire(stub, { title: "x" }), undefined);
  stub[Symbol.dispose]();
  assert.deepEqual(events, [["callback", [{ title: "x" }]]]);
});

test("events are NDJSON lines, their arguments encoded as results are", () => {
  const lines: string[] = [];
  ndjsonEvents((line) => lines.push(line))("added", [{ when: new Date(0), size: 3n, body: new Uint8Array([1]) }, undefined]);
  assert.deepEqual(lines, ['{"event":"added","args":[{"when":"1970-01-01T00:00:00.000Z","size":"3","body":{"base64":"AQ=="}},null]}\n']);
});
