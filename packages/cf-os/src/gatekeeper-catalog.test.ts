import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { secretSetup } from "./core/gatekeepers.ts";
import { loadCatalog } from "./gatekeeper-catalog.ts";
import { testCatalog } from "./test-support.ts";

/** The repository root, whose submodule the real catalog is read from. */
const ROOT = join(import.meta.dirname, "..", "..", "..");

/** A project root whose `cloudflare-os/packages` holds copies of the named submodule packages. */
function scratchPackages(t: { after: (fn: () => void) => void }, names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "cf-os-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of names) {
    const dir = join(root, "cloudflare-os", "packages", name);
    mkdirSync(dir, { recursive: true });
    for (const file of ["wrangler.jsonc", "package.json"]) {
      cpSync(join(ROOT, "cloudflare-os", "packages", name, file), join(dir, file));
    }
  }
  return root;
}

test("offers upstream's installable Gatekeepers, as the hosted catalog would", async () => {
  const catalog = await loadCatalog(ROOT);
  assert.equal(catalog.unavailable, undefined);
  const slugs = catalog.offered.map((gatekeeper) => gatekeeper.slug);

  const github = catalog.offered.find((gatekeeper) => gatekeeper.slug === "github")!;
  assert.equal(github.packageName, "@gadgets/github-gatekeeper");
  assert.equal(github.packageDir, "cloudflare-os/packages/gatekeeper-github");
  assert.deepEqual(github.secrets.map((input) => input.name), ["CLIENT_ID", "CLIENT_SECRET"]);
  assert.equal(github.secrets[0].redirectUriTemplate, "{PUBLIC_BASE_URL}/gatekeeper/github/oauth");
  assert.equal(github.secrets[0].consoleUrl, "https://github.com/settings/developers");
  assert.ok(github.secrets[0].setupSteps!.length > 0);
  assert.deepEqual(github.vars, []);
  assert.equal(github.singleton, false);
  assert.ok(github.config.migrations!.length > 0);

  // Without a deploy-inputs.json, upstream's default OAuth credentials.
  const linear = catalog.offered.find((gatekeeper) => gatekeeper.slug === "linear")!;
  assert.deepEqual(linear.secrets.map((input) => input.name), ["CLIENT_ID", "CLIENT_SECRET"]);
  assert.equal(linear.secrets[0].redirectUriTemplate, undefined);

  // The slug is the hosted one: punctuation folded out of the package name.
  const portal = catalog.offered.find((gatekeeper) => gatekeeper.slug === "mcpportal")!;
  assert.equal(portal.packageName, "@gadgets/mcp-portal-gatekeeper");
  assert.equal(portal.singleton, true);

  // No credentials at all: users connect their own instance in-app.
  const homeassistant = catalog.offered.find((gatekeeper) => gatekeeper.slug === "homeassistant")!;
  assert.deepEqual(homeassistant.secrets, []);
  assert.equal(homeassistant.singleton, true);

  // The built-ins are excluded by slug, and so is what upstream will not install.
  for (const slug of ["context", "scheduler", "websearch"]) {
    assert.ok(!slugs.includes(slug), slug);
    assert.match(catalog.excluded.find((gatekeeper) => gatekeeper.slug === slug)!.reason, /always deploys it/);
  }
  assert.ok(!slugs.includes("email"));
  assert.deepEqual(catalog.excluded.find((gatekeeper) => gatekeeper.slug === "email"),
    { package: "gatekeeper-email", slug: "email", reason: "upstream marks it not installable" });
  // A library has no wrangler.jsonc, so it is no Worker: neither offered nor excluded.
  assert.ok(![...catalog.offered.map((gatekeeper) => gatekeeper.packageDir), ...catalog.excluded.map((gatekeeper) => gatekeeper.package)]
    .some((name) => name.endsWith("gatekeeper-kit")));
});

test("the shared test catalog says what the real one says", async () => {
  const real = await loadCatalog(ROOT);
  const fake = testCatalog();
  for (const gatekeeper of fake.offered) {
    assert.deepEqual(gatekeeper, real.offered.find((offered) => offered.slug === gatekeeper.slug), gatekeeper.slug);
  }
  for (const gatekeeper of fake.excluded) {
    assert.deepEqual(gatekeeper, real.excluded.find((excluded) => excluded.package === gatekeeper.package), gatekeeper.package);
  }
});

test("excludes, without throwing, what upstream's rules or the starter cannot handle", async (t) => {
  const root = scratchPackages(t, ["gatekeeper-github", "gatekeeper-linear", "gatekeeper-x", "gatekeeper-context"]);
  const packages = join(root, "cloudflare-os", "packages");
  const edit = (name: string, change: (config: Record<string, unknown>) => void) => {
    const path = join(packages, name, "wrangler.jsonc");
    const config = JSON.parse(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "")) as Record<string, unknown>;
    change(config);
    writeFileSync(path, JSON.stringify(config));
  };
  // A key upstream's release has not decided about: buildWorkerEntry throws, and that is the reason.
  edit("gatekeeper-github", (config) => { config.d1_databases = [{ binding: "DB" }]; });
  // Storage the deploy would provision empty.
  edit("gatekeeper-linear", (config) => { config.kv_namespaces = [{ binding: "CACHE" }]; });
  // A binding to a Worker this deploy knows nothing about.
  edit("gatekeeper-x", (config) => { config.services = [{ binding: "OTHER", service: "other" }]; });

  const catalog = await loadCatalog(root);
  assert.equal(catalog.unavailable, undefined);
  assert.deepEqual(catalog.offered, []);
  const reason = (slug: string) => catalog.excluded.find((gatekeeper) => gatekeeper.slug === slug)?.reason;
  assert.match(reason("github")!, /gatekeeper-github\/wrangler\.jsonc has key\(s\) this generator doesn't handle: d1_databases/);
  assert.match(reason("linear")!, /KV namespaces/);
  assert.match(reason("x")!, /service bindings/);
  assert.match(reason("context")!, /always deploys it/);
});

test("is unavailable, not a crash, without the submodule's packages", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cf-os-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalog = await loadCatalog(root);
  assert.deepEqual([catalog.offered, catalog.excluded], [[], []]);
  assert.match(catalog.unavailable!, /cloudflare-os\/packages could not be read/);
});

test("prints upstream's setup guidance, the redirect URI and the secret commands", async () => {
  const catalog = await loadCatalog(ROOT);
  const github = catalog.offered.find((gatekeeper) => gatekeeper.slug === "github")!;
  const setup = secretSetup(github, "github", "acme-gk-github", "https://os.example.com", "0123456789abcdef0123456789abcdef");
  assert.equal(setup.consoleUrl, "https://github.com/settings/developers");
  assert.equal(setup.redirectUri, "https://os.example.com/gatekeeper/github/oauth");
  assert.deepEqual(setup.steps, github.secrets[0].setupSteps);
  assert.deepEqual(setup.commands, ["CLIENT_ID", "CLIENT_SECRET"].map((name) => ({
    name,
    command: `CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef pnpm exec wrangler secret put ${name} --name acme-gk-github`,
  })));
  assert.equal(setup.lines[0], "Console: https://github.com/settings/developers");
  assert.ok(setup.lines.includes("Redirect URI: https://os.example.com/gatekeeper/github/oauth"));
  assert.ok(setup.lines.includes(`  ${setup.commands[1].command}`));

  // No deploy-inputs.json: the hosted route's OAuth path, and a pointer to the package's README.
  const spotify = catalog.offered.find((gatekeeper) => gatekeeper.slug === "spotify")!;
  const generic = secretSetup(spotify, "spotify", "acme-gk-spotify", "https://os.example.com", "0123456789abcdef0123456789abcdef");
  assert.equal(generic.redirectUri, "https://os.example.com/gatekeeper/spotify/oauth");
  assert.equal(generic.consoleUrl, undefined);
  assert.equal(generic.steps.length, 1);
  assert.match(generic.steps[0], /Create an OAuth application.*cloudflare-os\/packages\/gatekeeper-spotify\/README\.md/);

  // Nothing to set, nothing printed.
  const homeassistant = catalog.offered.find((gatekeeper) => gatekeeper.slug === "homeassistant")!;
  assert.deepEqual(secretSetup(homeassistant, "homeassistant", "acme-gk-homeassistant", "https://os.example.com", "0123456789abcdef0123456789abcdef").lines, []);
});
