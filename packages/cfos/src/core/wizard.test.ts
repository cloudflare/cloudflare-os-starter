import assert from "node:assert/strict";
import test from "node:test";
import { editsAsFragment } from "./edits.ts";
import {
  adminsProblem,
  defaultHost,
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
    customGatekeeper: { name: "Acme", message: "Hello." },
  });
});

test("gives a workers.dev deployment the public origin the router answers on", () => {
  const fragment = editsAsFragment(newDeploymentEdits(answers({ workersDevSubdomain: "team" }))) as
    { publicBaseUrl: string; workers: { router: { route: unknown } } };
  assert.equal(fragment.publicBaseUrl, "https://acme.team.workers.dev");
  assert.deepEqual(fragment.workers.router.route, { workersDev: true });
  assert.equal(newDeploymentAccessTarget(answers({ workersDevSubdomain: "team" })).host, "acme.team.workers.dev");
});

test("finds which derived names are taken", () => {
  assert.deepEqual(nameCollisions("acme", [{ name: "acme" }, { name: "acme-errors" }, { name: "other" }]),
    ["acme", "acme-errors"]);
  assert.deepEqual(nameCollisions("fresh", [{ name: "acme" }]), []);
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
  assert.deepEqual(editsAsFragment(takeoverEdits({
    admins: ["a@example.com"], customGatekeeper: "acme-gk-custom", errorReporter: "acme-errors",
  })), {
    access: { admins: ["a@example.com"] },
    workers: { customGatekeeper: { name: "acme-gk-custom" }, errorReporter: { name: "acme-errors" } },
  });
  const withWebsearch = takeoverEdits({
    admins: ["a@example.com"], websearch: "acme-gk-websearch", customGatekeeper: "c", errorReporter: "e",
  });
  assert.ok(withWebsearch.some((edit) => edit.path.join(".") === "workers.websearch.name"));
});
