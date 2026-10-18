// The contract between the API generator (`packages/cf-os/generator`) and the `cf-os api` runtime
// beside this file. The generator turns upstream's `workshop-shared/src/api.ts` into one
// `ApiTable` (`generated/commands.ts`); the runtime walks argv against it. The table holds the
// CLI's decisions only -- names, argument encodings, what each return does to the chain -- and no
// logic, so a change in upstream's API is a regenerated table, never a hand edit.
//
// Shapes mirror capnweb-validate's `TypeShape` (its `transform/type-introspector.ts`), with named
// object and union types hoisted into `ApiTable.shapes` and referenced by name.

/**
 * A value's type, as the extractor resolved it. Named object and union types appear as `ref`s into
 * {@link ApiTable.shapes} (or the schema's `shapes`), so a recursive type stays finite.
 */
export type ApiShape =
  | { kind: "string" | "number" | "boolean" | "bigint" | "null" | "undefined" | "void" | "any" }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "array"; element: ApiShape }
  | { kind: "set"; element: ApiShape }
  | { kind: "map"; key: ApiShape; value: ApiShape }
  | {
    kind: "tuple";
    elements: ApiShape[];
    /** Required leading elements, when fewer than `elements` (`[a, b?]` is 1). */
    minLength?: number;
    /** The element type of a variadic tail (`[a, ...b[]]`). */
    rest?: ApiShape;
  }
  | {
    kind: "object";
    /** Every property, by name. An optional property's shape is a union with `undefined`. */
    properties: Record<string, ApiShape>;
    /** The value type of a string or number index signature (a `Record`). */
    index?: ApiShape;
  }
  | { kind: "union"; branches: ApiShape[] }
  | { kind: "ref"; name: string }
  | {
    kind:
      | "date" | "bytes" | "error" | "readableStream" | "writableStream" | "arrayBuffer" | "dataView"
      | "regexp" | "blob" | "url" | "headers" | "request" | "response";
  }
  | { kind: "typedArray"; name: string }
  /**
   * A capability passed by reference: an `RpcStub<X>`/`RpcPromise<X>`, an interface extending
   * `RpcTarget`, or a method-only interface. `service` names it in the schema's `services`; absent
   * when it is untyped (`RpcStub<any>`).
   */
  | { kind: "stub"; service?: string }
  /** A function passed by reference, with its signature. */
  | { kind: "function"; params: ApiShapeParam[]; returns: ApiShape }
  /** A type the extractor cannot represent, with why. */
  | { kind: "unsupported"; reason: string };

/** One parameter of a {@link ApiShape} function. */
export interface ApiShapeParam {
  name: string;
  type: ApiShape;
  optional: boolean;
}

/**
 * How the runtime turns argv tokens into one parameter's value.
 *
 * - `string`, `number`, `boolean` (`true`/`false`), `bigint` (decimal), `date` (ISO 8601): the
 *   token, converted.
 * - `bytes`: `@<file>`, `-` for stdin, or JSON `{"base64": "..."}`.
 * - `json`: inline JSON, `@<file>` or `-`, revived against {@link ApiArg.shape} so the `Date`s,
 *   `Uint8Array`s and `bigint`s nested inside it arrive as such.
 * - `stream`: a file path, or `-` for stdin, sent as a `ReadableStream<Uint8Array>`.
 * - `callback`: consumes no token. A client-implemented interface ({@link ApiArg.callback}) the
 *   runtime builds as an `RpcTarget` printing each call as an NDJSON event.
 * - `function`: consumes no token. A bare function printing each call as an NDJSON event named
 *   after the parameter.
 */
export type ApiEncoding =
  | "string" | "number" | "boolean" | "bigint" | "date" | "bytes" | "json" | "stream" | "callback"
  | "function";

/** One exposed parameter of a command. */
export interface ApiArg {
  /** The parameter's name in api.ts. Also the event name of a `function` argument. */
  name: string;
  /**
   * Where the decoded value goes in the call's argument list. Parameters the table does not list
   * (optional callbacks) and optional ones not given are passed as `undefined`; the runtime trims
   * trailing `undefined`s.
   */
  index: number;
  /**
   * The flag an optional parameter is given by, without the leading `--`: the kebab-case of its
   * name, or `arg-<name>` when that would collide with a runtime flag. Absent for a required
   * parameter, which is positional, taking the next token in parameter order (`callback` and
   * `function` arguments take none).
   */
  flag?: string;
  encoding: ApiEncoding;
  /** The declared type is `T | null`: the bare token `null` passes `null`. */
  nullable?: true;
  /** For a string-literal union, the values it accepts, sorted. */
  choices?: string[];
  /** For `json`, the declared type, to revive against. */
  shape?: ApiShape;
  /** For `callback`, the interface to implement: a key of {@link ApiTable.callbacks}. */
  callback?: string;
  /** For `function`, the function's parameter names, for help. */
  params?: string[];
  /**
   * The declared type, rendered TypeScript-like, for help. For `json`, each named object or union it
   * is made of is spelled out after it, unless that would run long: `Name = {...}`, or
   * `X[], where X = {...}`.
   */
  type: string;
  /** The parameter's JSDoc (`@param`), normalized; empty when it has none. */
  doc: string;
}

/**
 * What a command's result does.
 *
 * - `value`: print it as JSON (`type` is the declared type for help, its named types spelled out as
 *   {@link ApiArg.type}'s are).
 * - `stub`: a capability on `node`, where the chain continues with the next segment. `nullable`
 *   when the declared type is `X | null`: a null result ends the chain and prints `null`.
 * - `handle`: an empty capability (`RpcStub<{}>`): dispose it and print `null`.
 * - `stream`: a `ReadableStream<Uint8Array>`, written to `--out` (or stdout when it is not a
 *   terminal).
 * - `subscription`: the command takes a `callback` or `function` argument. The runtime prints its
 *   events as NDJSON until `--timeout` or SIGINT, then disposes the result (the subscription's
 *   handle).
 * - `untyped`: a capability over `any` (`RpcStub<any>`). Only a `call <method> [json-args...]`
 *   segment continues it, unchecked.
 */
export type ApiReturn =
  | { kind: "value"; type: string }
  | { kind: "stub"; node: string; nullable: boolean }
  | { kind: "handle" }
  | { kind: "stream" }
  | { kind: "subscription" }
  | { kind: "untyped" };

/** One method of a capability, as a CLI command. */
export interface ApiCommand {
  /** The method the runtime calls. */
  method: string;
  /** The method's JSDoc, normalized; empty when it has none. */
  doc: string;
  /** The exposed parameters, in parameter order. */
  args: ApiArg[];
  returns: ApiReturn;
}

/** One capability interface the chain can reach. */
export interface ApiNode {
  /** The interface's JSDoc, normalized; empty when it has none. */
  doc: string;
  /** Its methods, by command name (the method name in kebab-case), sorted. */
  commands: Record<string, ApiCommand>;
}

/** One method of a client-implemented callback interface. */
export interface ApiCallbackMethod {
  name: string;
  /** Its parameter names, in order: the positions of an event's `args`. */
  params: string[];
  doc: string;
}

/**
 * A client-implemented callback interface. The runtime's `RpcTarget` needs a prototype method for
 * every entry of `methods`: a call the server makes to a missing one throws, ending the
 * subscription.
 */
export interface ApiCallback {
  doc: string;
  /** Every method the server may call, sorted by name. */
  methods: ApiCallbackMethod[];
}

/** Constants upstream's api.ts exports that the session needs. */
export interface ApiConstants {
  /** The password-hash salt prefix (`SERVICE_SALT`): argon2id's salt is these bytes ++ utf8(username). */
  SERVICE_SALT: number[];
}

/** The whole `cf-os api` command table. */
export interface ApiTable {
  /** The node bare `cf-os api <command>` starts on: what `PublicApi.authenticate()` returns. */
  root: string;
  /**
   * The node a leading `public` segment selects, without authenticating: `PublicApi`, less the
   * credential methods the session performs itself.
   */
  public: string;
  nodes: Record<string, ApiNode>;
  /** The callback interfaces `callback` arguments name. */
  callbacks: Record<string, ApiCallback>;
  /** The named shapes `json` arguments' shapes refer to, by name. */
  shapes: Record<string, ApiShape>;
  constants: ApiConstants;
}
