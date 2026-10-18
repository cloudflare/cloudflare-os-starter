import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { table } from "../../generator/__fixtures__/generated/commands.ts";
import { callsOf, eventually, fixtureRoot, messagePortServer, serverLog, type FixtureOptions } from "../api/test-server.ts";
import { UsageError } from "../context.ts";
import { scratchProject, testContext } from "../test-support.ts";
import { run, type ApiDeps } from "./api.ts";

/** Just enough deployment file for the origin: `https://os.example.com`. */
const DEPLOYMENT = `{
  "publicBaseUrl": null,
  "workers": { "router": { "name": "acme-os", "route": { "customDomain": "os.example.com" } } }
}
`;

const NOTE_JSON = JSON.stringify({
  id: 1,
  title: "t",
  created: "2026-01-02T03:04:05Z",
  size: "12345678901234567890",
  body: { base64: "AQID" },
});

/**
 * `cf-os api` against the fixture server, as main.ts runs it: every token after `api` in
 * `positionals`. Token sign-in unless `env` says otherwise.
 */
function harness(
  t: { after: (fn: () => void) => void },
  { env = { CFOS_API_TOKEN: "good-token" }, stdin = "", tty = false, options = {} }:
    { env?: NodeJS.ProcessEnv; stdin?: string; tty?: boolean; options?: FixtureOptions } = {},
) {
  const root = scratchProject(t, DEPLOYMENT);
  const log = serverLog();
  const server = messagePortServer(log, () => fixtureRoot(log, options));
  t.after(() => server.close());
  const chunks: Buffer[] = [];
  const stdout = Object.assign(new PassThrough(), { isTTY: tty });
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const spawned: string[][] = [];
  const fetched: string[] = [];
  let interrupt: (() => void) | undefined;
  const deps: ApiDeps = {
    table,
    env,
    open: server.open,
    spawn: (command, args) => {
      spawned.push([command, ...args]);
      return { status: 1, stdout: "", stderr: "not logged in" };
    },
    fetch: async (url) => {
      fetched.push(url);
      return { status: 200, headers: new Headers() };
    },
    stdout,
    stdin: Readable.from([Buffer.from(stdin)]),
    onInterrupt: (listener) => {
      interrupt = listener;
      return () => {
        interrupt = undefined;
      };
    },
  };
  const context = testContext({ root });
  return {
    ...context,
    root,
    log,
    server,
    spawned,
    fetched,
    stdout: () => Buffer.concat(chunks).toString("utf8"),
    stdoutStream: stdout,
    interrupt: () => {
      assert.ok(interrupt, "nothing is listening for SIGINT");
      interrupt();
    },
    listening: () => interrupt !== undefined,
    api: (...positionals: string[]) => run({ command: "api", values: {}, positionals }, context.ctx, deps),
  };
}

test("a chain is sent pipelined in one session, its result printed and every stub disposed", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("open-notebook", "n1", "outline"), 0);
  assert.deepEqual(h.json, [{ title: "n1", children: [{ title: "child", children: [] }] }]);
  assert.equal(h.server.opened, 1);
  assert.deepEqual(callsOf(h.log, "authenticate"), [["good-token"]]);
  // The flag is whether `outline` had already been sent when the server ran `openNotebook`: it had,
  // because nothing waited for `openNotebook`'s result before calling on it.
  assert.deepEqual(callsOf(h.log, "openNotebook"), [["n1", true]]);
  await eventually(() => ["notebook", "authed", "root"].every((name) => h.log.disposed.includes(name)), "disposal");
  assert.equal(h.listening(), false);
});

test("optional parameters are flags, anywhere in their segment; unset ones are undefined, trailing ones trimmed", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("find-notes", "q", "--limit", "5", "--arg-url", "x"), 0);
  assert.equal(await h.api("find-notes", "--arg-url=x", "q"), 0);
  assert.equal(await h.api("find-notes", "q"), 0);
  assert.equal(await h.api("find-notes", "-5", "--limit", "-1"), 0);
  assert.deepEqual(callsOf(h.log, "findNotes"), [["q", 5, "x"], ["q", undefined, "x"], ["q"], ["-5", -1]]);
  assert.deepEqual(h.json[0], [{ id: 1, title: "q" }]);
});

test("JSON arguments are revived against their declared shape, inline, from @file or from stdin", async (t) => {
  const h = harness(t, { stdin: NOTE_JSON });
  writeFileSync(join(h.root, "dest.json"), '{"kind": "folder", "path": "/a"}');
  assert.equal(await h.api("open-notebook", "n", "file", NOTE_JSON, "@dest.json"), 0);
  assert.equal(await h.api("open-notebook", "n", "file", "-", '{"kind": "inbox"}'), 0);
  const [[note, destination], [fromStdin, inbox]] = callsOf(h.log, "file") as Record<string, unknown>[][];
  for (const received of [note, fromStdin]) {
    assert.ok(received.created instanceof Date);
    assert.equal((received.created as Date).toISOString(), "2026-01-02T03:04:05.000Z");
    assert.equal(received.size, 12345678901234567890n);
    assert.deepEqual(received.body, new Uint8Array([1, 2, 3]));
  }
  assert.deepEqual(destination, { kind: "folder", path: "/a" });
  assert.deepEqual(inbox, { kind: "inbox" });
});

test("scalars, bytes and booleans decode by their encoding, and a bad token fails before connecting", async (t) => {
  const h = harness(t);
  writeFileSync(join(h.root, "content.bin"), Buffer.from([9, 8, 7]));
  assert.equal(await h.api("set-nickname", "null"), 0);
  assert.equal(await h.api("set-mood", "busy"), 0);
  assert.equal(await h.api("open-notebook", "n", "upload", "@content.bin", "--pinned"), 0);
  assert.equal(await h.api("open-notebook", "n", "upload", '{"base64": "AQ=="}', "--no-pinned"), 0);
  assert.deepEqual(callsOf(h.log, "setNickname"), [[null]]);
  assert.deepEqual(callsOf(h.log, "setMood"), [["busy"]]);
  assert.deepEqual(callsOf(h.log, "upload"), [[new Uint8Array([9, 8, 7]), true], [new Uint8Array([1]), false]]);
  const opened = h.server.opened;
  await assert.rejects(h.api("set-mood", "angry"), (error: Error) =>
    error instanceof UsageError && /must be one of busy, calm/.test(error.message));
  await assert.rejects(h.api("open-notebook", "n", "file", "{", "{}"), UsageError);
  assert.equal(h.server.opened, opened);
});

test("a subscription prints NDJSON events until --timeout, then disposes its handle and exits 0", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("open-notebook", "n", "subscribe", "--timeout", "0.3"), 0);
  const events = h.stdout().trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.event), ["added", "removed", "ready"]);
  assert.deepEqual(events[0].args, { note: {
    id: 1,
    title: "First",
    created: "2026-01-02T03:04:05.000Z",
    size: "12345678901234567890",
    body: { base64: "AQID" },
    tags: ["a"],
  } });
  assert.deepEqual(events[1].args, { id: 7 });
  assert.deepEqual(events[2].args, {});
  assert.deepEqual(callsOf(h.log, "subscriberFailed"), []);
  await eventually(() => ["subscription", "notebook", "authed", "root"].every((name) => h.log.disposed.includes(name)), "disposal");
});

test("a bare-function callback's events are named after its parameter", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("open-notebook", "n", "watch-title", "--timeout", "0.2"), 0);
  assert.deepEqual(h.stdout().trim().split("\n").map((line) => JSON.parse(line)), [{ event: "callback", args: { title: "title of n" } }]);
  await eventually(() => h.log.disposed.includes("watch"), "the handle's disposal");
});

test("SIGINT ends a subscription with 130, disposing its handle", async (t) => {
  const h = harness(t);
  const running = h.api("open-notebook", "n", "subscribe");
  await eventually(() => h.stdout().trim().split("\n").length === 3, "the events");
  h.interrupt();
  assert.equal(await running, 130);
  await eventually(() => ["subscription", "root"].every((name) => h.log.disposed.includes(name)), "disposal");
});

test("a reader of stdout going away (EPIPE) ends a subscription with 0, disposing its handle", async (t) => {
  const h = harness(t);
  const running = h.api("open-notebook", "n", "subscribe");
  await eventually(() => h.stdout().trim().split("\n").length === 3, "the events");
  h.stdoutStream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  assert.equal(await running, 0);
  await eventually(() => ["subscription", "root"].every((name) => h.log.disposed.includes(name)), "disposal");
});

test("an EPIPE that arrives after the result is written, a tick later as pipes report it, is no crash", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("set-mood", "calm"), 0);
  assert.doesNotThrow(() => h.stdoutStream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
  // Anything else on stdout is still the failure it would be without the listener.
  assert.throws(() => h.stdoutStream.emit("error", Object.assign(new Error("write EIO"), { code: "EIO" })), /EIO/);
});

test("a subscription whose --timeout runs out before it is subscribed fails, rather than exiting 0", async (t) => {
  const h = harness(t, { env: { CFOS_API_PASSWORD: "pw" } });
  await assert.rejects(h.api("--username", "someone", "open-notebook", "n", "subscribe", "--timeout", "0.001"), /timed out/);
  assert.equal(h.stdout(), "");
});

test("a session that opens after --timeout has run out is still closed", async (t) => {
  // The password's argon2id takes far longer than the timeout, so the run is over before it connects.
  const h = harness(t, { env: { CFOS_API_PASSWORD: "pw" } });
  await assert.rejects(h.api("--username", "someone", "set-mood", "calm", "--timeout", "0.001"), /timed out/);
  await eventually(() => h.server.opened === 1 && h.log.disposed.includes("root"), "the late session's disposal");
  assert.deepEqual(callsOf(h.log, "setMood"), []);
});

test("a returned stream goes to --out, or to stdout when it is not a terminal, and nowhere on one", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("public", "download", "7", "--out", "note.txt"), 0);
  assert.equal(readFileSync(join(h.root, "note.txt"), "utf8"), "note 7\nsecond chunk\n");
  assert.equal(await h.api("public", "download", "8"), 0);
  assert.equal(h.stdout(), "note 8\nsecond chunk\n");
  // `public` signs nothing in.
  assert.deepEqual(callsOf(h.log, "authenticate"), []);

  const terminal = harness(t, { tty: true });
  await assert.rejects(terminal.api("public", "download", "7"), /pass --out <file>, or --out -/);
  assert.equal(terminal.server.opened, 0);
});

test("a stream parameter is read from a file or from stdin", async (t) => {
  const h = harness(t, { stdin: "from stdin" });
  writeFileSync(join(h.root, "archive.txt"), "from a file");
  assert.equal(await h.api("import-archive", "archive.txt"), 0);
  assert.equal(await h.api("import-archive", "-"), 0);
  assert.deepEqual(h.json, ["from a file", "from stdin"]);
  await assert.rejects(h.api("import-archive", "missing.txt"), /could not read missing\.txt: ENOENT/);
});

test("`call` invokes a method by name on an untyped capability, arguments as JSON or strings", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("open-notebook", "n", "connect", "call", "echo", "1", '"x"', "plain", '{"a": [1]}'), 0);
  assert.deepEqual(h.json, [[1, "x", "plain", { a: [1] }]]);
  await eventually(() => h.log.disposed.includes("untyped"), "the untyped capability's disposal");

  await assert.rejects(h.api("open-notebook", "n", "connect"), (error: Error) =>
    error instanceof UsageError && /call <method> \[json-args\.\.\.\]/.test(error.message));
  assert.equal(h.server.opened, 1);
});

test("--dry-run prints the chain without connecting, spawning or hashing, and no secret", async (t) => {
  const password = harness(t, { env: { CFOS_API_PASSWORD: "hunter2" } });
  assert.equal(await password.api("--username", "alice", "open-notebook", "n", "subscribe", "--since", "2026-01-01T00:00:00Z", "--dry-run"), 0);
  assert.deepEqual(password.json, [{
    url: "wss://os.example.com/api",
    auth: { mode: "password", username: "alice" },
    on: "FixtureAuthedApi",
    chain: [
      { method: "openNotebook", args: ["n"] },
      { method: "subscribe", args: [{ $callback: "NotesSubscriber" }, "2026-01-01T00:00:00.000Z"] },
    ],
  }]);
  assert.doesNotMatch(JSON.stringify(password.json), /hunter2/);

  const access = harness(t, { env: { CF_ACCESS_TOKEN: "secret.access.token" } });
  assert.equal(await access.api("--dry-run", "import-archive", "missing.txt", "--url", "https://other.example.com"), 0);
  assert.deepEqual(access.json, [{
    url: "wss://other.example.com/api",
    auth: { mode: "access" },
    on: "FixtureAuthedApi",
    chain: [{ method: "importArchive", args: [{ $stream: "missing.txt" }] }],
  }]);
  assert.doesNotMatch(JSON.stringify(access.json), /secret/);

  const publicChain = harness(t, { env: {} });
  assert.equal(await publicChain.api("public", "download", "3", "--dry-run"), 0);
  assert.deepEqual(publicChain.json, [{
    url: "wss://os.example.com/api",
    auth: { mode: "access" },
    on: "FixturePublicApi",
    chain: [{ method: "download", args: [3] }],
  }]);
  for (const h of [password, access, publicChain]) {
    assert.equal(h.server.opened, 0);
    assert.deepEqual(h.spawned, []);
    assert.deepEqual(h.fetched, []);
  }
});

test("a failing call disposes every stub of the chain and the session", async (t) => {
  const h = harness(t);
  await assert.rejects(h.api("get-admin", "set-banner", "hi"), /banner refused: hi/);
  await eventually(() => ["admin", "authed", "root"].every((name) => h.log.disposed.includes(name)), "disposal");
  assert.equal(h.listening(), false);
});

test("a null capability in the chain ends it with null", async (t) => {
  const h = harness(t, { options: { noAdmin: true } });
  assert.equal(await h.api("get-admin", "set-banner", "hi"), 0);
  assert.deepEqual(h.json, [null]);
  assert.deepEqual(callsOf(h.log, "setBanner"), []);
});

test("a handle is disposed at once and prints null", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("open-notebook", "n", "lock"), 0);
  assert.deepEqual(h.json, [null]);
  await eventually(() => h.log.disposed.includes("lock"), "the handle's disposal");
});

test("--timeout fails a call that is not a subscription, and still disposes the session", async (t) => {
  const h = harness(t, { options: { hang: true } });
  await assert.rejects(h.api("set-mood", "calm", "--timeout", "0.05"), /timed out after 0\.05s/);
  assert.deepEqual(callsOf(h.log, "setMood"), [["calm"]]);
  await eventually(() => ["authed", "root"].every((name) => h.log.disposed.includes(name)), "disposal");
});

test("ending on a capability is a usage error that says nothing was sent and how to finish the chain", async (t) => {
  const h = harness(t);
  const incomplete = async (...tokens: string[]) => {
    const error = await h.api(...tokens).then(() => assert.fail("no usage error"), (thrown: unknown) => thrown);
    assert.ok(error instanceof UsageError);
    return error.message;
  };
  assert.equal(await incomplete("open-notebook", "my notes"),
    "open-notebook returns a capability (Notebook), so the chain goes on: nothing was sent. Finish it with one of " +
    "Notebook's commands; `cf-os api open-notebook 'my notes' --help` lists them.");
  // An example only where a command's name promises a read: whoever is told it may run it as it is.
  assert.match(await incomplete("get-admin"), /Finish it with one of FixtureAdmin's commands; /);
  assert.match(await incomplete("open-notebook", "n", "connect"),
    /^connect returns an untyped capability, so the chain goes on: nothing was sent\. Finish it with `call <method> \[json-args\.\.\.\]`/);
  assert.equal(await incomplete(), 'cf-os api names no command, so nothing was sent. Find one with `cf-os api search "<task>"`; ' +
    "`cf-os api --help` lists them.");
  assert.match(await incomplete("public"), /^cf-os api public names no command/);
  assert.equal(h.server.opened, 0);
});

test("search prints the best matches as JSON, whole command lines, and connects to nothing", async (t) => {
  const h = harness(t);
  // Runtime options are taken and ignored, wherever they are.
  assert.equal(await h.api("--url", "https://example.invalid", "search", "subscribe", "to", "a", "notebook", "--dry-run"), 0);
  const matches = h.json[0] as { command: string; summary: string }[];
  assert.deepEqual(matches[0], { command: "cf-os api open-notebook <id> subscribe", summary: "A callback interface." });
  assert.ok(matches.length <= 5);
  assert.equal(await h.api("search", "--help"), 0);
  assert.match(h.stdout(), /^Usage: cf-os api search "<describe the task>"/);
  await assert.rejects(h.api("search"), /search needs a task/);
  await assert.rejects(h.api("search", "x", "--nope"), /Unknown option '--nope'.* Run `cf-os api search --help`\./);
  // `search` is a word only in a command's first place.
  await assert.rejects(h.api("open-notebook", "n", "search"), /Notebook has no command "search"/);
  assert.equal(h.server.opened, 0);
});

test("--help prints the help of the command or capability reached so far, on stdout", async (t) => {
  const h = harness(t);
  assert.equal(await h.api("open-notebook", "--help"), 0);
  assert.match(h.stdout(), /Usage: cf-os api open-notebook <id>/);
  assert.match(h.stdout(), /Returns a capability on Notebook/);
  assert.equal(await h.api("public", "-h"), 0);
  assert.match(h.stdout(), /Commands on FixturePublicApi:/);
  assert.equal(await h.api("open-notebook", "n", "subscribe", "--help"), 0);
  assert.match(h.stdout(), /added\(note\) +A note was added\./);
  assert.equal(h.server.opened, 0);
});

test("a token after a chain-ending result, or an unknown command, is a usage error", async (t) => {
  const h = harness(t);
  await assert.rejects(h.api("set-mood", "calm", "ping"), (error: Error) =>
    error instanceof UsageError && /set-mood returns nothing, which ends the chain/.test(error.message));
  await assert.rejects(h.api("open-notebook", "n", "outline", "lock"), (error: Error) =>
    error instanceof UsageError && /outline returns a value, which ends the chain/.test(error.message));
  await assert.rejects(h.api("open-notebook", "n", "nope"), (error: Error) => error instanceof UsageError &&
    /Notebook has no command "nope"\. Find one with `cf-os api search "<task>"`, or run `cf-os api open-notebook n --help` for Notebook's\./
      .test(error.message));
  await assert.rejects(h.api("open-notebook", "n", "outline", "--limit", "1"), /Unknown option --limit for outline/);
  await assert.rejects(h.api("open-notebook"), /open-notebook needs <id>/);
  assert.equal(h.server.opened, 0);
});
