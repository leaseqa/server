import test from "node:test";
import assert from "node:assert/strict";
import {
  hasReliableCitationSupport,
  questionTargetsUploadedSource,
  selectCitationChunks,
} from "./citationSelection.js";

const createChunk = ({
                       id,
                       sourceGroup,
                       sourceName,
                       score,
                       text = "chunk text",
                     }) => ({
  id,
  source_group: sourceGroup,
  source_name: sourceName,
  source_type: sourceGroup === "chapters" ? "chapter" : sourceGroup,
  chapter_ref: sourceGroup === "chapters" ? "8" : "",
  file_path: null,
  source_url: null,
  text,
  score,
});

test("questionTargetsUploadedSource detects lease-specific questions", () => {
  assert.equal(
    questionTargetsUploadedSource(
      "Can my landlord enter whenever they want if my lease says 24 hours notice?",
    ),
    true,
  );
});

test("questionTargetsUploadedSource detects uploaded form questions", () => {
  assert.equal(
    questionTargetsUploadedSource(
      "In the uploaded form, what does the tenant ask the landlord to do within 30 days?",
    ),
    true,
  );
});

test("questionTargetsUploadedSource ignores general legal questions", () => {
  assert.equal(
    questionTargetsUploadedSource(
      "My landlord shut off heat and hot water. What can I do?",
    ),
    false,
  );
});

test("selectCitationChunks prioritizes uploaded source for lease-specific questions", () => {
  const sessionChunk = createChunk({
    id: "upload-1",
    sourceGroup: "text",
    sourceName: "pasted-text",
    score: 0.98,
  });
  const knowledgeChunk = createChunk({
    id: "kb-1",
    sourceGroup: "chapters",
    sourceName: "ch08_getting_repairs_made.pdf",
    score: 0.95,
  });

  const citations = selectCitationChunks({
    question:
      "Can my landlord enter whenever they want if my lease says 24 hours notice?",
    sessionChunks: [sessionChunk],
    knowledgeChunks: [knowledgeChunk],
    limit: 2,
  });

  assert.equal(citations[0].id, "upload-1");
  assert.equal(citations[1].id, "kb-1");
});

test("selectCitationChunks prioritizes uploaded source for uploaded form questions", () => {
  const sessionChunk = createChunk({
    id: "upload-1",
    sourceGroup: "upload",
    sourceName: "form_05_security_deposit_demand_letter.pdf",
    score: 0.81,
  });
  const knowledgeChunk = createChunk({
    id: "kb-1",
    sourceGroup: "forms",
    sourceName: "form_03_statement_of_condition.pdf",
    score: 0.95,
  });

  const citations = selectCitationChunks({
    question:
      "In the uploaded form, what does the tenant ask the landlord to do within 30 days?",
    sessionChunks: [sessionChunk],
    knowledgeChunks: [knowledgeChunk],
    limit: 2,
  });

  assert.equal(citations[0].id, "upload-1");
  assert.equal(citations[1].id, "kb-1");
});

test("selectCitationChunks includes handbook support for uploaded clause legality questions", () => {
  const sessionChunk = createChunk({
    id: "upload-1",
    sourceGroup: "text",
    sourceName: "pasted-text",
    score: 0.98,
  });
  const secondSessionChunk = createChunk({
    id: "upload-2",
    sourceGroup: "text",
    sourceName: "pasted-text",
    score: 0.96,
  });
  const handbookChunk = {
    ...createChunk({
      id: "kb-1",
      sourceGroup: "chapters",
      sourceName: "ch03_security_deposits.pdf",
      score: 0.91,
    }),
    chapter_ref: "3",
  };

  const citations = selectCitationChunks({
    question:
      "Is this clause legal under the tenant-rights handbook, and what tenant protections are missing?",
    sessionChunks: [sessionChunk, secondSessionChunk],
    knowledgeChunks: [handbookChunk],
    limit: 2,
  });

  assert.equal(citations.length, 2);
  assert.equal(citations[0].id, "upload-1");
  assert.equal(citations[1].id, "kb-1");
});

test("selectCitationChunks keeps both uploaded and handbook citations when chunk ids are missing", () => {
  const citations = selectCitationChunks({
    question:
      "Is this clause legal under the tenant-rights handbook, and what tenant protections are missing?",
    sessionChunks: [
      {
        source_group: "text",
        source_name: "pasted-text",
        source_type: "text",
        chapter_ref: "",
        file_path: null,
        source_url: null,
        text: "The landlord must return the security deposit within 30 days.",
        score: 0.98,
      },
    ],
    knowledgeChunks: [
      {
        source_group: "chapters",
        source_name: "ch03_security_deposits.pdf",
        source_type: "chapter",
        chapter_ref: "3",
        file_path: null,
        source_url: null,
        text: "A landlord must return the security deposit within 30 days after the tenancy ends.",
        score: 0.91,
      },
    ],
    limit: 2,
  });

  assert.equal(citations.length, 2);
  assert.equal(citations[0].source_group, "text");
  assert.equal(citations[1].source_group, "chapters");
});

test("selectCitationChunks prioritizes knowledge base for general legal questions", () => {
  const sessionChunk = createChunk({
    id: "upload-1",
    sourceGroup: "text",
    sourceName: "pasted-text",
    score: 0.99,
  });
  const knowledgeChunk = createChunk({
    id: "kb-1",
    sourceGroup: "chapters",
    sourceName: "ch06_utilities.pdf",
    score: 0.75,
  });

  const citations = selectCitationChunks({
    question: "My landlord shut off heat and hot water. What can I do?",
    sessionChunks: [sessionChunk],
    knowledgeChunks: [knowledgeChunk],
    limit: 1,
  });

  assert.equal(citations[0].id, "kb-1");
});

test("hasReliableCitationSupport rejects template questions when top citation is not a form", () => {
  const chapterChunk = createChunk({
    id: "kb-1",
    sourceGroup: "chapters",
    sourceName: "ch08_getting_repairs_made.pdf",
    score: 0.91,
  });

  assert.equal(
    hasReliableCitationSupport({
      question: "Can you draft a repair demand letter for my landlord?",
      citationChunks: [chapterChunk],
    }),
    false,
  );
});

test("hasReliableCitationSupport rejects booklet-style eviction questions when top citation is not a booklet", () => {
  const chapterChunk = createChunk({
    id: "kb-1",
    sourceGroup: "chapters",
    sourceName: "ch12_evictions.pdf",
    score: 0.91,
  });

  assert.equal(
    hasReliableCitationSupport({
      question: "In a summary process eviction, how do I file an answer?",
      citationChunks: [chapterChunk],
    }),
    false,
  );
});

test("hasReliableCitationSupport rejects lead questions when top citation is not chapter 9", () => {
  const wrongChapterChunk = {
    ...createChunk({
      id: "kb-1",
      sourceGroup: "chapters",
      sourceName: "ch07_discrimination.pdf",
      score: 0.91,
    }),
    chapter_ref: "7",
  };

  assert.equal(
    hasReliableCitationSupport({
      question:
        "What must a landlord do if a child under 6 lives in a unit with lead paint?",
      citationChunks: [wrongChapterChunk],
    }),
    false,
  );
});

test("hasReliableCitationSupport accepts chapter support for general legal questions", () => {
  const chapterChunk = createChunk({
    id: "kb-1",
    sourceGroup: "chapters",
    sourceName: "ch06_utilities.pdf",
    score: 0.91,
  });

  assert.equal(
    hasReliableCitationSupport({
      question: "My landlord shut off heat and hot water. What can I do?",
      citationChunks: [chapterChunk],
    }),
    true,
  );
});

test("hasReliableCitationSupport requires handbook support for uploaded clause legality questions", () => {
  const sessionChunk = createChunk({
    id: "upload-1",
    sourceGroup: "text",
    sourceName: "pasted-text",
    score: 0.98,
  });
  const handbookChunk = {
    ...createChunk({
      id: "kb-1",
      sourceGroup: "chapters",
      sourceName: "ch03_security_deposits.pdf",
      score: 0.91,
    }),
    chapter_ref: "3",
  };

  assert.equal(
    hasReliableCitationSupport({
      question:
        "Is this clause legal under the tenant-rights handbook, and what tenant protections are missing?",
      citationChunks: [sessionChunk],
    }),
    false,
  );

  assert.equal(
    hasReliableCitationSupport({
      question:
        "Is this clause legal under the tenant-rights handbook, and what tenant protections are missing?",
      citationChunks: [sessionChunk, handbookChunk],
    }),
    true,
  );

  assert.equal(
    hasReliableCitationSupport({
      question:
        "Is this clause legal under the tenant-rights handbook, and what tenant protections are missing?",
      citationChunks: [handbookChunk],
    }),
    false,
  );
});
