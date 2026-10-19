import assert from "node:assert/strict";
import test from "node:test";
import { testCatalog } from "../test-support.ts";
import { editsAsFragment } from "./edits.ts";
import {
  adminsProblem,
  defaultHost,
  describeEdits,
  gatekeeperHint,
  gatewayChoices,
  hostProblem,
  nameCollisions,
  newDeploymentAccessTarget,
  newDeploymentEdits,
  parseAdmins,
  routerHost,
  takeoverEdits,
  type NewDeploymentAnswers,
} from "./wizard.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

function answers(route: NewDeploymentAnswers["route"]): NewDeploymentAnswers {
  return {
    accountId: ACCOUNT,
    name: "acme",
    route,
    admins: ["a@example.com"],
    aiGateway: { name: "default", providers: ["cloudflare", "anthropic"] },
    customGatekeeper: { name: "Acme", message: "Hello." },
    gatekeepers: {},
    removedGatekeepers: [],
  };
}

test("records a new deployment on a custom domain", () => {
  assert.deepEqual(editsAsFragment(newDeploymentEdits(answers({ customDomain: "os.example.com" }))), {
    accountId: ACCOUNT,
    publicBaseUrl: null,
    workers: {
      router: { name: "acme", route: { customDomain: "os.example.com" } },
      workshop: { name: "acme-backend" },
      context: { name: "acme-gk-context" },
      scheduler: { name: "acme-gk-scheduler" },
      websearch: { name: "acme-gk-websearch" },
      customGatekeeper: { name: "acme-gk-custom" },
      errorReporter: { name: "acme-errors" },
    },
    access: { admins: ["a@example.com"] },
    aiGateway: { enabled: true, name: "default", accountId: null, providers: ["cloudflare", "anthropic"] },
    customGatekeeper: { enabled: true, name: "Acme", message: "Hello." },
  });
});

test("records the Gatekeepers chosen: the custom one's text only when it is on, one name per slug", () => {
  const edits = newDeploymentEdits({
    ...answers({ customDomain: "os.example.com" }),
    customGatekeeper: null,
    gatekeepers: { github: "acme-gk-github", mcpportal: "acme-portal" },
    removedGatekeepers: ["homeassistant"],
  });
  const paths = edits.map((edit) => edit.path.join("."));
  assert.ok(!paths.some((path) => /customGatekeeper\.(name|message)$/.test(path)), "wrote the unused custom Gatekeeper's names");
  assert.ok(!paths.includes("workers.customGatekeeper.name"));
  // Only `name` per slug, so vars added by hand stay; a deselected one is removed whole.
  assert.deepEqual(edits.filter((edit) => edit.path[0] === "customGatekeeper" || edit.path[0] === "gatekeepers"), [
    { path: ["customGatekeeper", "enabled"], value: false },
    { path: ["gatekeepers", "github", "name"], value: "acme-gk-github" },
    { path: ["gatekeepers", "mcpportal", "name"], value: "acme-portal" },
    { path: ["gatekeepers", "homeassistant"], value: undefined },
  ]);
});

test("prints removals apart from the fragment, which cannot show them", () => {
  const text = describeEdits([
    { path: ["gatekeepers", "github", "name"], value: "acme-gk-github" },
    { path: ["gatekeepers", "homeassistant"], value: undefined },
  ]);
  const [json, ...removals] = text.split(/\n(?=Removed: )/);
  assert.deepEqual(JSON.parse(json), { gatekeepers: { github: { name: "acme-gk-github" } } });
  assert.deepEqual(removals, ["Removed: gatekeepers.homeassistant"]);
});

test("says what each optional Gatekeeper needs", () => {
  const [github, homeassistant] = testCatalog().offered;
  assert.equal(gatekeeperHint(github), "needs CLIENT_ID, CLIENT_SECRET");
  assert.equal(gatekeeperHint(homeassistant), "no credentials, one install only");
});

test("gives a workers.dev deployment the public origin the router answers on", () => {
  const fragment = editsAsFragment(newDeploymentEdits(answers({ workersDevSubdomain: "team" }))) as
    { publicBaseUrl: string; workers: { router: { route: unknown } } };
  assert.equal(fragment.publicBaseUrl, "https://acme.team.workers.dev");
  assert.deepEqual(fragment.workers.router.route, { workersDev: true });
  assert.equal(newDeploymentAccessTarget(answers({ workersDevSubdomain: "team" })).host, "acme.team.workers.dev");
});

test("finds which derived names are taken, the chosen optional Gatekeepers' included", () => {
  assert.deepEqual(nameCollisions("acme", [{ name: "acme" }, { name: "acme-errors" }, { name: "other" }]),
    ["acme", "acme-errors"]);
  assert.deepEqual(nameCollisions("fresh", [{ name: "acme" }]), []);
  const workers = [{ name: "acme-gk-github" }, { name: "acme-gk-slack" }];
  assert.deepEqual(nameCollisions("acme", workers), []);
  assert.deepEqual(nameCollisions("acme", workers, ["github", "notion"]), ["acme-gk-github"]);
});

test("offers os.<zone> and keeps the hostname inside the zone", () => {
  assert.equal(defaultHost("example.com"), "os.example.com");
  assert.equal(hostProblem("os.example.com", "example.com"), undefined);
  assert.equal(hostProblem("example.com", "example.com"), undefined);
  assert.match(hostProblem("os.example.org", "example.com")!, /not in the zone/);
  assert.match(hostProblem("notexample.com", "example.com")!, /not in the zone/);
  assert.match(hostProblem("OS.example.com", "example.com")!, /lowercase/);
  assert.equal(routerHost("acme", { customDomain: "os.example.com" }), "os.example.com");
});

test("reads admins as typed", () => {
  assert.deepEqual(parseAdmins(" a@example.com, b@example.com  a@example.com "), ["a@example.com", "b@example.com"]);
  assert.equal(adminsProblem("a@example.com"), undefined);
  assert.match(adminsProblem("")!, /at least one/);
  assert.match(adminsProblem("a@example.com, nope")!, /nope is not an email/);
});

test("offers the default gateway first, whether or not it exists yet", () => {
  assert.deepEqual(gatewayChoices([]), ["default"]);
  assert.deepEqual(gatewayChoices([{ id: "acme-ai" }, { id: "default" }]), ["default", "acme-ai"]);
});

test("records a takeover's answers, websearch only when asked", () => {
  const display = { name: "Acme", message: "Hello." };
  const none = { gatekeepers: {}, removedGatekeepers: [] };
  assert.deepEqual(editsAsFragment(takeoverEdits({
    admins: ["a@example.com"], customGatekeeper: { worker: "acme-gk-custom", display }, errorReporter: "acme-errors",
    providers: ["cloudflare", "anthropic"], ...none,
  })), {
    access: { admins: ["a@example.com"] },
    workers: { customGatekeeper: { name: "acme-gk-custom" }, errorReporter: { name: "acme-errors" } },
    aiGateway: { providers: ["cloudflare", "anthropic"] },
    customGatekeeper: { enabled: true, ...display },
  });
  const withWebsearch = takeoverEdits({
    admins: ["a@example.com"], websearch: "acme-gk-websearch", customGatekeeper: { worker: "c", display },
    errorReporter: "e", providers: ["cloudflare"], ...none,
  });
  assert.ok(withWebsearch.some((edit) => edit.path.join(".") === "workers.websearch.name"));
});

test("records a takeover without the custom Gatekeeper, keeping a found one and removing a deselected one", () => {
  assert.deepEqual(editsAsFragment(takeoverEdits({
    admins: ["a@example.com"], customGatekeeper: null, errorReporter: "acme-errors", providers: ["cloudflare"],
    gatekeepers: { github: "acme-gk-github" }, removedGatekeepers: [],
  })), {
    access: { admins: ["a@example.com"] },
    workers: { errorReporter: { name: "acme-errors" } },
    aiGateway: { providers: ["cloudflare"] },
    customGatekeeper: { enabled: false },
    gatekeepers: { github: { name: "acme-gk-github" } },
  });
  const removing = takeoverEdits({
    admins: ["a@example.com"], customGatekeeper: null, errorReporter: "e", providers: ["cloudflare"],
    gatekeepers: {}, removedGatekeepers: ["github"],
  });
  assert.deepEqual(removing.filter((edit) => edit.path[0] === "gatekeepers"), [{ path: ["gatekeepers", "github"], value: undefined }]);
});
