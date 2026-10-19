// Values to set in `deployment.jsonc`, as data. The core produces these; `deployment-file.ts`
// applies them to the file text, comments intact.

/** One value to set, by its path through the file's object tree. */
export interface DeploymentEdit {
  path: (string | number)[];
  value: unknown;
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
