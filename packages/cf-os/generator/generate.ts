#!/usr/bin/env node

// Regenerates `cf-os api`'s committed files, `src/api/generated/schema.json` and
// `src/api/generated/commands.ts`, from the pinned upstream's schema of its API,
// `cloudflare-os/packages/api-schema/generated/workshop-api.schema.json` (cloudflare/cloudflare-os#860):
// `emit.ts` renders the files, and this script is the only part that touches the disk. It also
// copies upstream's agent declarations beside them into `src/api/generated/agent-types.ts`, for `cf-os
// api types`, so that, like the commands, it works whatever the submodule holds. `pnpm
// api:check` (part of `pnpm lint`) keeps the committed files in step with the pin, as upstream's
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
import { type CommandDiff, diffCommands, generate, SCHEMA_FORMAT, SCHEMA_PATH, type Schema } from "./emit.ts";

const PACKAGE = join(import.meta.dirname, "..");
const ROOT = join(PACKAGE, "..", "..");

/** What the CLI is generated from: upstream's schema of everything reachable from `PublicApi`. */
export const SCHEMA_SOURCE = join(ROOT, "cloudflare-os", "packages", "api-schema", "generated", "workshop-api.schema.json");

/** Upstream's agent declarations, whole and per service, read from beside the schema. */
export const AGENT_DECLARATIONS = "workshop-api.agent.d.ts";
export const AGENT_FRAGMENTS = "workshop-api.fragments.json";

/** Where `cf-os api types` reads the agent declarations from, relative to the `cf-os` package. */
export const AGENT_TYPES_PATH = "src/api/generated/agent-types.ts";

/** Upstream's agent declarations: the whole file, and the same split per service, by service name. */
export interface AgentTypes {
  declarations: string;
  fragments: Record<string, string>;
}

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
  /** The schema to render; by default, read from {@link source}. */
  schema?: Schema;
  /** The upstream schema file to read, the agent declarations beside it; by default, {@link SCHEMA_SOURCE}. */
  source?: string;
  /** The agent declarations to copy; by default, read from beside {@link source}. */
  agent?: AgentTypes;
  /** The `cf-os` package the generated paths are relative to. */
  packageDir?: string;
  /** What reported paths are relative to. */
  root?: string;
}

/** Renders the generated files, writes those whose content changed (unless `check`), and reports. */
export function generateApi(options: GenerateOptions): GenerateResult {
  const packageDir = options.packageDir ?? PACKAGE;
  const root = options.root ?? ROOT;
  const source = options.source ?? SCHEMA_SOURCE;
  const schema = options.schema ?? readSchema(source, root);
  const agent = options.agent ?? readAgentTypes(dirname(source), root);
  const path = join(packageDir, SCHEMA_PATH);
  const text = options.since === undefined
    ? existsSync(path) ? readFileSync(path, "utf8") : undefined
    : schemaAt(options.since, packageDir);
  const before = text === undefined ? undefined
    : parseSchema(text, options.since === undefined ? path : `${options.since}:${SCHEMA_PATH}`);
  // A schema without `format` is the one this repository extracted itself before upstream's, which
  // records no stream's `element`: compared with it, a command whose shapes hold a stream would
  // count as changed when only the format grew.
  const commands = diffCommands(before, before && !("format" in before) ? withoutStreamElements(schema) : schema);
  const files: string[] = [];
  for (const file of [...generate(schema), { path: AGENT_TYPES_PATH, contents: renderAgentTypes(agent) }]) {
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

/** The upstream generated file at `path`, failing when the pin has none. */
function readUpstream(path: string, root: string): string {
  if (!existsSync(path)) {
    throw new Error(`${relative(root, path)} is missing: the cloudflare-os pin predates packages/api-schema `
      + "(cloudflare/cloudflare-os#860), which `cf-os api` is generated from. Move the pin to a commit that has it.");
  }
  return readFileSync(path, "utf8");
}

/** Upstream's schema at `source`, refusing one this generator cannot read. */
function readSchema(source: string, root: string): Schema {
  const where = relative(root, source);
  const schema = JSON.parse(readUpstream(source, root)) as Schema;
  if (schema.format !== SCHEMA_FORMAT) {
    const found = schema.format === undefined ? "no format" : `format ${JSON.stringify(schema.format)}`;
    throw new Error(`${where} has ${found}, and this cf-os reads ${SCHEMA_FORMAT}`);
  }
  return schema;
}

/** Upstream's agent declarations, from its generated directory `dir`. */
function readAgentTypes(dir: string, root: string): AgentTypes {
  return {
    declarations: readUpstream(join(dir, AGENT_DECLARATIONS), root),
    fragments: JSON.parse(readUpstream(join(dir, AGENT_FRAGMENTS), root)) as Record<string, string>,
  };
}

/**
 * `value` as a TypeScript expression: an array of its lines, joined, so that a pin move's diff of
 * `agent-types.ts` reads line by line as upstream's does.
 */
function linesLiteral(value: string, indent: string): string {
  return `[\n${value.split("\n").map((line) => `${indent}  ${JSON.stringify(line)},\n`).join("")}${indent}].join("\\n")`;
}

/** `agent-types.ts`: the header, then the whole declarations and the fragments by service name. */
export function renderAgentTypes(agent: AgentTypes): string {
  return [
    `// Generated by packages/cf-os/generator/generate.ts from cloudflare-os/packages/api-schema/generated/${AGENT_DECLARATIONS} `
      + `and ${AGENT_FRAGMENTS}; do not edit. Run pnpm api:generate.`,
    "",
    "/** What a holder of an `AuthenticatedApi` stub can call, as TypeScript declarations, without the credential methods. */",
    `export const declarations: string = ${linesLiteral(agent.declarations, "")};`,
    "",
    "/** The same declarations per service, each readable on its own, other services referred to by name. */",
    "export const fragments: Record<string, string> = {",
    ...Object.entries(agent.fragments).map(([name, fragment]) =>
      `  ${/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)}: ${linesLiteral(fragment, "  ")},`),
    "};",
    "",
  ].join("\n");
}

/** `schema` with every stream shape's `element` left out. */
function withoutStreamElements(schema: Schema): Schema {
  return JSON.parse(JSON.stringify(schema), (_key, value: unknown) => {
    if (value && typeof value === "object" && "element" in value && "kind" in value
      && (value.kind === "readableStream" || value.kind === "writableStream")) {
      const { element: _element, ...rest } = value;
      return rest;
    }
    return value;
  }) as Schema;
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
