# RAG Corpus Upstream Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect MassLegalHelp updates to the tenant-rights corpus, refresh it reproducibly, and re-ingest behind a retrieval quality gate that never swaps the alias onto a regressed corpus.

**Architecture:** Four layers, each independently testable. (1) A shared expectation matcher extracted from the eval runner. (2) An in-process retrieval gate that queries the *staging* Milvus collection before alias activation, reusing the existing eval set with no LLM and no HTTP server. (3) Content-stable provenance columns in `corpus_manifest.csv` plus a separate, unhashed `upstream_state.json` for volatile check bookkeeping. (4) A Playwright checker that reads public chapter pages at a polite rate, reports diffs, and defers to a human for the actual download.

**Tech Stack:** Node.js 24 LTS, node:test + node:assert/strict, Milvus/Zilliz SDK, Playwright (Chromium), GitHub Actions, plain git (no LFS).

**Spec:** `docs/superpowers/specs/2026-08-23-corpus-upstream-sync.md`

## Global Constraints

- Node 24 LTS (`.nvmrc` = `24.19.0`). Tests run via `npm test` / `npm run test:rag` and must not require network access — all external RAG operations are injected fakes.
- Repo code style: `if ( condition )` with spaces inside the parens; ESM (`"type": "module"`); named `export const` arrow functions.
- **Never write code that defeats, solves, or evades Cloudflare's bot check.** A blocked page is recorded as `status: "blocked"` and handed to a human. No retry loops.
- **`corpusVersion` hashes the full text of `corpus_manifest.csv`.** Any manifest byte that changes without a PDF changing forces a pointless 81-file re-embed. A no-op refresh must leave `corpus_manifest.csv` byte-identical.
- Volatile check bookkeeping lives in `upstream_state.json`, which is not a manifest row and is therefore never part of the identity hash.
- No real credentials, PDFs, or `.env` contents in tests, logs, or commits.
- Red-green-refactor. Commit only after the focused test and `npm run test:rag` both pass.
- All paths below are relative to the **server repository root** (`server/` in the workspace) unless the task says otherwise.

---

### Task 1: Extract the shared eval expectation matcher

`matchesExpectation` is currently private to `scripts/run-rag-eval.js` and operates on camelCase citations. The gate in Task 3 needs the identical rule over snake_case Milvus rows. Extract once, adapt at the edges.

**Files:**
- Create: `LeaseQA/RAG/evalExpectations.js`
- Create: `LeaseQA/RAG/evalExpectations.test.js`
- Modify: `scripts/run-rag-eval.js:173-194` (delete local `matchesExpectation`), `scripts/run-rag-eval.js:228-230` (call site)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `normalizeCitationExpectationInput(citation) -> { sourceGroup: string, sourceName: string, chapterRef: string }`
  - `normalizeChunkExpectationInput(chunk) -> { sourceGroup: string, sourceName: string, chapterRef: string }`
  - `matchesExpectation(evalCase, candidate) -> boolean` where `candidate` is the output of either normalizer.

- [ ] **Step 1: Write the failing test**

Create `LeaseQA/RAG/evalExpectations.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test LeaseQA/RAG/evalExpectations.test.js
```

Expected: FAIL with `Cannot find module .../LeaseQA/RAG/evalExpectations.js`.

- [ ] **Step 3: Write minimal implementation**

Create `LeaseQA/RAG/evalExpectations.js`:

```js
const asText = (value) => String(value ?? "");

export const normalizeCitationExpectationInput = (citation) => ({
  sourceGroup: asText(citation?.sourceGroup),
  sourceName: asText(citation?.sourceName),
  chapterRef: asText(citation?.chapterRef),
});

export const normalizeChunkExpectationInput = (chunk) => ({
  sourceGroup: asText(chunk?.source_group),
  sourceName: asText(chunk?.source_name),
  chapterRef: asText(chunk?.chapter_ref),
});

export const matchesExpectation = (evalCase, candidate) => {
  if ( !candidate || candidate.sourceGroup !== evalCase.expectedSourceGroup ) {
    return false;
  }
  if (
    Array.isArray(evalCase.expectedChapterRefs) &&
    evalCase.expectedChapterRefs.length > 0 &&
    !evalCase.expectedChapterRefs.includes(candidate.chapterRef)
  ) {
    return false;
  }
  if (
    Array.isArray(evalCase.expectedSourceNameIncludes) &&
    evalCase.expectedSourceNameIncludes.length > 0
  ) {
    const sourceName = candidate.sourceName.toLowerCase();
    return evalCase.expectedSourceNameIncludes.some((token) =>
      sourceName.includes(asText(token).toLowerCase()),
    );
  }
  return true;
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test LeaseQA/RAG/evalExpectations.test.js
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Rewire the eval runner to the shared matcher**

In `scripts/run-rag-eval.js`, add to the import block at the top of the file (after the `node:url` import):

```js
import {
  matchesExpectation,
  normalizeCitationExpectationInput,
} from "../LeaseQA/RAG/evalExpectations.js";
```

Delete the local definition at lines 173-194 (the whole `const matchesExpectation = (evalCase, citation) => { ... };` block).

Change the call site (currently line 230) from:

```js
    : citations.some((citation) => matchesExpectation(evalCase, citation));
```

to:

```js
    : citations.some((citation) =>
        matchesExpectation(evalCase, normalizeCitationExpectationInput(citation)),
      );
```

- [ ] **Step 6: Verify no behavior drift and no lint regression**

```bash
node --test LeaseQA/RAG/evalRunner.test.js LeaseQA/RAG/evalExpectations.test.js && npm run lint
```

Expected: PASS on both files, lint clean. `evalRunner.test.js` already covers the runner's scoring — it must stay green without edits. If it fails, the extraction changed behavior; fix the extraction, not the test.

- [ ] **Step 7: Commit**

```bash
git add LeaseQA/RAG/evalExpectations.js LeaseQA/RAG/evalExpectations.test.js scripts/run-rag-eval.js
git commit -m "refactor: extract shared eval expectation matcher for reuse by the ingest gate"
```

---

### Task 2: Let knowledge retrieval target an explicit collection

`getKnowledgeResults` hardcodes `config.knowledgeCollection` (the alias). The gate must query the staging collection by its physical name *before* the alias moves.

**Files:**
- Modify: `LeaseQA/RAG/service.js:579-607` (`getKnowledgeResults`)
- Create: `LeaseQA/RAG/knowledgeCollectionTarget.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `getKnowledgeResults` accepts an optional `collectionName` that defaults to `config.knowledgeCollection`, and is exported as `retrieveKnowledgeChunks` for the gate wiring in Task 4.
  Signature: `retrieveKnowledgeChunks({ config, vector, question, collectionName?, searchHybridChunksFn?, retryPolicy? }) -> Promise<Array<chunk>>` where `chunk` carries snake_case fields (`source_group`, `source_name`, `chapter_ref`, `text`, `corpus_version`).

- [ ] **Step 1: Write the failing test**

Create `LeaseQA/RAG/knowledgeCollectionTarget.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import * as service from "./service.js";

const createConfig = () => ({
  knowledgeCollection: "leaseqa_knowledge_chunks",
  knowledgeTopK: 8,
});

test("knowledge retrieval defaults to the configured alias", async () => {
  const searched = [];

  await service.retrieveKnowledgeChunks({
    config: createConfig(),
    vector: [0.1, 0.2],
    question: "How long does a landlord have to return my security deposit?",
    searchHybridChunksFn: async ({ collectionName }) => {
      searched.push(collectionName);
      return [];
    },
  });

  assert.ok(searched.length > 0, "the search plan must issue at least one search");
  assert.deepEqual(
    [...new Set(searched)],
    ["leaseqa_knowledge_chunks"],
  );
});

test("knowledge retrieval targets an explicit staging collection when given one", async () => {
  const searched = [];

  await service.retrieveKnowledgeChunks({
    config: createConfig(),
    vector: [0.1, 0.2],
    question: "How long does a landlord have to return my security deposit?",
    collectionName: "leaseqa_knowledge_chunks_fc79c9e24cd9",
    searchHybridChunksFn: async ({ collectionName }) => {
      searched.push(collectionName);
      return [];
    },
  });

  assert.deepEqual(
    [...new Set(searched)],
    ["leaseqa_knowledge_chunks_fc79c9e24cd9"],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test LeaseQA/RAG/knowledgeCollectionTarget.test.js
```

Expected: FAIL with `service.retrieveKnowledgeChunks is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `LeaseQA/RAG/service.js`, change the `getKnowledgeResults` declaration (currently `const getKnowledgeResults = async ({ ... })` at line 585) to an exported function with the new parameter:

```js
export const retrieveKnowledgeChunks = async ({
                                                config,
                                                vector,
                                                question,
                                                collectionName,
                                                searchHybridChunksFn = searchHybridChunks,
                                                retryPolicy,
                                              }) => {
  const targetCollection = collectionName || config.knowledgeCollection;
  const searchPlan = buildKnowledgeSearchPlan(question, config);
  const groupedResults = await Promise.all(
    searchPlan.map(({ group, limit, chapterRef }) =>
      searchHybridChunksFn({
        config,
        collectionName: targetCollection,
        denseVector: vector,
        sparseText: question,
        limit,
        filter: chapterRef
          ? `source_group == "${group}" && chapter_ref == "${chapterRef}"`
          : `source_group == "${group}"`,
        retryPolicy,
      }),
    ),
  );

  return rankKnowledgeChunks(question, dedupeById(groupedResults.flat())).slice(
    0,
    config.knowledgeTopK,
  );
};

const getKnowledgeResults = retrieveKnowledgeChunks;
```

Keeping the `getKnowledgeResults` alias means the existing call site (line 591 region, inside `answerSessionQuestion`) needs no edit and no existing test changes.

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test LeaseQA/RAG/knowledgeCollectionTarget.test.js
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Run the RAG regression suite**

```bash
npm run test:rag && npm run lint
```

Expected: all existing RAG tests still pass. `retrievalPolicy.test.js` and `answerQuestionGeneration.test.js` exercise the default path; they must stay green.

- [ ] **Step 6: Commit**

```bash
git add LeaseQA/RAG/service.js LeaseQA/RAG/knowledgeCollectionTarget.test.js
git commit -m "feat: allow knowledge retrieval to target an explicit collection"
```

---

### Task 3: Retrieval gate module

A pure-ish scorer: given eval cases and an injected retriever, report per-case hits and an overall hit rate. No LLM, no HTTP, no Milvus import — everything external is injected.

**Files:**
- Create: `LeaseQA/RAG/corpusGate.js`
- Create: `LeaseQA/RAG/corpusGate.test.js`

**Interfaces:**
- Consumes: `matchesExpectation`, `normalizeChunkExpectationInput` from Task 1.
- Produces:
  ```
  loadGateCases({ evalSetPath?, readFileFn? }) -> Promise<Array<evalCase>>   // non-abstain cases only
  runRetrievalGate({
    evalCases,
    collectionName,
    embedQuery,        // (question: string) => Promise<number[]>
    retrieveChunks,    // ({ collectionName, vector, question }) => Promise<Array<chunk>>
    minHitRate = 0.9,
    concurrency = 4,
  }) -> Promise<{
    passed: boolean,
    collectionName: string,
    minHitRate: number,
    hitRate: number,
    total: number,
    hits: number,
    misses: Array<{ id: string, expectedSourceGroup: string, actualSourceGroups: string[] }>,
  }>
  ```

- [ ] **Step 1: Write the failing test**

Create `LeaseQA/RAG/corpusGate.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test LeaseQA/RAG/corpusGate.test.js
```

Expected: FAIL with `Cannot find module .../LeaseQA/RAG/corpusGate.js`.

- [ ] **Step 3: Write minimal implementation**

Create `LeaseQA/RAG/corpusGate.js`:

```js
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  matchesExpectation,
  normalizeChunkExpectationInput,
} from "./evalExpectations.js";

const defaultEvalSetPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "evals",
  "tenant-rights-eval.json",
);

export const loadGateCases = async ({
  evalSetPath = defaultEvalSetPath,
  readFileFn = fs.readFile,
} = {}) => {
  const raw = await readFileFn(evalSetPath, "utf8");
  return JSON.parse(raw).filter((evalCase) => !evalCase.expectAbstain);
};

const runCase = async ({ evalCase, collectionName, embedQuery, retrieveChunks }) => {
  let chunks = [];
  try {
    const vector = await embedQuery(evalCase.question);
    chunks = await retrieveChunks({
      collectionName,
      vector,
      question: evalCase.question,
    });
  } catch ( error ) {
    console.error(
      JSON.stringify({
        event: "rag_gate_case_failed",
        caseId: evalCase.id,
        errorCode: error?.code || "RAG_GATE_RETRIEVAL_ERROR",
      }),
    );
    chunks = [];
  }

  const candidates = (chunks || []).map(normalizeChunkExpectationInput);
  const hit = candidates.some((candidate) =>
    matchesExpectation(evalCase, candidate),
  );

  return {
    hit,
    miss: hit
      ? null
      : {
          id: evalCase.id,
          expectedSourceGroup: evalCase.expectedSourceGroup,
          actualSourceGroups: [
            ...new Set(
              candidates.map((candidate) => candidate.sourceGroup).filter(Boolean),
            ),
          ],
        },
  };
};

const inBatches = async (items, size, worker) => {
  const output = [];
  for ( let index = 0; index < items.length; index += size ) {
    const batch = items.slice(index, index + size);
    output.push(...(await Promise.all(batch.map(worker))));
  }
  return output;
};

export const runRetrievalGate = async ({
  evalCases,
  collectionName,
  embedQuery,
  retrieveChunks,
  minHitRate = 0.9,
  concurrency = 4,
}) => {
  const results = await inBatches(evalCases, concurrency, (evalCase) =>
    runCase({ evalCase, collectionName, embedQuery, retrieveChunks }),
  );

  const hits = results.filter((result) => result.hit).length;
  const total = results.length;
  const hitRate = total === 0 ? 0 : hits / total;

  return {
    passed: total > 0 && hitRate >= minHitRate,
    collectionName,
    minHitRate,
    hitRate,
    total,
    hits,
    misses: results.map((result) => result.miss).filter(Boolean),
  };
};
```

Note the deliberate `total > 0` in `passed`: an empty or unreadable eval set must fail closed, never wave a corpus through.

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test LeaseQA/RAG/corpusGate.test.js
```

Expected: PASS, 6 tests. The last test asserts `27` cases — if it reports a different count, the eval set has changed; update the number only after confirming the change was intentional.

- [ ] **Step 5: Commit**

```bash
git add LeaseQA/RAG/corpusGate.js LeaseQA/RAG/corpusGate.test.js
git commit -m "feat: add retrieval gate that scores a staging collection against the eval set"
```

---

### Task 4: Block alias activation on a failing gate

**Files:**
- Modify: `LeaseQA/RAG/config.js:120-135` (add gate settings to `getRagConfig`)
- Modify: `LeaseQA/RAG/service.js:1096-1130` (gate dependency), `LeaseQA/RAG/service.js:1367-1390` (activation tail)
- Modify: `scripts/ingest-rag-corpus.js`
- Create: `LeaseQA/RAG/ingestGate.test.js`

**Interfaces:**
- Consumes: `runRetrievalGate`, `loadGateCases` (Task 3); `retrieveKnowledgeChunks` (Task 2).
- Produces:
  - `getRagConfig()` gains `ingestGateEnabled: boolean` (env `RAG_INGEST_GATE`, default on, `"off"` disables) and `ingestGateMinHitRate: number` (env `RAG_INGEST_GATE_MIN_HIT_RATE`, default `0.9`).
  - `ingestKnowledgeCorpus` accepts `dependencies.runIngestGate` — `({ config, collectionName }) => Promise<gateResult>`.
  - On gate failure it throws `Error` with `error.code === "RAG_INGEST_GATE_FAILED"` and `error.gate === gateResult`; state stays `status: "staging"`.

- [ ] **Step 1: Write the failing test**

Create `LeaseQA/RAG/ingestGate.test.js`. It reuses the fixture shape from `ingestState.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as service from "./service.js";

const MANIFEST = [
  "file_name,title_hint,source_type,source_group,chapter_ref,priority,file_path,source_url",
  "first.txt,First section,chapter,chapters,1,P0,docs/first.txt,https://example.test/first",
  "",
].join("\n");

const createCorpusFixture = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "leaseqa-rag-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "corpus_manifest.csv"), MANIFEST);
  await writeFile(path.join(root, "docs", "first.txt"), "First tenant right.");
  return root;
};

const createConfig = (root) => ({
  corpusRoot: root,
  manifestPath: path.join(root, "corpus_manifest.csv"),
  ingestStatePath: path.join(root, "ingest-state.json"),
  knowledgeCollection: "leaseqa_knowledge_chunks",
  chunkSize: 1200,
  chunkOverlap: 200,
  vectorTimeoutMs: 100,
  ingestGateEnabled: true,
  ingestGateMinHitRate: 0.9,
});

const createIngestDependencies = (overrides = {}) => {
  const order = [];
  return {
    order,
    embeddingsClient: {
      embedDocuments: async (texts) => texts.map(() => [0.1, 0.2]),
    },
    extractCorpusPages: async ({ buffer }) => [
      { text: buffer.toString("utf8"), pageNumber: 1 },
    ],
    hasChunkCollection: async () => false,
    insertChunkRows: async () => {},
    flushCollection: async ({ collectionName }) => {
      order.push(`flush:${collectionName}`);
    },
    ensureCollectionLoaded: async ({ collectionName }) => {
      order.push(`load:${collectionName}`);
    },
    getAliasTarget: async () => "leaseqa_knowledge_chunks_aaaaaaaaaaaa",
    activateCollectionAlias: async ({ collectionName }) => {
      order.push(`activate:${collectionName}`);
    },
    listCollections: async () => [],
    resetCollection: async ({ collectionName }) => {
      order.push(`drop:${collectionName}`);
    },
    ...overrides,
  };
};

test("a passing gate runs after load and before alias activation", async (t) => {
  const root = await createCorpusFixture(t);
  const dependencies = createIngestDependencies();
  dependencies.runIngestGate = async ({ collectionName }) => {
    dependencies.order.push(`gate:${collectionName}`);
    return { passed: true, hitRate: 1, total: 27, hits: 27, misses: [] };
  };

  const state = await service.ingestKnowledgeCorpus(
    {},
    { ...dependencies, config: createConfig(root) },
  );

  const gateIndex = dependencies.order.findIndex((entry) => entry.startsWith("gate:"));
  const loadIndex = dependencies.order.findIndex((entry) => entry.startsWith("load:"));
  const activateIndex = dependencies.order.findIndex((entry) =>
    entry.startsWith("activate:"),
  );

  assert.ok(loadIndex >= 0 && gateIndex > loadIndex, "gate must run after load");
  assert.ok(activateIndex > gateIndex, "gate must run before activation");
  assert.equal(state.status, "active");
});

test("a failing gate leaves the alias untouched and the state staging", async (t) => {
  const root = await createCorpusFixture(t);
  const dependencies = createIngestDependencies({
    runIngestGate: async () => ({
      passed: false,
      hitRate: 0.5,
      total: 27,
      hits: 13,
      misses: [
        { id: "ch03-deposit", expectedSourceGroup: "chapters", actualSourceGroups: [] },
      ],
    }),
  });

  await assert.rejects(
    service.ingestKnowledgeCorpus(
      {},
      { ...dependencies, config: createConfig(root) },
    ),
    (error) => error.code === "RAG_INGEST_GATE_FAILED",
  );

  assert.equal(
    dependencies.order.some((entry) => entry.startsWith("activate:")),
    false,
    "a failed gate must never activate the alias",
  );
  assert.equal(
    dependencies.order.some((entry) => entry.startsWith("drop:")),
    false,
    "a failed gate must leave the staging collection intact for inspection",
  );

  const savedState = JSON.parse(
    await readFile(path.join(root, "ingest-state.json"), "utf8"),
  );
  assert.equal(savedState.status, "staging");
  assert.equal(savedState.gate.passed, false);
  assert.equal(savedState.gate.hitRate, 0.5);
});

test("the gate is skipped when disabled in config", async (t) => {
  const root = await createCorpusFixture(t);
  let gateCalls = 0;
  const dependencies = createIngestDependencies({
    runIngestGate: async () => {
      gateCalls += 1;
      return { passed: false, hitRate: 0, total: 0, hits: 0, misses: [] };
    },
  });

  const state = await service.ingestKnowledgeCorpus(
    {},
    {
      ...dependencies,
      config: { ...createConfig(root), ingestGateEnabled: false },
    },
  );

  assert.equal(gateCalls, 0);
  assert.equal(state.status, "active");
});

test("a partial --limit run stops before the gate and stays staging", async (t) => {
  const root = await createCorpusFixture(t);
  let gateCalls = 0;
  const dependencies = createIngestDependencies({
    runIngestGate: async () => {
      gateCalls += 1;
      return { passed: true, hitRate: 1, total: 27, hits: 27, misses: [] };
    },
  });

  const manifestWithTwo = [
    "file_name,title_hint,source_type,source_group,chapter_ref,priority,file_path,source_url",
    "first.txt,First section,chapter,chapters,1,P0,docs/first.txt,https://example.test/first",
    "second.txt,Second section,form,forms,,P1,docs/second.txt,https://example.test/second",
    "",
  ].join("\n");
  await writeFile(path.join(root, "corpus_manifest.csv"), manifestWithTwo);
  await writeFile(path.join(root, "docs", "second.txt"), "Second tenant form.");

  const state = await service.ingestKnowledgeCorpus(
    { limit: 1 },
    { ...dependencies, config: createConfig(root) },
  );

  assert.equal(gateCalls, 0);
  assert.equal(state.status, "staging");
  assert.equal(state.nextIndex, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test LeaseQA/RAG/ingestGate.test.js
```

Expected: FAIL — the first test fails because the gate never runs (no `gate:` entry in `order`), and the second fails because the alias is activated anyway.

- [ ] **Step 3: Add the gate settings to config**

In `LeaseQA/RAG/config.js`, add a parser next to `parsePositiveInteger`:

```js
const parseRate = (value, fallback) => {
  const parsed = Number.parseFloat(value || "");
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
};
```

Then add two entries to the object returned by `getRagConfig()`, next to `knowledgeTopK`:

```js
    ingestGateEnabled: process.env.RAG_INGEST_GATE !== "off",
    ingestGateMinHitRate: parseRate(
      process.env.RAG_INGEST_GATE_MIN_HIT_RATE,
      0.9,
    ),
```

- [ ] **Step 4: Wire the default gate and the activation guard in service.js**

At the top of `LeaseQA/RAG/service.js`, add to the existing imports:

```js
import { loadGateCases, runRetrievalGate } from "./corpusGate.js";
```

Inside `ingestKnowledgeCorpus`, next to the other dependency defaults (after `const writeState = dependencies.writeIngestState || writeIngestState;`), add:

```js
  const runGate =
    dependencies.runIngestGate ||
    (async ({ config: gateConfig, collectionName: gateCollection }) =>
      runRetrievalGate({
        evalCases: await loadGateCases({}),
        collectionName: gateCollection,
        embedQuery: (question) => embeddings.embedQuery(question),
        retrieveChunks: ({ collectionName: target, vector, question }) =>
          retrieveKnowledgeChunks({
            config: gateConfig,
            vector,
            question,
            collectionName: target,
          }),
        minHitRate: gateConfig.ingestGateMinHitRate ?? 0.9,
      }));
```

Replace the activation tail (currently lines 1371-1373):

```js
  await flushCollectionFn({ config, collectionName });
  await loadCollectionFn({ config, collectionName });
  await activateAliasFn({ config, alias, collectionName });
```

with:

```js
  await flushCollectionFn({ config, collectionName });
  await loadCollectionFn({ config, collectionName });

  if ( config.ingestGateEnabled !== false ) {
    const gate = await runGate({ config, collectionName });
    console.info(
      JSON.stringify({
        event: "rag_ingest_gate_result",
        collectionName,
        passed: gate.passed,
        hitRate: Number(gate.hitRate.toFixed(4)),
        hits: gate.hits,
        total: gate.total,
      }),
    );

    if ( !gate.passed ) {
      const blockedState = await writeState({
        statePath: config.ingestStatePath,
        state: { ...ingestState, status: "staging", gate },
      });
      console.error(
        JSON.stringify({
          event: "rag_ingest_gate_failed",
          collectionName,
          hitRate: Number(gate.hitRate.toFixed(4)),
          minHitRate: gate.minHitRate,
          misses: gate.misses,
        }),
      );
      const error = new Error(
        `Corpus retrieval gate failed (${gate.hits}/${gate.total} hits, min ${gate.minHitRate}); alias not activated`,
      );
      error.code = "RAG_INGEST_GATE_FAILED";
      error.gate = gate;
      error.state = blockedState;
      throw error;
    }
  }

  await activateAliasFn({ config, alias, collectionName });
```

The throw happens *before* `cleanupInactiveVersions`, so the staging collection survives for inspection and the previous corpus keeps serving traffic.

- [ ] **Step 5: Run test to verify it passes**

```bash
node --test LeaseQA/RAG/ingestGate.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Surface the gate in the ingest CLI**

In `scripts/ingest-rag-corpus.js`, extend `parseArguments` to accept `--no-gate` and `--min-hit-rate=`:

```js
const parseArguments = (argv) =>
  argv.reduce(
    (options, argument) => {
      if ( argument === "--reset" ) {
        return { ...options, reset: true };
      }
      if ( argument === "--no-gate" ) {
        return { ...options, gate: false };
      }
      if ( argument.startsWith("--min-hit-rate=") ) {
        const value = Number.parseFloat(argument.slice("--min-hit-rate=".length));
        if ( Number.isFinite(value) && value >= 0 && value <= 1 ) {
          return { ...options, minHitRate: value };
        }
      }
      if ( argument.startsWith("--limit=") ) {
        const value = Number.parseInt(argument.slice("--limit=".length), 10);
        if ( Number.isFinite(value) && value > 0 ) {
          return { ...options, limit: value };
        }
      }
      return options;
    },
    { reset: false, limit: null, gate: true, minHitRate: null },
  );
```

Replace the body of `main` with a version that maps the flags onto env before config is read, and reports the gate:

```js
const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  if ( options.gate === false ) {
    process.env.RAG_INGEST_GATE = "off";
  }
  if ( options.minHitRate !== null ) {
    process.env.RAG_INGEST_GATE_MIN_HIT_RATE = String(options.minHitRate);
  }

  await mongoose.connect(process.env.DATABASE_CONNECTION_STRING);
  try {
    const state = await ingestKnowledgeCorpus({
      reset: options.reset,
      limit: options.limit,
    });
    console.log(
      JSON.stringify({
        event: "rag_ingest_complete",
        status: state.status,
        corpusVersion: state.corpusVersion,
        collectionName: state.collectionName,
        alias: state.alias,
        nextIndex: state.nextIndex,
      }),
    );
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((error) => {
  if ( error?.code === "RAG_INGEST_GATE_FAILED" ) {
    console.error(
      JSON.stringify({
        event: "rag_ingest_blocked",
        reason: error.message,
        gate: error.gate,
      }),
    );
    process.exit(2);
  }
  console.error("Knowledge corpus ingestion failed:", error);
  process.exit(1);
});
```

Exit code `2` distinguishes "corpus built but rejected" from "ingest crashed", so CI can report them differently.

- [ ] **Step 7: Document the new env vars**

Append to `.env.example`, next to the other `RAG_*` entries:

```
# Retrieval gate that must pass before the knowledge alias is repointed.
# Set to "off" to skip it (not recommended outside local experiments).
RAG_INGEST_GATE=on
RAG_INGEST_GATE_MIN_HIT_RATE=0.9
```

- [ ] **Step 8: Run the full RAG suite and lint**

```bash
npm run test:rag && npm run lint
```

Expected: everything green, including the pre-existing `ingestState.test.js` and `lifecycle.test.js` — those fixtures have no `ingestGateEnabled` and no `runIngestGate`, so the guard `config.ingestGateEnabled !== false` would call the *real* gate. If they fail, add `ingestGateEnabled: false` to their `createConfig` helpers; do **not** weaken the production default.

- [ ] **Step 9: Commit**

```bash
git add LeaseQA/RAG/config.js LeaseQA/RAG/service.js LeaseQA/RAG/ingestGate.test.js scripts/ingest-rag-corpus.js .env.example
git commit -m "feat: gate knowledge alias activation on staging retrieval quality"
```

---

### Task 5: Content-stable provenance columns and the refresh tool

Everything from here operates on the corpus, which currently lives at the workspace path `resources/rag-corpus/mass tenant rights/`. Task 7 moves it into its own repository; until then, use `RAG_CORPUS_ROOT` or the existing parent-directory walk.

**Files:**
- Modify: `<corpus-root>/corpus_manifest.csv` (append 4 columns to the header and every row)
- Create: `<corpus-root>/upstream_state.json`
- Create: `scripts/refresh-corpus-manifest.js`
- Create: `LeaseQA/RAG/corpusManifest.js`
- Create: `LeaseQA/RAG/corpusManifest.test.js`

**Interfaces:**
- Consumes: nothing from Tasks 1-4.
- Produces:
  ```
  MANIFEST_COLUMNS: string[]   // the canonical ordered header
  parseManifestCsv(text) -> Array<Record<string,string>>
  serializeManifestCsv(rows) -> string        // stable column order, CRLF-free, trailing newline
  planManifestRefresh({ rows, hashes, upstreamState, now }) -> {
    rows: Array<Record<string,string>>,
    changed: Array<{ fileName, previousSha, nextSha }>,
    unchanged: number,
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `LeaseQA/RAG/corpusManifest.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  MANIFEST_COLUMNS,
  parseManifestCsv,
  planManifestRefresh,
  serializeManifestCsv,
} from "./corpusManifest.js";

const HEADER = MANIFEST_COLUMNS.join(",");

const row = (overrides = {}) => ({
  file_name: "ch03_security_deposits.pdf",
  title_hint: "03 Security Deposits 2025- Updated 8-13-25",
  source_type: "chapter",
  source_group: "chapters",
  chapter_ref: "3",
  priority: "P0",
  file_path: "pdf/chapters/ch03_security_deposits.pdf",
  source_url: "https://www.masslegalhelp.org/x/chapter-3",
  pdf_url: "https://www.masslegalhelp.org/files/ch03.pdf",
  content_sha256: "a".repeat(64),
  retrieved_at: "2026-03-01",
  upstream_revision: "03 Security Deposits 2025- Updated 8-13-25",
  ...overrides,
});

test("the canonical header keeps the original eight columns first", () => {
  assert.deepEqual(MANIFEST_COLUMNS.slice(0, 8), [
    "file_name",
    "title_hint",
    "source_type",
    "source_group",
    "chapter_ref",
    "priority",
    "file_path",
    "source_url",
  ]);
  assert.deepEqual(MANIFEST_COLUMNS.slice(8), [
    "pdf_url",
    "content_sha256",
    "retrieved_at",
    "upstream_revision",
  ]);
});

test("serialize then parse round-trips a row", () => {
  const original = [row()];
  const parsed = parseManifestCsv(serializeManifestCsv(original));

  assert.deepEqual(parsed, original);
});

test("serialization quotes values containing commas or quotes", () => {
  const text = serializeManifestCsv([
    row({ title_hint: 'Handout 17 - Condos, "revised"' }),
  ]);

  assert.match(text, /"Handout 17 - Condos, ""revised"""/);
  assert.deepEqual(parseManifestCsv(text)[0].title_hint, 'Handout 17 - Condos, "revised"');
});

test("serialization ends with exactly one trailing newline", () => {
  const text = serializeManifestCsv([row()]);

  assert.equal(text.endsWith("\n"), true);
  assert.equal(text.endsWith("\n\n"), false);
  assert.equal(text.split("\n")[0], HEADER);
});

test("an unchanged corpus produces byte-identical output", () => {
  const rows = [row()];
  const before = serializeManifestCsv(rows);

  const plan = planManifestRefresh({
    rows,
    hashes: { "pdf/chapters/ch03_security_deposits.pdf": "a".repeat(64) },
    upstreamState: {
      entries: {
        "ch03_security_deposits.pdf": {
          pdfUrl: "https://cdn.example/new-location.pdf",
          revision: "03 Security Deposits 2025- Updated 11-02-25",
        },
      },
    },
    now: new Date("2026-09-01T00:00:00.000Z"),
  });

  assert.deepEqual(plan.changed, []);
  assert.equal(plan.unchanged, 1);
  assert.equal(serializeManifestCsv(plan.rows), before);
});

test("a changed hash refreshes retrieved_at and promotes upstream metadata", () => {
  const plan = planManifestRefresh({
    rows: [row()],
    hashes: { "pdf/chapters/ch03_security_deposits.pdf": "b".repeat(64) },
    upstreamState: {
      entries: {
        "ch03_security_deposits.pdf": {
          pdfUrl: "https://cdn.example/new-location.pdf",
          revision: "03 Security Deposits 2025- Updated 11-02-25",
        },
      },
    },
    now: new Date("2026-09-01T00:00:00.000Z"),
  });

  assert.deepEqual(plan.changed, [
    {
      fileName: "ch03_security_deposits.pdf",
      previousSha: "a".repeat(64),
      nextSha: "b".repeat(64),
    },
  ]);
  assert.equal(plan.rows[0].content_sha256, "b".repeat(64));
  assert.equal(plan.rows[0].retrieved_at, "2026-09-01");
  assert.equal(plan.rows[0].pdf_url, "https://cdn.example/new-location.pdf");
  assert.equal(
    plan.rows[0].upstream_revision,
    "03 Security Deposits 2025- Updated 11-02-25",
  );
});

test("a missing local file is reported instead of silently blanked", () => {
  assert.throws(
    () =>
      planManifestRefresh({
        rows: [row()],
        hashes: {},
        upstreamState: { entries: {} },
        now: new Date("2026-09-01T00:00:00.000Z"),
      }),
    /ch03_security_deposits\.pdf/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test LeaseQA/RAG/corpusManifest.test.js
```

Expected: FAIL with `Cannot find module .../LeaseQA/RAG/corpusManifest.js`.

- [ ] **Step 3: Write minimal implementation**

Create `LeaseQA/RAG/corpusManifest.js`:

```js
export const MANIFEST_COLUMNS = [
  "file_name",
  "title_hint",
  "source_type",
  "source_group",
  "chapter_ref",
  "priority",
  "file_path",
  "source_url",
  "pdf_url",
  "content_sha256",
  "retrieved_at",
  "upstream_revision",
];

const splitCsvLine = (line) => {
  const values = [];
  let current = "";
  let inQuotes = false;

  for ( let index = 0; index < line.length; index += 1 ) {
    const char = line[index];
    if ( char === '"' ) {
      if ( inQuotes && line[index + 1] === '"' ) {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if ( char === "," && !inQuotes ) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
};

const quoteCsvValue = (value) => {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const parseManifestCsv = (text) => {
  const [headerLine, ...lines] = text.split(/\r?\n/).filter(Boolean);
  const headers = splitCsvLine(headerLine);

  return lines.map((line) => {
    const values = splitCsvLine(line);
    return headers.reduce(
      (record, header, index) => ({ ...record, [header]: values[index] || "" }),
      {},
    );
  });
};

export const serializeManifestCsv = (rows) =>
  [
    MANIFEST_COLUMNS.join(","),
    ...rows.map((row) =>
      MANIFEST_COLUMNS.map((column) => quoteCsvValue(row[column])).join(","),
    ),
  ].join("\n") + "\n";

const isoDate = (date) => date.toISOString().slice(0, 10);

export const planManifestRefresh = ({ rows, hashes, upstreamState, now }) => {
  const changed = [];
  let unchanged = 0;

  const nextRows = rows.map((row) => {
    const nextSha = hashes[row.file_path];
    if ( !nextSha ) {
      throw new Error(
        `Local file missing for manifest row ${row.file_name} (${row.file_path})`,
      );
    }
    if ( nextSha === row.content_sha256 ) {
      unchanged += 1;
      return row;
    }

    changed.push({
      fileName: row.file_name,
      previousSha: row.content_sha256,
      nextSha,
    });

    const upstream = upstreamState?.entries?.[row.file_name] || {};
    return {
      ...row,
      content_sha256: nextSha,
      retrieved_at: isoDate(now),
      pdf_url: upstream.pdfUrl || row.pdf_url,
      upstream_revision: upstream.revision || row.upstream_revision,
    };
  });

  return { rows: nextRows, changed, unchanged };
};
```

The `!nextSha` throw is the point of the last test: a manifest row whose PDF vanished must stop the refresh loudly, not quietly write an empty hash that then poisons `corpusVersion`.

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test LeaseQA/RAG/corpusManifest.test.js
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Write the refresh CLI**

Create `scripts/refresh-corpus-manifest.js`:

```js
import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveCorpusRoot } from "../LeaseQA/RAG/config.js";
import {
  parseManifestCsv,
  planManifestRefresh,
  serializeManifestCsv,
} from "../LeaseQA/RAG/corpusManifest.js";

const HELP = `Usage: node scripts/refresh-corpus-manifest.js [options]

Recomputes content_sha256 for every manifest row from the PDFs on disk.
retrieved_at, pdf_url and upstream_revision are updated ONLY for rows whose
bytes actually changed, so a no-op refresh leaves corpus_manifest.csv
byte-identical and does not trigger a re-ingest.

Options:
  --corpus-root=<path>  Corpus directory (default: RAG_CORPUS_ROOT or auto-detected)
  --dry-run             Report what would change without writing
  --help                Show this help`;

const parseArgs = (argv) =>
  argv.reduce(
    (options, argument) => {
      if ( argument === "--help" || argument === "-h" ) {
        return { ...options, help: true };
      }
      if ( argument === "--dry-run" ) {
        return { ...options, dryRun: true };
      }
      if ( argument.startsWith("--corpus-root=") ) {
        return {
          ...options,
          corpusRoot: path.resolve(argument.slice("--corpus-root=".length)),
        };
      }
      return options;
    },
    { help: false, dryRun: false, corpusRoot: null },
  );

const readUpstreamState = async (statePath) => {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch ( error ) {
    if ( error?.code === "ENOENT" ) {
      return { entries: {} };
    }
    throw error;
  }
};

const hashCorpusFiles = async ({ corpusRoot, rows }) => {
  const hashes = {};
  for ( const row of rows ) {
    try {
      const buffer = await fs.readFile(path.resolve(corpusRoot, row.file_path));
      hashes[row.file_path] = createHash("sha256").update(buffer).digest("hex");
    } catch ( error ) {
      if ( error?.code !== "ENOENT" ) {
        throw error;
      }
    }
  }
  return hashes;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if ( options.help ) {
    console.log(HELP);
    return 0;
  }

  const corpusRoot = options.corpusRoot || resolveCorpusRoot();
  const manifestPath = path.join(corpusRoot, "corpus_manifest.csv");
  const statePath = path.join(corpusRoot, "upstream_state.json");

  const rows = parseManifestCsv(await fs.readFile(manifestPath, "utf8"));
  const hashes = await hashCorpusFiles({ corpusRoot, rows });
  const upstreamState = await readUpstreamState(statePath);

  const plan = planManifestRefresh({
    rows,
    hashes,
    upstreamState,
    now: new Date(),
  });

  console.log(
    JSON.stringify(
      {
        event: "corpus_manifest_refresh",
        corpusRoot,
        unchanged: plan.unchanged,
        changed: plan.changed.map((entry) => entry.fileName),
        dryRun: options.dryRun,
      },
      null,
      2,
    ),
  );

  if ( plan.changed.length === 0 ) {
    console.log("Manifest already matches the PDFs on disk; nothing written.");
    return 0;
  }
  if ( options.dryRun ) {
    return 0;
  }

  await fs.writeFile(manifestPath, serializeManifestCsv(plan.rows));
  console.log(`Wrote ${manifestPath}. Next: npm run ingest:rag`);
  return 0;
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("Corpus manifest refresh failed:", error);
    process.exitCode = 1;
  });
```

- [ ] **Step 6: Backfill the real manifest's new columns**

This is a one-time migration. Run from the server repository root with the corpus in place:

```bash
node -e '
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const manifestPath = path.join(root, "corpus_manifest.csv");
const lines = fs.readFileSync(manifestPath, "utf8").split(/\r?\n/).filter(Boolean);
const header = lines[0].split(",");
if ( header.includes("content_sha256") ) { console.log("already migrated"); process.exit(0); }
const out = [header.concat(["pdf_url","content_sha256","retrieved_at","upstream_revision"]).join(",")];
for ( const line of lines.slice(1) ) {
  const cols = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).slice(0, header.length).map((c) => c.replace(/,$/, ""));
  const record = Object.fromEntries(header.map((h, i) => [h, cols[i] ?? ""]));
  const buffer = fs.readFileSync(path.join(root, record.file_path.replace(/^"|"$/g, "")));
  const sha = createHash("sha256").update(buffer).digest("hex");
  out.push(line + ",," + sha + ",2026-03-01," + (record.title_hint || ""));
}
fs.writeFileSync(manifestPath, out.join("\n") + "\n");
console.log("backfilled " + (out.length - 1) + " rows");
' "$(node -e "import('./LeaseQA/RAG/config.js').then((m) => console.log(m.resolveCorpusRoot()))")"
```

`pdf_url` is intentionally left empty — Task 6's checker discovers it. `retrieved_at` is `2026-03-01`, the verified download date of the current snapshot. `upstream_revision` is seeded from `title_hint`, which already carries the official revision string.

- [ ] **Step 7: Verify the backfill did not change `corpusVersion` semantics unexpectedly**

```bash
node scripts/refresh-corpus-manifest.js --dry-run
```

Expected: `"changed": []` and `"unchanged": 81`. The manifest text *has* changed (new columns), so the next ingest will legitimately rebuild — that is a one-time cost. Confirm the count is 81 and no row throws.

- [ ] **Step 8: Seed `upstream_state.json`**

Create `<corpus-root>/upstream_state.json`:

```json
{
  "checkedAt": null,
  "note": "Written by scripts/check-corpus-upstream.js. Never referenced by corpus_manifest.csv, so it is not part of corpusVersion.",
  "entries": {}
}
```

- [ ] **Step 9: Run the suite and commit**

```bash
npm run test:rag && npm run lint
```

Then commit the code in the server repository:

```bash
git add LeaseQA/RAG/corpusManifest.js LeaseQA/RAG/corpusManifest.test.js scripts/refresh-corpus-manifest.js
git commit -m "feat: add content-stable corpus provenance columns and refresh tool"
```

The manifest and `upstream_state.json` are corpus-repository files; they are committed in Task 7.

---

### Task 6: Upstream change checker

Reads public chapter pages in a real browser, extracts PDF links and their revision text, diffs against the manifest, writes `upstream_state.json` and a human-readable report. Downloads nothing.

**Files:**
- Create: `scripts/check-corpus-upstream.js`
- Create: `LeaseQA/RAG/upstreamCheck.js`
- Create: `LeaseQA/RAG/upstreamCheck.test.js`
- Modify: `package.json` (add `playwright` devDependency and two scripts)

**Interfaces:**
- Consumes: `parseManifestCsv` (Task 5).
- Produces:
  ```
  CHALLENGE_MARKERS: string[]
  isChallengePage(pageTitle, bodyText) -> boolean
  extractPdfCandidates(anchors) -> Array<{ href: string, text: string }>
    // anchors: Array<{ href: string, text: string }> harvested from the DOM
  matchCandidateForRow(row, candidates) -> { href, text } | null
  diffAgainstManifest({ rows, observations }) -> {
    checkedAt: string,
    entries: Record<string, { pdfUrl, revision, status, pageUrl }>,
    changed: Array<{ fileName, previousRevision, nextRevision }>,
    blocked: string[],
    notFound: string[],
  }
  ```
  `status` is one of `"ok" | "changed" | "blocked" | "not_found"`.

- [ ] **Step 1: Write the failing test**

Create `LeaseQA/RAG/upstreamCheck.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  diffAgainstManifest,
  extractPdfCandidates,
  isChallengePage,
  matchCandidateForRow,
} from "./upstreamCheck.js";

const ROW = {
  file_name: "ch03_security_deposits.pdf",
  file_path: "pdf/chapters/ch03_security_deposits.pdf",
  source_url: "https://www.masslegalhelp.org/x/chapter-3",
  pdf_url: "https://www.masslegalhelp.org/files/03-security-deposits-2025.pdf",
  upstream_revision: "03 Security Deposits 2025- Updated 8-13-25",
};

test("a Cloudflare interstitial is recognized as a challenge", () => {
  assert.equal(isChallengePage("Just a moment...", "Checking your browser"), true);
  assert.equal(
    isChallengePage("Chapter 3: Security Deposits", "Your landlord must..."),
    false,
  );
});

test("only PDF anchors are kept, with whitespace-collapsed text", () => {
  const candidates = extractPdfCandidates([
    { href: "https://x/03-security-deposits-2025.pdf", text: "  03 Security\n Deposits 2025 " },
    { href: "https://x/chapter-4", text: "Next chapter" },
    { href: "https://x/form.PDF?download=1", text: "Form 5" },
  ]);

  assert.deepEqual(candidates, [
    { href: "https://x/03-security-deposits-2025.pdf", text: "03 Security Deposits 2025" },
    { href: "https://x/form.PDF?download=1", text: "Form 5" },
  ]);
});

test("a row matches the candidate whose href basename is closest to its known pdf_url", () => {
  const match = matchCandidateForRow(ROW, [
    { href: "https://x/04-tenancies-2025.pdf", text: "04 Tenancies 2025" },
    {
      href: "https://www.masslegalhelp.org/files/03-security-deposits-2025.pdf",
      text: "03 Security Deposits 2025- Updated 8-13-25",
    },
  ]);

  assert.equal(match.href, "https://www.masslegalhelp.org/files/03-security-deposits-2025.pdf");
});

test("a row with no known pdf_url falls back to matching on the revision text", () => {
  const match = matchCandidateForRow(
    { ...ROW, pdf_url: "" },
    [
      { href: "https://x/04-tenancies-2025.pdf", text: "04 Tenancies 2025" },
      { href: "https://x/03-sd-2025.pdf", text: "03 Security Deposits 2025- Updated 8-13-25" },
    ],
  );

  assert.equal(match.href, "https://x/03-sd-2025.pdf");
});

test("an unmatchable row returns null rather than a wrong guess", () => {
  assert.equal(
    matchCandidateForRow({ ...ROW, pdf_url: "" }, [
      { href: "https://x/18-foreclosures-2025.pdf", text: "18 Foreclosures 2025" },
    ]),
    null,
  );
});

test("diff reports changed revisions, blocked pages, and missing links separately", () => {
  const rows = [
    ROW,
    { ...ROW, file_name: "ch04_tenancies.pdf", pdf_url: "https://x/04.pdf", upstream_revision: "04 Tenancies 2025" },
    { ...ROW, file_name: "ch05_rent.pdf", pdf_url: "https://x/05.pdf", upstream_revision: "05 Rent 2025 v2" },
  ];
  const observations = {
    "ch03_security_deposits.pdf": {
      status: "ok",
      pageUrl: ROW.source_url,
      candidate: {
        href: "https://www.masslegalhelp.org/files/03-security-deposits-2026.pdf",
        text: "03 Security Deposits 2026 - Updated 1-15-26",
      },
    },
    "ch04_tenancies.pdf": { status: "blocked", pageUrl: ROW.source_url, candidate: null },
    "ch05_rent.pdf": { status: "ok", pageUrl: ROW.source_url, candidate: null },
  };

  const diff = diffAgainstManifest({
    rows,
    observations,
    now: new Date("2026-09-01T12:00:00.000Z"),
  });

  assert.equal(diff.checkedAt, "2026-09-01T12:00:00.000Z");
  assert.deepEqual(diff.changed, [
    {
      fileName: "ch03_security_deposits.pdf",
      previousRevision: "03 Security Deposits 2025- Updated 8-13-25",
      nextRevision: "03 Security Deposits 2026 - Updated 1-15-26",
    },
  ]);
  assert.deepEqual(diff.blocked, ["ch04_tenancies.pdf"]);
  assert.deepEqual(diff.notFound, ["ch05_rent.pdf"]);
  assert.equal(diff.entries["ch03_security_deposits.pdf"].status, "changed");
  assert.equal(
    diff.entries["ch03_security_deposits.pdf"].pdfUrl,
    "https://www.masslegalhelp.org/files/03-security-deposits-2026.pdf",
  );
});

test("an unchanged revision is recorded as ok and not listed as changed", () => {
  const diff = diffAgainstManifest({
    rows: [ROW],
    observations: {
      "ch03_security_deposits.pdf": {
        status: "ok",
        pageUrl: ROW.source_url,
        candidate: { href: ROW.pdf_url, text: ROW.upstream_revision },
      },
    },
    now: new Date("2026-09-01T12:00:00.000Z"),
  });

  assert.deepEqual(diff.changed, []);
  assert.equal(diff.entries["ch03_security_deposits.pdf"].status, "ok");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test LeaseQA/RAG/upstreamCheck.test.js
```

Expected: FAIL with `Cannot find module .../LeaseQA/RAG/upstreamCheck.js`.

- [ ] **Step 3: Write minimal implementation**

Create `LeaseQA/RAG/upstreamCheck.js`:

```js
export const CHALLENGE_MARKERS = [
  "just a moment",
  "checking your browser",
  "enable javascript and cookies to continue",
  "verify you are human",
];

const collapse = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export const isChallengePage = (pageTitle, bodyText) => {
  const haystack = `${collapse(pageTitle)} ${collapse(bodyText)}`.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => haystack.includes(marker));
};

export const extractPdfCandidates = (anchors) =>
  (anchors || [])
    .filter((anchor) => /\.pdf(\?|#|$)/i.test(String(anchor?.href || "")))
    .map((anchor) => ({
      href: String(anchor.href),
      text: collapse(anchor.text),
    }));

const basename = (href) => {
  try {
    return new URL(href).pathname.split("/").pop().toLowerCase();
  } catch {
    return String(href).split("/").pop().toLowerCase();
  }
};

const normalizeRevision = (value) =>
  collapse(value).toLowerCase().replace(/[^a-z0-9]+/g, "");

export const matchCandidateForRow = (row, candidates) => {
  if ( row.pdf_url ) {
    const target = basename(row.pdf_url);
    const exact = candidates.find((candidate) => basename(candidate.href) === target);
    if ( exact ) {
      return exact;
    }
  }

  const revision = normalizeRevision(row.upstream_revision);
  if ( revision ) {
    const byText = candidates.find(
      (candidate) => normalizeRevision(candidate.text) === revision,
    );
    if ( byText ) {
      return byText;
    }
    const prefix = revision.slice(0, 12);
    const byPrefix = candidates.filter((candidate) =>
      normalizeRevision(candidate.text).startsWith(prefix),
    );
    if ( byPrefix.length === 1 ) {
      return byPrefix[0];
    }
  }

  return null;
};

export const diffAgainstManifest = ({ rows, observations, now = new Date() }) => {
  const entries = {};
  const changed = [];
  const blocked = [];
  const notFound = [];

  for ( const row of rows ) {
    const observation = observations[row.file_name];

    if ( !observation || observation.status === "blocked" ) {
      blocked.push(row.file_name);
      entries[row.file_name] = {
        pdfUrl: row.pdf_url || "",
        revision: row.upstream_revision || "",
        status: "blocked",
        pageUrl: observation?.pageUrl || row.source_url,
      };
      continue;
    }

    if ( !observation.candidate ) {
      notFound.push(row.file_name);
      entries[row.file_name] = {
        pdfUrl: row.pdf_url || "",
        revision: row.upstream_revision || "",
        status: "not_found",
        pageUrl: observation.pageUrl || row.source_url,
      };
      continue;
    }

    const nextRevision = observation.candidate.text;
    const isChanged =
      normalizeRevision(nextRevision) !== normalizeRevision(row.upstream_revision);

    if ( isChanged ) {
      changed.push({
        fileName: row.file_name,
        previousRevision: row.upstream_revision || "",
        nextRevision,
      });
    }

    entries[row.file_name] = {
      pdfUrl: observation.candidate.href,
      revision: nextRevision,
      status: isChanged ? "changed" : "ok",
      pageUrl: observation.pageUrl || row.source_url,
    };
  }

  return {
    checkedAt: now.toISOString(),
    entries,
    changed,
    blocked,
    notFound,
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test LeaseQA/RAG/upstreamCheck.test.js
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Add Playwright as a devDependency and register scripts**

```bash
npm install --save-dev playwright@^1.58.2
```

Add to the `scripts` block of `package.json`:

```json
    "corpus:check": "node scripts/check-corpus-upstream.js",
    "corpus:refresh": "node scripts/refresh-corpus-manifest.js",
```

Also change `render.yaml`'s `buildCommand` from `npm ci` to `npm ci --omit=dev` so the production web service does not install a browser automation library it never uses.

- [ ] **Step 6: Write the browser driver**

Create `scripts/check-corpus-upstream.js`:

```js
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { resolveCorpusRoot } from "../LeaseQA/RAG/config.js";
import { parseManifestCsv } from "../LeaseQA/RAG/corpusManifest.js";
import {
  diffAgainstManifest,
  extractPdfCandidates,
  isChallengePage,
  matchCandidateForRow,
} from "../LeaseQA/RAG/upstreamCheck.js";

const HELP = `Usage: node scripts/check-corpus-upstream.js [options]

Opens each manifest source_url in a real browser, reads the PDF links and their
revision text, and reports what changed upstream. Downloads nothing.

If a page returns a Cloudflare challenge it is recorded as "blocked" and left
for a human. This tool must never attempt to solve or evade that challenge.

Options:
  --corpus-root=<path>   Corpus directory (default: RAG_CORPUS_ROOT or auto-detected)
  --report=<path>        JSON report path (default: artifacts/corpus-upstream.json)
  --limit=<count>        Check only the first N manifest rows
  --delay-ms=<ms>        Pause between page loads (default: 4000)
  --headed               Show the browser (use when confirming selectors)
  --dump-html=<path>     Save the first page's HTML for selector inspection
  --write-state          Update <corpus-root>/upstream_state.json
  --help                 Show this help`;

const parseArgs = (argv) =>
  argv.reduce(
    (options, argument) => {
      if ( argument === "--help" || argument === "-h" ) return { ...options, help: true };
      if ( argument === "--headed" ) return { ...options, headed: true };
      if ( argument === "--write-state" ) return { ...options, writeState: true };
      if ( argument.startsWith("--corpus-root=") ) {
        return { ...options, corpusRoot: path.resolve(argument.slice(14)) };
      }
      if ( argument.startsWith("--report=") ) {
        return { ...options, reportPath: path.resolve(argument.slice(9)) };
      }
      if ( argument.startsWith("--dump-html=") ) {
        return { ...options, dumpHtml: path.resolve(argument.slice(12)) };
      }
      if ( argument.startsWith("--limit=") ) {
        const value = Number.parseInt(argument.slice(8), 10);
        return Number.isFinite(value) && value > 0 ? { ...options, limit: value } : options;
      }
      if ( argument.startsWith("--delay-ms=") ) {
        const value = Number.parseInt(argument.slice(11), 10);
        return Number.isFinite(value) && value >= 0 ? { ...options, delayMs: value } : options;
      }
      return options;
    },
    {
      help: false,
      headed: false,
      writeState: false,
      corpusRoot: null,
      reportPath: path.resolve("artifacts", "corpus-upstream.json"),
      dumpHtml: null,
      limit: null,
      delayMs: 4000,
    },
  );

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readPageAnchors = async (page) =>
  page.$$eval("a[href]", (nodes) =>
    nodes.map((node) => ({ href: node.href, text: node.textContent || "" })),
  );

const observePage = async ({ page, url, dumpHtml }) => {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch {
    return { status: "blocked", pageUrl: url, candidates: [] };
  }

  const title = await page.title();
  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || "");

  if ( dumpHtml ) {
    await fs.mkdir(path.dirname(dumpHtml), { recursive: true });
    await fs.writeFile(dumpHtml, await page.content());
  }

  if ( isChallengePage(title, bodyText) ) {
    return { status: "blocked", pageUrl: url, candidates: [] };
  }

  return {
    status: "ok",
    pageUrl: url,
    candidates: extractPdfCandidates(await readPageAnchors(page)),
  };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if ( options.help ) {
    console.log(HELP);
    return 0;
  }

  const corpusRoot = options.corpusRoot || resolveCorpusRoot();
  const manifestPath = path.join(corpusRoot, "corpus_manifest.csv");
  const allRows = parseManifestCsv(await fs.readFile(manifestPath, "utf8"));
  const rows = options.limit ? allRows.slice(0, options.limit) : allRows;

  const browser = await chromium.launch({ headless: !options.headed });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  const page = await context.newPage();

  const observations = {};
  let dumpTarget = options.dumpHtml;

  try {
    for ( const [index, row] of rows.entries() ) {
      const observed = await observePage({
        page,
        url: row.source_url,
        dumpHtml: dumpTarget,
      });
      dumpTarget = null;

      observations[row.file_name] = {
        status: observed.status,
        pageUrl: observed.pageUrl,
        candidate:
          observed.status === "ok"
            ? matchCandidateForRow(row, observed.candidates)
            : null,
      };

      console.info(
        `[corpus check] ${index + 1}/${rows.length} ${row.file_name} -> ${observations[row.file_name].status}`,
      );

      if ( index < rows.length - 1 ) {
        await sleep(options.delayMs);
      }
    }
  } finally {
    await browser.close();
  }

  const diff = diffAgainstManifest({ rows, observations, now: new Date() });

  await fs.mkdir(path.dirname(options.reportPath), { recursive: true });
  await fs.writeFile(options.reportPath, `${JSON.stringify(diff, null, 2)}\n`);

  if ( options.writeState ) {
    await fs.writeFile(
      path.join(corpusRoot, "upstream_state.json"),
      `${JSON.stringify(
        {
          checkedAt: diff.checkedAt,
          note: "Written by scripts/check-corpus-upstream.js. Never referenced by corpus_manifest.csv, so it is not part of corpusVersion.",
          entries: diff.entries,
        },
        null,
        2,
      )}\n`,
    );
  }

  console.log(
    `SUMMARY checked=${rows.length} changed=${diff.changed.length} blocked=${diff.blocked.length} notFound=${diff.notFound.length} report=${options.reportPath}`,
  );

  return diff.changed.length > 0 ? 3 : 0;
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("Corpus upstream check failed:", error);
    process.exitCode = 1;
  });
```

Exit code `3` means "upstream changed"; `0` means "no change"; `1` means the tool itself broke. The workflow in Task 8 distinguishes them.

- [ ] **Step 7: Confirm the real page structure before trusting the checker**

**This step cannot be skipped or guessed.** The anchor structure of masslegalhelp.org has not been verified — Cloudflare blocked programmatic inspection during planning, and `readPageAnchors` uses a generic `a[href]` sweep as a deliberate placeholder.

```bash
npx playwright install chromium
node scripts/check-corpus-upstream.js --limit=1 --headed --dump-html=artifacts/mlh-sample.html
```

Then:
1. Confirm the page loaded (status `ok`, not `blocked`). If it is `blocked` even headed, stop and report — do not add evasion. Fall back to the human-only path and note it in the report.
2. Open `artifacts/mlh-sample.html` and check whether the PDF anchors carry the revision string in their text. If the revision lives in a sibling element or an attribute instead, narrow `readPageAnchors` to the real container selector and adjust the `text` source accordingly.
3. Re-run with `--limit=3` and confirm `matchCandidateForRow` finds the right link for all three.
4. Only then run the full sweep: `node scripts/check-corpus-upstream.js --write-state`. At 81 pages and a 4s delay this takes about 6 minutes.

If step 2 required changing the selector, add a regression test to `upstreamCheck.test.js` using a trimmed snippet of the real anchor list.

- [ ] **Step 8: Run the suite, lint, and commit**

```bash
npm run test:rag && npm run lint
```

```bash
git add LeaseQA/RAG/upstreamCheck.js LeaseQA/RAG/upstreamCheck.test.js scripts/check-corpus-upstream.js package.json package-lock.json render.yaml
git commit -m "feat: add polite upstream change checker for the MassLegalHelp corpus"
```

Add `artifacts/` to `.gitignore` if it is not already there — it is (line 19 of `.gitignore`).

---

### Task 7: Move the corpus into its own repository and let CI ingest

**Files:**
- Create (new repository `leaseqa-corpus`): `corpus_manifest.csv`, `upstream_state.json`, `CORPUS_GUIDE.md`, `pdf/**`, `README.md`, `.gitignore`
- Create: `.github/workflows/corpus-ingest.yml`
- Modify: `README.md` (server repository, corpus section)
- Modify: `.env.example` (document `RAG_CORPUS_ROOT` as the corpus checkout path)
- Modify (workspace, not a repository file): `docs/notes/workspace-role.md`

**Interfaces:**
- Consumes: the migrated manifest from Task 5 and `upstream_state.json` from Task 6.
- Produces: a `RAG_CORPUS_ROOT` contract — any checkout of `leaseqa-corpus` at `<path>/mass tenant rights` works as a corpus root, and `resolveCorpusRoot()` needs no code change.

- [ ] **Step 1: Create the corpus repository from the existing files**

```bash
git init /Users/Z1nk/Desktop/proj/leaseqa/resources/rag-corpus
```

Create `/Users/Z1nk/Desktop/proj/leaseqa/resources/rag-corpus/README.md`:

```markdown
# LeaseQA Corpus — Massachusetts Tenant Rights

Source snapshot of MassLegalHelp *Legal Tactics: Tenants' Rights in Massachusetts*.
Consumed only by `leaseqa-server`'s `npm run ingest:rag`; the running web service
never reads it.

## Layout

- `mass tenant rights/corpus_manifest.csv` — the ingest contract. Its full text is
  hashed into `corpusVersion`, so **never** touch it by hand; use
  `npm run corpus:refresh` in the server repository.
- `mass tenant rights/upstream_state.json` — last upstream check. Not referenced by
  the manifest, therefore not part of `corpusVersion`. Safe to update freely.
- `mass tenant rights/pdf/**` — the source PDFs.
- `mass tenant rights/CORPUS_GUIDE.md` — retrieval strategy and metadata reference.

## Refresh procedure

1. `npm run corpus:check -- --write-state` in the server repository. Read the report.
2. For each changed file, download the new PDF **in a real browser** from the page
   URL in the report and overwrite the file in place, keeping its existing name.
3. `npm run corpus:refresh` in the server repository. It rewrites only the rows whose
   bytes changed. A no-op refresh must leave `corpus_manifest.csv` byte-identical.
4. Commit here with the upstream revision strings in the message.
5. Run the `corpus-ingest` workflow in the server repository, or `npm run ingest:rag`
   locally. The retrieval gate decides whether the alias moves.

Plain git, no LFS: 36 MB total, largest file 1.5 MB.
```

Create `/Users/Z1nk/Desktop/proj/leaseqa/resources/rag-corpus/.gitignore`:

```
.DS_Store
```

- [ ] **Step 2: Commit the corpus and push it**

```bash
cd /Users/Z1nk/Desktop/proj/leaseqa/resources/rag-corpus && git add -A && git commit -m "chore: import Legal Tactics 2025 corpus snapshot with provenance columns"
```

Then create the remote and push (requires the `gh` CLI to be authenticated):

```bash
cd /Users/Z1nk/Desktop/proj/leaseqa/resources/rag-corpus && gh repo create leaseqa-corpus --private --source=. --push
```

- [ ] **Step 3: Confirm local ingest still resolves the corpus**

The workspace path is unchanged, so the existing parent-directory walk in `resolveCorpusRoot()` still finds it. Verify without touching Milvus:

```bash
node -e "import('./LeaseQA/RAG/config.js').then((m) => console.log(m.resolveCorpusRoot()))"
```

Expected: `/Users/Z1nk/Desktop/proj/leaseqa/resources/rag-corpus/mass tenant rights`

- [ ] **Step 4: Add the CI ingest workflow**

Create `.github/workflows/corpus-ingest.yml`:

```yaml
name: Corpus Ingest

on:
  workflow_dispatch:
    inputs:
      corpus_ref:
        description: Ref of leaseqa-corpus to ingest
        required: false
        default: main
      min_hit_rate:
        description: Minimum retrieval gate hit rate
        required: false
        default: "0.9"

permissions:
  contents: read

jobs:
  ingest:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - name: Check out server
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2

      - name: Check out corpus
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          repository: ${{ github.repository_owner }}/leaseqa-corpus
          ref: ${{ inputs.corpus_ref }}
          token: ${{ secrets.CORPUS_REPO_TOKEN }}
          path: corpus

      - name: Set up Node.js
        uses: actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f # v6.3.0
        with:
          node-version: 24.19.0
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Ingest with the retrieval gate
        env:
          DATABASE_CONNECTION_STRING: ${{ secrets.RAG_EVAL_DATABASE_CONNECTION_STRING }}
          DASHSCOPE_API_KEY: ${{ secrets.RAG_EVAL_DASHSCOPE_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.RAG_EVAL_GEMINI_API_KEY }}
          RAG_MILVUS_ADDRESS: ${{ secrets.RAG_EVAL_MILVUS_ADDRESS }}
          RAG_MILVUS_TOKEN: ${{ secrets.RAG_EVAL_MILVUS_TOKEN }}
          RAG_PROVIDER: ${{ secrets.RAG_EVAL_EMBEDDING_PROVIDER }}
          RAG_EMBEDDING_MODEL: ${{ secrets.RAG_EVAL_EMBEDDING_MODEL }}
          RAG_EMBEDDING_DIMENSIONS: ${{ secrets.RAG_EVAL_EMBEDDING_DIMENSIONS }}
          RAG_CORPUS_ROOT: ${{ github.workspace }}/corpus/mass tenant rights
          RAG_INGEST_STATE_PATH: ${{ github.workspace }}/.rag-knowledge-ingest-state.json
          RAG_INGEST_GATE_MIN_HIT_RATE: ${{ inputs.min_hit_rate }}
        run: npm run ingest:rag

      - name: Upload ingest state
        if: always()
        uses: actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f # v7.0.0
        with:
          name: corpus-ingest-${{ github.run_id }}
          path: .rag-knowledge-ingest-state.json
          if-no-files-found: warn
```

The job needs a `CORPUS_REPO_TOKEN` secret — a fine-grained PAT with read access to `leaseqa-corpus`. Note this in the PR description; the repository owner must add it.

- [ ] **Step 5: Document the split in the server README**

In `README.md`, replace the corpus paragraph with:

```markdown
### Knowledge corpus

The corpus lives in a separate repository, `leaseqa-corpus`, because only
`npm run ingest:rag` reads it — the running web service never does.

- Local development: clone it to `<workspace>/resources/rag-corpus`; the default
  corpus resolution walks up from the server directory and finds it.
- Anywhere else (CI, another checkout layout): set
  `RAG_CORPUS_ROOT=<checkout>/mass tenant rights`.

Refresh workflow: `npm run corpus:check -- --write-state` → download changed PDFs in a
real browser → `npm run corpus:refresh` → commit in `leaseqa-corpus` → run the
`corpus-ingest` workflow. The retrieval gate decides whether the alias moves; see
`docs/superpowers/specs/2026-08-23-corpus-upstream-sync.md`.
```

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/corpus-ingest.yml README.md .env.example
git commit -m "ci: ingest the corpus from its own repository behind the retrieval gate"
```

---

### Task 8: Weekly upstream check that opens an issue

**Files:**
- Create: `.github/workflows/corpus-upstream-check.yml`

**Interfaces:**
- Consumes: `scripts/check-corpus-upstream.js` (Task 6) and its exit codes (`0` no change, `3` changed, `1` broken).
- Produces: at most one open issue labelled `corpus-upstream` at a time.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/corpus-upstream-check.yml`:

```yaml
name: Corpus Upstream Check

on:
  schedule:
    - cron: "0 13 * * 1"
  workflow_dispatch:

permissions:
  contents: read
  issues: write

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Check out server
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2

      - name: Check out corpus
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          repository: ${{ github.repository_owner }}/leaseqa-corpus
          token: ${{ secrets.CORPUS_REPO_TOKEN }}
          path: corpus

      - name: Set up Node.js
        uses: actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f # v6.3.0
        with:
          node-version: 24.19.0
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Install Chromium
        run: npx playwright install --with-deps chromium

      - name: Check upstream
        id: check
        env:
          RAG_CORPUS_ROOT: ${{ github.workspace }}/corpus/mass tenant rights
        run: |
          set +e
          node scripts/check-corpus-upstream.js --report=artifacts/corpus-upstream.json
          status=$?
          set -e
          echo "status=$status" >> "$GITHUB_OUTPUT"
          if [ "$status" -eq 1 ]; then
            echo "checker failed" >&2
            exit 1
          fi

      - name: Upload report
        if: always()
        uses: actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f # v7.0.0
        with:
          name: corpus-upstream-${{ github.run_id }}
          path: artifacts/corpus-upstream.json
          if-no-files-found: warn

      - name: Open or update the corpus refresh issue
        if: steps.check.outputs.status == '3'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          body=$(node -e '
            const report = require("./artifacts/corpus-upstream.json");
            const lines = [
              "MassLegalHelp published changes to the tenant-rights corpus.",
              "",
              "Checked at: " + report.checkedAt,
              "",
              "## Changed (" + report.changed.length + ")",
              "",
              "| File | Recorded revision | Upstream revision |",
              "| --- | --- | --- |",
              ...report.changed.map((entry) =>
                "| `" + entry.fileName + "` | " + (entry.previousRevision || "—") +
                " | " + entry.nextRevision + " |"),
              "",
              "## Blocked (" + report.blocked.length + ")",
              "",
              report.blocked.length
                ? report.blocked.map((name) => "- `" + name + "`").join("\n")
                : "None.",
              "",
              "## No PDF link found (" + report.notFound.length + ")",
              "",
              report.notFound.length
                ? report.notFound.map((name) => "- `" + name + "`").join("\n")
                : "None.",
              "",
              "## Next steps",
              "",
              "1. Download each changed PDF in a real browser from the page URL in the report artifact.",
              "2. Overwrite the file in `leaseqa-corpus`, keeping its existing name.",
              "3. Run `npm run corpus:refresh` in the server repository.",
              "4. Commit in `leaseqa-corpus`, then run the `corpus-ingest` workflow.",
              "",
              "Blocked entries need a manual look — do not add bot-check evasion.",
            ];
            console.log(lines.join("\n"));
          ')
          existing=$(gh issue list --label corpus-upstream --state open --limit 1 --json number --jq '.[0].number // empty')
          if [ -n "$existing" ]; then
            gh issue comment "$existing" --body "$body"
          else
            gh label create corpus-upstream --description "MassLegalHelp corpus drift" --color FBCA04 2>/dev/null || true
            gh issue create --title "Corpus refresh needed: MassLegalHelp updated $(date -u +%Y-%m-%d)" --label corpus-upstream --body "$body"
          fi
```

Monday 13:00 UTC is 09:00 America/New_York in EDT — a weekday morning for the maintainer, and low traffic for the source site.

- [ ] **Step 2: Validate the workflow file parses**

```bash
node -e "const {readFileSync}=require('node:fs');const s=readFileSync('.github/workflows/corpus-upstream-check.yml','utf8');if(!/on:\s/.test(s))throw new Error('no trigger');console.log('yaml read ok, '+s.split('\n').length+' lines')"
```

Then push the branch and confirm GitHub lists both new workflows under Actions without a parse error. A syntactically invalid workflow shows as a repository warning rather than a failed run, so check explicitly.

- [ ] **Step 3: Dry-run the check by hand**

Trigger `Corpus Upstream Check` via `workflow_dispatch` and confirm:
- the run completes,
- `corpus-upstream-<run_id>` artifact exists and its `blocked` list is empty or small,
- no issue is opened when `changed` is empty.

If every entry comes back `blocked`, Cloudflare is challenging the GitHub runner's IP range even with a real browser. Do not add evasion. Report it, and fall back to running `npm run corpus:check` locally on a schedule — record that decision in the spec's "Upstream access constraint" section.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/corpus-upstream-check.yml
git commit -m "ci: check MassLegalHelp weekly and open a corpus refresh issue on drift"
```

---

## Self-Review

**Spec coverage**

| Spec item | Task |
| --- | --- |
| Gap 1 — no upstream change detection | Tasks 5, 6, 8 |
| Gap 2 — corpus unversioned, CI cannot ingest | Task 7 |
| Gap 3 — alias activation has no quality gate | Tasks 1-4 |
| Gap 4 — provenance invisible to users | Out of scope, stated as a non-goal |
| D1 — content-stable manifest columns | Task 5 Steps 1-4, enforced by the byte-identical no-op test |
| D2 — separate repo, plain git, `RAG_CORPUS_ROOT` | Task 7 |
| D3 — retrieval-only in-process gate, 27 cases, fail closed | Tasks 1-4 |
| D4 — no circular imports | Task 4 Step 4 injects `embedQuery`/`retrieveChunks`; `corpusGate.js` imports only `evalExpectations.js` |
| "Never evade the bot check" | Task 6 Step 7, Task 8 Step 3, and `isChallengePage` recording `blocked` |

**Known open item, deliberately left open**

Task 6 Step 7 requires a human to confirm the real anchor structure of masslegalhelp.org before the checker can be trusted. This is not a placeholder — Cloudflare blocked programmatic inspection during planning, and the step spells out exactly what to look at, what to change, and what to do if the page is still blocked. Guessing a selector here would be worse than naming the unknown.

**Type consistency**

- `matchesExpectation(evalCase, candidate)` takes a normalized candidate in every caller (Task 1 Step 5, Task 3 `runCase`).
- Chunks are snake_case (`source_group`, `source_name`, `chapter_ref`) everywhere they cross a boundary; citations are camelCase; the two normalizers are the only conversion points.
- `retrieveKnowledgeChunks` keeps `getKnowledgeResults` as a module-local alias, so no existing call site or test changes.
- Gate result shape `{ passed, collectionName, minHitRate, hitRate, total, hits, misses }` is identical in Task 3's implementation, Task 4's persisted `state.gate`, and Task 4's CLI error output.
- Manifest row keys match `MANIFEST_COLUMNS` in `corpusManifest.js`, `upstreamCheck.js`, and the backfill script.

**Execution note**

Tasks 1-4 (the gate) are independent of Tasks 5-8 (corpus sync) and can be reviewed, merged, and deployed on their own. Tasks 5→6→7→8 are strictly ordered: 6 needs 5's columns, 7 needs 6's `upstream_state.json`, 8 needs 6's script and 7's repository.
