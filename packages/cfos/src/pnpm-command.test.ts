import assert from "node:assert/strict";
import test from "node:test";
import { pnpmCommand } from "./pnpm-command.ts";

const NPM_CLI = "C:\\nvm4w\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
const PNPM_MJS = "C:\\nvm4w\\nodejs\\node_modules\\pnpm\\bin\\pnpm.mjs";

/** An `exists` that knows only `paths`. */
function only(...paths: string[]): (path: string) => boolean {
  return (path) => paths.includes(path);
}

test("under pnpm run, uses the entry npm_execpath names", () => {
  const env = { npm_execpath: PNPM_MJS, Path: "C:\\elsewhere" };
  assert.deepEqual(pnpmCommand(["build"], env, "win32", only()), [process.execPath, [PNPM_MJS, "build"]]);
});

test("under npx on Windows, finds the entry beside the pnpm.cmd shim on PATH", () => {
  // As `npx @maximoguk/cfos init` runs it: npm_execpath is npm's, and Node keeps `Path`'s case.
  const env = { npm_execpath: NPM_CLI, Path: "C:\\Windows\\system32;C:\\nvm4w\\nodejs" };
  const exists = only("C:\\nvm4w\\nodejs\\pnpm.cmd", PNPM_MJS);
  assert.deepEqual(pnpmCommand(["exec", "vp"], env, "win32", exists), [process.execPath, [PNPM_MJS, "exec", "vp"]]);
});

test("finds Corepack's entry beside its shim", () => {
  const corepack = "C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\pnpm.js";
  const exists = only("C:\\Program Files\\nodejs\\pnpm.cmd", corepack);
  assert.deepEqual(pnpmCommand(["test"], { PATH: "C:\\Program Files\\nodejs" }, "win32", exists),
    [process.execPath, [corepack, "test"]]);
});

test("keeps the bare pnpm with no shim, or a shim in an unknown layout", () => {
  const env = { Path: "C:\\tools" };
  assert.deepEqual(pnpmCommand(["test"], env, "win32", only()), ["pnpm", ["test"]]);
  assert.deepEqual(pnpmCommand(["test"], env, "win32", only("C:\\tools\\pnpm.cmd")), ["pnpm", ["test"]]);
});

test("off Windows, pnpm is on PATH as itself", () => {
  const exists = only("/usr/bin/pnpm.cmd", "/usr/bin/node_modules/pnpm/bin/pnpm.mjs");
  assert.deepEqual(pnpmCommand(["test"], { PATH: "/usr/bin" }, "linux", exists), ["pnpm", ["test"]]);
});
