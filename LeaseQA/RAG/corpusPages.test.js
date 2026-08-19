import test from "node:test";
import assert from "node:assert/strict";

import * as text from "./text.js";

test("PDF corpus extraction preserves text with its source page number", async () => {
  let destroyed = false;
  class FakePdfParser {
    async getText() {
      return {
        pages: [
          { num: 1, text: "Page one tenant rights." },
          { num: 2, text: "Page two tenant remedies." },
        ],
      };
    }

    async destroy() {
      destroyed = true;
    }
  }

  const pages = await text.extractCorpusPages(
    {
      buffer: Buffer.from("fake pdf"),
      originalName: "handbook.pdf",
      mimeType: "application/pdf",
    },
    { PDFParseClass: FakePdfParser },
  );

  assert.deepEqual(pages, [
    { text: "Page one tenant rights.", pageNumber: 1 },
    { text: "Page two tenant remedies.", pageNumber: 2 },
  ]);
  assert.equal(destroyed, true);
});

test("plain-text corpus extraction records that no page number exists", async () => {
  assert.deepEqual(
    await text.extractCorpusPages({
      buffer: Buffer.from("Tenant text"),
      originalName: "tenant.txt",
      mimeType: "text/plain",
    }),
    [{ text: "Tenant text", pageNumber: null }],
  );
});
