import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Back, Cancelled, clackPrompter, type Prompter } from "./prompt.ts";

/**
 * A clack prompter on streams of its own, a way to press keys once a prompt is drawn, and what the
 * terminal shows: `shown()` lines, below a line printed before any prompt.
 */
function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let drawn = "earlier line\n";
  output.on("data", (chunk: Buffer) => drawn += chunk.toString());
  return {
    input,
    prompter: clackPrompter({ input, output }),
    press: (keys: string) => setImmediate(() => input.write(keys)),
    shown: () => screen(drawn),
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
