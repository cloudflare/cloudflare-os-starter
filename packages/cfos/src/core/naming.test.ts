import assert from "node:assert/strict";
import test from "node:test";
import { accessAppName, baseNameProblem, findInstances, matchers, workerNames } from "./naming.ts";

test("names all seven Workers the hosted way", () => {
  assert.deepEqual(workerNames("acme"), {
    router: "acme",
    workshop: "acme-backend",
    context: "acme-gk-context",
    scheduler: "acme-gk-scheduler",
    websearch: "acme-gk-websearch",
    customGatekeeper: "acme-gk-custom",
    errorReporter: "acme-errors",
  });
});

test("marks what the hosted flow never creates as a suggestion", () => {
  const suggestions = matchers("acme").filter((matcher) => matcher.source === "suggestion");
  assert.deepEqual(suggestions.map((matcher) => matcher.path.join(".")),
    ["workers.customGatekeeper.name", "workers.errorReporter.name"]);
});

test("matches the Access application by instance name, not by prefix", () => {
  const pattern = accessAppName("acme");
  assert.ok(pattern.test("Cloudflare OS acme 1a2b3c4d"));
  assert.ok(pattern.test("Cloudflare OS acme"));
  assert.ok(!pattern.test("Cloudflare OS acme-staging 9f8e7d6c"));
  assert.ok(!pattern.test("Cloudflare OS acmecorp"));
});

test("finds the hosted instances among an account's Workers", () => {
  assert.deepEqual(findInstances([{ name: "acme" }, { name: "acme-backend" }, { name: "acme-gk-context" }]), ["acme"]);
  assert.deepEqual(findInstances([{ name: "acme-backend" }, { name: "solo" }]), []);
});

test("accepts a base name only if every derived name is a valid Worker name", () => {
  assert.equal(baseNameProblem("acme-os"), undefined);
  assert.match(baseNameProblem("Acme")!, /lowercase/);
  assert.match(baseNameProblem("-acme")!, /lowercase/);
  // 63 is the Worker limit; "-context-collections" is the longest suffix.
  assert.match(baseNameProblem("a".repeat(50))!, /Too long/);
});
