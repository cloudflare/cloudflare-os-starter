import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DELEGATION_SENTINEL } from "../project.ts";
import { apiCliProject as stubProject, scratchProject, testContext } from "../test-support.ts";
import { childEnv, defaultInstance, run } from "./api.ts";

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const MAIN = join(SRC, "main.ts");
/** This repository: a project whose submodule holds the real CLI. */
const REPOSITORY = resolve(SRC, "..", "..", "..");

/** A deployment file whose public origin is `origin`. */
const deployment = (origin: string | null, customDomain: string | null = "os.example.com") => JSON.stringify({
  publicBaseUrl: origin,
  workers: { router: { name: "acme-os", route: customDomain ? { customDomain } : { workersDev: true } } },
});

test("the default instance is the deployment's https:// origin, honouring --config", async (t) => {
  const root = scratchProject(t, deployment(null));
  writeFileSync(join(root, "other.jsonc"), deployment("https://other.example.com/"));
  assert.deepEqual(await defaultInstance(testContext({ root }).ctx), { url: "https://os.example.com" });
  assert.deepEqual(await defaultInstance(testContext({ root, flags: { config: "other.jsonc" } }).ctx),
    { url: "https://other.example.com" });
});

test("without one, the reason is a complete message naming --url", async (t) => {
  const root = scratchProject(t, deployment(null));
  const reasons: [string, string, RegExp][] = [
    ["placeholder.jsonc", deployment("https://<your-domain>"),
      /^placeholder\.jsonc is not configured yet \(https:\/\/<your-domain>\): pass --url <origin>\.$/],
    ["none.jsonc", deployment(null, null),
      /^none\.jsonc names no public origin \(publicBaseUrl or workers\.router\.route\.customDomain\): pass --url <origin>\.$/],
    ["http.jsonc", deployment("http://os.example.com"),
      /^http\.jsonc's public origin, http:\/\/os\.example\.com, is not an https:\/\/ origin: fix publicBaseUrl, or pass --url <origin>\.$/],
    ["path.jsonc", deployment("https://os.example.com/os"),
      /^path\.jsonc's public origin, https:\/\/os\.example\.com\/os, is not an https:\/\/ origin: fix publicBaseUrl, or pass --url <origin>\.$/],
    ["number.jsonc", JSON.stringify({ publicBaseUrl: 42 }),
      /^number\.jsonc's publicBaseUrl is not a string: fix publicBaseUrl, or pass --url <origin>\.$/],
    ["broken.jsonc", "{ nope",
      /^broken\.jsonc: \w+ at offset \d+: fix it, or pass --url <origin>\.$/],
  ];
  for (const [file, text, reason] of reasons) {
    writeFileSync(join(root, file), text);
    const instance = await defaultInstance(testContext({ root, flags: { config: file } }).ctx);
    assert.ok("unavailable" in instance, file);
    assert.match(instance.unavailable, reason);
  }
  const missing = await defaultInstance(testContext({ root, flags: { config: "missing.jsonc" } }).ctx);
  assert.deepEqual(missing, { unavailable: "could not read missing.jsonc (ENOENT): pass --url <origin>, or --config <path>." });
});

test("the CLI gets exactly one of the two variables, the other deleted even when inherited", () => {
  const inherited = { PATH: "/bin", CFOS_API_URL: "https://shell.example.com", CFOS_API_URL_UNAVAILABLE: "stale" };
  assert.deepEqual(childEnv(inherited, { url: "https://os.example.com" }), { PATH: "/bin", CFOS_API_URL: "https://os.example.com" });
  assert.deepEqual(childEnv(inherited, { unavailable: "why" }), { PATH: "/bin", CFOS_API_URL_UNAVAILABLE: "why" });
});

test("runs the pinned CLI with its tokens after `api`, in the directory the command was typed in", async (t) => {
  const { root, report } = stubProject(t);
  const cwd = join(root, "docs");
  mkdirSync(cwd);
  const { ctx } = testContext({ root, cwd });
  const env = { ...process.env, CFOS_API_URL_UNAVAILABLE: "inherited" };
  const code = await run({ command: "api", values: {}, positionals: ["open-gadget", "g1", "--", "--config"] }, ctx, { env });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), {
    argv: ["api", "open-gadget", "g1", "--", "--config"],
    cwd: realpathSync(cwd),
    CFOS_API_URL: "https://os.example.com",
    CFOS_API_URL_UNAVAILABLE: "(unset)",
  });
});

test("an unconfigured deployment sends the reason, with any inherited CFOS_API_URL deleted", async (t) => {
  const { root, report } = stubProject(t, deployment("https://<your-domain>"));
  const env = { ...process.env, CFOS_API_URL: "https://shell.example.com" };
  assert.equal(await run({ command: "api", values: {}, positionals: ["whoami"] }, testContext({ root }).ctx, { env }), 0);
  const seen = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(seen.CFOS_API_URL, "(unset)");
  assert.equal(seen.CFOS_API_URL_UNAVAILABLE, "deployment.jsonc is not configured yet (https://<your-domain>): pass --url <origin>.");
});

test("passes the CLI's exit code through", async (t) => {
  const { root } = stubProject(t);
  for (const status of [0, 1, 2, 130]) {
    const env = { ...process.env, STUB_EXIT: String(status) };
    assert.equal(await run({ command: "api", values: {}, positionals: [] }, testContext({ root }).ctx, { env }), status);
  }
});

test("names `cf-os update` for a pin without the CLI, and the install for an uninstalled one", async (t) => {
  const { root } = stubProject(t);
  rmSync(join(root, "cloudflare-os", "packages"), { recursive: true });
  const old = testContext({ root });
  assert.equal(await run({ command: "api", values: {}, positionals: ["whoami"] }, old.ctx), 1);
  assert.match(old.stderr(), /^The cloudflare-os pin predates `cf-os api` upstream: it has no cloudflare-os.packages.api-cli.src.main\.ts\. /);
  assert.match(old.stderr(), /`cf-os update`/);

  const stale = stubProject(t);
  writeFileSync(join(stale.root, "cloudflare-os", "pnpm-lock.yaml"), "lockfileVersion: '9.1'\n");
  const uninstalled = testContext({ root: stale.root });
  assert.equal(await run({ command: "api", values: {}, positionals: ["whoami"] }, uninstalled.ctx), 1);
  assert.match(uninstalled.stderr(), /cloudflare-os\/node_modules is stale\. Run `pnpm cf-os install`\.$/);
  assert.ok(!existsSync(stale.report), "the CLI ran");

  const empty = testContext({ root: scratchProject(t, deployment(null)) });
  assert.equal(await run({ command: "api", values: {}, positionals: ["whoami"] }, empty.ctx), 1);
  assert.match(empty.stderr(), /submodule is not checked out/);
});

test("stays alive while the CLI runs, passing a SIGTERM on and exiting with its code", { skip: process.platform === "win32" }, async (t) => {
  const { root } = stubProject(t);
  const ready = join(root, "ready");
  const parent = spawn(process.execPath, [MAIN, "api", "whoami"], {
    cwd: root, stdio: "ignore", env: { ...process.env, [DELEGATION_SENTINEL]: "1", STUB_WAIT: "1" },
  });
  const exited = new Promise<number | null>((done) => parent.once("exit", (code) => done(code)));
  for (let waited = 0; !existsSync(ready) && waited < 15000; waited += 50) await new Promise((done) => setTimeout(done, 50));
  assert.ok(existsSync(ready), "the CLI never started");
  parent.kill("SIGTERM");
  assert.equal(await exited, 7);
});

/** `text` as one line: help wraps its lines. */
const flat = (text: string) => text.replace(/\s+/g, " ");

/** `cf-os api <argv>` in this repository, against its pinned CLI, as a real process. */
function realApi(argv: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [MAIN, "api", ...argv], {
    cwd: REPOSITORY, encoding: "utf8", timeout: 60000,
    env: { ...process.env, [DELEGATION_SENTINEL]: "1", CFOS_API_URL: "https://shell.example.com", ...env },
  });
}

test("end to end against the pinned CLI: search, types, help and --dry-run connect to nothing", async (t) => {
  const dir = scratchProject(t, deployment(null));
  const configured = join(dir, "deployment.jsonc");
  const unconfigured = join(dir, "unconfigured.jsonc");
  writeFileSync(unconfigured, deployment("https://<your-domain>"));

  const search = realApi(["search", "list chats"]);
  assert.equal(search.status, 0, search.stderr);
  const matches = JSON.parse(search.stdout) as { command: string }[];
  assert.ok(matches.length > 0 && matches.every((match) => match.command.startsWith("cf-os api ")), search.stdout);

  const types = realApi(["types", "Overseer"]);
  assert.equal(types.status, 0, types.stderr);
  assert.match(types.stdout, /\bOverseer\b/);

  const help = realApi(["--config", configured, "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(flat(help.stdout), /default: https:\/\/os\.example\.com, from CFOS_API_URL/);
  const reasoned = realApi(["--help", "--config", unconfigured]);
  assert.equal(reasoned.status, 0, reasoned.stderr);
  assert.match(flat(reasoned.stdout), /unconfigured\.jsonc is not configured yet \(https:\/\/<your-domain>\): pass --url <origin>\./);

  // The deployment's origin, not the shell's CFOS_API_URL.
  const dryRun = realApi(["whoami", "--dry-run", "--config", configured, "--profile", "p"]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).url, "wss://os.example.com/api");
  const none = realApi(["whoami", "--dry-run", "--config", unconfigured]);
  assert.equal(none.status, 2, none.stderr);
  assert.match(none.stderr, /unconfigured\.jsonc is not configured yet \(https:\/\/<your-domain>\): pass --url <origin>\./);
});
