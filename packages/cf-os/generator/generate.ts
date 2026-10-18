#!/usr/bin/env node

// Regenerates `cf-os api`'s committed files, `src/api/generated/schema.json` and
// `src/api/generated/commands.ts`, from the pinned upstream's
// `cloudflare-os/packages/workshop-shared/src/api.ts`: `extract.ts` reads the API, `emit.ts`
// renders the files, and this script is the only part that touches the disk. `pnpm api:check`
// (part of `pnpm lint`) keeps the committed files in step with the pin, as upstream's
// `scripts/generate-worker-configs.ts --check` does its Worker configs; `cf-os update` runs
// `pnpm api:generate` after moving the pin.
//
// stdout is one JSON object for scripts: the files that changed (or, with --check, would) and the
// commands added, removed and changed relative to the committed schema. Everything else goes to
// stderr.
//
// Usage: node packages/cf-os/generator/generate.ts [--check]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { type CommandDiff, diffCommands, generate, SCHEMA_PATH, type Schema } from "./emit.ts";
import { type ExtractOptions, extractSchema } from "./extract.ts";

const PACKAGE = join(import.meta.dirname, "..");
const ROOT = join(PACKAGE, "..", "..");
const SHARED = join(ROOT, "cloudflare-os", "packages", "workshop-shared");

/** What the CLI is generated from: upstream's `PublicApi`, under its package's own tsconfig. */
export const API_SOURCE: ExtractOptions = {
  entry: join(SHARED, "src", "api.ts"),
  tsconfig: join(SHARED, "tsconfig.json"),
  entryName: "PublicApi",
  constants: ["SERVICE_SALT"],
};

/** What a run changed, as printed on stdout. */
export interface GenerateResult {
  /** Repository-relative paths written (or, with `check`, stale). */
  files: string[];
  commands: CommandDiff;
}

/** Where a run reads and writes; the defaults are this repository's. */
export interface GenerateOptions {
  /** Compare only: write nothing. */
  check: boolean;
  /** The schema to render; by default, extracted from {@link API_SOURCE}. */
  schema?: Schema;
  /** The `cf-os` package the generated paths are relative to. */
  packageDir?: string;
  /** What reported paths are relative to. */
  root?: string;
}

/** Renders the generated files, writes those whose content changed (unless `check`), and reports. */
export function generateApi(options: GenerateOptions): GenerateResult {
  const packageDir = options.packageDir ?? PACKAGE;
  const root = options.root ?? ROOT;
  const schema = options.schema ?? extractSchema(API_SOURCE);
  const commands = diffCommands(committedSchema(join(packageDir, SCHEMA_PATH)), schema);
  const files: string[] = [];
  for (const file of generate(schema)) {
    const path = join(packageDir, file.path);
    if (existsSync(path) && readFileSync(path, "utf8") === file.contents) continue;
    const rel = relative(root, path);
    files.push(rel);
    if (options.check) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.contents);
    console.error(`gen ${rel}`);
  }
  return { files, commands };
}

/**
 * The committed schema the command diff is relative to, or undefined (every command added) when
 * there is none or it does not build a table.
 */
function committedSchema(path: string): Schema | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const schema = JSON.parse(readFileSync(path, "utf8")) as Schema;
    diffCommands(undefined, schema);
    return schema;
  } catch (error) {
    console.error(`${path}: unreadable (${(error as Error).message}); counting every command as added`);
    return undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    console.error(`unknown argument ${unknown[0]}\nUsage: node packages/cf-os/generator/generate.ts [--check]`);
    process.exitCode = 1;
  } else {
    const check = args.includes("--check");
    try {
      const result = generateApi({ check });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (check && result.files.length > 0) {
        console.error(`API files out of date (run \`pnpm api:generate\`):\n  ${result.files.join("\n  ")}`);
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`API generation failed: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
}
