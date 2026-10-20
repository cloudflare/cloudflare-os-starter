import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Back, Cancelled, clackPrompter, waitOn, type Prompter } from "./prompt.ts";

/** A stand-in terminal input: a stream that can be put in raw mode, as `process.stdin` on a TTY can. */
class TtyInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  setRawMode(mode: boolean) {
    this.isRaw = mode;
    return this;
  }
}

/**
 * A clack prompter on streams of its own, a way to press keys once a prompt is drawn, and what the
 * terminal shows: `shown()` lines, below a line printed before any prompt. `written()` is everything
 * drawn, escapes included. With `tty`, the input is a terminal's; `columns` is the output's width.
 */
function terminal({ tty = false, columns }: { tty?: boolean; columns?: number } = {}) {
  const input = tty ? new TtyInput() : new PassThrough();
  const output = Object.assign(new PassThrough(), columns ? { columns } : {});
  let drawn = "earlier line\n";
  output.on("data", (chunk: Buffer) => drawn += chunk.toString());
  return {
    input,
    prompter: clackPrompter({ input, output }),
    press: (keys: string) => setImmediate(() => input.write(keys)),
    shown: () => screen(drawn),
    written: () => drawn,
  };
}

/**
 * The lines a terminal shows after `text`, trailing blank ones dropped: enough of a terminal for
 * clack, which draws line by line and moves the cursor with CSI A, B, C, D and G, and erases with J and K.
 */
function screen(text: string): string[] {
  const lines = [""];
  let row = 0;
  let column = 0;
  // eslint-disable-next-line no-control-regex -- terminal escapes are what is parsed here
  for (const [, param, command, char] of text.matchAll(/\x1b\[\??(\d*)([A-Za-z])|\x1b[78]|([\s\S])/g)) {
    const n = Number(param || 1);
    if (char === "\n") {
      row++;
      column = 0;
    } else if (char === "\r") column = 0;
    else if (char !== undefined) {
      const line = lines[row].padEnd(column);
      lines[row] = line.slice(0, column) + char + line.slice(column + 1);
      column++;
    } else if (command === "A") row = Math.max(0, row - n);
    else if (command === "B") row += n;
    else if (command === "C") column += n;
    else if (command === "D") column = Math.max(0, column - n);
    else if (command === "G") column = Number(param || 1) - 1;
    else if (command === "J") {
      lines.length = row + 1;
      lines[row] = lines[row].slice(0, column);
    } else if (command === "K") lines[row] = param === "2" ? "" : lines[row].slice(0, column);
    while (lines.length <= row) lines.push("");
  }
  return lines.map((line) => line.trimEnd()).join("\n").trimEnd().split("\n");
}

const pick = (prompter: Prompter) => prompter.select("Pick", [{ value: "a", label: "A" }, { value: "b", label: "B" }]);

test("on the backable view, Esc throws Back and Ctrl-C still cancels", async () => {
  const { input, prompter, press } = terminal();
  press("\x1b");
  await assert.rejects(pick(prompter.backable!()), Back);
  press("\x03");
  await assert.rejects(pick(prompter.backable!()), Cancelled);
  press("\x1b");
  await assert.rejects(prompter.backable!().text("Name", { initial: "acme" }), Back);
  assert.equal(input.listenerCount("keypress"), 0);
});

test("going back erases the question, where cancelling leaves it drawn as cancelled", async () => {
  const { prompter, press, shown } = terminal();
  press("\x1b[B");
  setTimeout(() => press("\x1b"), 20);
  await assert.rejects(pick(prompter.backable!()), Back);
  assert.deepEqual(shown(), ["earlier line"]);
  press("\x1b");
  await assert.rejects(prompter.backable!().text("Name", { initial: "acme" }), Back);
  assert.deepEqual(shown(), ["earlier line"]);

  press("\x03");
  await assert.rejects(pick(prompter.backable!()), Cancelled);
  assert.match(shown().join("\n"), /Pick[\s\S]*Cancelled\./);
});

test("on the plain prompter, Esc cancels", async () => {
  const { prompter, press } = terminal();
  press("\x1b");
  await assert.rejects(pick(prompter), Cancelled);
});

test("the backable view answers as the plain prompter does", async () => {
  const { input, prompter, press } = terminal();
  press("\x1b[B\r");
  assert.equal(await pick(prompter.backable!()), "b");
  press("\r");
  assert.equal(await prompter.backable!().text("Name", { initial: "acme" }), "acme");
  assert.equal(input.listenerCount("keypress"), 0);
});

/** One of clack's spinner frames, either set, then two spaces. */
const FRAME = /^[◒◐◓◑•oO0] {2}/;

test("a wait shows a spinner frame and its message while the work runs, then leaves the screen as it was", async () => {
  const { prompter, shown, written } = terminal();
  const before = shown();
  const listeners = process.listenerCount("SIGINT");
  let during: string[] = [];
  const value = await prompter.busy!("Loading the AI Gateways", async () => {
    await sleep(30);
    during = shown();
    assert.equal(process.listenerCount("SIGINT"), listeners + 1);
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(during.length, 2);
  assert.match(during[1], new RegExp(`${FRAME.source}Loading the AI Gateways$`));
  assert.deepEqual(shown(), before);
  // The cursor, hidden while the spinner shows, is shown again.
  assert.ok(written().includes("\x1b[?25l"));
  assert.ok(written().endsWith("\x1b[?25h"));
  assert.equal(process.listenerCount("SIGINT"), listeners);
});

test("a failed wait passes its error through, and leaves the screen as it was too", async () => {
  const { prompter, shown, written } = terminal();
  const listeners = process.listenerCount("SIGINT");
  const failure = new Error("cf workers list: exited with status 1");
  await assert.rejects(prompter.busy!("Loading your Workers", async () => {
    await sleep(30);
    throw failure;
  }), (error) => error === failure);
  assert.ok(written().includes("Loading your Workers"));
  assert.deepEqual(shown(), ["earlier line"]);
  assert.ok(written().endsWith("\x1b[?25h"));
  assert.equal(process.listenerCount("SIGINT"), listeners);
});

test("what follows a wait draws exactly where it would have without one", async () => {
  const waited = terminal();
  await waited.prompter.busy!("Loading your zones", () => sleep(30));
  waited.press("\r");
  await pick(waited.prompter);
  const plain = terminal();
  plain.press("\r");
  await pick(plain.prompter);
  assert.deepEqual(waited.shown(), plain.shown());
});

test("work already settled draws nothing", async () => {
  const { prompter, written } = terminal();
  const cached = Promise.resolve(["acme"]);
  assert.deepEqual(await prompter.busy!("Loading your Workers", () => cached), ["acme"]);
  assert.equal(written(), "earlier line\n");
});

test("overlapping waits, on either view, share one line showing the newest still in flight", async () => {
  const { prompter, shown } = terminal();
  const zones = Promise.withResolvers<void>();
  const workers = Promise.withResolvers<void>();
  const older = prompter.busy!("Loading your zones", () => zones.promise);
  await sleep(10);
  assert.match(shown()[1], new RegExp(`${FRAME.source}Loading your zones$`));
  const newer = prompter.backable!().busy!("Loading your Workers", () => workers.promise);
  assert.equal(shown().length, 2);
  assert.match(shown()[1], new RegExp(`${FRAME.source}Loading your Workers$`));
  workers.resolve();
  await newer;
  assert.equal(shown().length, 2);
  assert.match(shown()[1], new RegExp(`${FRAME.source}Loading your zones$`));
  zones.resolve();
  await older;
  assert.deepEqual(shown(), ["earlier line"]);
});

test("a message too long for the terminal is cut short of its width, never wrapping", async () => {
  const { prompter, shown } = terminal({ columns: 20 });
  let during: string[] = [];
  await prompter.busy!("Loading the Access applications on this account", async () => {
    await sleep(30);
    during = shown();
  });
  assert.equal(during.length, 2);
  assert.match(during[1], new RegExp(`${FRAME.source}Loading the Ac`));
  assert.ok(during[1].length < 20, `"${during[1]}" fills the terminal's width`);
});

test("Ctrl-C during a wait quits as a cancelled prompt does: Cancelled. and exit code 130", async (t) => {
  const exits: unknown[] = [];
  t.mock.method(process, "exit", ((code?: number) => exits.push(code)) as never);
  const { prompter, shown } = terminal();
  const listeners = process.listenerCount("SIGINT");
  await prompter.busy!("Loading your Workers", async () => {
    await sleep(20);
    process.emit("SIGINT");
  });
  assert.deepEqual(exits, [130]);
  // The spinner's line erased, and clack's own cancel line in its place.
  assert.equal(shown().length, 2);
  assert.match(shown()[1], /^\S {2}Cancelled\.$/);
  assert.equal(process.listenerCount("SIGINT"), listeners);
});

test("on a terminal, a wait holds keys typed meanwhile, quits on Ctrl-C, and gives the input back as it was", async (t) => {
  const exits: unknown[] = [];
  t.mock.method(process, "exit", ((code?: number) => exits.push(code)) as never);
  const { input, prompter, press, shown } = terminal({ tty: true });
  const tty = input as TtyInput;
  const flowing = input.readableFlowing;
  let raw = false;
  await prompter.busy!("Loading your Workers", async () => {
    await sleep(20);
    raw = tty.isRaw;
    input.write("oops");
    await sleep(10);
  });
  assert.ok(raw);
  assert.equal(tty.isRaw, false);
  assert.equal(input.readableFlowing, flowing);
  assert.equal(input.listenerCount("data"), 0);
  // What was typed during the wait is not the next question's answer.
  press("\r");
  assert.equal(await prompter.text("Name", { initial: "acme" }), "acme");

  // After a prompt, the input is paused, and stays so.
  const paused = input.readableFlowing;
  await prompter.busy!("Loading your zones", async () => {
    await sleep(20);
    input.write("\x03");
    await sleep(10);
  });
  assert.deepEqual(exits, [130]);
  assert.match(shown().at(-1)!, /^\S {2}Cancelled\.$/);
  assert.equal(tty.isRaw, false);
  assert.equal(input.readableFlowing, paused);
});

test("waitOn draws through a prompter's busy, and without a prompter just runs the work", async () => {
  const { prompter, written } = terminal();
  assert.equal(await waitOn(prompter, "Loading your zones", async () => {
    await sleep(20);
    return "zones";
  }), "zones");
  assert.ok(written().includes("Loading your zones"));
  assert.equal(await waitOn(null, "Loading your zones", async () => "zones"), "zones");
  await assert.rejects(waitOn(undefined, "Loading your zones", async () => {
    throw new Error("boom");
  }), /boom/);
});
