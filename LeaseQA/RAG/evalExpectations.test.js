import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  expectedSourceGroupsOf,
  matchesExpectation,
  normalizeChunkExpectationInput,
  normalizeCitationExpectationInput,
  pastedSourceTextOf,
} from "./evalExpectations.js";

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

test("a list of source groups matches any of them, with the same chapter refs", () => {
  const evalCase = {
    expectedSourceGroup: ["chapters", "handouts"],
    expectedChapterRefs: ["3"],
  };
  const matches = (chunk) =>
    matchesExpectation(evalCase, normalizeChunkExpectationInput(chunk));

  assert.equal(matches({ source_group: "chapters", chapter_ref: "3" }), true);
  assert.equal(matches({ source_group: "handouts", chapter_ref: "3" }), true);
  assert.equal(matches({ source_group: "handouts", chapter_ref: "12" }), false);
  assert.equal(matches({ source_group: "forms", chapter_ref: "3" }), false);
});

test("every non-abstaining eval case declares an expected source group", async () => {
  const cases = JSON.parse(await readFile(evalSetPath, "utf8"));

  const missing = cases
    .filter((evalCase) => {
      if ( evalCase.expectAbstain ) {
        return false;
      }
      const groups = expectedSourceGroupsOf(evalCase);
      return (
        groups.length === 0 ||
        !groups.every((group) => typeof group === "string" && group.length > 0)
      );
    })
    .map((evalCase) => evalCase.id);

  assert.deepEqual(missing, []);
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
