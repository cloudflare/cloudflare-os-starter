// The client side of a subscription: the callback a `subscribe*` method takes, built from the table
// so that it answers every call the server may make.
//
// capnweb only exposes an `RpcTarget`'s prototype methods to the peer. An instance property is
// refused ("an instance property of the RpcTarget"), and a method that is missing altogether makes
// the server's call throw, which ends the subscription on its side. So the target is a class minted
// per callback interface with a real prototype method for every method the table lists. Each call
// becomes one NDJSON line, `{"event": <method>, "args": {<parameter>: <value>, ...}}`, and returns
// nothing, or, while stdout is full, a promise that settles once it drains: a server that awaits its
// calls then delivers no faster than the reader takes them, rather than Node buffering every event.

import { once } from "node:events";
import { RpcStub, RpcTarget } from "capnweb";
import { encodeValue } from "./codec.ts";
import type { ApiCallback } from "./table.ts";

/**
 * Where events go: one call, one event, its arguments keyed by parameter name. A promise means the
 * event is still waiting to be written out, and the call should not return before it settles.
 */
export type EmitEvent = (event: string, args: Record<string, unknown>) => Promise<void> | undefined;

/** Writes to `stream`, returning a promise for its draining when the write leaves it full. */
export function drainingWriter(stream: NodeJS.WritableStream): (line: string) => Promise<void> | undefined {
  return (line) => stream.write(line) ? undefined : once(stream, "drain").then(() => undefined);
}

/**
 * A call's arguments keyed by the parameter names the table gives, in order. One past the names
 * (which the table's signature does not promise) is keyed by its position.
 */
function named(params: string[], args: unknown[]): Record<string, unknown> {
  return Object.fromEntries(args.map((arg, index) => [params[index] ?? String(index), arg]));
}

/** An {@link EmitEvent} writing NDJSON lines through `write`, arguments encoded as results are. */
export function ndjsonEvents(write: (line: string) => Promise<void> | undefined): EmitEvent {
  return (event, args) => {
    // Capabilities passed into a callback are the callee's to forget: capnweb disposes them when
    // the call returns.
    const encoded = Object.fromEntries(Object.entries(args).map(([name, arg]) => [name, encodeValue(arg)]));
    return write(`${JSON.stringify({ event, args: encoded })}\n`);
  };
}

/**
 * An `RpcTarget` implementing `callback`: every method in its table entry is a prototype method that
 * emits an event named after the method and returns what emitting it did.
 */
export function callbackTarget(name: string, callback: ApiCallback, emit: EmitEvent): RpcTarget {
  const Target = class extends RpcTarget {};
  Object.defineProperty(Target, "name", { value: name });
  for (const method of callback.methods) {
    Object.defineProperty(Target.prototype, method.name, {
      value: function (...args: unknown[]): Promise<void> | undefined {
        return emit(method.name, named(method.params, args));
      },
      writable: true,
      configurable: true,
    });
  }
  return new Target();
}

/**
 * The stub to pass for a `callback` argument: one stub over the target, so the caller holds a
 * single reference to dispose when the subscription ends.
 */
export function callbackStub(name: string, callback: ApiCallback, emit: EmitEvent): Disposable {
  return new RpcStub(callbackTarget(name, callback, emit)) as unknown as Disposable;
}

/**
 * The stub to pass for a bare-function callback (`subscribeToMetadata(callback)`): each call emits
 * an event named after the parameter, its arguments keyed by the function's `params`.
 */
export function functionStub(param: string, params: string[], emit: EmitEvent): Disposable {
  const callback = (...args: unknown[]): Promise<void> | undefined => emit(param, named(params, args));
  return new RpcStub(callback) as unknown as Disposable;
}
