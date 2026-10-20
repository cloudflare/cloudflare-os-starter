import assert from "node:assert/strict";
import test from "node:test";
import { BACK_HINT, withBack } from "./back.ts";
import type { Output } from "./context.ts";
import { Cancelled, type Prompter } from "./prompt.ts";
import { BACK, CANCEL, DEFAULT, scriptedPrompter, type Step } from "./test-support.ts";

/** Three questions, a line printed before each, and the answers as the result. */
async function threeQuestions(prompter: Prompter, out: Output) {
  out.log("before name");
  const name = await prompter.text("Name", { initial: "acme" });
  out.log(`before color, after ${name}`);
  const color = await prompter.select("Color", [
    { value: "red", label: "red" }, { value: "blue", label: "blue" },
  ], "red");
  out.log("before sure");
  const sure = await prompter.confirm("Sure?", true);
  return { name, color, sure };
}

function run(script: Step[], questions = threeQuestions) {
  const prompter = scriptedPrompter(script);
  const log: string[] = [];
  const out: Output = { json: () => {}, log: (text) => log.push(text) };
  return { prompter, log, result: withBack(prompter, out, questions) };
}

test("Esc asks the previous question again, its earlier answer the default, and the result takes the new answer", async () => {
  const { prompter, log, result } = run([
    ["Name", "first"],
    ["Color", BACK],
    ["Name", DEFAULT],
    ["Color", "blue"],
    ["Sure?", DEFAULT],
  ]);
  assert.deepEqual(await result, { name: "first", color: "blue", sure: true });
  assert.deepEqual(prompter.asked.map(({ message, initial }) => [message, initial]),
    [["Name", "acme"], ["Color", "red"], ["Name", "first"], ["Color", "red"], ["Sure?", true]]);
  assert.ok(prompter.asked.every((asked) => asked.backable));
  assert.deepEqual(log, [
    "before name", BACK_HINT, "before color, after first", "Back to: Name",
    "before name", "before color, after first", "before sure",
  ]);
});

test("a changed answer on the way back carries on from there", async () => {
  const { result } = run([
    ["Name", "first"],
    ["Color", BACK],
    ["Name", "second"],
    ["Color", "blue"],
    ["Sure?", false],
  ]);
  assert.deepEqual(await result, { name: "second", color: "blue", sure: false });
});

test("Esc twice goes back two questions, replaying none of them", async () => {
  const { prompter, log, result } = run([
    ["Name", "first"],
    ["Color", "blue"],
    ["Sure?", BACK],
    ["Color", BACK],
    ["Name", "second"],
    ["Color", DEFAULT],
    ["Sure?", DEFAULT],
  ]);
  assert.deepEqual(await result, { name: "second", color: "red", sure: true });
  assert.deepEqual(prompter.asked.map(({ message, initial }) => [message, initial]), [
    ["Name", "acme"], ["Color", "red"], ["Sure?", true],
    ["Color", "blue"], ["Name", "first"], ["Color", "red"], ["Sure?", true],
  ]);
  assert.deepEqual(log.filter((line) => line.startsWith("Back to")), ["Back to: Color", "Back to: Name"]);
});

test("replayed questions are not asked, and what they print is muted until the question asked again", async () => {
  const { prompter, log, result } = run([
    ["Name", "first"],
    ["Color", "blue"],
    ["Sure?", BACK],
    ["Color", DEFAULT],
    ["Sure?", DEFAULT],
  ]);
  assert.deepEqual(await result, { name: "first", color: "blue", sure: true });
  assert.equal(prompter.asked.filter(({ message }) => message === "Name").length, 1);
  assert.deepEqual(log, [
    "before name", BACK_HINT, "before color, after first", "before sure", "Back to: Color",
    "before color, after first", "before sure",
  ]);
});

test("Esc at the first question asks it again", async () => {
  const { prompter, log, result } = run([
    ["Name", "first"],
    ["Color", BACK],
    ["Name", BACK],
    ["Name", "second"],
    ["Color", DEFAULT],
    ["Sure?", DEFAULT],
  ]);
  assert.deepEqual(await result, { name: "second", color: "red", sure: true });
  assert.deepEqual(prompter.asked.slice(2).map(({ message, initial }) => [message, initial]),
    [["Name", "first"], ["Name", "first"], ["Color", "red"], ["Sure?", true]]);
  assert.equal(log.filter((line) => line === BACK_HINT).length, 1);
});

test("a replay whose question changed asks from there", async () => {
  let attempt = 0;
  const shifting = async (prompter: Prompter, out: Output) => {
    attempt++;
    const extra = await prompter.text(attempt === 1 ? "Extra" : "Extra, reworded", { initial: "none" });
    return { extra, ...await threeQuestions(prompter, out) };
  };
  const { prompter, result } = run([
    ["Extra", "x"], ["Name", "first"], ["Color", "blue"], ["Sure?", BACK],
    ["Extra, reworded", DEFAULT], ["Name", "second"], ["Color", DEFAULT], ["Sure?", DEFAULT],
  ], shifting);
  assert.deepEqual(await result, { extra: "none", name: "second", color: "red", sure: true });
  // Everything from the changed question on is asked, not replayed, with no earlier answer offered.
  assert.deepEqual(prompter.asked.slice(4).map(({ message, initial }) => [message, initial]),
    [["Extra, reworded", "none"], ["Name", "acme"], ["Color", "red"], ["Sure?", true]]);
});

test("Ctrl-C and any other failure pass through", async () => {
  await assert.rejects(run([["Name", "first"], ["Color", CANCEL]]).result, Cancelled);
  await assert.rejects(run([["Name", "first"]], async (prompter) => {
    await prompter.text("Name");
    throw new Error("boom");
  }).result, /boom/);
});

test("without a backable view, the questions run once and Esc is the test's failure", async () => {
  const { backable: _, ...plain } = scriptedPrompter([["Name", "first"], ["Color", BACK]]);
  await assert.rejects(withBack(plain, { json: () => {}, log: () => {} }, threeQuestions),
    /Esc goes back only where a command lets you/);
});
