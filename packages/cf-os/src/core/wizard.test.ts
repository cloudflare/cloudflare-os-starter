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
  offeredAdmins,
  offeredProviders,
  parseAdmins,
  pinMoveReason,
  routerHost,
  strayPushIdentity,
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

test("a new deployment clears a push identity that is another deployment's, and keeps its own", () => {
  const push = { serviceUrl: "https://push.example.com", installId: "install-acme", keyId: "key-1", webPushPublicKey: null };
  const file = (workshop: string, accountId = ACCOUNT, pushIdentity: unknown = push) =>
    ({ accountId, workers: { workshop: { name: workshop } }, pushIdentity });
  // The account's Workers as listed: the Workshop Worker a takeover of acme left there, or none of acme's.
  const there = [{ name: "acme" }, { name: "acme-backend" }];
  const lists = [there, [{ name: "other" }], null];
  // The file a takeover of instance acme wrote: its Workshop Worker is acme-backend, which holds the
  // signing key. A deployment under another base name deploys another Workshop Worker.
  for (const name of ["acme-2", "beta"]) {
    for (const workers of lists) {
      const stray = strayPushIdentity(file("acme-backend"), { accountId: ACCOUNT, name }, workers);
      assert.deepEqual(stray.edits, [{ path: ["pushIdentity"], value: null }], name);
      assert.match(stray.note ?? "", /push identity of the deployment it described \(Workshop Worker acme-backend\), whose signing key is a secret on that Worker\. A new deployment has no such key, so the block is set to null/);
    }
  }
  // The same Workshop Worker name in another account, or in a file that names no account, is another Worker.
  for (const accountId of ["f".repeat(32), "<CLOUDFLARE_ACCOUNT_ID>"]) {
    for (const workers of lists) {
      assert.equal(strayPushIdentity(file("acme-backend", accountId), { accountId: ACCOUNT, name: "acme" }, workers).edits.length, 1, accountId);
    }
  }
  assert.doesNotMatch(strayPushIdentity(file("<WORKSHOP_WORKER_NAME>"), { accountId: ACCOUNT, name: "acme" }, null).note ?? "", /Workshop Worker/);
  // The Workshop Worker the new deployment itself deploys over, in the same account, where the
  // account has it or its Workers could not be listed: the identity is that Worker's own.
  for (const workers of [there, null]) {
    assert.deepEqual(strayPushIdentity(file("acme-backend"), { accountId: ACCOUNT.toUpperCase(), name: "acme" }, workers), { edits: [] });
  }
  // The same name in the same account, and the account's Workers do not include it: the deploy
  // creates the Worker, which has no key to sign with.
  for (const workers of [[{ name: "other" }], [{ name: "acme" }, { name: "acme-backend-2" }], []]) {
    const gone = strayPushIdentity(file("acme-backend"), { accountId: ACCOUNT, name: "acme" }, workers);
    assert.deepEqual(gone.edits, [{ path: ["pushIdentity"], value: null }]);
    assert.equal(gone.note, "The file's pushIdentity block is the push identity of the deployment it described, whose signing " +
      "key is a secret on its Workshop Worker, acme-backend. The account has no Worker of that name, so the one this " +
      "deployment creates has no such key, and the block is set to null: push notifications reach open browser tabs only.");
  }
  // Nothing to clear in a file with no identity.
  for (const workers of lists) {
    assert.deepEqual(strayPushIdentity(file("acme-backend", ACCOUNT, null), { accountId: ACCOUNT, name: "acme-2" }, workers), { edits: [] });
    assert.deepEqual(
      strayPushIdentity({ accountId: ACCOUNT, workers: { workshop: { name: "acme-backend" } } }, { accountId: ACCOUNT, name: "acme-2" }, workers),
      { edits: [] });
  }
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

test("offers a takeover the first usable admin list: the instance's own ahead of the file's", () => {
  assert.equal(offeredAdmins(["root@example.com", "ops@example.com"], ["file@example.com"]), "root@example.com, ops@example.com");
  // Nothing read from the backend, or nothing usable there: the file's, when it is a list of addresses.
  assert.equal(offeredAdmins(undefined, ["file@example.com"]), "file@example.com");
  assert.equal(offeredAdmins([], ["file@example.com"]), "file@example.com");
  assert.equal(offeredAdmins(["not an address"], ["file@example.com"]), "file@example.com");
  assert.equal(offeredAdmins("root@example.com", ["file@example.com"]), "file@example.com");
  // The template's placeholder is no address, so there is nothing to offer but what the caller falls back on.
  assert.equal(offeredAdmins(undefined, ["<ADMIN_EMAIL>"]), undefined);
  assert.equal(offeredAdmins([1, 2], null), undefined);
  assert.equal(offeredAdmins(), undefined);
});

test("preselects the providers a backend advertises that the starter serves, in the order the question lists them", () => {
  assert.deepEqual(offeredProviders(["cloudflare", "anthropic"]), ["anthropic", "cloudflare"]);
  // One the starter does not serve is no choice of the question.
  assert.deepEqual(offeredProviders(["groq", "openai"]), ["openai"]);
  assert.deepEqual(offeredProviders(["groq"]), []);
  assert.deepEqual(offeredProviders(undefined), []);
  assert.deepEqual(offeredProviders("cloudflare"), []);
});

test("says why a takeover moves the pin: the release the instance runs, what an older pin would do, and what the move is", () => {
  assert.equal(pinMoveReason("moss", "r004945-6c8d301"),
    "moss runs release r004945-6c8d301, which this project's pin is behind: deployed as it is, it would put older code over " +
    "storage the instance has already migrated, which cannot be undone. The move is staged, not committed, and merges nothing " +
    "of the starter.");
  // With only --commit to go by, there is no release to name.
  assert.match(pinMoveReason("moss", null), /^moss runs the commit --commit names, which this project's pin is behind: /);
});
