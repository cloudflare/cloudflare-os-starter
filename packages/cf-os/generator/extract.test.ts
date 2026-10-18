// The extractor, against the miniature API in `__fixtures__/api.ts` (whose schema is committed as
// `__fixtures__/generated/schema.json`) and against the pinned upstream api.ts itself.
//
// After changing the fixture or the extractor on purpose, rewrite the expected schema with
// `CF_OS_UPDATE_FIXTURES=1 node --test packages/cf-os/generator/extract.test.ts`, then the expected
// commands with the same for `emit.test.ts`, and read the diff.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript6";
import type { ApiShape } from "../src/api/table.ts";
import { buildTable, type SchemaService } from "./emit.ts";
import { type ExtractOptions, extractSchema, normalizeDoc } from "./extract.ts";
import { API_SOURCE } from "./generate.ts";

const FIXTURES = join(import.meta.dirname, "__fixtures__");
const FIXTURE: ExtractOptions = {
  entry: join(FIXTURES, "api.ts"),
  tsconfig: join(import.meta.dirname, "..", "tsconfig.json"),
  entryName: "FixturePublicApi",
  constants: ["SERVICE_SALT"],
};
const EXPECTED_SCHEMA = join(FIXTURES, "generated", "schema.json");

test("extracts the fixture's schema as committed", () => {
  const actual = `${JSON.stringify(extractSchema(FIXTURE), null, 2)}\n`;
  if (process.env.CF_OS_UPDATE_FIXTURES) writeFileSync(EXPECTED_SCHEMA, actual);
  assert.equal(actual, readFileSync(EXPECTED_SCHEMA, "utf8"));
});

test("tells capabilities, callbacks, streams, handles and any tails apart", () => {
  const schema = extractSchema(FIXTURE);
  const method = (service: string, name: string) => {
    const found = schema.services[service]!.methods.find((m) => m.name === name);
    assert.ok(found, `${service}.${name}`);
    return found;
  };
  // A Promise<Interface extending RpcTarget> and an RpcStub<Interface> are both capabilities.
  assert.deepEqual(method("FixturePublicApi", "authenticate").returns, { kind: "stub", service: "FixtureAuthedApi" });
  assert.deepEqual(method("FixtureAuthedApi", "openNotebook").returns, { kind: "stub", service: "Notebook" });
  // A method-only interface behind a nullable stub.
  assert.deepEqual(method("FixtureAuthedApi", "getAdmin").returns,
    { kind: "union", branches: [{ kind: "null" }, { kind: "stub", service: "FixtureAdmin" }] });
  assert.deepEqual(schema.services.FixtureAdmin!.methods.map((m) => m.name), ["setBanner"]);
  // RpcStub<{}> is a capability with no methods; RpcStub<any> one with no service.
  assert.deepEqual(method("Notebook", "lock").returns, { kind: "stub", service: "{}" });
  assert.deepEqual(schema.services["{}"]!.methods, []);
  assert.deepEqual(method("Notebook", "connect").returns, { kind: "stub" });
  assert.deepEqual(method("FixturePublicApi", "download").returns, { kind: "readableStream" });
  assert.deepEqual(method("FixtureAuthedApi", "importArchive").params[0]!.type, { kind: "readableStream" });
  // The client-implemented interface is recorded with every method, and the bare function with its
  // signature.
  assert.deepEqual(method("Notebook", "subscribe").params[0]!.type, { kind: "stub", service: "NotesSubscriber" });
  assert.deepEqual(schema.services.NotesSubscriber!.methods.map((m) => [m.name, m.params.map((p) => p.name)]),
    [["added", ["note"]], ["ready", []], ["removed", ["id"]]]);
  assert.deepEqual(method("Notebook", "watchTitle").params[0]!.type, {
    kind: "function",
    params: [{ name: "title", type: { kind: "string" }, optional: false }],
    returns: { kind: "void" },
  });
});

test("keeps optional parameters' types without the undefined they imply", () => {
  const search = extractSchema(FIXTURE).services.FixtureAuthedApi!.methods.find((m) => m.name === "search")!;
  assert.deepEqual(search.params.map(({ name, type, optional }) => ({ name, type, optional })), [
    { name: "query", type: { kind: "string" }, optional: false },
    { name: "limit", type: { kind: "number" }, optional: true },
    { name: "url", type: { kind: "string" }, optional: true },
  ]);
  const upload = extractSchema(FIXTURE).services.Notebook!.methods.find((m) => m.name === "upload")!;
  assert.deepEqual(upload.params[1]!.type, { kind: "boolean" });
});

test("hoists named types once, references them by name, and survives recursion", () => {
  const schema = extractSchema(FIXTURE);
  assert.deepEqual(Object.keys(schema.shapes), ["Destination", "Mood", "Note", "Outline"]);
  assert.deepEqual(schema.shapes.Outline, {
    kind: "object",
    properties: { children: { kind: "array", element: { kind: "ref", name: "Outline" } }, title: { kind: "string" } },
  });
  const { properties } = schema.shapes.Note as { properties: Record<string, ApiShape> };
  assert.deepEqual([properties.created, properties.size, properties.body],
    [{ kind: "date" }, { kind: "bigint" }, { kind: "bytes" }]);
  assert.deepEqual(properties.tags, { kind: "union", branches: [{ kind: "array", element: { kind: "string" } },
    { kind: "undefined" }] });
});

test("records the constants and the docs, @param text on the parameter", () => {
  const schema = extractSchema(FIXTURE);
  assert.deepEqual(schema.constants, { SERVICE_SALT: [1, 2, 254, 255] });
  const open = schema.services.FixtureAuthedApi!.methods.find((m) => m.name === "openNotebook")!;
  assert.equal(open.doc, "A capability hop, with an optional callback that is never passed.\n@param id The notebook's ID.");
  assert.equal(open.params[0]!.doc, "The notebook's ID.");
  assert.equal(schema.services.FixtureAuthedApi!.doc, "The authenticated API, as upstream's AuthenticatedApi.");
});

test("normalizes doc text", () => {
  assert.equal(normalizeDoc("  first  \r\nsecond\t\r\n\r\n\r\n\n third\n"), "first\nsecond\n\n third");
  assert.equal(normalizeDoc(""), "");
});

test("is deterministic across separate programs", () => {
  assert.equal(JSON.stringify(extractSchema(FIXTURE)), JSON.stringify(extractSchema(FIXTURE)));
});

test("refuses what the CLI cannot call, naming it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cf-os-extract-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let files = 0;
  const extract = (source: string, entryName = "Api") => {
    const entry = join(dir, `api-${files++}.ts`);
    writeFileSync(entry, source);
    return () => extractSchema({ entry, compilerOptions: { strict: true }, entryName, constants: [] });
  };
  assert.throws(extract("export interface Api { a(x: string): void; a(x: number): void; }"),
    /Api\.a: overloaded/);
  assert.throws(extract("export interface Api { a(...xs: string[]): void; }"), /Api\.a: rest parameter xs/);
  assert.throws(extract("export interface Api { a(): void; b: string; }"), /Api\.b: a property/);
  assert.throws(extract("export interface Other { a(): void; }"), /no exported Api/);
  assert.throws(() => extractSchema({ ...FIXTURE, constants: ["Mood"] }), /Mood is not an exported `new Uint8Array/);
  // An unresolved type would read as `any`: a capability quietly turned into an untyped value.
  assert.throws(extract('import type { Missing } from "./nowhere.ts";\nexport interface Api { a(): Promise<Missing>; }'),
    /does not type-check[\s\S]*nowhere/);
});

/** The method names an interface declares in `file`, read from the syntax alone. */
function declaredMethods(file: string, name: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false);
  const declaration = source.statements.find((s): s is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(s) && s.name.text === name);
  assert.ok(declaration, `${name} in ${file}`);
  return declaration.members.filter(ts.isMethodSignature).map((member) => member.name.getText(source)).toSorted();
}

test("the pinned upstream API: the whole graph, and every subscriber's full method list", () => {
  const schema = extractSchema(API_SOURCE);
  const method = (service: string, name: string) => schema.services[service]?.methods.find((m) => m.name === name);
  assert.deepEqual(method("PublicApi", "authenticate")?.returns, { kind: "stub", service: "AuthenticatedApi" });
  assert.deepEqual(method("AuthenticatedApi", "openGadget")?.returns, { kind: "stub", service: "Overseer" });
  assert.deepEqual(method("Overseer", "getGadget")?.returns, { kind: "stub", service: "GadgetClient" });
  assert.deepEqual(method("GadgetClient", "connectToGadget")?.returns, { kind: "stub" });
  assert.equal(schema.constants.SERVICE_SALT?.length, 16);

  const methods = Object.values(schema.services).reduce((n, service: SchemaService) => n + service.methods.length, 0);
  assert.ok(methods > 150, `${methods} methods`);

  const subscribers = new Map<string, string>();
  let functions = 0;
  for (const [service, { methods: list }] of Object.entries(schema.services)) {
    for (const m of list.filter((x) => x.name.startsWith("subscribe"))) {
      const callback = m.params[0]!.type;
      if (callback.kind === "function") {
        functions++;
        assert.deepEqual(callback.params.map((p) => p.name), ["metadata"], `${service}.${m.name}`);
      } else {
        assert.equal(callback.kind, "stub", `${service}.${m.name}`);
        subscribers.set(`${service}.${m.name}`, (callback as { service: string }).service);
      }
    }
  }
  assert.equal(functions, 1);
  assert.deepEqual([...new Set(subscribers.values())].toSorted(), [
    "ActionsSubscriber", "AiChatSubscriber", "ConnectedAccountsSubscriber", "ConsoleLogSubscriber",
    "NotificationSubscriber", "PresenceSubscriber", "WorkpiecesSubscriber",
  ]);
  const table = buildTable(schema);
  for (const name of subscribers.values()) {
    const expected = declaredMethods(API_SOURCE.entry, name);
    assert.deepEqual(schema.services[name]!.methods.map((m) => m.name), expected, name);
    assert.deepEqual(table.callbacks[name]!.methods.map((m) => m.name), expected, name);
  }
  assert.ok(table.callbacks.AiChatSubscriber!.methods.some((m) => m.name === "changeApplied"));
});
