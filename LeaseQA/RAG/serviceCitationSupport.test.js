import test from "node:test";
import assert from "node:assert/strict";

import { resolveSupportedCitationChunks } from "./service.js";

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
