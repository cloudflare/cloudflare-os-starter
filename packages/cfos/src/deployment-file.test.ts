import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyDeploymentEdits,
  parseDeployment,
  updateDeployment,
  valueAtPath,
} from "./deployment-file.ts";

const ANNOTATED = `{
  // Account comment.
  "accountId": "<CLOUDFLARE_ACCOUNT_ID>",
  "workers": {
    // Router comment.
    "router": { "name": "<ROUTER>", "route": { "customDomain": "os.example.com" } },
  },
  "context": {
    "kvNamespaceId": null

    // "artifacts": { "enabled": true }
  }
}
`;

test("sets values in place and keeps every comment", () => {
  const edited = applyDeploymentEdits(ANNOTATED, [
    { path: ["accountId"], value: "0123456789abcdef0123456789abcdef" },
    { path: ["workers", "router", "name"], value: "acme" },
    { path: ["workers", "router", "route"], value: { workersDev: true } },
    { path: ["context", "kvNamespaceId"], value: "kv-id" },
  ]);
  for (const comment of ["// Account comment.", "// Router comment.", '// "artifacts": { "enabled": true }']) {
    assert.ok(edited.includes(comment), `lost ${comment}`);
  }
  const parsed = parseDeployment(edited);
  assert.equal(valueAtPath(parsed, ["accountId"]), "0123456789abcdef0123456789abcdef");
  assert.equal(valueAtPath(parsed, ["workers", "router", "name"]), "acme");
  assert.deepEqual(valueAtPath(parsed, ["workers", "router", "route"]), { workersDev: true });
  assert.equal(valueAtPath(parsed, ["context", "kvNamespaceId"]), "kv-id");
});

test("adds a key that is not there yet", () => {
  const edited = applyDeploymentEdits(ANNOTATED, [{ path: ["workers", "websearch", "name"], value: "acme-gk-websearch" }]);
  assert.equal(valueAtPath(parseDeployment(edited), ["workers", "websearch", "name"]), "acme-gk-websearch");
});

test("refuses to edit a file that does not parse", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "deployment-file-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "deployment.jsonc");
  writeFileSync(path, '{ "accountId": ');
  return assert.rejects(
    updateDeployment(path, [{ path: ["accountId"], value: "x" }]),
    /deployment\.jsonc: /,
  ).then(() => assert.equal(readFileSync(path, "utf8"), '{ "accountId": '));
});

test("updates the file on disk", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "deployment-file-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "deployment.jsonc");
  writeFileSync(path, ANNOTATED);
  await updateDeployment(path, [{ path: ["accountId"], value: "abc" }]);
  const text = readFileSync(path, "utf8");
  assert.ok(text.includes("// Account comment."));
  assert.equal(valueAtPath(parseDeployment(text), ["accountId"]), "abc");
});
