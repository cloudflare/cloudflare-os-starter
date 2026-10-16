#!/usr/bin/env node

// cfos: scaffold, configure and deploy a self-hosted Cloudflare OS.
//
// This file is the dispatcher, and the only part a globally installed `cfos` ever runs for itself.
// Inside a project it hands every command to that project's own copy (`packages/cfos`), the way a
// global `cf` hands off to a project-local one, so the deploy logic always matches the project's
// pinned `cloudflare-os`. Outside a project, only `init` runs: it scaffolds one.
//
// Commands load lazily. `install` has to work before the submodule is checked out, and the
// `@gadgets/scripts` modules other commands import only resolve once it is -- so nothing imported
// statically here, or by `commands/scaffold.ts`, may reach them. `main.test.ts` checks that.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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
  "  --account <id>     Cloudflare account, ahead of the file's accountId",
  "  --profile <name>   cf sign-in to use, passed to every cf call",
  "  -h, --help         this help",
];

interface CommandSpec {
  summary: string;
  /** What follows `cfos <name>`. */
  synopsis: string;
  /** Option lines beyond the global ones. */
  help: string[];
  options: ParseArgsOptionsConfig;
  positionals: number;
  /** Printed before a failure's message. */
  failure: string;
  /** The module to run. `inProject` is false only for `init`, which then scaffolds. */
  load(inProject: boolean): Promise<CommandModule>;
}

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
    "Usage: cfos <command> [options]",
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([name, spec]) => `  ${name.padEnd(width)}  ${spec.summary}`),
    "",
    "Options:",
    ...GLOBAL_HELP,
    "",
    "Run `cfos <command> --help` for a command's own options.",
  ].join("\n");
}

function commandUsage(name: string): string {
  const spec = COMMANDS[name];
  return [
    `Usage: cfos ${name}${spec.synopsis ? ` ${spec.synopsis}` : ""}`,
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

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Runs `cfos <argv>`, resolving to the exit code. Never exits the process itself. */
export async function cli(argv: string[], deps: CliDeps): Promise<number> {
  const at = commandIndex(argv);
  const name = at < 0 ? undefined : argv[at];
  if (!name) {
    const wantsHelp = argv.includes("--help") || argv.includes("-h");
    if (wantsHelp) process.stdout.write(`${usage()}\n`);
    else deps.out.log(usage());
    return wantsHelp ? 0 : 1;
  }
  const spec = COMMANDS[name];
  if (!spec) {
    deps.out.log(`Unknown command "${name}".\n\n${usage()}`);
    return 1;
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv.toSpliced(at, 1),
      options: { ...GLOBAL_OPTIONS, ...spec.options },
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length > spec.positionals) {
      throw new Error(`Unexpected argument ${parsed.positionals[spec.positionals]}.`);
    }
  } catch (error) {
    deps.out.log(`${(error as Error).message}\n\n${commandUsage(name)}`);
    return 1;
  }
  const values = parsed.values as CommandArgs["values"];
  if (values.help) {
    process.stdout.write(`${commandUsage(name)}\n`);
    return 0;
  }

  const root = findProjectRoot(deps.cwd);
  if (root && !deps.env[DELEGATION_SENTINEL]) {
    const local = localEntry(root);
    if (existsSync(local) && !samePath(local, deps.self)) return delegate(local, argv, deps);
    if (!existsSync(local)) {
      deps.out.log(
        `${root} has no packages/cfos to hand off to: it predates the cfos CLI. Update it from the ` +
        "starter (`git pull starter main`), or use the scripts in its own package.json.");
      return 1;
    }
  }
  if (!root && name !== "init") {
    deps.out.log(
      "Not in a Cloudflare OS project: no directory here or above holds deployment.jsonc beside " +
      "cloudflare-os/. Run `cfos init <dir>` to create one.");
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
      deps.out.log(`${error.message}\n\n${commandUsage(name)}`);
      return 1;
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

const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && samePath(process.argv[1], self)) {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    process.stdout.write(`${version()}\n`);
  } else {
    process.exitCode = await cli(argv, {
      cwd: process.cwd(),
      env: process.env,
      self,
      out: consoleOutput(),
      prompter: terminalPrompter(),
      spawn: spawnSync,
    });
  }
}
