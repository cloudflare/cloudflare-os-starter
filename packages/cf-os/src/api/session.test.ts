import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { table as realTable } from "./generated/commands.ts";
import {
  accessToken,
  connect,
  passwordHash,
  resolveAuth,
  resolveTarget,
  webSocketConnection,
  type SessionDeps,
  type SpawnCloudflared,
} from "./session.ts";
import { callsOf, fixtureRoot, messagePortServer, serverLog, type FixtureOptions } from "./test-server.ts";
import { scratchProject, testContext } from "../test-support.ts";

const SALT = [1, 2, 254, 255];

test("--url is the instance's origin: wss:// for https, ws:// only for an explicit http://", async (t) => {
  const { ctx } = testContext({ root: scratchProject(t, "{}") });
  assert.deepEqual(await resolveTarget("https://os.example.com/some/path", ctx), { origin: "https://os.example.com", url: "wss://os.example.com/api" });
  assert.deepEqual(await resolveTarget("http://localhost:8787", ctx), { origin: "http://localhost:8787", url: "ws://localhost:8787/api" });
  await assert.rejects(resolveTarget("ftp://os.example.com", ctx), /must be an https:\/\/ origin/);
  await assert.rejects(resolveTarget("os.example.com", ctx), /is not a URL/);
});

test("without --url, the origin is the deployment file's, --config honoured", async (t) => {
  const root = scratchProject(t, `{
    // Comments are fine: it is the deployment file.
    "publicBaseUrl": null,
    "workers": { "router": { "name": "r", "route": { "customDomain": "os.example.com" } } },
  }`);
  assert.deepEqual(await resolveTarget(undefined, testContext({ root }).ctx), { origin: "https://os.example.com", url: "wss://os.example.com/api" });
  writeFileSync(join(root, "other.jsonc"), `{ "publicBaseUrl": "https://r.sub.workers.dev", "workers": { "router": { "name": "r", "route": { "workersDev": true } } } }`);
  const other = testContext({ root, flags: { config: "other.jsonc" } }).ctx;
  assert.deepEqual(await resolveTarget(undefined, other), { origin: "https://r.sub.workers.dev", url: "wss://r.sub.workers.dev/api" });

  writeFileSync(join(root, "template.jsonc"), `{ "publicBaseUrl": null, "workers": { "router": { "name": "r", "route": { "customDomain": "<HOST>" } } } }`);
  await assert.rejects(resolveTarget(undefined, testContext({ root, flags: { config: "template.jsonc" } }).ctx), /not configured yet.*pass --url/);
  await assert.rejects(resolveTarget(undefined, testContext({ root, flags: { config: "missing.jsonc" } }).ctx), /could not read missing\.jsonc \(ENOENT\): pass --url/);

  // Only an explicit --url may be http:// (ws://, and an Access token in plain text) or carry a path.
  for (const origin of ["http://os.example.com", "https://os.example.com/app", "https://OS.example.com"]) {
    writeFileSync(join(root, "bad.jsonc"), JSON.stringify({ publicBaseUrl: origin, workers: { router: { name: "r", route: { workersDev: true } } } }));
    await assert.rejects(resolveTarget(undefined, testContext({ root, flags: { config: "bad.jsonc" } }).ctx),
      /is not an https:\/\/ origin: fix publicBaseUrl, or pass --url/, origin);
  }
});

test("the sign-in is --auth, else a password for --username, a token for CFOS_API_TOKEN, else Access over https", () => {
  const https = "https://os.example.com";
  assert.deepEqual(resolveAuth({}, {}, https), { mode: "access" });
  assert.deepEqual(resolveAuth({}, { CFOS_API_TOKEN: "t" }, https), { mode: "token" });
  assert.deepEqual(resolveAuth({ username: "alice" }, { CFOS_API_TOKEN: "t" }, https), { mode: "password", username: "alice" });
  assert.deepEqual(resolveAuth({ auth: "access" }, { CFOS_API_TOKEN: "t" }, https), { mode: "access" });
  assert.throws(() => resolveAuth({ auth: "oauth" }, {}, https), /--auth must be one of access, token, password/);
  assert.throws(() => resolveAuth({ auth: "password" }, {}, https), /needs --username/);
  assert.throws(() => resolveAuth({ auth: "token", username: "alice" }, {}, https), /--username is for --auth password/);
  // Access never fronts a dev server, and its token is not for a plain-text origin.
  const http = "http://localhost:8787";
  assert.deepEqual(resolveAuth({}, {}, http), { mode: "token" });
  assert.deepEqual(resolveAuth({ username: "alice" }, {}, http), { mode: "password", username: "alice" });
  assert.throws(() => resolveAuth({ auth: "access" }, {}, http), /plain text; Access fronts https:\/\/ origins only/);
});

test("the password hash is the frontend's argon2id over SERVICE_SALT ++ the username", async () => {
  // Computed once with hash-wasm's argon2id: password "correct horse", salt the pinned upstream's
  // SERVICE_SALT followed by utf8("alice"), parallelism 1, 3 iterations, 64 MiB, 32 bytes.
  const hash = await passwordHash("alice", "correct horse", realTable.constants.SERVICE_SALT);
  assert.equal(Buffer.from(hash).toString("hex"), "53ecb1a9a75da3f7e034e02d429f26482da87fd75c5fd967bac332a6ae6ac093");
});

test("the Access token comes from CF_ACCESS_TOKEN, else cloudflared, spawned without a shell", () => {
  const calls: { command: string; args: string[]; options: object }[] = [];
  const spawn = (reply: ReturnType<SpawnCloudflared>): SpawnCloudflared => (command, args, options) => {
    calls.push({ command, args, options });
    return reply;
  };
  const ok = spawn({ status: 0, stdout: "aaa.bbb.ccc\n", stderr: "" });
  assert.equal(accessToken("https://os.example.com", { env: { CF_ACCESS_TOKEN: "env.token.value" }, spawn: ok }), "env.token.value");
  assert.equal(calls.length, 0);
  assert.equal(accessToken("https://os.example.com", { env: {}, spawn: ok }), "aaa.bbb.ccc");
  assert.equal(calls[0].command, "cloudflared");
  assert.deepEqual(calls[0].args, ["access", "token", "-app=https://os.example.com"]);
  assert.equal("shell" in calls[0].options, false);

  assert.throws(
    () => accessToken("https://os.example.com", { env: {}, spawn: spawn({ status: 1, stdout: "", stderr: "Unable to find token" }) }),
    /Unable to find token\. Run `cloudflared access login https:\/\/os\.example\.com`/);
  const missing = spawn({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" }) });
  assert.throws(() => accessToken("https://os.example.com", { env: {}, spawn: missing }),
    /cloudflared could not run \(spawn cloudflared ENOENT\)\. Run `cloudflared access login https:\/\/os\.example\.com`/);

  // Neither a malformed CF_ACCESS_TOKEN nor what cloudflared printed instead of a token is repeated.
  const pasted = "eyJhbGc.SECRETPAYLOAD.sig\nsecond-line";
  assert.throws(() => accessToken("https://os.example.com", { env: { CF_ACCESS_TOKEN: pasted }, spawn: ok }),
    (error: Error) => /CF_ACCESS_TOKEN is not an Access token/.test(error.message) && !error.message.includes("SECRET"));
  const noisy = spawn({ status: 0, stdout: "eyJhbGc.SECRETPAYLOAD.sig trailing\n", stderr: "" });
  assert.throws(() => accessToken("https://os.example.com", { env: {}, spawn: noisy }),
    (error: Error) => /cloudflared printed no token/.test(error.message) && !error.message.includes("SECRET"));
});

function sessionDeps(t: { after: (fn: () => void) => void }, env: NodeJS.ProcessEnv, options: FixtureOptions = {}) {
  const log = serverLog();
  const server = messagePortServer(log, () => fixtureRoot(log, options));
  t.after(() => server.close());
  const spawned: string[][] = [];
  const deps: SessionDeps = {
    env,
    open: server.open,
    spawn: (command, args) => {
      spawned.push([command, ...args]);
      return { status: 0, stdout: "from.cloudflared.token\n", stderr: "" };
    },
    fetch: async () => assert.fail("fetched with the connection open"),
  };
  return { log, deps, spawned };
}

const target = { origin: "https://os.example.com", url: "wss://os.example.com/api" };

test("Access mode sends Origin and cf-access-token, then authenticateFromCfAccess", async (t) => {
  const { log, deps, spawned } = sessionDeps(t, {});
  const session = await connect(target, { mode: "access" }, { serviceSalt: SALT, needsSignIn: true }, deps);
  const { api } = await session.authenticate();
  assert.deepEqual(await api.findNotes("q"), [{ id: 1, title: "q" }]);
  api[Symbol.dispose]();
  session.main[Symbol.dispose]();
  assert.deepEqual(log.headers, [{ Origin: "https://os.example.com", "cf-access-token": "from.cloudflared.token" }]);
  assert.deepEqual(spawned, [["cloudflared", "access", "token", "-app=https://os.example.com"]]);
  assert.deepEqual(callsOf(log, "authenticateFromCfAccess"), [[]]);
  assert.deepEqual(callsOf(log, "authenticate"), []);
});

test("token mode authenticates with CFOS_API_TOKEN; a public chain needs no token", async (t) => {
  const { log, deps, spawned } = sessionDeps(t, { CFOS_API_TOKEN: "good-token" });
  const session = await connect(target, { mode: "token" }, { serviceSalt: SALT, needsSignIn: true }, deps);
  const { api } = await session.authenticate();
  assert.deepEqual(await api.findNotes("q"), [{ id: 1, title: "q" }]);
  session.main[Symbol.dispose]();
  assert.deepEqual(log.headers, [{ Origin: "https://os.example.com" }]);
  assert.deepEqual(callsOf(log, "authenticate"), [["good-token"]]);
  assert.deepEqual(spawned, []);

  const bare = sessionDeps(t, {});
  await assert.rejects(connect(target, { mode: "token" }, { serviceSalt: SALT, needsSignIn: true }, bare.deps), /reads the secret from CFOS_API_TOKEN/);
  const publicSession = await connect(target, { mode: "token" }, { serviceSalt: SALT, needsSignIn: false }, bare.deps);
  await publicSession.main.ping();
  publicSession.main[Symbol.dispose]();
});

test("password mode logs in with the argon2id hash, then authenticates with the token it returns", async (t) => {
  const hashHex = Buffer.from(await passwordHash("alice", "s3cret", SALT)).toString("hex");
  const { log, deps } = sessionDeps(t, { CFOS_API_PASSWORD: "s3cret" }, { login: { username: "alice", hashHex } });
  const session = await connect(target, { mode: "password", username: "alice" }, { serviceSalt: SALT, needsSignIn: true }, deps);
  const { api } = await session.authenticate();
  assert.deepEqual(await api.findNotes("q"), [{ id: 1, title: "q" }]);
  session.main[Symbol.dispose]();
  assert.deepEqual(callsOf(log, "login"), [["alice", hashHex]]);
  assert.deepEqual(callsOf(log, "authenticate"), [["good-token"]]);

  const wrong = sessionDeps(t, { CFOS_API_PASSWORD: "guess" }, { login: { username: "alice", hashHex } });
  const refused = await connect(target, { mode: "password", username: "alice" }, { serviceSalt: SALT, needsSignIn: true }, wrong.deps);
  await assert.rejects(refused.authenticate(), /wrong username or password for alice/);
  refused.main[Symbol.dispose]();
  assert.deepEqual(callsOf(wrong.log, "authenticate"), []);
});

/**
 * A local server refusing every WebSocket upgrade, recording its headers, and answering plain
 * requests with `status` (and `location`), as Access's edge answers an unauthenticated request.
 */
async function refusingServer(t: { after: (fn: () => void) => void }, status: number, location?: string) {
  const upgrades: IncomingHttpHeaders[] = [];
  const requests: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    requests.push(request.headers);
    response.writeHead(status, location ? { location } : {}).end();
  });
  server.on("upgrade", (request, socket) => {
    upgrades.push(request.headers);
    socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, upgrades, requests };
}

test("a refused WebSocket is diagnosed over HTTP: Access's login names cloudflared access login", async (t) => {
  const { origin, upgrades, requests } = await refusingServer(t, 302, "https://team.cloudflareaccess.com/cdn-cgi/access/login/os");
  const local = { origin, url: `${origin.replace("http:", "ws:")}/api` };
  const deps: SessionDeps = {
    env: { CF_ACCESS_TOKEN: "env.access.token" },
    open: webSocketConnection,
    spawn: () => assert.fail("spawned cloudflared with CF_ACCESS_TOKEN set"),
    fetch,
  };
  const session = await connect(local, { mode: "access" }, { serviceSalt: SALT, needsSignIn: true }, deps);
  const failure = await (await session.authenticate()).api.then(() => assert.fail("connected"), (error: unknown) => error);
  const explained = await session.explain(failure) as Error;
  session.main[Symbol.dispose]();
  assert.match(explained.message, new RegExp(`redirected to Cloudflare Access's login: run \`cloudflared access login ${origin}\``));
  assert.equal(upgrades[0].origin, origin);
  assert.equal(upgrades[0]["cf-access-token"], "env.access.token");
  assert.equal(requests[0]["cf-access-token"], "env.access.token");
});

test("a 401 for a token sign-in names the token, not cloudflared", async (t) => {
  const { origin } = await refusingServer(t, 401);
  const local = { origin, url: `${origin.replace("http:", "ws:")}/api` };
  const deps: SessionDeps = { env: { CFOS_API_TOKEN: "t" }, open: webSocketConnection, spawn: () => assert.fail("spawned"), fetch };
  const session = await connect(local, { mode: "token" }, { serviceSalt: SALT, needsSignIn: true }, deps);
  const failure = await (await session.authenticate()).api.then(() => assert.fail("connected"), (error: unknown) => error);
  const explained = await session.explain(failure) as Error;
  session.main[Symbol.dispose]();
  assert.match(explained.message, /refused with HTTP 401: check CFOS_API_TOKEN/);
  assert.doesNotMatch(explained.message, /cloudflared/);
});
