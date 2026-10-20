// Going back a question. A command runs its questions as one function, and Esc on one runs it again:
// the answers before the previous question are replayed without asking, and that question is asked
// again with its earlier answer as the default. At the first question there is nothing to go back
// to, so Esc there cancels, as it does anywhere else. A replay repeats whatever ran between the questions,
// so that has to be reads, which the command can cache; nothing it creates may come before a question.

import type { Output } from "./context.ts";
import {
  Back,
  type Choice,
  type MultiselectOptions,
  type PasswordOptions,
  type Prompter,
  type TextOptions,
} from "./prompt.ts";

/** Printed before the first question asked. */
export const BACK_HINT = "Esc goes back to the previous question; Ctrl-C quits.";

/** One question answered. */
interface Answered {
  kind: "select" | "multiselect" | "text" | "password" | "confirm";
  message: string;
  answer: unknown;
}

/**
 * Runs `run`, whose questions go back on Esc. `run` asks through the prompter it is handed and prints
 * through the output, which is silent while answers are replayed, so nothing prints twice. Without a
 * {@link Prompter.backable} view, `run` runs once, as is.
 */
export async function withBack<T>(
  prompter: Prompter,
  out: Output,
  run: (prompter: Prompter, out: Output) => Promise<T>,
): Promise<T> {
  if (!prompter.backable) return run(prompter, out);
  const live = prompter.backable();
  const history: Answered[] = [];
  /** The question going back asks again, with the answer it had. */
  let reask: Answered | undefined;
  let hinted = false;

  for (;;) {
    let index = 0;
    const replaying = () => index < history.length;
    const quiet: Output = {
      json: (data) => {
        if (!replaying()) out.json(data);
      },
      log: (text) => {
        if (!replaying()) out.log(text);
      },
    };
    const ask = async <A>(
      kind: Answered["kind"],
      message: string,
      prompt: (asker: Prompter, previous: Answered | undefined) => Promise<A>,
    ): Promise<A> => {
      const at = index++;
      if (at < history.length) {
        const record = history[at];
        if (record.kind === kind && record.message === message) return record.answer as A;
        // A different question than last time: ask from here on.
        history.length = at;
      }
      const previous = reask?.kind === kind && reask.message === message ? reask : undefined;
      reask = undefined;
      if (!hinted) out.log(BACK_HINT);
      hinted = true;
      try {
        const answer = await prompt(at === 0 ? prompter : live, previous);
        history.push({ kind, message, answer });
        return answer;
      } catch (error) {
        if (error instanceof Back) {
          reask = history[at - 1];
          history.length = at - 1;
        }
        throw error;
      }
    };

    const asker: Prompter = {
      select<V extends string>(message: string, choices: Choice<V>[], initial?: V) {
        return ask("select", message, (to, previous) => to.select(message, choices,
          choices.find((choice) => choice.value === previous?.answer)?.value ?? initial));
      },
      multiselect<V extends string>(message: string, choices: Choice<V>[], initial: V[], options?: MultiselectOptions) {
        return ask("multiselect", message, (to, previous) => to.multiselect(message, choices,
          Array.isArray(previous?.answer)
            ? (previous.answer as V[]).filter((value) => choices.some((choice) => choice.value === value))
            : initial,
          options));
      },
      text(message: string, options?: TextOptions) {
        return ask("text", message, (to, previous) => to.text(message,
          previous ? { ...options, initial: previous.answer as string } : options));
      },
      // No default: a secret is never offered back.
      password(message: string, options?: PasswordOptions) {
        return ask("password", message, (to) => to.password(message, options));
      },
      confirm(message: string, initial?: boolean) {
        return ask("confirm", message, (to, previous) => to.confirm(message,
          previous ? previous.answer as boolean : initial));
      },
    };

    try {
      return await run(asker, quiet);
    } catch (error) {
      if (!(error instanceof Back)) throw error;
    }
  }
}
