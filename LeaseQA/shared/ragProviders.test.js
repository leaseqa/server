import test from "node:test";
import assert from "node:assert/strict";
import {
  ARK_COMPATIBLE_BASE_URL,
  ARK_DEFAULT_CHAT_MODEL,
  ARK_DEFAULT_EMBEDDING_MODEL,
  DASHSCOPE_COMPATIBLE_BASE_URL,
  DASHSCOPE_DEFAULT_CHAT_MODEL,
  fingerprintEmbeddingProvider,
  getRagChatConfig,
  getRagProvider,
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
