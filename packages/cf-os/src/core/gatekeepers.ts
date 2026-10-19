// The optional upstream Gatekeepers a deployment can add, as data. `gatekeeper-catalog.ts` builds the
// catalog from the submodule's packages with upstream's own release logic, the same scan the hosted
// deploy service's catalog comes from; everything here works on the result, with no I/O.

import type { DeployInput } from "@gadgets/scripts/release/manifest-lib";
import type { ProdWranglerConfig } from "./deployment-config.ts";

/** One Gatekeeper the starter can deploy beside the built-in ones. */
export interface CatalogGatekeeper {
  /** The hosted install slug: its `gatekeepers` key, `GATEKEEPER_<SLUG>` binding and route. */
  slug: string;
  /** Its package, relative to the project root, with forward slashes. */
  packageDir: string;
  /** Its `package.json` name, which `vp run -F` builds it by. */
  packageName: string;
  /** Upstream's release preinstalls it on every hosted instance. */
  preinstall: boolean;
  /** Upstream allows one install per instance. */
  singleton: boolean;
  /** Inputs its Worker reads as secrets, set with `wrangler secret put`. */
  secrets: DeployInput[];
  /** Inputs its Worker reads as plain vars, set in `gatekeepers.<slug>.vars`. */
  vars: DeployInput[];
  /** Its README, relative to the project root, when it has one. */
  readme?: string;
  /** Its base `wrangler.jsonc`, parsed. */
  config: ProdWranglerConfig;
}

/** A `gatekeeper-*` Worker package the starter does not offer, and why. */
export interface ExcludedGatekeeper {
  /** The package directory's name, e.g. `gatekeeper-email`. */
  package: string;
  /** Its install slug, when upstream's rules give it one. */
  slug?: string;
  reason: string;
}

/** What the submodule offers. */
export interface GatekeeperCatalog {
  offered: CatalogGatekeeper[];
  excluded: ExcludedGatekeeper[];
  /** Why there is no catalog at all (the submodule is not installed, say). Both lists are empty. */
  unavailable?: string;
}

/** How to give one Gatekeeper its OAuth credentials. See {@link secretSetup}. */
export interface SecretSetup {
  /** The provider's console page the OAuth app is created in, when upstream names one. */
  consoleUrl?: string;
  /** Upstream's setup steps, or a generic one when it ships none. */
  steps: string[];
  /** The OAuth redirect URI to register with the provider. */
  redirectUri: string;
  /** One `wrangler secret put` per secret input. */
  commands: { name: string; command: string }[];
  /** All of the above, as lines to print. */
  lines: string[];
}

/**
 * How to set `entry`'s secrets on Worker `worker`, deployed as `slug` at `origin`: upstream's
 * `deploy-inputs.json` guidance when the package ships one, and the `wrangler secret put` commands.
 * `CLOUDFLARE_ACCOUNT_ID` pins the account the way the deploys are pinned, since `wrangler secret
 * put` takes only `--name`. Upstream's steps are written for the hosted wizard's form; the commands
 * are where the values go here.
 */
export function secretSetup(
  entry: CatalogGatekeeper,
  slug: string,
  worker: string,
  origin: string,
  accountId: string,
): SecretSetup {
  const consoleUrl = entry.secrets.find((input) => input.consoleUrl)?.consoleUrl;
  const template = entry.secrets.find((input) => input.redirectUriTemplate)?.redirectUriTemplate;
  // Upstream's files write `{PUBLIC_BASE_URL}`; its type documents `$PUBLIC_BASE_URL`. Either way.
  const redirectUri = template
    ? template.replace(/\{PUBLIC_BASE_URL\}|\$PUBLIC_BASE_URL/g, origin)
    : `${origin}/gatekeeper/${slug}/oauth`;
  const upstreamSteps = entry.secrets.flatMap((input) => input.setupSteps ?? []);
  const steps = upstreamSteps.length ? upstreamSteps : [
    `Create an OAuth application with the provider, registering the redirect URI below${entry.readme ? `; ${entry.readme} has the details` : ""}.`,
  ];
  const commands = entry.secrets.map(({ name }) => ({
    name,
    command: `CLOUDFLARE_ACCOUNT_ID=${accountId} pnpm exec wrangler secret put ${name} --name ${worker}`,
  }));
  const lines = entry.secrets.length ? [
    ...(consoleUrl ? [`Console: ${consoleUrl}`] : []),
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    `Redirect URI: ${redirectUri}`,
    "Then set each secret on the Worker:",
    ...commands.map(({ command }) => `  ${command}`),
  ] : [];
  return { ...(consoleUrl ? { consoleUrl } : {}), steps, redirectUri, commands, lines };
}
