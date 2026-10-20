// Interactive questions, behind `cf`'s rule (packages/cli/src/lib/interactive.ts): prompt only when
// stdin and stdout are both terminals and the run is not CI, where a prompt would hang the pipeline
// rather than ask anyone. Every question has a flag or config equivalent, for when nobody is there.
//
// `@clack/prompts`, as `cf` uses. A cancelled prompt throws {@link Cancelled}, which the CLI turns into
// exit code 130, as `cf` and wrangler do. Ctrl-C cancels; so does Esc, except on a prompter's
// {@link Prompter.backable} view, where a command lets Esc go back a question instead (back.ts).
//
// A step blocked on the network shows a spinner ({@link Prompter.busy}); like the questions, it is
// drawn only on a terminal, so a run without one prints nothing extra.

import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import {
  cancel, confirm, isCancel, multiselect, password, S_BAR, S_STEP_CANCEL, select, symbol, symbolBar, text, unicode,
  type Option,
} from "@clack/prompts";

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
   * Runs `work`, `message` shown beside a spinner until it settles, for a step waiting on the
   * network; its value or error passes through. Absent on a prompter that draws nothing:
   * {@link waitOn} runs the work either way.
   */
  busy?<T>(message: string, work: () => Promise<T>): Promise<T>;
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

/**
 * Runs `work` behind `prompter`'s spinner, labelled `message`, or just runs it where there is no
 * prompter or it draws none.
 */
export function waitOn<T>(prompter: Prompter | null | undefined, message: string, work: () => Promise<T>): Promise<T> {
  return prompter?.busy ? prompter.busy(message, work) : work();
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
 * `output`, on which, once `escaped()`, clack's cancelled frame is drawn grey rather than red: going
 * back is not cancelling. The red parts are recomputed as clack computes them, so they match under
 * any colour setting.
 */
function rewound(output: Writable, escaped: () => boolean): Writable {
  const write = (chunk: unknown, ...rest: unknown[]) => {
    if (escaped() && typeof chunk === "string") {
      chunk = chunk
        .replaceAll(symbol("cancel"), styleText("gray", S_STEP_CANCEL))
        .replaceAll(symbolBar("cancel")!, styleText("gray", S_BAR));
    }
    return (output.write as (...args: unknown[]) => boolean)(chunk, ...rest);
  };
  return new Proxy(output, {
    get(target, key) {
      if (key === "write") return write;
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Clack's spinner frames, which it draws in magenta, and how often it draws the next. */
const FRAMES = unicode ? ["◒", "◐", "◓", "◑"] : ["•", "o", "O", "0"];
const FRAME_INTERVAL = 80;

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** An input stream that may be a terminal, which can then be put in raw mode. */
type TerminalInput = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown };

/**
 * Holds a terminal `input` raw while a spinner shows, so a key typed is not echoed into it, and
 * reads it, so Ctrl-C, a byte in raw mode, still quits (`interrupt`). Returns how to put it back.
 */
function holdInput(input: Readable, interrupt: () => void): () => void {
  const terminal = input as TerminalInput;
  if (!terminal.isTTY || !terminal.setRawMode) return () => {};
  const raw = terminal.isRaw ?? false;
  const flowing = input.readableFlowing;
  const onData = (chunk: Buffer | string) => {
    if (String(chunk).includes("\x03")) interrupt();
  };
  terminal.setRawMode(true);
  input.on("data", onData);
  input.resume();
  return () => {
    input.off("data", onData);
    terminal.setRawMode!(raw);
    if (flowing) return;
    input.pause();
    // `pause` marks a stream nothing had read yet (null) as paused (false), from which a later
    // `data` listener would no longer start it.
    (input as { readableFlowing: boolean | null }).readableFlowing = flowing;
  };
}

/**
 * {@link Prompter.busy} on `output`: one line showing the newest call still in flight, erased once
 * the last settles. The first frame waits for a timer, so work already settled draws nothing. Ctrl-C
 * quits as on a prompt.
 */
function spinner(input: Readable, output: Writable): NonNullable<Prompter["busy"]> {
  /** The calls in flight, oldest first. */
  const waiting: { message: string }[] = [];
  let timer: NodeJS.Timeout | undefined;
  let frame = 0;
  let shown = false;
  let releaseInput: (() => void) | undefined;

  const draw = () => {
    // Short of the last column, where some terminals wrap at once.
    const width = Math.max(1, ((output as { columns?: number }).columns || 80) - 1);
    const rest = [...`  ${waiting.at(-1)?.message ?? ""}`].slice(0, width - 1).join("");
    output.write(`\r${styleText("magenta", FRAMES[frame])}${rest}\x1b[K`);
  };
  const clear = () => {
    clearInterval(timer);
    timer = undefined;
    if (!shown) return;
    shown = false;
    process.off("SIGINT", interrupt);
    releaseInput?.();
    releaseInput = undefined;
    output.write(`\r\x1b[K${SHOW_CURSOR}`);
  };
  const interrupt = () => {
    clear();
    cancel("Cancelled.", { output });
    process.exit(130);
  };
  const show = () => {
    shown = true;
    output.write(HIDE_CURSOR);
    process.once("SIGINT", interrupt);
    releaseInput = holdInput(input, interrupt);
    draw();
    timer = setInterval(() => {
      frame = (frame + 1) % FRAMES.length;
      draw();
    }, FRAME_INTERVAL);
  };

  return async (message, work) => {
    const call = { message };
    waiting.push(call);
    if (waiting.length === 1) timer = setTimeout(show, 0);
    else if (shown) draw();
    try {
      return await work();
    } finally {
      waiting.splice(waiting.indexOf(call), 1);
      if (!waiting.length) clear();
      else if (shown) draw();
    }
  };
}

/**
 * A {@link Prompter} drawing with clack on `streams`, the process's own by default. With `back`, Esc
 * throws {@link Back}; clack cancels on Esc and Ctrl-C alike, so a listener ahead of clack's notes
 * which key it was.
 */
export function clackPrompter({ input = process.stdin, output = process.stdout }: Streams = {}, back = false): Prompter {
  return clackView(input, output, back, spinner(input, output));
}

/** {@link clackPrompter}, its views sharing one spinner, so overlapping waits on either draw one line. */
function clackView(input: Readable, output: Writable, back: boolean, busy: NonNullable<Prompter["busy"]>): Prompter {
  const ask = async <T>(prompt: (streams: { input: Readable; output: Writable }) => Promise<T | symbol>): Promise<T> => {
    let escaped = false;
    const onKeypress = (_: unknown, key?: { name?: string }) => {
      escaped = key?.name === "escape";
    };
    // Ahead of clack's own, so the frame clack draws for a key is drawn knowing whether it was Esc.
    if (back) input.prependListener("keypress", onKeypress);
    try {
      const value = await prompt({ input, output: back ? rewound(output, () => escaped) : output });
      if (back && escaped && isCancel(value)) {
        output.write(`${styleText("gray", S_BAR)}  ${styleText("gray", "Rewound.")}\n`);
        throw new Back();
      }
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
    busy,
    backable: () => clackView(input, output, true, busy),
  };
}
