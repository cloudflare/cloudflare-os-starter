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
  // The first question cannot go back, so it is asked as any other prompt is.
  assert.deepEqual(prompter.asked.map(({ backable }) => Boolean(backable)), [false, true, false, true, true]);
  assert.deepEqual(log, [
    "before name", BACK_HINT, "before color, after first",
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
  const { prompter, result } = run([
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
    "before name", BACK_HINT, "before color, after first", "before sure",
    "before color, after first", "before sure",
  ]);
});

test("Esc at the first question cancels, there being nothing to go back to", async () => {
  await assert.rejects(run([["Name", BACK]]).result, Cancelled);
  const back = run([["Name", "first"], ["Color", BACK], ["Name", BACK]]);
  await assert.rejects(back.result, Cancelled);
  assert.equal(back.prompter.asked[2].initial, "first");
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

test("without a backable view, the questions run once and Esc cancels", async () => {
  const { backable: _, ...plain } = scriptedPrompter([["Name", "first"], ["Color", BACK]]);
  await assert.rejects(withBack(plain, { json: () => {}, log: () => {} }, threeQuestions), Cancelled);
});

/** Four questions, a wait for the second one's choices between the first two. */
async function waitingQuestions(prompter: Prompter) {
  const name = await prompter.text("Name", { initial: "acme" });
  const colors = await prompter.busy!(`Loading the colors for ${name}`, async () => ["red", "blue"]);
  const color = await prompter.select("Color", colors.map((value) => ({ value, label: value })), "red");
  const sure = await prompter.confirm("Sure?", true);
  const size = await prompter.text("Size", { initial: "m" });
  return { name, colors, color, sure, size };
}

test("a wait shows through the prompter on a question asked, and draws nothing while answers are replayed", async () => {
  // Esc at Size replays Name and Color, the wait between them included, and asks Sure? again.
  const prompter = scriptedPrompter([
    ["Name", "first"], ["Color", "blue"], ["Sure?", false], ["Size", BACK], ["Sure?", DEFAULT], ["Size", "l"],
  ]);
  assert.deepEqual(await withBack(prompter, { json: () => {}, log: () => {} }, waitingQuestions), { name: "first", colors: ["red", "blue"], color: "blue", sure: false, size: "l" });
  assert.deepEqual(prompter.waited, ["Loading the colors for first"]);
  assert.deepEqual(prompter.answered, ["Name", "Color", "Sure?", "Sure?", "Size"]);
});
