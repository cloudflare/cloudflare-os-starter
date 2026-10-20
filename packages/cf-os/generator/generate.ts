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
// commands added, removed and changed relative to the committed schema, or, with --since, to the
// schema committed at that commit. `cf-os update` passes the commit it started from: after a merge
// that brought regenerated files, the working tree's schema is already the new one. Everything else
// goes to stderr.
//
// Usage: node packages/cf-os/generator/generate.ts [--check] [--since <commit>]

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
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
  /** The commit whose committed schema the commands are compared with; by default, the working tree's. */
  since?: string;
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
  const path = join(packageDir, SCHEMA_PATH);
  const before = options.since === undefined
    ? existsSync(path) ? readFileSync(path, "utf8") : undefined
    : schemaAt(options.since, packageDir);
  const commands = diffCommands(before === undefined ? undefined
    : parseSchema(before, options.since === undefined ? path : `${options.since}:${SCHEMA_PATH}`), schema);
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
 * The schema committed at `commit`, or undefined when it had none (a project from before
 * `cf-os api`). A `commit` git cannot resolve fails the run: a wrong diff would pass for a right one.
 */
function schemaAt(commit: string, packageDir: string): string | undefined {
  const verify = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], { cwd: packageDir, encoding: "utf8" });
  if (verify.error) throw new Error(`could not run git: ${verify.error.message}`);
  if (verify.status !== 0) throw new Error(`--since ${commit}: not a commit`);
  // `./`: the path is relative to the package, wherever the repository root is.
  const shown = spawnSync("git", ["show", `${commit}:./${SCHEMA_PATH}`],
    { cwd: packageDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return shown.status === 0 ? shown.stdout : undefined;
}

/**
 * The schema the command diff is relative to, from `where`, or undefined (every command added) when
 * it does not build a table.
 */
function parseSchema(text: string, where: string): Schema | undefined {
  try {
    const schema = JSON.parse(text) as Schema;
    diffCommands(undefined, schema);
    return schema;
  } catch (error) {
    console.error(`${where}: unreadable (${(error as Error).message}); counting every command as added`);
    return undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const usage = "Usage: node packages/cf-os/generator/generate.ts [--check] [--since <commit>]";
  let parsed: { values: { check?: boolean; since?: string } } | undefined;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: { check: { type: "boolean" }, since: { type: "string" } } });
  } catch (error) {
    console.error(`${(error as Error).message}\n${usage}`);
    process.exitCode = 1;
  }
  if (parsed) {
    const { check = false, since } = parsed.values;
    try {
      const result = generateApi({ check, since });
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
