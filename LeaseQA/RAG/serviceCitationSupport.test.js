import test from "node:test";
import assert from "node:assert/strict";

import {
  finalizeAssistantCitations,
  resolveSupportedCitationChunks,
} from "./service.js";

const createChunk = ({
                       id,
                       sourceGroup,
                       sourceName,
                       chapterRef = "",
                       score,
                     }) => ({
  id,
  source_group: sourceGroup,
  source_name: sourceName,
  chapter_ref: chapterRef,
  score,
});

test("resolveSupportedCitationChunks rejects clause legality questions when uploaded-clause support is missing", () => {
  const supportedChunks = resolveSupportedCitationChunks({
    question:
      "Is this clause legal under the tenant-rights handbook, and what tenant protections are missing?",
    citationChunks: [],
    knowledgeChunks: [
      createChunk({
        id: "kb-1",
        sourceGroup: "chapters",
        sourceName: "ch03_security_deposits.pdf",
        chapterRef: "3",
        score: 0.91,
      }),
    ],
  });

  assert.equal(supportedChunks.length, 0);
});

test("finalizeAssistantCitations returns only citations explicitly selected by the model", () => {
  const result = finalizeAssistantCitations({
    structuredAnswer: {
      summary: "The handbook gives a deadline.",
      bullets: [
        {
          text: "The deadline is described in the handbook.",
          citationIndices: [1],
        },
      ],
      content: "The handbook gives a deadline.",
    },
    candidateCitations: [
      { sourceName: "uploaded-lease.pdf" },
      { sourceName: "tenant-handbook.pdf" },
    ],
  });

  assert.deepEqual(result.citations, [{ sourceName: "tenant-handbook.pdf" }]);
  assert.deepEqual(result.structuredAnswer.bullets[0].citationIndices, [0]);
  assert.equal(result.hasExplicitSupport, true);
});

test("finalizeAssistantCitations drops selected citations absent from retrieval and fails the support gate", () => {
  const result = finalizeAssistantCitations({
    structuredAnswer: {
      summary: "A fabricated answer.",
      bullets: [
        {
          text: "This cites an item that was not retrieved.",
          citationIndices: [9],
        },
      ],
      content: "A fabricated answer.",
    },
    candidateCitations: [{ sourceName: "only-retrieved-source.pdf" }],
  });

  assert.equal(result.hasExplicitSupport, false);
  assert.deepEqual(result.citations, []);
  assert.match(result.structuredAnswer.summary, /could not find enough support/i);
  assert.doesNotMatch(result.structuredAnswer.content, /fabricated answer/i);
});

test("finalizeAssistantCitations returns zero citations when no explicit support id was selected", () => {
  const result = finalizeAssistantCitations({
    structuredAnswer: {
      summary: "An uncited answer.",
      bullets: [
        {
          text: "No model support ids resolved.",
          citationIndices: [],
        },
      ],
      content: "An uncited answer.",
    },
    candidateCitations: [
      { sourceName: "candidate-one.pdf" },
      { sourceName: "candidate-two.pdf" },
    ],
  });

  assert.equal(result.hasExplicitSupport, false);
  assert.deepEqual(result.citations, []);
});
