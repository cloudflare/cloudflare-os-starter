// Writes to `deployment.jsonc` that keep it the annotated file people edit by hand. `init`, `import`
// and `access` fill in values there; serialising a parsed object back would drop every comment,
// which is most of the file. jsonc-parser's `modify` edits the text instead, touching only the value
// at each path.

import { readFile, writeFile } from "node:fs/promises";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { DeploymentEdit } from "./core/edits.ts";

export { valueAtPath, type DeploymentEdit } from "./core/edits.ts";

/** The `deployment.jsonc` dialect: wrangler-style JSONC, trailing commas allowed. */
const parseOptions = { allowTrailingComma: true };

/** Parses `deployment.jsonc` text without validating it; validation is `validateConfig`'s job. */
export function parseDeployment(text: string, where = "deployment.jsonc"): Record<string, unknown> {
  const errors: ParseError[] = [];
  const result: unknown = parse(text, errors, parseOptions);
  if (errors.length) {
    throw new Error(`${where}: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`${where}: expected a JSON object.`);
  }
  return result as Record<string, unknown>;
}

/** `text` with every edit applied in order, comments and layout elsewhere left as they were. */
export function applyDeploymentEdits(text: string, edits: DeploymentEdit[]): string {
  let result = text;
  for (const { path, value } of edits) {
    result = applyEdits(result, modify(result, path, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }));
  }
  return result;
}

/** Applies `edits` to the file at `path`, writing the result to `outPath` (in place by default). */
export async function updateDeployment(
  path: string,
  edits: DeploymentEdit[],
  outPath = path,
): Promise<void> {
  const text = await readFile(path, "utf8");
  // Parse first so a file that is already broken is reported as broken, not edited further.
  parseDeployment(text, path);
  await writeFile(outPath, applyDeploymentEdits(text, edits));
}
