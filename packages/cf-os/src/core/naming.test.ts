import assert from "node:assert/strict";
import test from "node:test";
import { placeholderPaths } from "./edits.ts";
import {
  accessAppInstance,
  accessAppName,
  baseNameProblem,
  BUILT_IN_GATEKEEPER_SLUGS,
  coreInstance,
  coreNames,
  CUSTOM_NAMES_HINT,
  findInstances,
  gatekeeperInstance,
  gatekeeperWorkerName,
  gatewayInstance,
  matchers,
  workerNames,
} from "./naming.ts";

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

test("a router and a backend named by the operator replace the first two names, and nothing else", () => {
  assert.deepEqual(coreNames("moss"), { router: "moss", backend: "moss-backend" });
  assert.deepEqual(coreNames("moss", { router: "moss-os" }), { router: "moss-os", backend: "moss-backend" });
  assert.deepEqual(coreNames("moss", { backend: "moss-api" }), { router: "moss", backend: "moss-api" });
  assert.deepEqual(workerNames("moss", { router: "moss-os", backend: "moss-api" }), {
    router: "moss-os",
    workshop: "moss-api",
    context: "moss-gk-context",
    scheduler: "moss-gk-scheduler",
    websearch: "moss-gk-websearch",
    customGatekeeper: "moss-gk-custom",
    errorReporter: "moss-errors",
  });
  // Only the two rows differ from the hosted flow's own naming: storage, the gateway and the
  // Gatekeepers are named after the instance either way.
  const custom = matchers("moss", { router: "moss-os", backend: "moss-api" });
  const hosted = matchers("moss");
  assert.deepEqual(custom.map((matcher) => matcher.path.join(".")), hosted.map((matcher) => matcher.path.join(".")));
  assert.deepEqual(custom.filter((matcher, index) => matcher.name !== hosted[index].name).map((matcher) => [matcher.path.join("."), matcher.name]),
    [["workers.router.name", "moss-os"], ["workers.workshop.name", "moss-api"]]);
  assert.deepEqual(matchers("moss", {}), hosted);
});

test("an instance under names of its own is not among the instances found by name", () => {
  const workers = [{ name: "moss-os" }, { name: "moss-api" }, { name: "moss-gk-context" }, { name: "acme" }, { name: "acme-backend" }];
  assert.deepEqual(findInstances(workers), ["acme"]);
  assert.match(CUSTOM_NAMES_HINT, /--router <name> and --backend <name>/);
});

test("a router and a backend say an instance only as the hosted flow's own pair, whoever named them", () => {
  assert.equal(coreInstance(coreNames("acme")), "acme");
  assert.equal(coreInstance({ router: "moss-os", backend: "moss-api" }), null);
  assert.equal(coreInstance({ router: "moss", backend: "moss-api" }), null);
  assert.equal(coreInstance({ router: "moss-os", backend: "moss-backend" }), null);
  // Two Workers the operator named `X` and `X-backend` read as an instance "X", which is all a list of names can say.
  assert.equal(coreInstance(coreNames("moss", { router: "moss-os", backend: "moss-os-backend" })), "moss-os");
  assert.deepEqual(findInstances([{ name: "moss-os" }, { name: "moss-os-backend" }, { name: "moss-gk-context" }]), ["moss-os"]);
});

test("accepts a base name only if every derived name is a valid Worker name", () => {
  assert.equal(baseNameProblem("acme-os"), undefined);
  assert.match(baseNameProblem("Acme")!, /lowercase/);
  assert.match(baseNameProblem("-acme")!, /lowercase/);
  // 63 is the Worker limit; "-context-collections" is the longest suffix.
  assert.match(baseNameProblem("a".repeat(50))!, /Too long/);
});

test("names an optional Gatekeeper the hosted way, and leaves room for its slug", () => {
  assert.equal(gatekeeperWorkerName("acme", "github"), "acme-gk-github");
  assert.equal(gatekeeperWorkerName("acme", "mcpportal"), "acme-gk-mcpportal");
  assert.deepEqual([...BUILT_IN_GATEKEEPER_SLUGS].toSorted(), ["context", "custom", "scheduler", "websearch"]);
  // 43 + "-context-collections" is 63: fine alone, too long once a 20-character slug's
  // "-gk-<slug>" (24) is selected.
  const n = "a".repeat(43);
  assert.equal(baseNameProblem(n), undefined);
  assert.equal(baseNameProblem(n, ["github"]), undefined);
  assert.match(baseNameProblem(n, ["github", "a".repeat(20)])!, /Too long: the longest derived name would be 67 characters/);
});

test("lists the placeholders a deploy would still refuse, and only those", () => {
  const file = {
    accountId: "0123456789abcdef0123456789abcdef",
    workers: { router: { name: "acme" }, errorReporter: { name: "<ERROR_REPORTER_WORKER_NAME>" } },
    access: { audience: "<ACCESS_AUDIENCE>", admins: ["<ADMIN_EMAIL>"] },
    customGatekeeper: { name: "<ORGANIZATION_DISPLAY_NAME>", message: "Hi." },
    errorReporting: { enabled: true },
    aiGateway: { enabled: false, name: "<UNUSED>" },
  };
  assert.deepEqual(placeholderPaths(file),
    ["workers.errorReporter.name", "access.audience", "access.admins.0", "customGatekeeper.name"]);
  assert.deepEqual(placeholderPaths({ ...file, errorReporting: { enabled: false } }),
    ["access.audience", "access.admins.0", "customGatekeeper.name"]);
  // The custom Gatekeeper's Worker name and display text, while it is off.
  const customOff = {
    ...file,
    workers: { ...file.workers, customGatekeeper: { name: "<CUSTOM_GATEKEEPER_WORKER_NAME>" } },
    customGatekeeper: { ...file.customGatekeeper, enabled: false },
  };
  assert.deepEqual(placeholderPaths(customOff), ["workers.errorReporter.name", "access.audience", "access.admins.0"]);
  assert.deepEqual(placeholderPaths({ ...customOff, customGatekeeper: { ...customOff.customGatekeeper, enabled: true } }),
    ["workers.errorReporter.name", "workers.customGatekeeper.name", "access.audience", "access.admins.0", "customGatekeeper.name"]);
  // And an optional Gatekeeper's, like any other value.
  assert.deepEqual(placeholderPaths({ ...customOff, gatekeepers: { github: { name: "<GITHUB_WORKER_NAME>" } } }),
    ["workers.errorReporter.name", "access.audience", "access.admins.0", "gatekeepers.github.name"]);
});

test("reads the instance back out of the names the hosted flow derives from it, and out of no other", () => {
  // The Access application: the instance, between the product's name and the installation's fingerprint.
  assert.equal(accessAppInstance("Cloudflare OS acme 1a2b3c4d"), "acme");
  assert.equal(accessAppInstance("Cloudflare OS acme-staging 9f8e7d6c"), "acme-staging");
  for (const name of ["Cloudflare OS acme", "Cloudflare OS acme users 1a2b3c4d", "Cloudflare OS acme 1A2B3C4D", "Acme OS 1a2b3c4d", ""]) {
    assert.equal(accessAppInstance(name), null, name);
  }
  // The gateway and a Gatekeeper Worker: the inverse of the names `matchers` and `gatekeeperWorkerName` give.
  const gateway = matchers("acme").find((matcher) => matcher.kind === "gateway")!.name;
  assert.equal(gatewayInstance(gateway), "acme");
  assert.equal(gatewayInstance("default"), null);
  assert.equal(gatewayInstance("-ai"), null);
  assert.equal(gatekeeperInstance(gatekeeperWorkerName("acme", "github"), "github"), "acme");
  assert.equal(gatekeeperInstance(workerNames("acme-staging").context, "context"), "acme-staging");
  // Named for another slug, or not the hosted way at all, it names no instance.
  assert.equal(gatekeeperInstance("acme-gk-github", "google"), null);
  assert.equal(gatekeeperInstance("hub", "github"), null);
  assert.equal(gatekeeperInstance("-gk-github", "github"), null);
});
