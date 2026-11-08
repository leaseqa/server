import test from "node:test";
import assert from "node:assert/strict";

import { createDraftTracker, parsePartialJsonObject } from "./answerDraft.js";

const MODEL_ANSWER = JSON.stringify({
  summary: "The deposit is capped at one month's rent.",
  summarySupports: ["c1"],
  bullets: [
    { text: "Two months' rent is more than the law allows.", supports: ["c1"] },
    { text: "A \"non-refundable\" fee is not allowed.", supports: ["c2"] },
  ],
});

const applyDeltas = (draft, deltas) => {
  for ( const delta of deltas ) {
    if ( delta.part === "summary" ) {
      draft.summary += delta.text;
    } else {
      draft.bullets[delta.index] = (draft.bullets[delta.index] || "") + delta.text;
    }
  }
  return draft;
};

test("parsePartialJsonObject closes a string and its brackets mid-word", () => {
  assert.deepEqual(parsePartialJsonObject('{"summary": "The dep'), {
    summary: "The dep",
  });
  assert.deepEqual(
    parsePartialJsonObject('{"summary":"Done.","bullets":[{"text":"Two mon'),
    { summary: "Done.", bullets: [{ text: "Two mon" }] },
  );
});

test("parsePartialJsonObject drops half-written escapes instead of failing", () => {
  assert.deepEqual(parsePartialJsonObject('{"summary": "A \\'), { summary: "A " });
  assert.deepEqual(parsePartialJsonObject('{"summary": "caf\\u00'), {
    summary: "caf",
  });
  assert.deepEqual(parsePartialJsonObject('{"summary": "caf\\u00e9'), {
    summary: "café",
  });
  // A complete escaped backslash is content, not a half-written escape.
  assert.deepEqual(parsePartialJsonObject('{"summary": "a\\\\'), {
    summary: "a\\",
  });
});

test("parsePartialJsonObject skips a fence and anything after the object", () => {
  assert.deepEqual(
    parsePartialJsonObject('```json\n{"summary": "Short."}\n```'),
    { summary: "Short." },
  );
});

test("parsePartialJsonObject returns null until there is a value to read", () => {
  assert.equal(parsePartialJsonObject(""), null);
  assert.equal(parsePartialJsonObject("```json"), null);
  assert.equal(parsePartialJsonObject('{"summ'), null);
  assert.equal(parsePartialJsonObject('{"summary": "Done.", "bullets"'), null);
  assert.equal(parsePartialJsonObject('{"a": [}'), null);
});

test("the draft rebuilds the summary and bullets from any chunking", () => {
  for ( const chunkSize of [1, 3, 7, 40, MODEL_ANSWER.length] ) {
    const tracker = createDraftTracker();
    const draft = { summary: "", bullets: [] };
    for ( let end = chunkSize; end < MODEL_ANSWER.length + chunkSize; end += chunkSize ) {
      applyDeltas(draft, tracker.update(MODEL_ANSWER.slice(0, end)));
    }
    assert.deepEqual(draft, {
      summary: "The deposit is capped at one month's rent.",
      bullets: [
        "Two months' rent is more than the law allows.",
        "A \"non-refundable\" fee is not allowed.",
      ],
    }, `chunk size ${chunkSize}`);
  }
});

test("the draft reports only new text and never repeats itself", () => {
  const tracker = createDraftTracker();
  assert.deepEqual(tracker.update('{"summary": "The'), [
    { part: "summary", text: "The" },
  ]);
  assert.deepEqual(tracker.update('{"summary": "The'), []);
  assert.deepEqual(tracker.update('{"summary": "The deposit", "summarySupports": ["c1"'), [
    { part: "summary", text: " deposit" },
  ]);
  assert.deepEqual(
    tracker.update('{"summary": "The deposit", "summarySupports": ["c1"], "bullets": [{"text": "Two'),
    [{ part: "bullet", index: 0, text: "Two" }],
  );
});

test("support ids and unknown fields never reach the draft", () => {
  const tracker = createDraftTracker();
  const deltas = tracker.update(
    '{"summarySupports": ["c1"], "note": "internal", "bullets": [{"supports": ["c2"]}]}',
  );
  assert.deepEqual(deltas, []);
});
