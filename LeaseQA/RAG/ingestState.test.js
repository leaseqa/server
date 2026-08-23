import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as ingestState from "./ingestState.js";
import * as service from "./service.js";

const MANIFEST = [
  "file_name,title_hint,source_type,source_group,chapter_ref,priority,file_path,source_url",
  "first.txt,First section,chapter,chapters,1,P0,docs/first.txt,https://example.test/first",
  "second.txt,Second section,form,forms,,P1,docs/second.txt,https://example.test/second",
  "",
].join("\n");

const createCorpusFixture = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "leaseqa-rag-corpus-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "corpus_manifest.csv"), MANIFEST);
  await writeFile(path.join(root, "docs", "first.txt"), "First tenant right.");
  await writeFile(path.join(root, "docs", "second.txt"), "Second tenant form.");
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
});

const createIngestDependencies = (overrides = {}) => {
  const order = [];
  const insertedRows = [];
  const dependencies = {
    order,
    insertedRows,
    embeddingsClient: {
      embedDocuments: async (texts) => texts.map(() => [0.1, 0.2]),
    },
    extractCorpusPages: async ({ buffer }) => [
      { text: buffer.toString("utf8"), pageNumber: 7 },
    ],
    hasChunkCollection: async () => false,
    insertChunkRows: async ({ collectionName, rows }) => {
      order.push(`insert:${collectionName}`);
      insertedRows.push(...rows);
    },
    flushCollection: async ({ collectionName }) => {
      order.push(`flush:${collectionName}`);
    },
    ensureCollectionLoaded: async ({ collectionName }) => {
      order.push(`load:${collectionName}`);
    },
    getAliasTarget: async () => "leaseqa_knowledge_chunks_aaaaaaaaaaaa",
    activateCollectionAlias: async ({ alias, collectionName }) => {
      order.push(`activate:${alias}:${collectionName}`);
    },
    listCollections: async () => [
      "leaseqa_knowledge_chunks_aaaaaaaaaaaa",
      "leaseqa_knowledge_chunks_unrelated",
    ],
    resetCollection: async ({ collectionName }) => {
      order.push(`drop:${collectionName}`);
    },
    ...overrides,
  };
  return dependencies;
};

test("corpus version hashes manifest bytes plus sorted source hashes", () => {
  const identity = ingestState.buildCorpusIdentity({
    manifestContents: "manifest-bytes",
    sourceHashes: ["hash-b", "hash-a"],
  });

  assert.deepEqual(identity, {
    manifestSha256:
      "7abe730d8933f3f50dfd2b5e4d8be28fb52cad62481446b6f59860f6be7bed09",
    corpusVersion:
      "1a79301019c3814ef46e376de4f3a591b5fe9b2966281bf9093ea2eba8982b63",
  });
});

test("corpus version changes when the embedding fingerprint changes", () => {
  const shared = {
    manifestContents: "manifest-bytes",
    sourceHashes: ["hash-b", "hash-a"],
  };
  const ark = ingestState.buildCorpusIdentity({
    ...shared,
    embeddingFingerprint: "ark:doubao-embedding-vision:1024",
  });
  const dashscope = ingestState.buildCorpusIdentity({
    ...shared,
    embeddingFingerprint: "openai:text-embedding-v3:1024",
  });

  assert.equal(ark.manifestSha256, dashscope.manifestSha256);
  assert.notEqual(ark.corpusVersion, dashscope.corpusVersion);
});

for ( const failureStage of ["parse", "embedding", "insert"] ) {
  test(`${failureStage} failure leaves the active corpus untouched`, async (t) => {
    const root = await createCorpusFixture(t);
    const dependencies = createIngestDependencies();
    if ( failureStage === "parse" ) {
      dependencies.extractCorpusPages = async () => {
        throw new Error("parse failed");
      };
    }
    if ( failureStage === "embedding" ) {
      dependencies.embeddingsClient.embedDocuments = async () => {
        throw new Error("embedding failed");
      };
    }
    if ( failureStage === "insert" ) {
      dependencies.insertChunkRows = async () => {
        throw new Error("insert failed");
      };
    }

    await assert.rejects(
      service.ingestKnowledgeCorpus(
        {},
        { ...dependencies, config: createConfig(root) },
      ),
      new RegExp(`${failureStage} failed`),
    );

    assert.equal(
      dependencies.order.some((entry) => entry.startsWith("activate:")),
      false,
    );
    assert.equal(
      dependencies.order.includes("drop:leaseqa_knowledge_chunks_aaaaaaaaaaaa"),
      false,
    );
  });
}

test("alias activation failure leaves staging state and skips cleanup", async (t) => {
  const root = await createCorpusFixture(t);
  let cleanupDiscovered = false;
  const dependencies = createIngestDependencies({
    activateCollectionAlias: async () => {
      throw Object.assign(new Error("alias rejected"), {
        code: "RAG_MILVUS_STATUS_ERROR",
        status: "UnexpectedError",
      });
    },
    listCollections: async () => {
      cleanupDiscovered = true;
      return [];
    },
  });

  await assert.rejects(
    service.ingestKnowledgeCorpus(
      {},
      { ...dependencies, config: createConfig(root) },
    ),
    (error) => error.code === "RAG_MILVUS_STATUS_ERROR",
  );

  const savedState = JSON.parse(
    await readFile(createConfig(root).ingestStatePath, "utf8"),
  );
  assert.equal(savedState.status, "staging");
  assert.equal(cleanupDiscovered, false);
});

test("successful ingest stages every chunk, activates the alias, then cleans old versions", async (t) => {
  const root = await createCorpusFixture(t);
  const dependencies = createIngestDependencies();

  const result = await service.ingestKnowledgeCorpus(
    {},
    { ...dependencies, config: createConfig(root) },
  );

  assert.match(result.corpusVersion, /^[a-f0-9]{64}$/);
  assert.equal(
    result.collectionName,
    `leaseqa_knowledge_chunks_${result.corpusVersion.slice(0, 12)}`,
  );
  assert.equal(dependencies.insertedRows.length, 2);
  assert.deepEqual(
    dependencies.insertedRows.map((row) => ({
      sourceHash: row.source_hash,
      page: row.page,
      section: row.section,
      corpusVersion: row.corpus_version,
    })),
    [
      {
        sourceHash:
          "16c98cdbc74dd775fbe8194e3a38bbc7dd50ac0fdded7cc94a7e768eb9e3ecd2",
        page: "7",
        section: "First section",
        corpusVersion: result.corpusVersion,
      },
      {
        sourceHash:
          "a49c67abf6750a1eeaae10c644fd4a76cb03600f50bbf29a99c627f85ac9a1cd",
        page: "7",
        section: "Second section",
        corpusVersion: result.corpusVersion,
      },
    ],
  );

  const activateIndex = dependencies.order.findIndex((entry) =>
    entry.startsWith("activate:"),
  );
  assert.ok(activateIndex > dependencies.order.findLastIndex((entry) => entry.startsWith("insert:")));
  assert.ok(activateIndex > dependencies.order.findIndex((entry) => entry.startsWith("load:")));
  assert.ok(
    dependencies.order.indexOf("drop:leaseqa_knowledge_chunks_aaaaaaaaaaaa") >
      activateIndex,
  );
  assert.equal(
    dependencies.order.includes("drop:leaseqa_knowledge_chunks_unrelated"),
    false,
  );

  const savedState = JSON.parse(
    await readFile(createConfig(root).ingestStatePath, "utf8"),
  );
  assert.equal(savedState.status, "active");
  assert.equal(savedState.corpusVersion, result.corpusVersion);
  assert.match(savedState.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(savedState.collectionName, result.collectionName);
  assert.equal(savedState.alias, "leaseqa_knowledge_chunks");
  assert.ok(savedState.activatedAt);
});

test("an active version is reconstructed from the alias when local state is absent", async (t) => {
  const root = await createCorpusFixture(t);
  const config = createConfig(root);
  const firstDependencies = createIngestDependencies();
  const first = await service.ingestKnowledgeCorpus(
    {},
    { ...firstDependencies, config },
  );
  await rm(config.ingestStatePath);

  const secondDependencies = createIngestDependencies({
    getAliasTarget: async () => first.collectionName,
    hasChunkCollection: async () => true,
    insertChunkRows: async () => {
      throw new Error("active collection must not be reinserted");
    },
  });
  const reconstructed = await service.ingestKnowledgeCorpus(
    {},
    { ...secondDependencies, config },
  );

  assert.equal(reconstructed.status, "active");
  assert.equal(reconstructed.collectionName, first.collectionName);
  assert.equal(reconstructed.corpusVersion, first.corpusVersion);
});

for ( const cleanupFailure of ["list", "drop"] ) {
  test(`active corpus cleanup retries a ${cleanupFailure} failure on the next ingest`, async (t) => {
    const root = await createCorpusFixture(t);
    const config = createConfig(root);
    const oldCollection = "leaseqa_knowledge_chunks_aaaaaaaaaaaa";
    let firstCleanupAttempt = true;
    const firstDependencies = createIngestDependencies({
      listCollections: async () => {
        if ( cleanupFailure === "list" && firstCleanupAttempt ) {
          firstCleanupAttempt = false;
          throw Object.assign(new Error("PRIVATE_LIST_FAILURE"), {
            code: "RAG_MILVUS_STATUS_ERROR",
          });
        }
        return [oldCollection];
      },
      resetCollection: async ({ collectionName }) => {
        if ( cleanupFailure === "drop" && firstCleanupAttempt ) {
          firstCleanupAttempt = false;
          throw Object.assign(new Error("PRIVATE_DROP_FAILURE"), {
            code: "RAG_MILVUS_STATUS_ERROR",
          });
        }
        firstDependencies.order.push(`drop:${collectionName}`);
      },
    });

    const first = await service.ingestKnowledgeCorpus(
      {},
      { ...firstDependencies, config },
    );
    assert.equal(first.status, "active");
    assert.equal(first.cleanupPending, true);
    assert.deepEqual(
      first.pendingCollections,
      cleanupFailure === "drop" ? [oldCollection] : [],
    );

    const secondDependencies = createIngestDependencies({
      getAliasTarget: async () => first.collectionName,
      listCollections: async () => [oldCollection, first.collectionName],
    });
    const second = await service.ingestKnowledgeCorpus(
      {},
      { ...secondDependencies, config },
    );

    assert.equal(second.collectionName, first.collectionName);
    assert.equal(second.cleanupPending, false);
    assert.deepEqual(second.pendingCollections, []);
    assert.deepEqual(secondDependencies.order, [`drop:${oldCollection}`]);
  });
}
