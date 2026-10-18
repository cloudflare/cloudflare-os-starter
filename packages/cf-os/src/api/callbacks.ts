// The client side of a subscription: the callback a `subscribe*` method takes, built from the table
// so that it answers every call the server may make.
//
// capnweb only exposes an `RpcTarget`'s prototype methods to the peer. An instance property is
// refused ("an instance property of the RpcTarget"), and a method that is missing altogether makes
// the server's call throw, which ends the subscription on its side. So the target is a class minted
// per callback interface with a real prototype method for every method the table lists. Each call
// becomes one NDJSON line, `{"event": <method>, "args": [...]}`, and returns nothing.

import { RpcStub, RpcTarget } from "capnweb";
import { encodeValue } from "./codec.ts";
import type { ApiCallback } from "./table.ts";

/** Where events go: one call, one event. */
export type EmitEvent = (event: string, args: unknown[]) => void;

/** An {@link EmitEvent} writing NDJSON lines through `write`, arguments encoded as results are. */
export function ndjsonEvents(write: (line: string) => void): EmitEvent {
  return (event, args) => {
    // Capabilities passed into a callback are the callee's to forget: capnweb disposes them when
    // the call returns.
    write(`${JSON.stringify({ event, args: args.map((arg) => encodeValue(arg)) })}\n`);
  };
}

/**
 * An `RpcTarget` implementing `callback`: every method in its table entry is a prototype method that
 * emits an event named after the method and returns `undefined`.
 */
export function callbackTarget(name: string, callback: ApiCallback, emit: EmitEvent): RpcTarget {
  const Target = class extends RpcTarget {};
  Object.defineProperty(Target, "name", { value: name });
  for (const method of callback.methods) {
    Object.defineProperty(Target.prototype, method.name, {
      value: function (...args: unknown[]): undefined {
        emit(method.name, args);
        return undefined;
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
 * an event named after the parameter.
 */
export function functionStub(param: string, emit: EmitEvent): Disposable {
  const callback = (...args: unknown[]): undefined => {
    emit(param, args);
    return undefined;
  };
  return new RpcStub(callback) as unknown as Disposable;
}
