import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Back, Cancelled, clackPrompter, type Prompter } from "./prompt.ts";

/** A clack prompter on streams of its own, and a way to press keys once a prompt is drawn. */
function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  return { input, prompter: clackPrompter({ input, output }), press: (keys: string) => setImmediate(() => input.write(keys)) };
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
