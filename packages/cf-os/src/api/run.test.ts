import assert from "node:assert/strict";
import test from "node:test";
import { table } from "../../generator/__fixtures__/generated/commands.ts";
import { UsageError } from "../context.ts";
import { table as realTable } from "./generated/commands.ts";
import { commandHelp, decodeCalls, dryRunChain, nodeHelp, parseInvocation, type Hop } from "./run.ts";

const noFiles = {
  readFile: async () => assert.fail("read a file"),
  readStdin: async () => assert.fail("read stdin"),
};

function names(hops: Hop[]): string[] {
  return hops.map((hop) => hop.kind === "command" ? hop.name : `call ${hop.method}`);
}

test("segments take their command's positionals; flags may sit anywhere before the next segment", () => {
  const invocation = parseInvocation(table, ["--dry-run", "open-notebook", "--timeout", "5", "n1", "subscribe", "--since", "2026-01-01", "--url=http://localhost:8787"]);
  assert.deepEqual(names(invocation.hops), ["open-notebook", "subscribe"]);
  const [open, subscribe] = invocation.hops as Extract<Hop, { kind: "command" }>[];
  assert.deepEqual(open.positionals, ["n1"]);
  assert.deepEqual(subscribe.flags, { since: "2026-01-01" });
  assert.deepEqual(invocation.flags, { url: "http://localhost:8787", auth: undefined, username: undefined, dryRun: true, timeout: 5, out: undefined });
  assert.deepEqual(invocation.end, { kind: "result", returns: { kind: "subscription" } });
  assert.deepEqual(invocation.path, ["open-notebook", "n1", "subscribe"]);
  assert.equal(invocation.public, false);
});

test("a leading `public` starts on PublicApi; a capability or untyped result left open ends the walk there", () => {
  const publicChain = parseInvocation(table, ["public", "download", "3"]);
  assert.equal(publicChain.public, true);
  assert.deepEqual(names(publicChain.hops), ["download"]);
  assert.deepEqual(parseInvocation(table, []).end, { kind: "node", node: "FixtureAuthedApi" });
  assert.deepEqual(parseInvocation(table, ["public"]).end, { kind: "node", node: "FixturePublicApi" });
  assert.deepEqual(parseInvocation(table, ["open-notebook", "n"]).end, { kind: "node", node: "Notebook" });
  assert.deepEqual(parseInvocation(table, ["get-admin"]).end, { kind: "node", node: "FixtureAdmin" });
  assert.deepEqual(parseInvocation(table, ["open-notebook", "n", "connect"]).end, { kind: "untyped" });
  // `public` is only a segment in first place: elsewhere it is a positional like any other.
  assert.deepEqual((parseInvocation(table, ["open-notebook", "public"]).hops[0] as Extract<Hop, { kind: "command" }>).positionals, ["public"]);
});

test("`call` segments continue an untyped capability, taking every token up to the next `call`", () => {
  const invocation = parseInvocation(table, ["open-notebook", "n", "connect", "call", "a", "1", "x", "call", "b"]);
  assert.deepEqual(invocation.hops.slice(2), [{ kind: "call", method: "a", args: ["1", "x"] }, { kind: "call", method: "b", args: [] }]);
  assert.deepEqual(invocation.end, { kind: "result", returns: { kind: "call" } });
  assert.throws(() => parseInvocation(table, ["open-notebook", "n", "connect", "outline"]), /continue with `call <method>/);
  assert.throws(() => parseInvocation(table, ["open-notebook", "n", "connect", "call"]), /call needs a method name/);
});

test("`--` makes the rest positionals, so values that look like flags pass through", () => {
  const invocation = parseInvocation(table, ["search", "--", "--limit"]);
  assert.deepEqual((invocation.hops[0] as Extract<Hop, { kind: "command" }>).positionals, ["--limit"]);
});

function usage(tokens: string[], message: RegExp): void {
  assert.throws(() => parseInvocation(table, tokens), (error: Error) => error instanceof UsageError && message.test(error.message));
}

test("what the table does not allow is a usage error that says what to run", () => {
  usage(["nope"], /FixtureAuthedApi has no command "nope"\. Run `cf-os api --help`/);
  usage(["public", "nope"], /FixturePublicApi has no command "nope"\. Run `cf-os api public --help`/);
  usage(["search"], /search needs <query>/);
  usage(["search", "q", "--bogus"], /Unknown option --bogus for search/);
  usage(["--bogus"], /Unknown option --bogus\./);
  usage(["search", "q", "--limit"], /--limit needs a value/);
  usage(["set-mood", "calm", "lock"], /set-mood returns a value, which ends the chain/);
  usage(["search", "q", "--timeout", "0"], /--timeout must be a positive number/);
  usage(["search", "q", "--dry-run=yes"], /--dry-run/);
});

test("--help stops the walk at the segment it is in", () => {
  assert.deepEqual(parseInvocation(table, ["--help", "nope"]).help, { kind: "node", node: "FixtureAuthedApi" });
  assert.deepEqual(parseInvocation(table, ["public", "-h"]).help, { kind: "node", node: "FixturePublicApi" });
  assert.deepEqual(parseInvocation(table, ["open-notebook", "--help"]).help, { kind: "command", node: "FixtureAuthedApi", name: "open-notebook" });
  assert.deepEqual(parseInvocation(table, ["open-notebook", "n", "file", "-h"]).help, { kind: "command", node: "Notebook", name: "file" });
  assert.deepEqual(parseInvocation(table, ["open-notebook", "n", "connect", "call", "x", "--help"]).help, { kind: "untyped" });
});

test("calls are decoded with unset optionals undefined, trailing ones trimmed, callbacks and streams as placeholders", async () => {
  const decode = async (tokens: string[]) => decodeCalls(table, parseInvocation(table, tokens), noFiles);
  assert.deepEqual((await decode(["search", "q", "--arg-url", "u"]))[0].args, ["q", undefined, "u"]);
  assert.deepEqual((await decode(["search", "q"]))[0].args, ["q"]);
  assert.deepEqual(dryRunChain(await decode(["open-notebook", "n", "subscribe", "--since", "2026-01-01"])), [
    { method: "openNotebook", args: ["n"] },
    { method: "subscribe", args: [{ $callback: "NotesSubscriber" }, "2026-01-01T00:00:00.000Z"] },
  ]);
  assert.deepEqual(dryRunChain(await decode(["open-notebook", "n", "watch-title"])).at(-1), { method: "watchTitle", args: [{ $function: "callback" }] });
  assert.deepEqual(dryRunChain(await decode(["import-archive", "a.zip"])), [{ method: "importArchive", args: [{ $stream: "a.zip" }] }]);
  await assert.rejects(decodeCalls(table, parseInvocation(table, ["open-notebook", "n", "file", "-", "-"]), {
    readFile: noFiles.readFile,
    readStdin: async () => new TextEncoder().encode("{}"),
  }), /Only one argument can read stdin/);
});

test("help lists a capability's commands and a command's arguments, events and result", () => {
  const root = nodeHelp(realTable, realTable.root, []);
  assert.match(root, /^Usage: cf-os api <command>/);
  assert.match(root, new RegExp(`Commands on ${realTable.root}, after signing in:`));
  assert.match(root, /\n {2}open-gadget <id> → Overseer /);
  assert.match(root, /A command marked `→ X` returns capability X: follow it on the same line/);
  assert.doesNotMatch(nodeHelp(table, "FixtureAdmin", ["get-admin"]), /marked `→ X`/);
  assert.match(root, /`cf-os api public <command>` calls PublicApi without signing in/);
  assert.match(root, /--auth <mode> {8}access \(default for https:\/\/\)/);

  const file = commandHelp(table, "Notebook", "file", ["open-notebook", "n", "file"]);
  assert.match(file, /^Usage: cf-os api open-notebook n file <note> <destination>\n/);
  assert.match(file, /<note> +<json\|@file\|->: Note/);
  assert.match(file, /Returns nothing \(prints null\)\./);
  const search = commandHelp(table, "FixtureAuthedApi", "search", ["search"]);
  assert.match(search, /\[--limit <number>\] \[--arg-url <string>\]/);
  const subscribe = commandHelp(table, "Notebook", "subscribe", ["open-notebook", "n", "subscribe"]);
  assert.match(subscribe, /Events \(one JSON line each/);
  assert.match(subscribe, /removed\(id\)/);
  assert.match(subscribe, /Returns events, one JSON line each on stdout, until --timeout or Ctrl-C\./);
  const upload = commandHelp(table, "Notebook", "upload", ["upload"]);
  assert.match(upload, /--pinned, --no-pinned/);
});
