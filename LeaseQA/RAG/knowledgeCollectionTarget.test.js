import test from "node:test";
import assert from "node:assert/strict";

import * as service from "./service.js";

const createConfig = () => ({
  knowledgeCollection: "leaseqa_knowledge_chunks",
  candidatesPerGroup: 10,
  evidenceLimit: 6,
  minSupportScore: 0.025,
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
