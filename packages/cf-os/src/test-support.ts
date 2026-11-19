// Shared fixtures for the command suites: a scripted prompter, a context that captures output, and
// scratch project directories. Test support only; not part of the build.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { API_CLI_ENTRY, API_GENERATOR } from "./commands/api.ts";
import { INSTALL_MARKER } from "./commands/install.ts";
import type { Context, GlobalFlags, Output } from "./context.ts";
import type { CloudflareClient } from "./core/client.ts";
import type { ProdWranglerConfig } from "./core/deployment-config.ts";
import type { GatekeeperCatalog } from "./core/gatekeepers.ts";
import type { FakeReply } from "./fake-cf.ts";
import type { CfWorkerBinding, CfWorkerDeployment, CfWorkerVersion } from "./core/client.ts";
import type { MemoryAccount } from "./core/memory-client.ts";
import { migrationClasses } from "./core/hosted-release.ts";
import { durableObjectNamespacesReply, workerLiveReplies } from "./fake-cf.ts";
import type { PinMove } from "./commands/update.ts";
import { Back, Cancelled, type Choice, type Prompter } from "./prompt.ts";

/** Accept whatever the prompt offers as its default. */
export const DEFAULT = Symbol("default");

/** Cancel the prompt, as Ctrl-C would. */
export const CANCEL = Symbol("cancel");

/** Press Esc: on the {@link Prompter.backable} view it goes back a question; elsewhere it cancels. */
export const BACK = Symbol("back");

/** One scripted answer: the prompt it expects (a substring or pattern of its message), and the reply. */
export type Step = [expected: string | RegExp, answer: unknown];

/** A recorded prompt. */
export interface Asked {
  kind: "select" | "multiselect" | "text" | "password" | "confirm";
  message: string;
  /** Choice values offered, for select and multiselect. */
  choices?: string[];
  /** Hints offered, by value. */
  hints?: Record<string, string | undefined>;
  /** The default offered. */
  initial?: unknown;
  /** For multiselect: whether an empty answer is refused. */
  required?: boolean;
  /** For password: why the prompt's validation refused the answer, which then asked again. */
  refused?: string;
  /** Asked on the {@link Prompter.backable} view, where Esc goes back. */
  backable?: true;
}

function describeChoices(choices: Choice[]): Pick<Asked, "choices" | "hints"> {
  return {
    choices: choices.map((choice) => choice.value),
    hints: Object.fromEntries(choices.map((choice) => [choice.value, choice.hint])),
  };
}

/**
 * A {@link Prompter} answering from `script`, in order. Each prompt must match its step's expected
 * message, every text answer must pass the prompt's own validation, and a prompt past the end of the
 * script fails the test -- so a script is also an assertion about what was asked. `answered` and
 * `waited` record, in order, the questions answered and the {@link Prompter.busy} waits it ran.
 */
export function scriptedPrompter(
  script: Step[],
): Prompter & { asked: Asked[]; answered: string[]; waited: string[]; remaining: () => Step[] } {
  const state: ScriptState = { steps: [...script], asked: [], answered: [], waited: [] };
  const { steps, asked, answered, waited } = state;
  return { asked, answered, waited, remaining: () => steps, ...scriptedView(state, false) };
}

/** What a {@link scriptedPrompter} and its views share. */
interface ScriptState {
  steps: Step[];
  asked: Asked[];
  answered: string[];
  waited: string[];
}

function scriptedView(shared: ScriptState, backable: boolean): Prompter {
  const { steps, asked, answered, waited } = shared;
  /** `answer`, recorded as `message`'s. */
  const done = <T>(message: string, answer: T): T => {
    answered.push(message);
    return answer;
  };
  const next = (record: Asked): unknown => {
    if (backable) record.backable = true;
    asked.push(record);
    const step = steps.shift();
    assert.ok(step, `unexpected prompt: ${record.message}`);
    const [expected, answer] = step;
    if (typeof expected === "string") assert.ok(record.message.includes(expected), `expected a prompt about "${expected}", got "${record.message}"`);
    else assert.match(record.message, expected);
    if (answer === CANCEL || answer === BACK && !backable) throw new Cancelled();
    if (answer === BACK) throw new Back();
    return answer === DEFAULT ? record.initial : answer;
  };
  return {
    backable: () => scriptedView(shared, true),
    async busy(message, work) {
      waited.push(message);
      return work();
    },
    async select(message, choices, initial) {
      const answer = next({ kind: "select", message, ...describeChoices(choices), initial }) as string;
      assert.ok(choices.some((choice) => choice.value === answer), `"${answer}" is not a choice for "${message}"`);
      return done(message, answer as never);
    },
    async multiselect(message, choices, initial, { required = true } = {}) {
      const answer = next({ kind: "multiselect", message, ...describeChoices(choices), initial, required });
      assert.ok(Array.isArray(answer), `"${message}" takes a list`);
      for (const value of answer) {
        assert.ok(choices.some((choice) => choice.value === value), `"${value}" is not a choice for "${message}"`);
      }
      assert.ok(!required || answer.length, `"${message}" needs at least one choice`);
      return done(message, answer as never);
    },
    async text(message, { initial, validate } = {}) {
      const answer = String(next({ kind: "text", message, initial }) ?? "");
      const problem = validate?.(answer);
      assert.equal(problem, undefined, `"${answer}" fails "${message}": ${problem}`);
      return done(message, answer);
    },
    async password(message, { validate } = {}) {
      for (;;) {
        const record: Asked = { kind: "password", message };
        const answer = String(next(record) ?? "");
        const problem = validate?.(answer);
        if (problem === undefined) return done(message, answer);
        record.refused = problem;
      }
    },
    async confirm(message, initial = true) {
      return done(message, next({ kind: "confirm", message, initial }) as boolean);
    },
  };
}

/** A context for running a command directly, with its stdout JSON and stderr lines captured. */
export function testContext(
  { root, cwd = root, prompter = null, client, flags = {} }:
    { root: string; cwd?: string; prompter?: Prompter | null; client?: CloudflareClient; flags?: GlobalFlags },
): { ctx: Context; json: unknown[]; log: string[]; stderr: () => string } {
  const json: unknown[] = [];
  const log: string[] = [];
  const out: Output = { json: (data) => json.push(data), log: (text) => log.push(text) };
  return {
    ctx: {
      root,
      cwd,
      flags,
      prompter,
      out,
      client: async () => {
        assert.ok(client, "the command used a Cloudflare client this test did not provide");
        return client;
      },
    },
    json,
    log,
    stderr: () => log.join("\n"),
  };
}

/** A scratch project directory: `deployment.jsonc` holding `text`, and an empty `cloudflare-os/`. */
export function scratchProject(t: { after: (fn: () => void) => void }, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cf-os-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "cloudflare-os"));
  writeFileSync(join(dir, "deployment.jsonc"), text);
  return dir;
}

/**
 * A scratch project as `cf-os api` needs it: the submodule installed for its lockfile, and at the
 * pinned CLI's entry a stand-in that writes its arguments, cwd and the two variables `cf-os api`
 * sets to `report`, then exits `STUB_EXIT`; with `STUB_WAIT`, it writes `<root>/ready` instead and
 * waits for a SIGTERM, exiting 7. At the pin's generator, another writes its arguments, and whether
 * the CLI had yet to run, to `generation`, then exits `STUB_GENERATE_EXIT`.
 */
export function apiCliProject(
  t: { after: (fn: () => void) => void },
  text = TEMPLATE,
): { root: string; report: string; generation: string } {
  const root = scratchProject(t, text);
  const submodule = join(root, "cloudflare-os");
  writeFileSync(join(submodule, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  writeFileSync(join(submodule, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  mkdirSync(dirname(join(submodule, INSTALL_MARKER)), { recursive: true });
  writeFileSync(join(submodule, INSTALL_MARKER), JSON.stringify({
    lockfileSha256: createHash("sha256").update(readFileSync(join(submodule, "pnpm-lock.yaml"))).digest("hex"),
  }));
  const entry = join(root, API_CLI_ENTRY);
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, `
    import { writeFileSync } from "node:fs";
    const root = new URL("../../../../", import.meta.url);
    const pick = (name) => Object.hasOwn(process.env, name) ? process.env[name] : "(unset)";
    writeFileSync(new URL("report.json", root), JSON.stringify({
      argv: process.argv.slice(2), cwd: process.cwd(),
      CFOS_API_URL: pick("CFOS_API_URL"), CFOS_API_URL_UNAVAILABLE: pick("CFOS_API_URL_UNAVAILABLE"),
    }));
    if (process.env.STUB_WAIT) {
      process.on("SIGTERM", () => process.exit(7));
      writeFileSync(new URL("ready", root), "");
      setInterval(() => {}, 1000);
    } else {
      process.exitCode = Number(process.env.STUB_EXIT ?? 0);
    }
  `);
  const generator = join(root, API_GENERATOR);
  mkdirSync(dirname(generator), { recursive: true });
  writeFileSync(generator, `
    import { existsSync, writeFileSync } from "node:fs";
    const root = new URL("../../../../", import.meta.url);
    writeFileSync(new URL("generation.json", root), JSON.stringify({
      argv: process.argv.slice(2), beforeCli: !existsSync(new URL("report.json", root)),
    }));
    process.exitCode = Number(process.env.STUB_GENERATE_EXIT ?? 0);
  `);
  return { root, report: join(root, "report.json"), generation: join(root, "generation.json") };
}

/**
 * A fresh `deployment.jsonc`, comments cut down. Inline rather than read from the repository's: that file is
 * the operator's own once they fill it in, and `pnpm cf-os check` runs these tests against it.
 */
export const TEMPLATE = `{
  // Cloudflare account that owns every Worker and provisioned resource.
  "accountId": "<CLOUDFLARE_ACCOUNT_ID>",
  "publicBaseUrl": null,
  // Worker names are permanent service identities.
  "workers": {
    "router": {
      "name": "<ROUTER_WORKER_NAME>",
      // Production: use a hostname in an active Cloudflare zone.
      "route": { "customDomain": "os.example.com" }
    },
    "workshop": { "name": "<WORKSHOP_WORKER_NAME>" },
    "context": { "name": "<CONTEXT_WORKER_NAME>" },
    "scheduler": { "name": "<SCHEDULER_WORKER_NAME>" },
    "websearch": { "name": "<WEBSEARCH_WORKER_NAME>" },
    // Ignored when customGatekeeper.enabled is false.
    "customGatekeeper": { "name": "<CUSTOM_GATEKEEPER_WORKER_NAME>" },
    "errorReporter": { "name": "<ERROR_REPORTER_WORKER_NAME>" }
  },
  // Optional upstream Gatekeepers, by slug: { "github": { "name": "acme-gk-github" } }.
  "gatekeepers": {},
  "access": {
    "issuer": "https://<TEAM_NAME>.cloudflareaccess.com",
    "audience": "<ACCESS_AUDIENCE>",
    "admins": ["<ADMIN_EMAIL>"]
  },
  "aiGateway": { "enabled": true, "name": "default", "accountId": null, "providers": ["cloudflare"] },
  "context": { "sharingDomain": null, "kvNamespaceId": null },
  "customGatekeeper": { "enabled": true, "name": "<ORGANIZATION_DISPLAY_NAME>", "message": "<ORGANIZATION_GUIDANCE>" },
  "errorReporting": { "enabled": true, "environment": "production", "release": null },
  "resources": {
    "blueprintsKvNamespaceId": null,
    "avatarsKvNamespaceId": null,
    "blueprintContentBucket": null
  },
  "observability": {
    "enabled": true,
    "headSamplingRate": 1,
    "logs": { "invocationLogs": false },
    "traces": { "enabled": false, "headSamplingRate": 0.1 }
  }
}
`;

/** A `delay` for `fakeCf` settling the calls in the reverse of the order they started: the first waits longest. */
export function reversing(): (args: string[]) => number {
  let started = 0;
  return () => 60 - 10 * started++;
}

/** A hosted instance "acme" deployed before Web Search shipped, as `cf` would print it. */
export function hostedAccount(): Record<string, FakeReply> {
  return {
    "zero-trust organization get": { auth_domain: "acme-team.cloudflareaccess.com" },
    "workers list": [
      { name: "acme", subdomain: { enabled: true, url: "https://acme.acme-sub.workers.dev" } },
      { name: "acme-backend" },
      { name: "acme-gk-context" },
      { name: "acme-gk-scheduler" },
      { name: "acme-gk-github" },
      { name: "unrelated" },
    ],
    "kv namespaces list": [
      { id: "kv-blueprints", title: "acme-blueprints" },
      { id: "kv-avatars", title: "acme-avatars" },
      { id: "kv-context", title: "acme-context-collections" },
    ],
    "r2 buckets list": { buckets: [{ name: "acme-blueprint-content" }] },
    "ai-gateway gateways list": [{ id: "default" }, { id: "acme-ai" }],
    "zero-trust access applications list": [
      { name: "Cloudflare OS acme 1a2b3c4d", aud: "aud-acme", domain: "acme.acme-sub.workers.dev" },
    ],
  };
}

/** The repository root, for reading the submodule's packages whatever the working directory. */
const REPOSITORY = join(import.meta.dirname, "..", "..", "..");

/** An upstream package's file, parsed as `cf-os deploy` parses JSONC, errors included. */
function upstreamJsonc<T>(path: string): T {
  const errors: ParseError[] = [];
  const result = parse(readFileSync(join(REPOSITORY, path), "utf8"), errors, { allowTrailingComma: true }) as T;
  assert.deepEqual(errors, [], `${path} did not parse cleanly`);
  return result;
}

/** Upstream package `dir`'s catalog entry, as `loadCatalog` reads it, with the OAuth inputs it reads when `oauth`. */
function offeredGatekeeper(slug: string, dir: string, packageName: string, singleton: boolean, oauth = false) {
  const packageDir = `cloudflare-os/packages/${dir}`;
  return {
    slug,
    packageDir,
    packageName,
    preinstall: false,
    singleton,
    secrets: oauth ? upstreamJsonc<GatekeeperCatalog["offered"][number]["secrets"]>(`${packageDir}/deploy-inputs.json`) : [],
    vars: [],
    readme: `${packageDir}/README.md`,
    config: upstreamJsonc<ProdWranglerConfig>(`${packageDir}/wrangler.jsonc`),
  };
}

/**
 * A small Gatekeeper catalog, as `loadCatalog` reads it from the submodule: GitHub, an OAuth one
 * with upstream's `deploy-inputs.json` setup guidance; Home Assistant, which takes no credentials;
 * the MCP portal, whose slug folds its package name; and Email, excluded. The configs and inputs
 * come from the packages themselves, and gatekeeper-catalog.test.ts holds every entry to what the
 * real catalog says.
 */
export function testCatalog(): GatekeeperCatalog {
  return {
    offered: [
      offeredGatekeeper("github", "gatekeeper-github", "@gadgets/github-gatekeeper", false, true),
      offeredGatekeeper("homeassistant", "gatekeeper-homeassistant", "@gadgets/homeassistant-gatekeeper", true),
      offeredGatekeeper("mcpportal", "gatekeeper-mcp-portal", "@gadgets/mcp-portal-gatekeeper", true),
    ],
    excluded: [{ package: "gatekeeper-email", slug: "email", reason: "upstream marks it not installable" }],
  };
}

/** {@link testCatalog} with GitLab too: a second OAuth Gatekeeper, for runs that set more than one. */
export function testCatalogWithGitlab(): GatekeeperCatalog {
  const catalog = testCatalog();
  catalog.offered.push(offeredGatekeeper("gitlab", "gatekeeper-gitlab", "@gadgets/gitlab-gatekeeper", false, true));
  return catalog;
}

/** {@link testCatalog} with Google too: an optional Gatekeeper with a Workers AI binding of its own. */
export function testCatalogWithGoogle(): GatekeeperCatalog {
  const catalog = testCatalog();
  catalog.offered.push(offeredGatekeeper("google", "gatekeeper-google", "@gadgets/google-gatekeeper", false, true));
  return catalog;
}

/** The release the hosted fixtures run: the one the deploy flow's take-over command names. */
export const HOSTED_RELEASE = "r004945-6c8d301";

/** The cloudflare-os commit {@link HOSTED_RELEASE} was built from. */
export const HOSTED_COMMIT = "6c8d301dcfef4e8fdff41a3db5fe3f8bb82f8e2d";

/** The installation fingerprint every version tag of the hosted fixtures ends with. */
export const HOSTED_FINGERPRINT = "1a2b3c4d";

/**
 * What one Worker runs, as the account holds it: its deployments, live first, their versions, and
 * the Durable Object classes it has a namespace for.
 */
export interface WorkerLive {
  deployments: CfWorkerDeployment[];
  versions: CfWorkerVersion[];
  durableObjects: string[];
}

/** How {@link hostedWorkerLive} builds one Worker of a hosted instance. */
export interface HostedWorkerOptions {
  /** The release its live version was uploaded from. Default {@link HOSTED_RELEASE}. */
  release?: string;
  /** The hosted flow's label for the upload: `core`, or `gk-<slug>` for an optional Gatekeeper. */
  operation?: string;
  /** The version's annotations, in place of the hosted flow's tag and message. */
  annotations?: Record<string, string>;
  /** Whether it carries the CLOUDFLARE_OS_RELEASE_ID variable. Default true. */
  releaseVar?: boolean;
  /** Plain variables beside CLOUDFLARE_OS_RELEASE_ID. One set to `undefined` is left out. */
  vars?: Record<string, string | undefined>;
  /** JSON variables. One set to `undefined` is left out. */
  json?: Record<string, unknown>;
  /** Service bindings: the Worker each points at, by binding name. One set to `undefined` is left out. */
  services?: Record<string, string | undefined>;
  /** Secret bindings, which a version lists by name and type alone. */
  secrets?: string[];
  /**
   * The Durable Object migration tag the API reports with the live version. Unset, it reports none,
   * as the version endpoint `cf` reads is not documented to: a suite that sets it covers an API
   * that does.
   */
  migrationTag?: string;
  /**
   * The Durable Object classes the Worker has a namespace for. Unset, a Worker of the fixture
   * instance has the ones the pinned upstream's migrations create ({@link pinnedDurableObjects}),
   * as an instance on the project's own release would, and any other Worker has none.
   */
  durableObjects?: string[];
  /**
   * Changed by hand: the live version is one the dashboard made over the hosted flow's, keeping its
   * variables and bindings but none of its annotations.
   */
  handEdited?: boolean;
}

/** A version ID for Worker `name`'s `nth` version: a UUID, the same on every run. */
export function fixtureVersionId(name: string, nth = 1): string {
  const hex = createHash("sha256").update(`${name}#${nth}`).digest("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

/** The annotations the hosted flow puts on a version it uploads from `release`, for `operation`. */
export function hostedAnnotations(release: string, operation = "core"): Record<string, string> {
  const run = /^r0*(\d+)-/.exec(release)?.[1] ?? release;
  return {
    "workers/tag": `gd:${run}:${HOSTED_FINGERPRINT}`,
    "workers/message": `Cloudflare OS ${operation} from release ${release} (upload 5e0b7c12)`,
    "workers/triggered_by": "upload",
  };
}

/** The upstream package each Worker of the fixture instance "acme" that has Durable Objects is built from. */
const HOSTED_PACKAGES: Record<string, string> = {
  "acme-backend": "workshop-backend",
  "acme-gk-context": "gatekeeper-context",
  "acme-gk-scheduler": "gatekeeper-scheduler",
  "acme-gk-github": "gatekeeper-github",
};

/**
 * The Durable Object classes fixture Worker `name` stores objects of when its instance runs the
 * release the project is pinned to: the ones the migrations in its upstream package's
 * `wrangler.jsonc` create. None for a Worker the fixture instance does not have.
 */
export function pinnedDurableObjects(name: string): string[] {
  if (!Object.hasOwn(HOSTED_PACKAGES, name)) return [];
  const config = upstreamJsonc<ProdWranglerConfig>(`cloudflare-os/packages/${HOSTED_PACKAGES[name]}/wrangler.jsonc`);
  return [...migrationClasses(config.migrations ?? [])].toSorted();
}

/**
 * What Worker `name` of a hosted instance runs: one deployment sending all traffic to one version
 * the hosted flow uploaded, with the annotations, variables and bindings it sets. `handEdited` puts a
 * dashboard-made version live over it instead.
 */
export function hostedWorkerLive(name: string, options: HostedWorkerOptions = {}): WorkerLive {
  const release = options.release ?? HOSTED_RELEASE;
  const bindings: CfWorkerBinding[] = [
    ...(options.releaseVar === false ? [] : [{ name: "CLOUDFLARE_OS_RELEASE_ID", type: "plain_text", text: release }]),
    ...Object.entries(options.vars ?? {})
      .flatMap(([key, text]) => text === undefined ? [] : [{ name: key, type: "plain_text", text }]),
    ...Object.entries(options.json ?? {})
      .flatMap(([key, json]) => json === undefined ? [] : [{ name: key, type: "json", json }]),
    ...Object.entries(options.services ?? {})
      .flatMap(([key, service]) => service === undefined ? [] : [{ name: key, type: "service", service }]),
    ...(options.secrets ?? []).map((key) => ({ name: key, type: "secret_text" })),
  ];
  const uploaded: CfWorkerVersion = {
    id: fixtureVersionId(name),
    number: 1,
    created_on: "2026-10-01T09:00:00.000Z",
    source: "api",
    annotations: options.annotations ?? hostedAnnotations(release, options.operation),
    bindings,
    migration_tag: options.migrationTag ?? null,
  };
  const edited: CfWorkerVersion = {
    ...uploaded,
    id: fixtureVersionId(name, 2),
    number: 2,
    created_on: "2026-10-20T14:30:00.000Z",
    source: "dash",
    annotations: { "workers/triggered_by": "upload" },
  };
  const live = options.handEdited ? edited : uploaded;
  return {
    deployments: [{
      id: fixtureVersionId(`${name} deployment`, live.number),
      created_on: live.created_on,
      source: live.source,
      annotations: { "workers/triggered_by": "deployment" },
      versions: [{ version_id: live.id, percentage: 100 }],
    }],
    versions: options.handEdited ? [edited, uploaded] : [uploaded],
    durableObjects: options.durableObjects ?? pinnedDurableObjects(name),
  };
}

/**
 * What every Worker of {@link hostedAccount}'s instance "acme" runs, by Worker name: the router,
 * bound to its backend, the backend with everything the hosted flow sets on it (admins, providers, the public origin, its
 * Gatekeeper bindings, the push identity and the install description), and its three Gatekeepers.
 * No version reports a migration tag, and each Worker stores the Durable Object classes the pinned
 * upstream gives it. `overrides` change one Worker's options; `null` leaves that Worker with nothing
 * to read.
 */
export function hostedInstanceLive(overrides: Record<string, HostedWorkerOptions | null> = {}): Record<string, WorkerLive> {
  const backendRelease = overrides["acme-backend"]?.release ?? HOSTED_RELEASE;
  const defaults: Record<string, HostedWorkerOptions> = {
    acme: { services: { WORKSHOP_BACKEND: "acme-backend" } },
    "acme-backend": {
      vars: {
        PUBLIC_BASE_URL: "https://acme.acme-sub.workers.dev",
        CF_AI_GATEWAY_PROVIDERS: "cloudflare,anthropic",
        NOTIFICATION_SERVICE_URL: "https://push.example.com",
        NOTIFICATION_WEB_PUSH_PUBLIC_KEY: "BFixtureWebPushPublicKey",
        CFOS_INSTALL_ID: "install-acme",
        CFOS_INSTALL_KEY_ID: "key-1",
      },
      json: {
        ADMINS: ["admin@example.com"],
        CLOUDFLARE_OS_DEPLOYMENT: {
          releaseId: backendRelease,
          versionTag: hostedAnnotations(backendRelease)["workers/tag"],
          versionTagSuffix: `:${HOSTED_FINGERPRINT}`,
          updateUrl: "https://deploy.example.com/update/acme",
          updateCheckUrl: "https://deploy.example.com/check",
        },
      },
      services: {
        GATEKEEPER_CONTEXT: "acme-gk-context",
        GATEKEEPER_SCHEDULER: "acme-gk-scheduler",
        GATEKEEPER_GITHUB: "acme-gk-github",
      },
      secrets: ["CFOS_INSTALL_PRIVATE_KEY"],
    },
    "acme-gk-context": {},
    "acme-gk-scheduler": {},
    "acme-gk-github": { operation: "gk-github", secrets: ["CLIENT_ID", "CLIENT_SECRET"] },
  };
  const live: Record<string, WorkerLive> = {};
  for (const name of new Set([...Object.keys(defaults), ...Object.keys(overrides)])) {
    const override = overrides[name];
    if (override === null) continue;
    const base = defaults[name] ?? {};
    live[name] = hostedWorkerLive(name, {
      ...base,
      ...override,
      vars: { ...base.vars, ...override?.vars },
      json: { ...base.json, ...override?.json },
      services: { ...base.services, ...override?.services },
    });
  }
  return live;
}

/** {@link hostedAccount} with what each of its instance's Workers runs ({@link hostedInstanceLive}), as `cf` would print it. */
export function hostedAccountLive(overrides: Record<string, HostedWorkerOptions | null> = {}): Record<string, FakeReply> {
  const live = hostedInstanceLive(overrides);
  return {
    ...hostedAccount(),
    ...workerLiveReplies(live),
    "durable-objects namespaces list": durableObjectNamespacesReply(liveDurableObjects(live)),
  };
}

/** The Durable Object classes each Worker of `live` has a namespace for, by Worker name. */
function liveDurableObjects(live: Record<string, WorkerLive>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(live).map(([name, { durableObjects }]) => [name, durableObjects]));
}

/** {@link hostedAccountLive}'s account for the in-memory client. */
export function hostedMemoryAccount(overrides: Record<string, HostedWorkerOptions | null> = {}): MemoryAccount {
  const live = hostedInstanceLive(overrides);
  return {
    organization: { auth_domain: "acme-team.cloudflareaccess.com" },
    workers: [
      { name: "acme", subdomain: { enabled: true, url: "https://acme.acme-sub.workers.dev" } },
      { name: "acme-backend" },
      { name: "acme-gk-context" },
      { name: "acme-gk-scheduler" },
      { name: "acme-gk-github" },
      { name: "unrelated" },
    ],
    kvNamespaces: [
      { id: "kv-blueprints", title: "acme-blueprints" },
      { id: "kv-avatars", title: "acme-avatars" },
      { id: "kv-context", title: "acme-context-collections" },
    ],
    buckets: ["acme-blueprint-content"],
    gateways: [{ id: "default" }, { id: "acme-ai" }],
    accessApps: [
      { name: `Cloudflare OS acme ${HOSTED_FINGERPRINT}`, aud: "aud-acme", domain: "acme.acme-sub.workers.dev" },
    ],
    deployments: Object.fromEntries(Object.entries(live).map(([name, { deployments }]) => [name, deployments])),
    versions: Object.fromEntries(Object.entries(live).map(([name, { versions }]) => [name, versions])),
    durableObjectNamespaces: Object.entries(liveDurableObjects(live)).flatMap(([script, classes]) =>
      classes.map((name) => ({ id: `namespace-${script}-${name}`, script, class: name }))),
  };
}

/** One call a {@link recordingPinMove} stand-in took. */
export interface PinMoveCall {
  /** The commit asked for. */
  to: string;
  /** Whether it was a comparison only. */
  dryRun: boolean;
  /** The project root it was asked to move the pin of. */
  root: string;
  /** Whether it was handed a prompter, and so could ask before moving. */
  asks: boolean;
  /** The other commits the pin was to be held against, when any were given. */
  atLeast?: string[];
}

/**
 * A stand-in for `movePin` (commands/update.ts), which a take-over holds the project's pin against
 * the instance's release with: it records each call, runs `then` (a place to look at the project
 * as it is when the pin is moved), and answers `outcome`, or by default that the pin is the commit
 * asked for. Nothing runs git, so nothing reaches a repository or upstream.
 */
export function recordingPinMove(
  outcome?: PinMove | ((call: PinMoveCall) => PinMove),
  then?: (call: PinMoveCall) => void,
): {
  move: (to: string, ctx: Context, options?: { dryRun?: boolean; atLeast?: readonly string[] }) => Promise<PinMove>;
  calls: PinMoveCall[];
} {
  const calls: PinMoveCall[] = [];
  return {
    calls,
    move: async (to, ctx, { dryRun = false, atLeast = [] } = {}) => {
      const call: PinMoveCall = {
        to, dryRun, root: ctx.root, asks: ctx.prompter !== null, ...atLeast.length ? { atLeast: [...atLeast] } : {},
      };
      calls.push(call);
      then?.(call);
      if (typeof outcome === "function") return outcome(call);
      return outcome ?? { status: "current", path: "cloudflare-os", from: to, to, past: false };
    },
  };
}
