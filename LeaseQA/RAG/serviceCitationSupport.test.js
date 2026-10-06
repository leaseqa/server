import test from "node:test";
import assert from "node:assert/strict";

import { finalizeAssistantCitations } from "./service.js";

test("finalizeAssistantCitations returns only citations explicitly selected by the model", () => {
  const result = finalizeAssistantCitations({
    structuredAnswer: {
      summary: "The handbook gives a deadline.",
      summaryCitationIndices: [1],
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
      summaryCitationIndices: [9],
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
  assert.equal(result.structuredAnswer.abstentionReason, "unsupported_citations");
});

test("finalizeAssistantCitations returns zero citations when no explicit support id was selected", () => {
  const result = finalizeAssistantCitations({
    structuredAnswer: {
      summary: "An uncited answer.",
      summaryCitationIndices: [],
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

test("finalizeAssistantCitations rejects an unsupported summary even when an unrelated bullet is supported", () => {
  const result = finalizeAssistantCitations({
    structuredAnswer: {
      summary: "The landlord must pay triple damages.",
      summaryCitationIndices: [9],
      bullets: [
        {
          text: "The handbook mentions a deposit deadline.",
          citationIndices: [0],
        },
      ],
      content: "The landlord must pay triple damages.",
    },
    candidateCitations: [{ sourceName: "deposit-deadline.pdf" }],
  });

  assert.equal(result.hasExplicitSupport, false);
  assert.deepEqual(result.citations, []);
  assert.doesNotMatch(result.structuredAnswer.content, /triple damages/i);
  assert.match(result.structuredAnswer.summary, /could not find enough support/i);
});
