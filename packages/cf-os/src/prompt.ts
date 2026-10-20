// Interactive questions, behind `cf`'s rule (packages/cli/src/lib/interactive.ts): prompt only when
// stdin and stdout are both terminals and the run is not CI, where a prompt would hang the pipeline
// rather than ask anyone. Every question has a flag or config equivalent, for when nobody is there.
//
// `@clack/prompts`, as `cf` uses. A cancelled prompt throws {@link Cancelled}, which the CLI turns into
// exit code 130, as `cf` and wrangler do. Ctrl-C cancels; so does Esc, except on a prompter's
// {@link Prompter.backable} view, where a command lets Esc go back a question instead (back.ts).

import type { Readable, Writable } from "node:stream";
import { cancel, confirm, isCancel, multiselect, password, select, text, type Option } from "@clack/prompts";

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

/** Options for {@link Prompter.password}. */
export interface PasswordOptions {
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
  /** As {@link text}, the answer masked as it is typed, with nothing offered as a default. */
  password(message: string, options?: PasswordOptions): Promise<string>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
  /**
   * The same prompter, on which Esc throws {@link Back} rather than cancelling. Absent on one that
   * cannot go back.
   */
  backable?(): Prompter;
}

/** The person at the terminal cancelled a prompt. */
export class Cancelled extends Error {
  constructor() {
    super("Cancelled.");
  }
}

/** The person at the terminal pressed Esc on a {@link Prompter.backable} prompt, to go back a question. */
export class Back extends Error {
  constructor() {
    super("Back.");
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

function answered<T>(value: T | symbol, output?: Writable): T {
  if (isCancel(value)) {
    cancel("Cancelled.", { output });
    throw new Cancelled();
  }
  return value as T;
}

/** Where clack reads keys and draws, which a test replaces with streams of its own. */
export interface Streams {
  input?: Readable;
  output?: Writable;
}

/** A {@link Prompter} on the terminal, or null when nobody is there to answer one. */
export function terminalPrompter(): Prompter | null {
  return isInteractive() ? clackPrompter() : null;
}

/**
 * A {@link Prompter} drawing with clack on `streams`, the process's own by default. With `back`, Esc
 * throws {@link Back}: clack cancels on Esc and Ctrl-C alike, so a listener beside clack's notes
 * which key it was. Clack still draws the question as cancelled, and Ctrl-C still cancels.
 */
export function clackPrompter({ input = process.stdin, output = process.stdout }: Streams = {}, back = false): Prompter {
  const ask = async <T>(prompt: (streams: { input: Readable; output: Writable }) => Promise<T | symbol>): Promise<T> => {
    let escaped = false;
    const onKeypress = (_: unknown, key?: { name?: string }) => {
      if (key?.name === "escape") escaped = true;
    };
    // After clack's own, which the prompt adds as it starts: clack then sees the key first.
    const pending = prompt({ input, output });
    if (back) input.on("keypress", onKeypress);
    try {
      const value = await pending;
      if (back && escaped && isCancel(value)) throw new Back();
      return answered<T>(value, output);
    } finally {
      input.off("keypress", onKeypress);
    }
  };
  return {
    // The casts: clack's `Option<T>` is a conditional type, which an unresolved `T` cannot satisfy.
    async select<T extends string>(message: string, choices: Choice<T>[], initial?: T) {
      return ask<T>((streams) => select({ ...streams, message, options: choices as Option<T>[], initialValue: initial }));
    },
    async multiselect<T extends string>(
      message: string, choices: Choice<T>[], initial: T[], { required = true }: MultiselectOptions = {},
    ) {
      return ask<T[]>((streams) => multiselect({
        ...streams, message, options: choices as Option<T>[], initialValues: initial, required,
      }));
    },
    async text(message, { initial, validate } = {}) {
      return ask<string>((streams) => text({
        ...streams,
        message,
        placeholder: initial,
        defaultValue: initial,
        // clack validates the raw input, before an empty one falls back to the default.
        validate: validate && ((value) => validate(value || initial || "")),
      }));
    },
    async password(message, { validate } = {}) {
      return ask<string>((streams) => password({
        ...streams, message, validate: validate && ((value) => validate(value ?? "")),
      }));
    },
    async confirm(message, initial = true) {
      return ask<boolean>((streams) => confirm({ ...streams, message, initialValue: initial }));
    },
    backable: () => clackPrompter({ input, output }, true),
  };
}
