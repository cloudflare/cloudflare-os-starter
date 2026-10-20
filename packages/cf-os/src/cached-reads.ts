// The account reads an interactive command makes, each made once per run and shared by the step that
// needs it, a replay after Esc (back.ts), and a read started ahead of its step.

import type { CloudflareClient } from "./core/client.ts";
import { waitOn, type Prompter } from "./prompt.ts";

/** The client methods that only read, which {@link cachedReads} answers a second time from memory. */
const READ = /^(whoami|list|find|get|workersDevSubdomain)/;

/** What the spinner says while a step waits on each client method. */
export const LABELS: { [K in keyof CloudflareClient]: (...args: Parameters<CloudflareClient[K]>) => string } = {
  whoami: () => "Checking the cf sign-in",
  listAccounts: () => "Listing your accounts",
  listWorkers: () => "Listing the account's Workers",
  listWorkerSecrets: (_accountId, worker) => `Reading ${worker}'s secrets`,
  workersDevSubdomain: () => "Reading the workers.dev subdomain",
  listKvNamespaces: () => "Listing the account's KV namespaces",
  listR2Buckets: () => "Listing the account's R2 buckets",
  listAiGateways: () => "Listing the account's AI Gateways",
  listZones: () => "Listing the account's zones",
  findDnsRecords: (_accountId, _zone, host) => `Checking DNS records for ${host}`,
  getOrganization: () => "Reading the Zero Trust organization",
  listAccessApps: () => "Listing the Access applications",
  createAccessApp: () => "Creating the Access application",
  dryRunCreateAccessApp: () => "Checking the Access application request",
  listIdentityProviders: () => "Listing the identity providers",
  createIdentityProvider: () => "Adding the identity provider",
  dryRunCreateIdentityProvider: () => "Checking the identity provider request",
};

/** What the spinner says while a step waits on `fetchInventory`'s six reads (core/discovery.ts). */
export const INVENTORY_LABEL = "Reading the account's Workers, storage, AI Gateways and Access";

/** One read {@link cachedReads} holds: its promise, and whether it has settled. */
interface CachedRead {
  promise: Promise<unknown>;
  settled: boolean;
}

/**
 * Two views of `client` over one cache, each read answered once per method and arguments, its
 * failure included. `quiet` draws nothing, for starting reads ahead. `loud(prompter)` shows the
 * prompter's spinner while a step waits on a read still in flight, or on a create, which is never
 * cached. `pending` says whether any read is still in flight.
 */
export function cachedReads(client: CloudflareClient): {
  quiet: CloudflareClient;
  loud(prompter: Prompter | null | undefined): CloudflareClient;
  pending(): boolean;
} {
  const cache = new Map<string, CachedRead>();
  const cached = (key: string, method: (...args: unknown[]) => Promise<unknown>, args: unknown[]): CachedRead => {
    const id = `${key} ${JSON.stringify(args)}`;
    let entry = cache.get(id);
    if (!entry) {
      const read: CachedRead = { promise: method(...args), settled: false };
      const settle = () => {
        read.settled = true;
      };
      read.promise.then(settle, settle);
      cache.set(id, entry = read);
    }
    return entry;
  };
  const view = (wrap: (key: string, method: (...args: unknown[]) => Promise<unknown>) => unknown) =>
    new Proxy(client, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key);
        if (typeof key !== "string" || typeof value !== "function") return value;
        return wrap(key, value.bind(target) as (...args: unknown[]) => Promise<unknown>);
      },
    });
  return {
    quiet: view((key, method) => READ.test(key) ? (...args: unknown[]) => cached(key, method, args).promise : method),
    loud: (prompter) => view((key, method) => {
      const label = (LABELS as Record<string, ((...args: unknown[]) => string) | undefined>)[key];
      if (!label) return method;
      if (!READ.test(key)) return (...args: unknown[]) => waitOn(prompter, label(...args), () => method(...args));
      return (...args: unknown[]) => {
        const entry = cached(key, method, args);
        return entry.settled ? entry.promise : waitOn(prompter, label(...args), () => entry.promise);
      };
    }),
    pending: () => [...cache.values()].some((entry) => !entry.settled),
  };
}

/**
 * Starts `read` in the background. Nobody may ever await it (Esc, Ctrl-C, another path), and a
 * failure then must not become an unhandled rejection. A rejected read stays in the cache, so the
 * step that uses it still sees the failure, at the same point.
 */
export function prefetch(read: Promise<unknown>): void {
  read.catch(() => {});
}
