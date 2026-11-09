import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  matchesAnswerCitation,
  matchesExpectation,
  normalizeChunkExpectationInput,
  normalizeCitationExpectationInput,
  pastedSourceTextOf,
} from "./evalExpectations.js";
import { KNOWLEDGE_SOURCE_GROUPS } from "./retrievalPolicy.js";

const evalSetPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "evals",
  "tenant-rights-eval.json",
);

test("citation and chunk shapes normalize to the same candidate", () => {
  const citation = {
    sourceGroup: "chapters",
    sourceName: "ch03_security_deposits.pdf",
    chapterRef: "3",
  };
  const chunk = {
    source_group: "chapters",
    source_name: "ch03_security_deposits.pdf",
    chapter_ref: "3",
  };

  assert.deepEqual(
    normalizeCitationExpectationInput(citation),
    normalizeChunkExpectationInput(chunk),
  );
});

test("normalizers coerce missing fields to empty strings", () => {
  assert.deepEqual(normalizeChunkExpectationInput({}), {
    sourceGroup: "",
    sourceName: "",
    chapterRef: "",
  });
  assert.deepEqual(normalizeCitationExpectationInput(undefined), {
    sourceGroup: "",
    sourceName: "",
    chapterRef: "",
  });
});

test("a mismatched source group never matches", () => {
  const evalCase = { expectedSourceGroup: "chapters" };
  const candidate = normalizeChunkExpectationInput({ source_group: "forms" });

  assert.equal(matchesExpectation(evalCase, candidate), false);
});

test("chapter refs are compared as strings and numbers alike", () => {
  const evalCase = {
    expectedSourceGroup: "chapters",
    expectedChapterRefs: ["3"],
  };

  assert.equal(
    matchesExpectation(
      evalCase,
      normalizeChunkExpectationInput({ source_group: "chapters", chapter_ref: 3 }),
    ),
    true,
  );
  assert.equal(
    matchesExpectation(
      evalCase,
      normalizeChunkExpectationInput({ source_group: "chapters", chapter_ref: "11" }),
    ),
    false,
  );
});

test("source name tokens are matched case-insensitively", () => {
  const evalCase = {
    expectedSourceGroup: "forms",
    expectedSourceNameIncludes: ["Repair_Demand"],
  };

  assert.equal(
    matchesExpectation(
      evalCase,
      normalizeChunkExpectationInput({
        source_group: "forms",
        source_name: "form_10_repair_demand_letter.pdf",
      }),
    ),
    true,
  );
  assert.equal(
    matchesExpectation(
      evalCase,
      normalizeChunkExpectationInput({
        source_group: "forms",
        source_name: "form_09_repair_letter.pdf",
      }),
    ),
    false,
  );
});

test("a group-only expectation matches any chunk in that group", () => {
  assert.equal(
    matchesExpectation(
      { expectedSourceGroup: "booklets" },
      normalizeChunkExpectationInput({ source_group: "booklets" }),
    ),
    true,
  );
});

const citation = (sourceGroup, chapterRef, sourceName = "") =>
  normalizeCitationExpectationInput({ sourceGroup, chapterRef, sourceName });

test("an answer citing a chapter's handout meets a case that names the chapter", () => {
  const evalCase = { expectedSourceGroup: "chapters", expectedChapterRefs: ["12"] };

  assert.equal(matchesAnswerCitation(evalCase, citation("chapters", "12")), true);
  assert.equal(matchesAnswerCitation(evalCase, citation("handouts", "12")), true);
  // Another chapter's handout is still the wrong passage.
  assert.equal(matchesAnswerCitation(evalCase, citation("handouts", "3")), false);
  assert.equal(matchesAnswerCitation(evalCase, citation("upload", "")), false);
});

test("the ingest gate's matcher still wants the chapter itself", () => {
  const evalCase = { expectedSourceGroup: "chapters", expectedChapterRefs: ["12"] };

  // The gate checks that the ingest made chapter 12 retrievable, and chapter
  // 12's handout cannot stand in for that.
  assert.equal(matchesExpectation(evalCase, citation("handouts", "12")), false);
  assert.equal(matchesExpectation(evalCase, citation("chapters", "12")), true);
});

test("a handout never stands in for a form, a booklet or the renter's own document", () => {
  const handout = citation("handouts", "8", "handout_ch08_getting_repairs_made.pdf");

  assert.equal(
    matchesAnswerCitation(
      { expectedSourceGroup: "forms", expectedSourceNameIncludes: ["repair_demand_letter"] },
      handout,
    ),
    false,
  );
  assert.equal(matchesAnswerCitation({ expectedSourceGroup: "booklets" }, handout), false);
  assert.equal(matchesAnswerCitation({ expectedSourceGroup: "upload" }, handout), false);
});

test("every non-abstaining eval case names a source group a citation can have", async () => {
  const cases = JSON.parse(await readFile(evalSetPath, "utf8"));
  const known = new Set([...KNOWLEDGE_SOURCE_GROUPS, "upload", "text"]);

  const unknown = cases
    .filter((evalCase) => !evalCase.expectAbstain)
    .filter((evalCase) => !known.has(evalCase.expectedSourceGroup))
    .map((evalCase) => evalCase.id);

  assert.deepEqual(unknown, []);
});

test("only non-blank pasted text counts as a case's own source text", () => {
  assert.equal(
    pastedSourceTextOf({ sourceText: "Tenant will pay two months of rent." }),
    "Tenant will pay two months of rent.",
  );
  assert.equal(pastedSourceTextOf({ sourceText: "  \n " }), null);
  assert.equal(pastedSourceTextOf({ sourceText: 42 }), null);
  assert.equal(pastedSourceTextOf({}), null);
  assert.equal(pastedSourceTextOf(undefined), null);
});

test("no eval case both uploads a document and pastes text", async () => {
  const cases = JSON.parse(await readFile(evalSetPath, "utf8"));

  const both = cases
    .filter((evalCase) => evalCase.upload && pastedSourceTextOf(evalCase) !== null)
    .map((evalCase) => evalCase.id);

  assert.deepEqual(both, []);
});
