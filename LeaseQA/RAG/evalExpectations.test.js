import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  matchesExpectation,
  normalizeChunkExpectationInput,
  normalizeCitationExpectationInput,
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

test("every non-abstaining eval case declares an expected source group", async () => {
  const cases = JSON.parse(await readFile(evalSetPath, "utf8"));

  const missing = cases
    .filter((evalCase) => !evalCase.expectAbstain && !evalCase.expectedSourceGroup)
    .map((evalCase) => evalCase.id);

  assert.deepEqual(missing, []);
});
