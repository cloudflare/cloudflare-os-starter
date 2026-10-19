// An in-memory `CloudflareClient`, for the core suites: an account as plain data, every create
// recorded. Test support only; not part of the build.

import {
  CfAuthError,
  CfError,
  workersDevSubdomainOf,
  type CfAccessApp,
  type CfAccount,
  type CfAiGateway,
  type CfDnsRecord,
  type CfIdentityProvider,
  type CfKvNamespace,
  type CfOrganization,
  type CfWorker,
  type CfZone,
  type CloudflareClient,
} from "./client.ts";

/** One account's contents. Absent lists are empty. */
export interface MemoryAccount {
  workers?: CfWorker[];
  /** Secret names by Worker name; a Worker named here is in the account. One only in `workers` has none. */
  secrets?: Record<string, string[]>;
  kvNamespaces?: CfKvNamespace[];
  buckets?: string[];
  gateways?: CfAiGateway[];
  zones?: CfZone[];
  /** Records by exact hostname. */
  dns?: Record<string, CfDnsRecord[]>;
  /** Null: the account has no Zero Trust organization. */
  organization?: CfOrganization | null;
  accessApps?: CfAccessApp[];
  identityProviders?: CfIdentityProvider[];
  /** What `listAccounts` returns. */
  accounts?: CfAccount[];
  email?: string;
  /** Every call fails as signed out (`whoami` reports it instead). */
  signedOut?: boolean;
  /** Methods that fail with this API error, by name. */
  failing?: Partial<Record<keyof CloudflareClient, string>>;
}

/** What the client was asked to create. */
export interface MemoryCreation {
  kind: "access-app" | "identity-provider";
  dryRun: boolean;
  body: Record<string, unknown>;
}

/** A client over `account`, recording creates and every method called. */
export function memoryClient(account: MemoryAccount): CloudflareClient & {
  created: MemoryCreation[];
  calls: (keyof CloudflareClient)[];
} {
  const created: MemoryCreation[] = [];
  const calls: (keyof CloudflareClient)[] = [];
  const gate = (method: keyof CloudflareClient) => {
    calls.push(method);
    if (account.signedOut) throw new CfAuthError("No authentication token found.");
    const failure = account.failing?.[method];
    if (failure) throw new CfError(failure);
  };
  return {
    created,
    calls,
    async whoami() {
      calls.push("whoami");
      return account.signedOut ? { authenticated: false } : { authenticated: true, email: account.email };
    },
    async listAccounts() {
      gate("listAccounts");
      return account.accounts ?? [];
    },
    async listWorkers() {
      gate("listWorkers");
      return account.workers ?? [];
    },
    async listWorkerSecrets(_accountId, worker) {
      gate("listWorkerSecrets");
      const secrets = account.secrets?.[worker];
      if (secrets) return secrets;
      return account.workers?.some((candidate) => candidate.name === worker) ? [] : null;
    },
    async workersDevSubdomain() {
      gate("workersDevSubdomain");
      return workersDevSubdomainOf(account.workers ?? []);
    },
    async listKvNamespaces() {
      gate("listKvNamespaces");
      return account.kvNamespaces ?? [];
    },
    async listR2Buckets() {
      gate("listR2Buckets");
      return account.buckets ?? [];
    },
    async listAiGateways() {
      gate("listAiGateways");
      return account.gateways ?? [];
    },
    async listZones() {
      gate("listZones");
      return account.zones ?? [];
    },
    async findDnsRecords(_accountId, _zone, name) {
      gate("findDnsRecords");
      return account.dns?.[name] ?? [];
    },
    async getOrganization() {
      gate("getOrganization");
      if (!account.organization) throw new CfError("[12000] organization not found");
      return account.organization;
    },
    async listAccessApps() {
      gate("listAccessApps");
      return account.accessApps ?? [];
    },
    async createAccessApp(_accountId, body) {
      gate("createAccessApp");
      created.push({ kind: "access-app", dryRun: false, body });
      const app = { ...body, aud: `aud-${created.length}` } as CfAccessApp;
      (account.accessApps ??= []).push(app);
      return app;
    },
    async dryRunCreateAccessApp(_accountId, body) {
      gate("dryRunCreateAccessApp");
      created.push({ kind: "access-app", dryRun: true, body });
      return { method: "POST", body };
    },
    async listIdentityProviders() {
      gate("listIdentityProviders");
      return account.identityProviders ?? [];
    },
    async createIdentityProvider(_accountId, body) {
      gate("createIdentityProvider");
      created.push({ kind: "identity-provider", dryRun: false, body });
      (account.identityProviders ??= []).push(body);
      return body;
    },
    async dryRunCreateIdentityProvider(_accountId, body) {
      gate("dryRunCreateIdentityProvider");
      created.push({ kind: "identity-provider", dryRun: true, body });
      return { method: "POST", body };
    },
  };
}
