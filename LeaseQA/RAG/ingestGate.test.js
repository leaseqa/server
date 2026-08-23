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
    return {
      passed: true,
      minHitRate: 0.9,
      hitRate: 1,
      total: 27,
      hits: 27,
      misses: [],
    };
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
      minHitRate: 0.9,
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
      return {
        passed: false,
        minHitRate: 0.9,
        hitRate: 0,
        total: 0,
        hits: 0,
        misses: [],
      };
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
      return {
        passed: true,
        minHitRate: 0.9,
        hitRate: 1,
        total: 27,
        hits: 27,
        misses: [],
      };
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
