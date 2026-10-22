// An in-process Cap'n Web server for the `cf-os api` suites: the generator fixture's API (the one
// `generator/__fixtures__/generated/schema.json` describes, upstream's extractor fixture
// `packages/api-schema/__tests__/__fixtures__/api.ts` before its format additions) implemented as
// `RpcTarget`s that record every call and every disposal, served over a MessageChannel through the
// session factory the runtime takes. Test support only; not part of the build.

import { setImmediate as nextTurn } from "node:timers/promises";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import type { Remote, OpenConnection } from "./session.ts";

/** What the server saw. */
export interface ServerLog {
  /** Calls, as `Target.method` and the arguments received. */
  calls: { method: string; args: unknown[] }[];
  /** Targets whose `Symbol.dispose` ran, by name. */
  disposed: string[];
  /** Headers each connection was opened with. */
  headers: Record<string, string>[];
  /** Messages the client posted, in order: what had been sent when a server method ran. */
  sent: string[];
}

/** The log entry for calls of `method`. */
export function callsOf(log: ServerLog, method: string): unknown[][] {
  return log.calls.filter((call) => call.method === method).map((call) => call.args);
}

/** Waits until `ready()` holds, failing after five seconds: disposal crosses the channel asynchronously. */
export async function eventually(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await nextTurn();
  }
}

/** A disposable, named handle: the `RpcStub<{}>` a subscription or `lock` returns. */
class Handle extends RpcTarget {
  readonly #name: string;
  readonly #log: ServerLog;
  constructor(name: string, log: ServerLog) {
    super();
    this.#name = name;
    this.#log = log;
  }
  [Symbol.dispose](): void {
    this.#log.disposed.push(this.#name);
  }
}

/** The stored note the fixture hands out: one of every type JSON lacks. */
export function sampleNote(): Record<string, unknown> {
  return {
    id: 1,
    title: "First",
    created: new Date("2026-01-02T03:04:05.000Z"),
    size: 12345678901234567890n,
    body: new Uint8Array([1, 2, 3]),
    tags: ["a"],
    missing: undefined,
  };
}

/** Knobs for the fixture's behaviour. */
export interface FixtureOptions {
  /** What `login` accepts: the username and hash bytes (hex). */
  login?: { username: string; hashHex: string };
  /** `getAdmin` returns null. */
  noAdmin?: boolean;
  /** `setMood` never returns. */
  hang?: boolean;
}

/** The fixture API's root, `FixturePublicApi`. */
export function fixtureRoot(log: ServerLog, options: FixtureOptions = {}): RpcTarget {
  const record = (method: string, args: unknown[]) => log.calls.push({ method, args });

  class Admin extends RpcTarget {
    setBanner(text: string): void {
      record("setBanner", [text]);
      throw new Error(`banner refused: ${text}`);
    }
    [Symbol.dispose](): void {
      log.disposed.push("admin");
    }
  }

  class Untyped extends RpcTarget {
    echo(...args: unknown[]): unknown[] {
      record("echo", args);
      return args;
    }
    [Symbol.dispose](): void {
      log.disposed.push("untyped");
    }
  }

  class Notebook extends RpcTarget {
    readonly #id: string;
    constructor(id: string) {
      super();
      this.#id = id;
    }
    file(...args: unknown[]): void {
      record("file", args);
    }
    subscribe(subscriber: Remote, ...rest: unknown[]): Handle {
      record("subscribe", rest);
      // A callback outlives the call only as a duplicate, as upstream's subscribers are kept.
      const kept = subscriber.dup();
      void (async () => {
        await kept.added(sampleNote());
        await kept.removed(7);
        await kept.ready();
      })().catch((error: unknown) => record("subscriberFailed", [(error as Error).message]));
      return new Handle("subscription", log);
    }
    watchTitle(callback: Remote): Handle {
      const kept = callback.dup();
      void Promise.resolve(kept(`title of ${this.#id}`)).catch(() => {});
      return new Handle("watch", log);
    }
    lock(): Handle {
      record("lock", []);
      return new Handle("lock", log);
    }
    connect(): Untyped {
      return new Untyped();
    }
    upload(...args: unknown[]): void {
      record("upload", args);
    }
    outline(): unknown {
      record("outline", [this.#id]);
      return { title: this.#id, children: [{ title: "child", children: [] }] };
    }
    [Symbol.dispose](): void {
      log.disposed.push("notebook");
    }
  }

  class Authed extends RpcTarget {
    openNotebook(...args: unknown[]): Notebook {
      record("openNotebook", [...args, log.sent.some((message) => message.includes('"outline"'))]);
      return new Notebook(args[0] as string);
    }
    getAdmin(): Admin | null {
      return options.noAdmin ? null : new Admin();
    }
    async importArchive(archive: ReadableStream<Uint8Array>): Promise<string> {
      const chunks: Uint8Array[] = [];
      for await (const chunk of archive) chunks.push(chunk);
      return Buffer.concat(chunks).toString("utf8");
    }
    findNotes(...args: unknown[]): unknown[] {
      record("findNotes", args);
      return [{ id: 1, title: String(args[0]) }];
    }
    setMood(mood: string): Promise<void> | void {
      record("setMood", [mood]);
      if (options.hang) return new Promise(() => {});
    }
    setNickname(name: string | null): void {
      record("setNickname", [name]);
    }
    [Symbol.dispose](): void {
      log.disposed.push("authed");
    }
  }

  class Root extends RpcTarget {
    ping(): void {
      record("ping", []);
    }
    authenticate(token: string): Authed {
      record("authenticate", [token]);
      if (token !== "good-token") throw new Error("invalid token");
      return new Authed();
    }
    authenticateFromCfAccess(): Authed {
      record("authenticateFromCfAccess", []);
      return new Authed();
    }
    login(username: string, hash: Uint8Array): string | null {
      record("login", [username, Buffer.from(hash).toString("hex")]);
      const expected = options.login;
      return expected && expected.username === username && expected.hashHex === Buffer.from(hash).toString("hex")
        ? "good-token"
        : null;
    }
    download(id: number): ReadableStream<Uint8Array> {
      record("download", [id]);
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`note ${id}\n`));
          controller.enqueue(new TextEncoder().encode("second chunk\n"));
          controller.close();
        },
      });
    }
    [Symbol.dispose](): void {
      log.disposed.push("root");
    }
  }

  return new Root();
}

/**
 * A session factory serving `root()` over a fresh MessageChannel per connection. `close()` shuts the
 * ports, which would otherwise keep the test process alive.
 */
export function messagePortServer(log: ServerLog, root: () => RpcTarget): { open: OpenConnection; close(): void; opened: number } {
  const ports: MessagePort[] = [];
  const server = {
    opened: 0,
    open: ((url, headers) => {
      server.opened++;
      log.headers.push(headers);
      const { port1, port2 } = new MessageChannel();
      ports.push(port1, port2);
      const post = port1.postMessage.bind(port1);
      port1.postMessage = (message: unknown) => {
        log.sent.push(JSON.stringify(message, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value));
        post(message);
      };
      newMessagePortRpcSession(port2, root());
      return { main: newMessagePortRpcSession(port1), opened: () => true };
    }) as OpenConnection,
    close: () => {
      for (const port of ports) port.close();
    },
  };
  return server;
}

/** An empty log. */
export function serverLog(): ServerLog {
  return { calls: [], disposed: [], headers: [], sent: [] };
}
