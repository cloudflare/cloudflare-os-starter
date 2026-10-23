#!/usr/bin/env node

// cf-os: scaffold, configure and deploy a self-hosted Cloudflare OS, and call a running one's API.
//
// This file is the dispatcher, and with scaffolding and `update` the only part a globally installed
// `cf-os` ever runs for itself.
// Inside a project it hands every command but `update` to that project's own copy
// (`packages/cf-os`), the way a global `cf` hands off to a project-local one, so the deploy logic
// always matches the project's pinned `cloudflare-os`. `update` runs here, as it is what brings that
// copy up to date. Outside a project, only `init` and `update` run: `init` scaffolds one, and
// `update` moves the Cloudflare OS pin of any repository that has one.
//
// Commands load lazily. `install` has to work before the submodule is checked out, and the
// `@gadgets/scripts` modules other commands import only resolve once it is -- so nothing imported
// statically here, or by `commands/scaffold.ts` or `commands/update.ts`, may reach them. Nor may
// it reach `api`'s modules (`src/api`), whose packages (capnweb, hash-wasm) are development
// dependencies a published copy lacks, nor the generator's (`@gadgets/api-schema`). `main.test.ts`
// checks both.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import {
  consoleOutput,
  UsageError,
  type CommandArgs,
  type CommandModule,
  type Context,
  type GlobalFlags,
  type Output,
} from "./context.ts";
import { delegate, DELEGATION_SENTINEL, findProjectRoot, localEntry, type SpawnDelegate } from "./project.ts";
import { Cancelled, terminalPrompter, type Prompter } from "./prompt.ts";

const GLOBAL_OPTIONS = {
  config: { type: "string" },
  account: { type: "string" },
  profile: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

const GLOBAL_HELP = [
  "  --config <path>    deployment file (default: deployment.jsonc in the project root)",
  "  --account <id>     Cloudflare account for init and import, ahead of the file's accountId;",
  "                     check, deploy, access and secrets refuse one other than the file's",
  "  --profile <name>   cf sign-in to use, passed to every cf call",
  "  -h, --help         this help",
];

interface CommandSpec {
  summary: string;
  /** What follows `cf-os <name>`. */
  synopsis: string;
  /** Option lines beyond the global ones. */
  help: string[];
  options: ParseArgsOptionsConfig;
  positionals: number;
  /** Printed before a failure's message. */
  failure: string;
  /**
   * False when the command runs in the copy that was started rather than being handed to the
   * project's own: `update`, which replaces that copy, and is missing from projects older than it.
   */
  delegates?: false;
  /** True when the command also runs outside a Cloudflare OS project. */
  anywhere?: true;
  /**
   * True when the command parses its own arguments, `--help` included: `api`, whose commands and
   * flags are its generated table's. Only the global `--config`, `--account` and `--profile` are
   * taken out; every other token after the command's name reaches it as a positional, verbatim.
   * Its usage errors exit {@link USAGE_EXIT}, so a caller can tell "nothing was sent, fix the
   * command" from a failure of the call itself.
   */
  rawArgs?: true;
  /** The module to run. `inProject` is false only for `init`, which then scaffolds. */
  load(inProject: boolean): Promise<CommandModule>;
}

/** The exit code of a {@link CommandSpec.rawArgs} command's usage error; others' are 1. */
const USAGE_EXIT = 2;

const COMMANDS: Record<string, CommandSpec> = {
  init: {
    summary: "create a project in <dir>, or configure and deploy the one you are in",
    synopsis: "[<dir>] [--out <path>] [--template <git-url|path>] [--ref <branch|tag>]",
    help: [
      "  <dir>                  outside a project: where to create one (asked for when omitted)",
      "  --template <url|path>  starter to clone (default: https://github.com/cloudflare/cloudflare-os-starter)",
      "  --ref <branch|tag>     branch or tag of the starter to clone",
      "  --out <path>           inside a project: write the configuration here instead of in place",
    ],
    options: { out: { type: "string" }, template: { type: "string" }, ref: { type: "string" } },
    positionals: 1,
    failure: "Init failed.",
    anywhere: true,
    load: (inProject) => inProject ? import("./commands/init.ts") : import("./commands/scaffold.ts"),
  },
  import: {
    summary: "take over an instance created by the hosted deploy (read-only against the account)",
    synopsis: "[<instance>] [--out <path>]",
    help: [
      "  <instance>     the hosted instance's name: its router Worker's (asked for when omitted)",
      "  --out <path>   write what was found into this copy of the config (pass --config's path to",
      "                 update it in place). Without it, nothing is written.",
    ],
    options: { out: { type: "string" } },
    positionals: 1,
    failure: "Import failed.",
    load: () => import("./commands/import.ts"),
  },
  access: {
    summary: "find or create the Access application, and write its issuer and audience",
    synopsis: "[--dry-run]",
    help: ["  --dry-run   print the application it would create; create and write nothing"],
    options: { "dry-run": { type: "boolean" } },
    positionals: 0,
    failure: "Access setup failed.",
    load: () => import("./commands/access.ts"),
  },
  secrets: {
    summary: "ask for the optional Gatekeepers' OAuth credentials and set them on their Workers",
    synopsis: "[<slug>...]",
    help: ["  <slug>...   the Gatekeepers to set (default: every selected one that reads secrets)"],
    options: {},
    positionals: Infinity,
    failure: "Setting secrets failed.",
    load: () => import("./commands/secrets.ts"),
  },
  check: {
    summary: "validate, check the account, test, build, and dry-run every deploy",
    synopsis: "",
    help: [],
    options: {},
    positionals: 0,
    failure: "Check failed.",
    load: () => import("./commands/deploy.ts"),
  },
  deploy: {
    summary: "the same checks, then deploy every Worker for real",
    synopsis: "",
    help: [],
    options: {},
    positionals: 0,
    failure: "Deploy failed.",
    load: () => import("./commands/deploy.ts"),
  },
  update: {
    summary: "bring this repository up to date with the starter, or move its Cloudflare OS pin, and write a " +
      "brief for your coding agent",
    synopsis: "[--ref <branch>] [--template <git-url|path>] [--upstream] [--to <ref> [--preview]] [--submodule <path>] " +
      "[--dry-run]",
    help: [
      "  --ref <branch>         starter branch to merge (default: main)",
      "  --template <url|path>  starter to fetch it from (default: https://github.com/cloudflare/cloudflare-os-starter)",
      "  --upstream             move Cloudflare OS on to upstream's main, staged and not committed, for review.",
      "                         Required outside a starter project, where only the pin moves",
      "  --to <ref>             as --upstream, but to this commit, tag or branch on upstream's main. One older",
      "                         than the pin is a rollback; give its full SHA. pull/<n> is a pull request",
      "  --preview              let --to pin an upstream branch or pull request that is not on main, for a",
      "                         merge request's preview deploy; move it to main before merging",
      "  --submodule <path>     the Cloudflare OS submodule (default: the one pointing at upstream)",
      "  --dry-run              list what would be merged; merge, check out and write nothing",
    ],
    options: {
      ref: { type: "string" }, template: { type: "string" }, upstream: { type: "boolean" }, to: { type: "string" }, preview: { type: "boolean" },
      submodule: { type: "string" },
      "dry-run": { type: "boolean" },
    },
    positionals: 0,
    failure: "Update failed.",
    delegates: false,
    anywhere: true,
    load: () => import("./commands/update.ts"),
  },
  api: {
    summary: "call a running instance's API, with the commands generated from the pinned cloudflare-os " +
      "(`cf-os api search \"<task>\"` finds one)",
    synopsis: "[public] <command> [arguments] [<command> [arguments]]... [--url <origin>] [--auth <mode>] " +
      "[--username <name>] [--dry-run] [--timeout <seconds>] [--out <file|->]",
    help: [],
    options: {},
    positionals: 0,
    failure: "API call failed.",
    rawArgs: true,
    // Outside a project there is no deployment file to read the origin from, so `--url` names it.
    anywhere: true,
    load: () => import("./commands/api.ts"),
  },
  install: {
    summary: "install the cloudflare-os submodule's own workspace",
    synopsis: "[--check]",
    help: ["  --check   only report whether the install matches cloudflare-os/pnpm-lock.yaml"],
    options: { check: { type: "boolean" } },
    positionals: 0,
    failure: "Install failed.",
    load: () => import("./commands/install.ts"),
  },
};

function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  return [
    "Usage: cf-os <command> [options]",
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([name, spec]) => `  ${name.padEnd(width)}  ${spec.summary}`),
    "",
    "Options:",
    ...GLOBAL_HELP,
    "",
    "Run `cf-os <command> --help` for a command's own options.",
  ].join("\n");
}

function commandUsage(name: string): string {
  const spec = COMMANDS[name];
  return [
    `Usage: cf-os ${name}${spec.synopsis ? ` ${spec.synopsis}` : ""}`,
    "",
    `${spec.summary[0].toUpperCase()}${spec.summary.slice(1)}.`,
    ...spec.help.length ? ["", "Options:", ...spec.help] : [],
    "",
    "Global options:",
    ...GLOBAL_HELP,
  ].join("\n");
}

/** Where the command name is in `argv`: the first argument that is not an option or its value. */
function commandIndex(argv: string[]): number {
  const takesValue = new Set(Object.entries(GLOBAL_OPTIONS)
    .filter(([, option]) => option.type === "string")
    .map(([name]) => `--${name}`));
  for (let i = 0; i < argv.length; i++) {
    if (takesValue.has(argv[i])) i++;
    else if (!argv[i].startsWith("-")) return i;
  }
  return -1;
}

/**
 * `argv` without the command's name and the global options with a value, which are returned
 * apart, for a {@link CommandSpec.rawArgs} command. Tokens after a `--` are the command's, whatever
 * they look like.
 */
function splitGlobals(argv: string[], at: number): { values: CommandArgs["values"]; rest: string[] } {
  const values: CommandArgs["values"] = {};
  const rest: string[] = [];
  const tokens = argv.toSpliced(at, 1);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") {
      rest.push(...tokens.slice(i));
      break;
    }
    const flag = token.split("=")[0];
    const name = flag.slice(2);
    if (!flag.startsWith("--") || !Object.hasOwn(GLOBAL_OPTIONS, name) ||
      GLOBAL_OPTIONS[name as keyof typeof GLOBAL_OPTIONS].type !== "string") {
      rest.push(token);
      continue;
    }
    if (token.length > flag.length) {
      values[name] = token.slice(flag.length + 1);
    } else {
      if (i + 1 >= tokens.length) throw new Error(`Option '${flag} <value>' argument missing`);
      values[name] = tokens[++i];
    }
  }
  return { values, rest };
}

/** What {@link cli} runs against, so tests can stand in for the process. */
export interface CliDeps {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The running entry point, compared against the project's own to decide whether to delegate. */
  self: string;
  out: Output;
  prompter: Prompter | null;
  spawn: SpawnDelegate;
  /** The Cloudflare client factory. Defaults to `cf-client.ts`, loaded on first use. */
  client?: Context["client"];
}

/**
 * The directory the command was typed in. A package-manager script (`pnpm cf-os` from a
 * subdirectory) runs from its package's directory and records the one it was started from in
 * `INIT_CWD`; that one is taken only when it lies below, so an unrelated outer script's is ignored.
 */
export function invocationDir(cwd: string, env: NodeJS.ProcessEnv): string {
  const started = env.npm_lifecycle_event ? env.INIT_CWD : undefined;
  if (!started) return cwd;
  const below = relative(cwd, started);
  return below && !below.startsWith("..") && !isAbsolute(below) ? started : cwd;
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Runs `cf-os <argv>`, resolving to the exit code. Never exits the process itself. */
export async function cli(argv: string[], deps: CliDeps): Promise<number> {
  const at = commandIndex(argv);
  const name = at < 0 ? undefined : argv[at];
  if (!name) {
    const wantsHelp = argv.includes("--help") || argv.includes("-h");
    if (wantsHelp) process.stdout.write(`${usage()}\n`);
    else deps.out.log(usage());
    return wantsHelp ? 0 : 1;
  }
  // Handed off before anything here reads the arguments: the project's copy may be another version,
  // with commands, options or help this one does not have.
  const root = findProjectRoot(deps.cwd);
  if (root && COMMANDS[name]?.delegates !== false && !deps.env[DELEGATION_SENTINEL]) {
    const local = localEntry(root);
    if (!existsSync(local)) {
      deps.out.log(
        `${root} has no packages/cf-os to hand off to: it predates the cf-os CLI. Bring it up to date ` +
        "with `npx cf-os@latest update`, or use the scripts in its own package.json.");
      return 1;
    }
    if (!samePath(local, deps.self)) {
      // Its dependencies come from the project's install, which a fresh clone has not had yet.
      if (!existsSync(join(dirname(dirname(local)), "node_modules"))) {
        deps.out.log(`${root} is not installed yet: run \`pnpm install\` there, then this again.`);
        return 1;
      }
      return delegate(local, argv, deps);
    }
  }

  const spec = COMMANDS[name];
  if (!spec) {
    deps.out.log(`Unknown command "${name}".\n\n${usage()}`);
    return 1;
  }

  /**
   * A usage error as printed: with the command's usage after it, or, for one parsing its own, alone,
   * since its messages say what to run. Only the global options' parse errors, which are not its
   * own, get a pointer at its help.
   */
  const usageError = (message: string, own: boolean) => !spec.rawArgs ? `${message}\n\n${commandUsage(name)}`
    : own ? message : `${message.replace(/[^.!?]$/, "$&.")} Run \`cf-os ${name} --help\` for its commands and options.`;
  let parsed: { values: CommandArgs["values"]; positionals: string[] };
  try {
    if (spec.rawArgs) {
      const { values, rest } = splitGlobals(argv, at);
      parsed = { values, positionals: rest };
    } else {
      parsed = parseArgs({
        args: argv.toSpliced(at, 1),
        options: { ...GLOBAL_OPTIONS, ...spec.options },
        allowPositionals: true,
        strict: true,
      }) as typeof parsed;
      if (parsed.positionals.length > spec.positionals) {
        throw new Error(`Unexpected argument ${parsed.positionals[spec.positionals]}.`);
      }
    }
  } catch (error) {
    deps.out.log(usageError((error as Error).message, false));
    return spec.rawArgs ? USAGE_EXIT : 1;
  }
  const { values } = parsed;
  if (values.help) {
    process.stdout.write(`${commandUsage(name)}\n`);
    return 0;
  }

  if (!root && !spec.anywhere) {
    deps.out.log(
      "Not in a Cloudflare OS project: no directory here or above holds deployment.jsonc beside " +
      "cloudflare-os/. Run `cf-os init <dir>` to create one.");
    return 1;
  }

  const flags: GlobalFlags = {
    config: values.config as string | undefined,
    account: values.account as string | undefined,
    profile: values.profile as string | undefined,
  };
  const ctx: Context = {
    root: root ?? deps.cwd,
    cwd: deps.cwd,
    flags,
    prompter: deps.prompter,
    out: deps.out,
    client: deps.client ?? (async () => {
      const { cfClient } = await import("./cf-client.ts");
      return cfClient({ profile: flags.profile, cwd: root ?? deps.cwd });
    }),
  };
  try {
    const module = await spec.load(root !== null);
    return await module.run({ command: name, values, positionals: parsed.positionals }, ctx);
  } catch (error) {
    if (error instanceof Cancelled) return 130;
    if (error instanceof UsageError) {
      deps.out.log(usageError(error.message, true));
      return spec.rawArgs ? USAGE_EXIT : 1;
    }
    // One line, no stack: every failure here is a config, account or subprocess problem.
    deps.out.log(`\n${spec.failure} ${(error as Error).message}`);
    return 1;
  }
}

/** This package's version, for `--version`. */
function version(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return String(manifest.version);
}

/**
 * Ends the process with exit code `code`. A failed or cancelled run exits once stdout and stderr have
 * flushed, rather than waiting on a `cf` read still in flight, which is left to finish on its own: it
 * may be refreshing a single-use token (see cf-client.ts `firstAlone`). A successful run is left to
 * the event loop.
 */
export async function finish(code: number, exit: (code: number) => void = process.exit): Promise<void> {
  if (code === 0) {
    process.exitCode = code;
    return;
  }
  await Promise.all([process.stdout, process.stderr].map((stream) =>
    new Promise<void>((flushed) => stream.write("", () => flushed()))));
  exit(code);
}

const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && samePath(process.argv[1], self)) {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    process.stdout.write(`${version()}\n`);
  } else {
    await finish(await cli(argv, {
      cwd: invocationDir(process.cwd(), process.env),
      env: process.env,
      self,
      out: consoleOutput(),
      prompter: terminalPrompter(),
      spawn: spawnSync,
    }));
  }
}
