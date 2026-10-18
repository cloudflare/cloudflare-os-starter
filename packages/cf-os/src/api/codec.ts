// The JSON edge of `cf-os api`: argv tokens into the values a call takes, and the values capnweb
// hands back into JSON on stdout.
//
// capnweb carries `bigint`, `Date`, `Uint8Array`, `Error` and capabilities natively; JSON carries
// none of them. (`Set` and `Map` are revived and encoded as their declared shapes say, though
// capnweb 0.12 serializes neither, and no method of the pinned API takes or returns one.) Results are encoded one way (`bigint` as a decimal string, bytes as
// `{"base64": ...}`, a capability as `{"$capability": true}`), and JSON arguments are revived against
// their declared shape from the table, so a `Date` nested in an object argument arrives as a `Date`.

import { RpcStub } from "capnweb";
import { UsageError } from "../context.ts";
import type { ApiArg, ApiShape } from "./table.ts";

/** Where argument tokens naming a file (`@<path>`) or stdin (`-`) are read. */
export interface ArgSource {
  /** The bytes of `path`, resolved against where the command was run. */
  readFile(path: string): Promise<Uint8Array>;
  /** All of stdin. */
  readStdin(): Promise<Uint8Array>;
}

/**
 * A `stream` argument: the file (or `-`, stdin) to send. Opened only when the call is made, so a dry
 * run names it without reading it.
 */
export class StreamArg {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
}

/**
 * `value` as JSON-safe data. Every capability found inside it (a stub, or a function, which capnweb
 * passes by reference) is replaced by `{"$capability": true}` and pushed onto `found`, for the
 * caller to dispose once it has printed the result.
 */
export function encodeValue(value: unknown, found: Disposable[] = []): unknown {
  return encode(value, found) ?? null;
}

function encode(value: unknown, found: Disposable[]): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  // A stub is a Proxy over a function, so it is told apart before functions are.
  if (value instanceof RpcStub) {
    found.push(value as unknown as Disposable);
    return { $capability: true };
  }
  if (typeof value === "function") {
    if (Symbol.dispose in value) found.push(value as unknown as Disposable);
    return { $capability: true };
  }
  if (typeof value !== "object") return String(value);
  if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString("base64") };
  if (ArrayBuffer.isView(value)) {
    return { base64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  }
  if (value instanceof ArrayBuffer) return { base64: Buffer.from(value).toString("base64") };
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value instanceof URL) return value.href;
  if (value instanceof ReadableStream || value instanceof WritableStream) return { $stream: true };
  if (value instanceof Set) return [...value].map((item) => encode(item, found) ?? null);
  if (value instanceof Map) {
    return [...value].map(([key, item]) => [encode(key, found) ?? null, encode(item, found) ?? null]);
  }
  if (Array.isArray(value)) return value.map((item) => encode(item, found) ?? null);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const encoded = encode(item, found);
    if (encoded !== undefined) result[key] = encoded;
  }
  return result;
}

/**
 * The argument `token` stands for, decoded by `arg`'s encoding. `shapes` resolves the named shapes a
 * `json` argument's shape refers to. Not for `callback` and `function` arguments, which take no
 * token.
 */
export async function decodeArg(
  arg: ApiArg,
  token: string | boolean,
  shapes: Record<string, ApiShape>,
  source: ArgSource,
): Promise<unknown> {
  const label = arg.flag ? `--${arg.flag}` : `<${arg.name}>`;
  if (typeof token === "boolean") {
    if (arg.encoding !== "boolean") throw new UsageError(`${label} needs a value.`);
    return token;
  }
  if (arg.nullable && token === "null" && arg.encoding !== "json") return null;
  switch (arg.encoding) {
    case "string":
      if (arg.choices && !arg.choices.includes(token)) {
        throw new UsageError(`${label} must be one of ${arg.choices.join(", ")}; got "${token}".`);
      }
      return token;
    case "number": {
      const value = token.trim() === "" ? Number.NaN : Number(token);
      if (Number.isNaN(value)) throw new UsageError(`${label} must be a number; got "${token}".`);
      return value;
    }
    case "boolean":
      if (token === "true") return true;
      if (token === "false") return false;
      throw new UsageError(`${label} must be true or false; got "${token}".`);
    case "bigint":
      if (!/^-?\d+$/.test(token)) throw new UsageError(`${label} must be a decimal integer; got "${token}".`);
      return BigInt(token);
    case "date":
      return parseDate(token, label);
    case "bytes":
      if (token === "-") return source.readStdin();
      if (token.startsWith("@")) return source.readFile(token.slice(1));
      return parseBase64(parseJson(token, label), label);
    case "json": {
      const shape = arg.shape ?? { kind: "any" };
      const inline = token !== "-" && !token.startsWith("@");
      // `new-chat hello`: where a string is one of the shapes, a bare word that is not JSON is it.
      if (inline && admitsString(shape, shapes) && !isJson(token)) return token;
      const text = !inline
        ? Buffer.from(token === "-" ? await source.readStdin() : await source.readFile(token.slice(1))).toString("utf8")
        : token;
      return revive(parseJson(text, label), shape, shapes, label);
    }
    case "stream":
      return new StreamArg(token);
    case "callback":
    case "function":
      throw new UsageError(`${label} is implemented by cf-os api and takes no value.`);
  }
}

/**
 * An argument of a `call` on an untyped capability: the token as JSON, or the token itself when it
 * is not JSON. Unchecked: nothing says what the method takes.
 */
export function decodeUntyped(token: string): unknown {
  try {
    return JSON.parse(token);
  } catch {
    return token;
  }
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `shape` is `string`, or a union with a `string` branch: a JSON argument of that shape
 * takes a bare word that is not JSON as the string itself.
 */
export function admitsString(shape: ApiShape, shapes: Record<string, ApiShape>): boolean {
  const resolved = resolve(shape, shapes);
  return resolved.kind === "string" || (resolved.kind === "union" && resolved.branches.some((branch) => admitsString(branch, shapes)));
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}

function parseDate(value: unknown, label: string): Date {
  const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new UsageError(`${label} must be an ISO 8601 date, such as 2026-01-31T12:00:00Z; got ${JSON.stringify(value)}.`);
  }
  return date;
}

function parseBase64(value: unknown, label: string): Uint8Array {
  const base64 = isPlainObject(value) ? value.base64 : undefined;
  if (typeof base64 !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(base64)) {
    throw new UsageError(`${label} must be @<file>, - for stdin, or {"base64": "..."}.`);
  }
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parsed JSON with every place `shape` declares a `Date`, bytes, `bigint`, `Set` or `Map` turned into
 * one. Values whose JSON does not fit their shape are left as they are, for the server to judge.
 */
export function revive(value: unknown, shape: ApiShape, shapes: Record<string, ApiShape>, label = "value"): unknown {
  const resolved = resolve(shape, shapes);
  switch (resolved.kind) {
    case "date":
      return typeof value === "string" ? parseDate(value, label) : value;
    case "bytes":
      return isPlainObject(value) && "base64" in value ? parseBase64(value, label) : value;
    case "bigint":
      return (typeof value === "string" && /^-?\d+$/.test(value)) || Number.isInteger(value)
        ? BigInt(value as string | number)
        : value;
    case "array":
      return Array.isArray(value) ? value.map((item) => revive(item, resolved.element, shapes, label)) : value;
    case "set":
      return Array.isArray(value) ? new Set(value.map((item) => revive(item, resolved.element, shapes, label))) : value;
    case "map": {
      const entries = Array.isArray(value) ? value : isPlainObject(value) ? Object.entries(value) : null;
      if (!entries || !entries.every((entry) => Array.isArray(entry) && entry.length === 2)) return value;
      return new Map(entries.map(([key, item]: [unknown, unknown]) =>
        [revive(key, resolved.key, shapes, label), revive(item, resolved.value, shapes, label)]));
    }
    case "tuple":
      if (!Array.isArray(value)) return value;
      return value.map((item, index) => {
        const element = resolved.elements[index] ?? resolved.rest;
        return element ? revive(item, element, shapes, label) : item;
      });
    case "object": {
      if (!isPlainObject(value)) return value;
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const property = Object.hasOwn(resolved.properties, key) ? resolved.properties[key] : resolved.index;
        result[key] = property ? revive(item, property, shapes, `${label}.${key}`) : item;
      }
      return result;
    }
    case "union": {
      if (value === null || value === undefined) return value;
      const branch = resolved.branches.find((candidate) => fits(value, candidate, shapes));
      return branch ? revive(value, branch, shapes, label) : value;
    }
    default:
      return value;
  }
}

function resolve(shape: ApiShape, shapes: Record<string, ApiShape>): ApiShape {
  let current = shape;
  for (let depth = 0; current.kind === "ref" && depth < 32; depth++) {
    current = shapes[current.name] ?? { kind: "any" };
  }
  return current;
}

/** Whether JSON `value` could be `shape`: the union branch to revive it against. */
function fits(value: unknown, shape: ApiShape, shapes: Record<string, ApiShape>): boolean {
  const resolved = resolve(shape, shapes);
  switch (resolved.kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "undefined":
    case "void":
      return value === undefined;
    case "any":
      return true;
    case "literal":
      return value === resolved.value;
    case "bigint":
      return (typeof value === "string" && /^-?\d+$/.test(value)) || Number.isInteger(value);
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
    case "bytes":
      return isPlainObject(value) && typeof value.base64 === "string";
    case "array":
    case "set":
    case "tuple":
      return Array.isArray(value);
    case "map":
      return Array.isArray(value) || isPlainObject(value);
    case "object":
      // Discriminated by its literal-typed properties: `{ kind: "folder" }` fits only that branch.
      return isPlainObject(value) && Object.entries(resolved.properties).every(([key, property]) => {
        const declared = resolve(property, shapes);
        return declared.kind !== "literal" || value[key] === declared.value;
      });
    case "union":
      return resolved.branches.some((branch) => fits(value, branch, shapes));
    default:
      return false;
  }
}
