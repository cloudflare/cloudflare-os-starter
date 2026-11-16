// Values to set in `deployment.jsonc`, as data. The core produces these; `deployment-file.ts`
// applies them to the file text, comments intact.

import type { PushIdentity } from "./hosted-release.ts";

/** One value to set, by its path through the file's object tree. */
export interface DeploymentEdit {
  path: (string | number)[];
  value: unknown;
}

/**
 * Where `deployment.jsonc` holds the push identity a take-over carries over from a hosted instance:
 * the top-level `pushIdentity` block. Absent, or `null`, on a deployment that never had one.
 *
 * Its value is a {@link PushIdentity} (core/hosted-release.ts), field for field:
 *
 *   "pushIdentity": {
 *     "serviceUrl": "https://...",      // the notification service's origin
 *     "installId": "...",               // this installation's identity with the service
 *     "keyId": "...",                   // the active generation of its signing key
 *     "webPushPublicKey": "..." | null  // null offers no browser push
 *   }
 *
 * Each field is the backend's plain variable `PUSH_IDENTITY_VARS` (core/hosted-release.ts) names
 * for it, so a deploy that honours the block sends the same four variables the hosted flow set. The
 * signing key itself is not in the block and never in the file: it is the secret
 * `PUSH_IDENTITY_SECRET` on the backend Worker, which a deploy leaves in place.
 * `core/deployment-config.ts` is where the block is typed and validated.
 */
export const PUSH_IDENTITY_PATH: readonly string[] = ["pushIdentity"];

/**
 * The edit writing `push` at {@link PUSH_IDENTITY_PATH}: the block whole, so no field of an older
 * identity outlives it.
 */
export function pushIdentityEdit(push: PushIdentity): DeploymentEdit {
  const { serviceUrl, installId, keyId, webPushPublicKey } = push;
  return { path: [...PUSH_IDENTITY_PATH], value: { serviceUrl, installId, keyId, webPushPublicKey } };
}

/** The value at `path` in a parsed file, or undefined. */
export function valueAtPath(object: unknown, path: (string | number)[]): unknown {
  let value = object;
  for (const key of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

/** Whether a value is still one of the template's `<PLACEHOLDER>` markers, or contains one. */
export function isPlaceholder(value: unknown): boolean {
  return typeof value === "string" && /<[^>]+>/.test(value);
}

/**
 * Config paths still holding a template placeholder, in file order. Sections a deploy ignores are
 * skipped: the Error Reporter's while error reporting is off, the custom Gatekeeper's beyond `enabled`
 * while it is off, and AI Gateway's beyond `enabled` while it is off -- the same scope
 * `validateConfig` checks placeholders in.
 */
export function placeholderPaths(file: Record<string, unknown>): string[] {
  const skip = new Set<string>();
  if (valueAtPath(file, ["errorReporting", "enabled"]) === false) {
    skip.add("workers.errorReporter");
    skip.add("errorReporting");
  }
  if (valueAtPath(file, ["customGatekeeper", "enabled"]) === false) {
    skip.add("workers.customGatekeeper");
    skip.add("customGatekeeper.name");
    skip.add("customGatekeeper.message");
  }
  if (valueAtPath(file, ["aiGateway", "enabled"]) === false) skip.add("aiGateway");
  const found: string[] = [];
  const walk = (value: unknown, path: string[]) => {
    const key = path.join(".");
    if (skip.has(key) || [...skip].some((prefix) => key.startsWith(`${prefix}.`))) return;
    if (isPlaceholder(value)) found.push(key);
    else if (Array.isArray(value)) value.forEach((item, index) => walk(item, [...path, String(index)]));
    else if (value && typeof value === "object") {
      for (const [child, nested] of Object.entries(value)) walk(nested, [...path, child]);
    }
  };
  walk(file, []);
  return found;
}

/** The edits as the nested `deployment.jsonc` fragment they produce. */
export function editsAsFragment(edits: DeploymentEdit[]): Record<string, unknown> {
  const fragment: Record<string, unknown> = {};
  for (const { path, value } of edits) {
    let node = fragment;
    for (const key of path.slice(0, -1)) {
      node[key] = (node[key] as Record<string, unknown> | undefined) ?? {};
      node = node[key] as Record<string, unknown>;
    }
    node[path.at(-1)!] = value;
  }
  return fragment;
}
