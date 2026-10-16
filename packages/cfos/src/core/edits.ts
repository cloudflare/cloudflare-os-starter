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
