import test from "node:test";
import assert from "node:assert/strict";

import { loadGateCases, runRetrievalGate } from "./corpusGate.js";

const CASES = [
  {
    id: "ch03-deposit",
    expectedSourceGroup: "chapters",
    expectedChapterRefs: ["3"],
    question: "When must my deposit come back?",
  },
  {
    id: "form-repair",
    expectedSourceGroup: "forms",
    expectedSourceNameIncludes: ["repair_demand"],
    question: "Write me a repair demand letter.",
  },
];

const createRetriever = (byQuestion) => async ({ question }) =>
  byQuestion[question] || [];

test("gate passes when every case retrieves an expected chunk", async () => {
  const result = await runRetrievalGate({
    evalCases: CASES,
    collectionName: "leaseqa_knowledge_chunks_abc123abc123",
    embedQuery: async () => [0.1, 0.2],
    retrieveChunks: createRetriever({
      "When must my deposit come back?": [
        { source_group: "chapters", chapter_ref: "3", source_name: "ch03.pdf" },
      ],
      "Write me a repair demand letter.": [
        { source_group: "forms", source_name: "form_10_repair_demand_letter.pdf" },
      ],
    }),
  });

  assert.equal(result.passed, true);
  assert.equal(result.hitRate, 1);
  assert.equal(result.total, 2);
  assert.equal(result.collectionName, "leaseqa_knowledge_chunks_abc123abc123");
  assert.deepEqual(result.misses, []);
});

test("gate fails below the minimum hit rate and names the misses", async () => {
  const result = await runRetrievalGate({
    evalCases: CASES,
    collectionName: "staging",
    embedQuery: async () => [0.1, 0.2],
    retrieveChunks: createRetriever({
      "When must my deposit come back?": [
        { source_group: "chapters", chapter_ref: "3", source_name: "ch03.pdf" },
      ],
      "Write me a repair demand letter.": [
        { source_group: "handouts", source_name: "handout_ch08.pdf" },
      ],
    }),
    minHitRate: 0.9,
  });

  assert.equal(result.passed, false);
  assert.equal(result.hits, 1);
  assert.equal(result.hitRate, 0.5);
  assert.deepEqual(result.misses, [
    {
      id: "form-repair",
      expectedSourceGroup: "forms",
      actualSourceGroups: ["handouts"],
    },
  ]);
});

test("a retrieval error counts as a miss instead of crashing the gate", async () => {
  const result = await runRetrievalGate({
    evalCases: [CASES[0]],
    collectionName: "staging",
    embedQuery: async () => [0.1, 0.2],
    retrieveChunks: async () => {
      throw new Error("milvus unavailable");
    },
    minHitRate: 0.9,
  });

  assert.equal(result.passed, false);
  assert.equal(result.hits, 0);
  assert.deepEqual(result.misses, [
    {
      id: "ch03-deposit",
      expectedSourceGroup: "chapters",
      actualSourceGroups: [],
    },
  ]);
});

test("an empty case list fails closed rather than passing vacuously", async () => {
  const result = await runRetrievalGate({
    evalCases: [],
    collectionName: "staging",
    embedQuery: async () => [0.1, 0.2],
    retrieveChunks: async () => [],
  });

  assert.equal(result.passed, false);
  assert.equal(result.total, 0);
  assert.equal(result.hitRate, 0);
});

test("loadGateCases drops abstain cases because retrieval cannot judge them", async () => {
  const cases = await loadGateCases({
    evalSetPath: "/fake/eval.json",
    readFileFn: async () =>
      JSON.stringify([
        { id: "a", expectedSourceGroup: "chapters", question: "q1" },
        { id: "b", expectAbstain: true, question: "q2" },
      ]),
  });

  assert.deepEqual(
    cases.map((evalCase) => evalCase.id),
    ["a"],
  );
});

test("loadGateCases reads the real tenant-rights eval set by default", async () => {
  const cases = await loadGateCases({});

  assert.equal(cases.length, 27);
  assert.equal(
    cases.every((evalCase) => Boolean(evalCase.expectedSourceGroup)),
    true,
  );
});
