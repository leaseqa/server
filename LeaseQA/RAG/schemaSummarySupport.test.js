import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import ragSessionSchema from "./schema.js";

test("RAG session messages persist remapped summary citation indices", () => {
  const Model = mongoose.model(
    "RagSummarySupportContractTest",
    ragSessionSchema.clone(),
  );
  const document = new Model({
    clientSessionId: "client-1",
    sourceKind: "text",
    sourceName: "pasted-text",
    sourceTextPreview: "preview",
    sourceCharCount: 7,
    messages: [
      {
        role: "assistant",
        content: "Supported summary.",
        summary: "Supported summary.",
        summaryCitationIndices: [0, 2],
        bullets: [
          {
            text: "Supported bullet.",
            citationIndices: [0],
          },
        ],
        citations: [],
      },
    ],
  });

  const storedMessage = document.toObject().messages[0];
  assert.deepEqual(storedMessage.summaryCitationIndices, [0, 2]);
});
