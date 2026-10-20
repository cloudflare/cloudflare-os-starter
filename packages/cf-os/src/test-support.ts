// Shared fixtures for the command suites: a scripted prompter, a context that captures output, and
// scratch project directories. Test support only; not part of the build.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import type { Context, GlobalFlags, Output } from "./context.ts";
import type { CloudflareClient } from "./core/client.ts";
import type { ProdWranglerConfig } from "./core/deployment-config.ts";
import type { GatekeeperCatalog } from "./core/gatekeepers.ts";
import type { FakeReply } from "./fake-cf.ts";
import { Back, Cancelled, type Choice, type Prompter } from "./prompt.ts";

/** Accept whatever the prompt offers as its default. */
export const DEFAULT = Symbol("default");

/** Cancel the prompt, as Ctrl-C would. */
export const CANCEL = Symbol("cancel");

/** Press Esc, to go back a question: only on the {@link Prompter.backable} view. */
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
 * script fails the test -- so a script is also an assertion about what was asked. A password answer
 * the validation refuses is asked again, as the terminal does, from the next step; the record never
 * holds a password answer. Its {@link Prompter.backable} view answers from the same script, and only
 * there may a step answer {@link BACK}.
 */
export function scriptedPrompter(script: Step[]): Prompter & { asked: Asked[]; remaining: () => Step[] } {
  const steps = [...script];
  const asked: Asked[] = [];
  return { asked, remaining: () => steps, ...scriptedView(steps, asked, false) };
}

function scriptedView(steps: Step[], asked: Asked[], backable: boolean): Prompter {
  const next = (record: Asked): unknown => {
    if (backable) record.backable = true;
    asked.push(record);
    const step = steps.shift();
    assert.ok(step, `unexpected prompt: ${record.message}`);
    const [expected, answer] = step;
    if (typeof expected === "string") assert.ok(record.message.includes(expected), `expected a prompt about "${expected}", got "${record.message}"`);
    else assert.match(record.message, expected);
    if (answer === CANCEL) throw new Cancelled();
    if (answer === BACK) {
      assert.ok(backable, `Esc goes back only where a command lets you: "${record.message}"`);
      throw new Back();
    }
    return answer === DEFAULT ? record.initial : answer;
  };
  return {
    backable: () => scriptedView(steps, asked, true),
    async select(message, choices, initial) {
      const answer = next({ kind: "select", message, ...describeChoices(choices), initial }) as string;
      assert.ok(choices.some((choice) => choice.value === answer), `"${answer}" is not a choice for "${message}"`);
      return answer as never;
    },
    async multiselect(message, choices, initial, { required = true } = {}) {
      const answer = next({ kind: "multiselect", message, ...describeChoices(choices), initial, required });
      assert.ok(Array.isArray(answer), `"${message}" takes a list`);
      for (const value of answer) {
        assert.ok(choices.some((choice) => choice.value === value), `"${value}" is not a choice for "${message}"`);
      }
      assert.ok(!required || answer.length, `"${message}" needs at least one choice`);
      return answer as never;
    },
    async text(message, { initial, validate } = {}) {
      const answer = String(next({ kind: "text", message, initial }) ?? "");
      const problem = validate?.(answer);
      assert.equal(problem, undefined, `"${answer}" fails "${message}": ${problem}`);
      return answer;
    },
    async password(message, { validate } = {}) {
      for (;;) {
        const record: Asked = { kind: "password", message };
        const answer = String(next(record) ?? "");
        const problem = validate?.(answer);
        if (problem === undefined) return answer;
        record.refused = problem;
      }
    },
    async confirm(message, initial = true) {
      return next({ kind: "confirm", message, initial }) as boolean;
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
