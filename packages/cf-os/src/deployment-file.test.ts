import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validatePushIdentity } from "./core/deployment-config.ts";
import { PUSH_IDENTITY_PATH, pushIdentityEdit } from "./core/edits.ts";
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

test("creates and removes nested gatekeepers entries, comments intact", () => {
  const withGatekeepers = ANNOTATED.replace('  "context": {', `  // Gatekeepers comment.
  "gatekeepers": {},
  "context": {`);
  const added = applyDeploymentEdits(withGatekeepers, [
    { path: ["gatekeepers", "github", "name"], value: "acme-gk-github" },
    { path: ["gatekeepers", "mcpportal", "name"], value: "acme-gk-mcpportal" },
  ]);
  assert.deepEqual(valueAtPath(parseDeployment(added), ["gatekeepers"]), {
    github: { name: "acme-gk-github" },
    mcpportal: { name: "acme-gk-mcpportal" },
  });
  // Vars added by hand survive a name edit, and an undefined value removes the whole entry.
  const handEdited = added.replace('"name": "acme-gk-mcpportal"',
    '"name": "acme-gk-mcpportal",\n      // Portal comment.\n      "vars": { "MCP_PORTAL_URL": "https://portal.example.com/mcp" }');
  const edited = applyDeploymentEdits(handEdited, [
    { path: ["gatekeepers", "mcpportal", "name"], value: "acme-gk-portal" },
    { path: ["gatekeepers", "github"], value: undefined },
  ]);
  assert.deepEqual(valueAtPath(parseDeployment(edited), ["gatekeepers"]), {
    mcpportal: { name: "acme-gk-portal", vars: { MCP_PORTAL_URL: "https://portal.example.com/mcp" } },
  });
  for (const comment of ["// Account comment.", "// Router comment.", "// Gatekeepers comment.", "// Portal comment."]) {
    assert.ok(edited.includes(comment), `lost ${comment}`);
  }
  // Removing the last one leaves the empty block, not a missing one.
  const emptied = applyDeploymentEdits(edited, [{ path: ["gatekeepers", "mcpportal"], value: undefined }]);
  assert.deepEqual(valueAtPath(parseDeployment(emptied), ["gatekeepers"]), {});
  // Into a file that has no gatekeepers block yet, the block is created.
  const created = applyDeploymentEdits(ANNOTATED, [{ path: ["gatekeepers", "github", "name"], value: "acme-gk-github" }]);
  assert.deepEqual(valueAtPath(parseDeployment(created), ["gatekeepers"]), { github: { name: "acme-gk-github" } });
  assert.ok(created.includes("// Router comment."));
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

test("writes a take-over's push identity where the template holds null, whole, and as the deploy validates it", async () => {
  const template = await readFile(join(import.meta.dirname, "..", "..", "..", "deployment.jsonc"), "utf8")
    .catch(() => null);
  const annotated = ANNOTATED.replace(/\n\}\n$/, `,

  // Push comment.
  "pushIdentity": null
}
`);
  const push = { serviceUrl: "https://push.example.com", installId: "install-acme", keyId: "key-1", webPushPublicKey: null };
  const path = [...PUSH_IDENTITY_PATH];
  const written = applyDeploymentEdits(annotated, [pushIdentityEdit(push)]);
  assert.deepEqual(valueAtPath(parseDeployment(written), path), push);
  for (const comment of ["// Account comment.", "// Router comment.", "// Push comment."]) {
    assert.ok(written.includes(comment), `lost ${comment}`);
  }
  // In the key's place, under its comment, not appended somewhere else.
  assert.match(written, /\/\/ Push comment\.\n {2}"pushIdentity": \{/);
  assert.doesNotThrow(() => validatePushIdentity(valueAtPath(parseDeployment(written), path)));

  // A second take-over writes the block whole: no field of the first identity outlives it.
  const first = written.replace('"keyId": "key-1"', '"keyId": "key-1",\n    "left": "over"');
  assert.equal(valueAtPath(parseDeployment(first), [...path, "left"]), "over");
  const next = { ...push, installId: "install-other", webPushPublicKey: "BFixtureWebPushPublicKey" };
  const replaced = applyDeploymentEdits(first, [pushIdentityEdit(next)]);
  assert.deepEqual(valueAtPath(parseDeployment(replaced), path), next);
  assert.doesNotThrow(() => validatePushIdentity(valueAtPath(parseDeployment(replaced), path)));

  // Into a file without the key, the block is added, and it still parses.
  const added = applyDeploymentEdits(ANNOTATED, [pushIdentityEdit(push)]);
  assert.deepEqual(valueAtPath(parseDeployment(added), path), push);
  assert.ok(added.includes("// Router comment."));

  // The repository's own file, where it holds the key: the same, whatever else is in it.
  if (template !== null && valueAtPath(parseDeployment(template), path) !== undefined) {
    const filled = applyDeploymentEdits(template, [pushIdentityEdit(push)]);
    assert.deepEqual(valueAtPath(parseDeployment(filled), path), push);
    assert.equal(filled.split("\n").filter((line) => line.trimStart().startsWith("//")).length,
      template.split("\n").filter((line) => line.trimStart().startsWith("//")).length);
  }
});
