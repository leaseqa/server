import test from "node:test";
import assert from "node:assert/strict";

import { formatEvidenceSourceLabel, normalizeAssistantAnswer, } from "./service.js";

test("normalizeAssistantAnswer maps model support ids to bullet citation indices", () => {
  const normalized = normalizeAssistantAnswer({
    rawAnswer: JSON.stringify({
      summary: "This clause is mostly consistent with the handbook.",
      bullets: [
        {
          text: "The 30-day timeline matches the handbook rule.",
          supports: ["c2"],
        },
        {
          text: "It leaves out the itemized deduction notice.",
          supports: ["c1", "c2"],
        },
      ],
    }),
    citationIdToIndex: {
      c1: 0,
      c2: 1,
    },
    fallbackCitationIndices: [0, 1],
  });

  assert.equal(
    normalized.summary,
    "This clause is mostly consistent with the handbook.",
  );
  assert.deepEqual(normalized.bullets, [
    {
      text: "The 30-day timeline matches the handbook rule.",
      citationIndices: [1],
    },
    {
      text: "It leaves out the itemized deduction notice.",
      citationIndices: [0, 1],
    },
  ]);
  assert.match(normalized.content, /^This clause is mostly consistent/);
});

test("normalizeAssistantAnswer leaves malformed support ids uncited instead of attaching every source", () => {
  const normalized = normalizeAssistantAnswer({
    rawAnswer: JSON.stringify({
      summary: "This clause needs more support.",
      bullets: [
        {
          text: "This bullet had a bad support id.",
          supports: ["missing-id"],
        },
      ],
    }),
    citationIdToIndex: {
      c1: 0,
      c2: 1,
    },
    fallbackCitationIndices: [0, 1],
  });

  assert.deepEqual(normalized.bullets, [
    {
      text: "This bullet had a bad support id.",
      citationIndices: [],
    },
  ]);
});

test("normalizeAssistantAnswer abstains without citations for plain text answers", () => {
  const normalized = normalizeAssistantAnswer({
    rawAnswer: [
      "### 1. Short Answer",
      "",
      "This clause is mostly consistent with the handbook.",
      "",
      "* The 30-day timeline matches the handbook.",
      "* The clause leaves out the itemized deduction notice.",
      "* The clause does not mention interest.",
    ].join("\n"),
    citationIdToIndex: {
      c1: 0,
    },
    fallbackCitationIndices: [0],
  });

  assert.match(normalized.summary, /could not find enough support/i);
  assert.deepEqual(normalized.bullets, [
    {
      text: "Ask a narrower question or quote the specific clause you want reviewed.",
      citationIndices: [],
    },
  ]);
  assert.doesNotMatch(normalized.content, /30-day timeline/);
});

test("normalizeAssistantAnswer abstains without echoing malformed plain-text answer sections", () => {
  const normalized = normalizeAssistantAnswer({
    rawAnswer: [
      "### Answer",
      "",
      "This clause is mostly consistent with the handbook.",
      "",
      "- The 30-day rule matches the handbook.",
      "This is not legal advice.",
    ].join("\n"),
    citationIdToIndex: {},
    fallbackCitationIndices: [],
  });

  assert.match(normalized.summary, /could not find enough support/i);
  assert.deepEqual(normalized.bullets, [
    {
      text: "Ask a narrower question or quote the specific clause you want reviewed.",
      citationIndices: [],
    },
  ]);
  assert.doesNotMatch(normalized.content, /30-day rule/);
  assert.doesNotMatch(normalized.content, /not legal advice/i);
});

test("normalizeAssistantAnswer abstains when JSON sections fail schema validation", () => {
  const normalized = normalizeAssistantAnswer({
    rawAnswer: JSON.stringify({
      summary: "An answer with the wrong bullets shape.",
      bullets: "not-an-array",
    }),
    citationIdToIndex: { c1: 0 },
    fallbackCitationIndices: [0],
  });

  assert.match(normalized.summary, /could not find enough support/i);
  assert.deepEqual(normalized.bullets[0].citationIndices, []);
  assert.doesNotMatch(normalized.content, /wrong bullets shape/);
});

test("normalizeAssistantAnswer abstains when a bullet omits explicit support ids", () => {
  const normalized = normalizeAssistantAnswer({
    rawAnswer: JSON.stringify({
      summary: "An answer without explicit support ids.",
      bullets: [{ text: "This assertion has no supports field." }],
    }),
    citationIdToIndex: { c1: 0 },
    fallbackCitationIndices: [0],
  });

  assert.match(normalized.summary, /could not find enough support/i);
  assert.deepEqual(normalized.bullets[0].citationIndices, []);
});

test("formatEvidenceSourceLabel makes uploaded clause evidence explicit", () => {
  assert.equal(
    formatEvidenceSourceLabel({
      source_group: "text",
      source_name: "pasted-text",
      chapter_ref: "",
    }),
    "Uploaded clause text",
  );
});
