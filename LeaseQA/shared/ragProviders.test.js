import test from "node:test";
import assert from "node:assert/strict";
import {
  ARK_COMPATIBLE_BASE_URL,
  ARK_DEFAULT_CHAT_MODEL,
  ARK_DEFAULT_EMBEDDING_MODEL,
  DASHSCOPE_COMPATIBLE_BASE_URL,
  DASHSCOPE_DEFAULT_CHAT_MODEL,
  ZHIPU_COMPATIBLE_BASE_URL,
  ZHIPU_DEFAULT_CHAT_MODEL,
  ZHIPU_DEFAULT_EMBEDDING_DIMENSION,
  ZHIPU_DEFAULT_EMBEDDING_MODEL,
  fingerprintEmbeddingProvider,
  getRagChatConfig,
  getRagProvider,
  getRagRerankConfig,
  resolveRagProviderId,
} from "./ragProviders.js";

test("RAG_PROVIDER selects the Ark plug without per-field URLs", () => {
  const env = { RAG_PROVIDER: "volcengine", ARK_API_KEY: "ark-key" };
  assert.equal(resolveRagProviderId(env), "ark");
  const provider = getRagProvider(env);
  assert.equal(provider.embeddingPath, "embeddings/multimodal");
  assert.equal(provider.embeddingModel, ARK_DEFAULT_EMBEDDING_MODEL);
  assert.equal(provider.chatBaseUrl, ARK_COMPATIBLE_BASE_URL);
  const chat = getRagChatConfig(env);
  assert.equal(chat.providerId, "ark");
  assert.equal(chat.apiKey, "ark-key");
  assert.equal(chat.baseURL, ARK_COMPATIBLE_BASE_URL);
  assert.equal(chat.model, ARK_DEFAULT_CHAT_MODEL);
});

test("RAG_CHAT_MODEL overrides the selected plug", () => {
  const chat = getRagChatConfig({
    RAG_PROVIDER: "ark",
    RAG_CHAT_MODEL: "ark-endpoint-id",
    ARK_API_KEY: "ark-key",
  });
  assert.equal(chat.model, "ark-endpoint-id");
});

test("unset RAG_PROVIDER keeps DashScope defaults", () => {
  assert.equal(resolveRagProviderId({}), "dashscope");
  const chat = getRagChatConfig({ DASHSCOPE_API_KEY: "dash-key" });
  assert.equal(chat.model, DASHSCOPE_DEFAULT_CHAT_MODEL);
  assert.equal(chat.baseURL, DASHSCOPE_COMPATIBLE_BASE_URL);
});

test("embedding fingerprint labels the vector space for corpus versioning", () => {
  assert.equal(fingerprintEmbeddingProvider("dashscope"), "openai");
  assert.equal(fingerprintEmbeddingProvider("ark"), "ark");
});

// Zhipu BigModel replaced Ark on 2026-10-06, when the Ark Agent Plan
// subscription lapsed. Its endpoint is OpenAI-compatible; these pin the
// defaults the rest of the stack was verified against.
test("RAG_PROVIDER=zhipu selects BigModel without per-field URLs", () => {
  const env = { RAG_PROVIDER: "zhipu", ZHIPU_API_KEY: "zhipu-key" };
  assert.equal(resolveRagProviderId(env), "zhipu");
  const provider = getRagProvider(env);
  assert.equal(provider.chatBaseUrl, ZHIPU_COMPATIBLE_BASE_URL);
  assert.equal(provider.embeddingBaseUrl, ZHIPU_COMPATIBLE_BASE_URL);
  assert.equal(provider.embeddingPath, "embeddings");
  assert.equal(provider.embeddingModel, ZHIPU_DEFAULT_EMBEDDING_MODEL);
  // embedding-3 defaults to 2048-d. The Milvus collections are 1024-d, so the
  // preset has to ask for 1024 explicitly or every insert fails on dimension.
  assert.equal(provider.embeddingDimension, ZHIPU_DEFAULT_EMBEDDING_DIMENSION);
  assert.equal(ZHIPU_DEFAULT_EMBEDDING_DIMENSION, 1024);
  const chat = getRagChatConfig(env);
  assert.equal(chat.apiKey, "zhipu-key");
  assert.equal(chat.model, ZHIPU_DEFAULT_CHAT_MODEL);
  assert.equal(chat.baseURL, ZHIPU_COMPATIBLE_BASE_URL);
});

test("the BigModel aliases and its base URL all resolve to zhipu", () => {
  for ( const alias of ["zhipu", "zhipuai", "bigmodel", "glm", "ZHIPU"] ) {
    assert.equal(resolveRagProviderId({ RAG_PROVIDER: alias }), "zhipu", alias);
  }
  assert.equal(
    resolveRagProviderId({ RAG_CHAT_BASE_URL: "https://open.bigmodel.cn/api/paas/v4" }),
    "zhipu",
  );
});

test("a leftover Ark key never authenticates a zhipu request", () => {
  // Production still carries ARK_API_KEY after the switch. If zhipu's key
  // resolution fell through to it, every request would 401 at BigModel.
  const env = { RAG_PROVIDER: "zhipu", ARK_API_KEY: "ark-key", ZHIPU_API_KEY: "zhipu-key" };
  assert.equal(getRagChatConfig(env).apiKey, "zhipu-key");
  assert.equal(getRagChatConfig({ RAG_PROVIDER: "zhipu", ARK_API_KEY: "ark-key" }).apiKey, "");
});

test("zhipu vectors get their own fingerprint, forcing a re-ingest", () => {
  // Ark and BigModel both produce 1024-d vectors, so nothing errors if a
  // collection embedded by one is queried with the other -- retrieval just
  // returns noise and every answer abstains. A distinct fingerprint changes
  // corpusVersion, which is what makes the ingest build a fresh collection.
  assert.equal(fingerprintEmbeddingProvider("zhipu"), "zhipu");
  assert.notEqual(fingerprintEmbeddingProvider("zhipu"), fingerprintEmbeddingProvider("ark"));
  assert.notEqual(fingerprintEmbeddingProvider("zhipu"), fingerprintEmbeddingProvider("dashscope"));
});

test("zhipu reranks with BigModel's rerank model and the BigModel key", () => {
  const rerank = getRagRerankConfig({
    RAG_PROVIDER: "zhipu",
    ZHIPU_API_KEY: "zhipu-key",
    ARK_API_KEY: "leftover-ark-key",
  });

  assert.deepEqual(rerank, {
    enabled: true,
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    model: "rerank",
    rawScores: true,
    minScore: 15.1,
    scopeCheckBelow: 17.5,
    apiKey: "zhipu-key",
  });
});

test("RAG_RERANK=off turns the zhipu reranker off", () => {
  assert.equal(
    getRagRerankConfig({ RAG_PROVIDER: "zhipu", RAG_RERANK: "off" }).enabled,
    false,
  );
});

test("providers without a reranker preset rerank only when one is configured", () => {
  assert.equal(getRagRerankConfig({ RAG_PROVIDER: "ark" }).enabled, false);

  const configured = getRagRerankConfig({
    RAG_PROVIDER: "ark",
    RAG_RERANK_BASE_URL: "https://rerank.invalid/v1",
    RAG_RERANK_MODEL: "some-reranker",
    RAG_RERANK_API_KEY: "rerank-key",
  });
  assert.equal(configured.enabled, true);
  assert.equal(configured.apiKey, "rerank-key");
});
