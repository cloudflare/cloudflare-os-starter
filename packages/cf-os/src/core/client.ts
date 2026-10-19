// Everything the core reads from or creates in a Cloudflare account, as one interface.
//
// Today `cf-client.ts` implements it by spawning the `cf` CLI; the core suites implement it in
// memory (`memory-client.ts`). Inside `cf` itself it would be `cf`'s own API layer, with no
// subprocess, which is why every method is async even though the CLI-backed one is not.
//
// The shapes below are the API's, as `cf` prints them, cut down to the fields the core reads.

/** The client ran, and the API refused it for want of credentials or permission. */
export class CfAuthError extends Error {}

/** The request failed for any reason other than authentication. */
export class CfError extends Error {}

/** The client could not reach the API at all (for the CLI-backed one: `cf` would not run). */
export class CfUnavailableError extends CfError {}

/** A Worker as `workers list` describes it. */
export interface CfWorker {
  name: string;
  /** The Worker's workers.dev address. Present whether or not the route is enabled. */
  subdomain?: { enabled?: boolean; url?: string };
}

/** A KV namespace. */
export interface CfKvNamespace {
  id: string;
  title: string;
}

/** An AI Gateway. `id` is the gateway's name. */
export interface CfAiGateway {
  id: string;
}

/** A zone, as `zones list` describes it. */
export interface CfZone {
  id: string;
  /** The zone's apex hostname. */
  name: string;
  status?: string;
}

/** A DNS record. */
export interface CfDnsRecord {
  id?: string;
  name: string;
  type?: string;
  content?: string;
}

/** An Access application. */
export interface CfAccessApp {
  id?: string;
  name?: string;
  type?: string;
  aud?: string;
  /** Primary hostname, optionally with a path. */
  domain?: string;
  /** Every hostname the application covers, the primary one included. */
  self_hosted_domains?: string[];
  /** The newer form of `self_hosted_domains`. Only `public` destinations carry a hostname. */
  destinations?: { type?: string; uri?: string }[];
}

/** The account's Zero Trust organization. */
export interface CfOrganization {
  /** The team domain, `<team>.cloudflareaccess.com`, without a scheme. */
  auth_domain?: string;
  name?: string;
}

/** A Zero Trust identity provider: a way for people to sign in through Access. */
export interface CfIdentityProvider {
  id?: string;
  name?: string;
  /** `onetimepin`, `github`, `oidc`, ... */
  type?: string;
}

/** An account the signed-in identity can reach. */
export interface CfAccount {
  id: string;
  name: string;
}

/** Who the client is signed in as. Signed out is an answer, not an error. */
export interface CfWhoami {
  authenticated: boolean;
  email?: string;
}

/**
 * Every Cloudflare read and write the core makes. Methods that act on an account take its ID first;
 * nothing relies on an ambient or cached account.
 *
 * Failures are {@link CfAuthError} for credentials, {@link CfUnavailableError} when the API cannot
 * be reached, and {@link CfError} for everything else.
 */
export interface CloudflareClient {
  whoami(): Promise<CfWhoami>;
  listAccounts(): Promise<CfAccount[]>;
  listWorkers(accountId: string): Promise<CfWorker[]>;
  /**
   * The names of the secrets set on Worker `worker` (their values are never readable), or null when
   * the account has no Worker by that name yet.
   */
  listWorkerSecrets(accountId: string, worker: string): Promise<string[] | null>;
  /** The account's workers.dev subdomain (`<sub>` in `<worker>.<sub>.workers.dev`), when knowable. */
  workersDevSubdomain(accountId: string): Promise<string | null>;
  listKvNamespaces(accountId: string): Promise<CfKvNamespace[]>;
  /** Bucket names. */
  listR2Buckets(accountId: string): Promise<string[]>;
  listAiGateways(accountId: string): Promise<CfAiGateway[]>;
  /** The account's active zones. */
  listZones(accountId: string): Promise<CfZone[]>;
  /** Records in `zone` (an ID or apex name) named exactly `name`. */
  findDnsRecords(accountId: string, zone: string, name: string): Promise<CfDnsRecord[]>;
  /** Throws {@link CfError} when the account has no Zero Trust organization. */
  getOrganization(accountId: string): Promise<CfOrganization>;
  /** Every Access application in the account. */
  listAccessApps(accountId: string): Promise<CfAccessApp[]>;
  createAccessApp(accountId: string, body: Record<string, unknown>): Promise<CfAccessApp>;
  /** The request {@link createAccessApp} would send, validated but not sent. */
  dryRunCreateAccessApp(accountId: string, body: Record<string, unknown>): Promise<unknown>;
  listIdentityProviders(accountId: string): Promise<CfIdentityProvider[]>;
  createIdentityProvider(accountId: string, body: Record<string, unknown>): Promise<CfIdentityProvider>;
  /** The request {@link createIdentityProvider} would send, validated but not sent. */
  dryRunCreateIdentityProvider(accountId: string, body: Record<string, unknown>): Promise<unknown>;
}

/** The Access issuer for an organization: its team domain as an HTTPS origin. */
export function issuerOf(organization: CfOrganization): string | undefined {
  return organization.auth_domain ? `https://${organization.auth_domain}` : undefined;
}

/** An application's public destinations, each as a lowercased hostname and the path after it. */
function accessAppDestinations(app: CfAccessApp): { host: string; path: string }[] {
  const entries = [
    app.domain,
    ...(app.self_hosted_domains ?? []),
    ...(app.destinations ?? [])
      .filter((destination) => (destination.type ?? "public") === "public")
      .map((destination) => destination.uri),
  ];
  return entries
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .map((entry) => {
      const bare = entry.replace(/^https?:\/\//, "");
      const slash = bare.indexOf("/");
      return slash < 0
        ? { host: bare.toLowerCase(), path: "" }
        : { host: bare.slice(0, slash).toLowerCase(), path: bare.slice(slash) };
    });
}

/** Every hostname an Access application names, lowercased and without paths. */
export function accessAppHosts(app: CfAccessApp): string[] {
  return [...new Set(accessAppDestinations(app).map((destination) => destination.host))];
}

/**
 * Application types that put Access in front of a hostname. The others (bookmarks, SaaS, the App
 * Launcher, ...) can name a hostname without gating a single request to it.
 */
const GATING_TYPES = new Set(["self_hosted", "ssh", "vnc", "rdp"]);

/** Whether one hostname label matches a pattern label, in which a `*` stands for any run of characters. */
function labelMatches(pattern: string, label: string): boolean {
  if (!pattern.includes("*")) return pattern === label;
  const parts = pattern.split("*").map((part) => part.replace(/[^a-z\d-]/g, "\\$&"));
  return new RegExp(`^${parts.join("[^.]*")}$`).test(label);
}

/**
 * Whether a wildcard hostname such as `*.example.com` matches `host`. As in Access, a `*` stands
 * within one label, so `*.example.com` covers `os.example.com` but not `example.com` or
 * `os.team.example.com`.
 */
function wildcardMatches(pattern: string, host: string): boolean {
  const patterns = pattern.split(".");
  const labels = host.split(".");
  return patterns.length === labels.length && patterns.every((label, i) => labelMatches(label, labels[i]));
}

/**
 * How specifically an Access application names `host` for every path of it: `Infinity` through a
 * destination that is `host` itself; through a wildcard one, the characters it matches literally
 * (`*.team.example.com` over `*.example.com`); `-1` when it does not gate them all. Only a
 * destination without a path (or `/`, `/*`) counts: one on `/admin` leaves `/` and `/api` open.
 */
function specificity(app: CfAccessApp, host: string): number {
  if (!GATING_TYPES.has(app.type ?? "self_hosted")) return -1;
  const target = host.toLowerCase();
  return Math.max(-1, ...accessAppDestinations(app)
    .filter((destination) => ["", "/", "/*"].includes(destination.path))
    .map(({ host: name }) => name === target ? Infinity
      : name.includes("*") && wildcardMatches(name, target) ? name.replaceAll("*", "").length : -1));
}

/**
 * How an Access application gates every path of `host`: `"exact"` through a destination that is
 * `host` itself, `"wildcard"` through one whose `*` matches it, `null` when it does not. Only a
 * destination without a path (or `/`, `/*`) counts: one on `/admin` leaves `/` and `/api` open.
 */
export function accessAppCoverage(app: CfAccessApp, host: string): "exact" | "wildcard" | null {
  const score = specificity(app, host);
  return score === Infinity ? "exact" : score >= 0 ? "wildcard" : null;
}

/** Whether an Access application gates every path of `host`: see {@link accessAppCoverage}. */
export function accessAppCovers(app: CfAccessApp, host: string): boolean {
  return specificity(app, host) >= 0;
}

/**
 * The application Access applies to `host` out of `apps`: the one naming it most specifically, as
 * Access itself prefers -- `host` exactly, else the wildcard matching the most of it. Undefined when
 * none gates every path.
 */
export function accessAppFor(apps: CfAccessApp[], host: string): CfAccessApp | undefined {
  let best: CfAccessApp | undefined;
  let bestScore = -1;
  for (const app of apps) {
    const score = specificity(app, host);
    if (score > bestScore) [best, bestScore] = [app, score];
  }
  return best;
}

/**
 * The account's workers.dev subdomain, read off any Worker's own workers.dev address. Every Worker
 * in an account shares it, and the record carries the address whether or not the route is enabled.
 * Null when the account has no Workers to read it from.
 */
export function workersDevSubdomainOf(workers: CfWorker[]): string | null {
  for (const worker of workers) {
    const url = worker.subdomain?.url;
    if (!url) continue;
    let labels: string[];
    try {
      labels = new URL(url).host.toLowerCase().split(".");
    } catch {
      continue;
    }
    if (labels.length === 4 && labels[2] === "workers" && labels[3] === "dev") return labels[1];
  }
  return null;
}
