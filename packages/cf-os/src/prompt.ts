// Interactive questions, behind `cf`'s rule (packages/cli/src/lib/interactive.ts): prompt only when
// stdin and stdout are both terminals and the run is not CI, where a prompt would hang the pipeline
// rather than ask anyone. Every question has a flag or config equivalent, for when nobody is there.
//
// `@clack/prompts`, as `cf` uses. A cancelled prompt (Ctrl-C, Esc) throws {@link Cancelled}, which
// the CLI turns into exit code 130, as `cf` and wrangler do.

import { cancel, confirm, isCancel, multiselect, select, text, type Option } from "@clack/prompts";

/** One choice in a {@link Prompter.select}. */
export interface Choice<T extends string = string> {
  value: T;
  label: string;
  /** Dim text beside the label, such as an account ID. */
  hint?: string;
}

/** Options for {@link Prompter.text}. */
export interface TextOptions {
  /** Offered as the answer; Enter accepts it. */
  initial?: string;
  /** Why an answer is unacceptable, or undefined to accept it. */
  validate?: (value: string) => string | undefined;
}

/** Options for {@link Prompter.multiselect}. */
export interface MultiselectOptions {
  /** Whether at least one choice has to be picked. On by default. */
  required?: boolean;
}

/** Asks the person at the terminal. Every method throws {@link Cancelled} when they cancel. */
export interface Prompter {
  select<T extends string>(message: string, choices: Choice<T>[], initial?: T): Promise<T>;
  multiselect<T extends string>(
    message: string, choices: Choice<T>[], initial: T[], options?: MultiselectOptions,
  ): Promise<T[]>;
  text(message: string, options?: TextOptions): Promise<string>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
}

/** The person at the terminal cancelled a prompt. */
export class Cancelled extends Error {
  constructor() {
    super("Cancelled.");
  }
}

/** Whether to prompt at all: both ends a terminal, and not CI. */
export function isInteractive(
  env: NodeJS.ProcessEnv = process.env,
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY) && !env.CI;
}

function answered<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Cancelled.");
    throw new Cancelled();
  }
  return value as T;
}

/** A {@link Prompter} on the terminal, or null when nobody is there to answer one. */
export function terminalPrompter(): Prompter | null {
  if (!isInteractive()) return null;
  return {
    // The casts: clack's `Option<T>` is a conditional type, which an unresolved `T` cannot satisfy.
    async select<T extends string>(message: string, choices: Choice<T>[], initial?: T) {
      return answered<T>(await select({ message, options: choices as Option<T>[], initialValue: initial }));
    },
    async multiselect<T extends string>(
      message: string, choices: Choice<T>[], initial: T[], { required = true }: MultiselectOptions = {},
    ) {
      return answered<T[]>(await multiselect({
        message, options: choices as Option<T>[], initialValues: initial, required,
      }));
    },
    async text(message, { initial, validate } = {}) {
      return answered<string>(await text({
        message,
        placeholder: initial,
        defaultValue: initial,
        // clack validates the raw input, before an empty one falls back to the default.
        validate: validate && ((value) => validate(value || initial || "")),
      }));
    },
    async confirm(message, initial = true) {
      return answered<boolean>(await confirm({ message, initialValue: initial }));
    },
  };
}
