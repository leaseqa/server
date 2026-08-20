import test from "node:test";
import assert from "node:assert/strict";
import {
  DASHSCOPE_COMPATIBLE_BASE_URL,
  DASHSCOPE_DEFAULT_CHAT_MODEL,
  GEMINI_OPENAI_BASE_URL,
  getGeminiChatConfig,
  getRagChatConfig,
} from "./geminiOpenAI.js";

test("getRagChatConfig defaults to DashScope OpenAI-compatible chat", () => {
  const config = getRagChatConfig({});

  assert.equal(config.apiKey, "");
  assert.equal(config.model, DASHSCOPE_DEFAULT_CHAT_MODEL);
  assert.equal(config.baseURL, DASHSCOPE_COMPATIBLE_BASE_URL);
});

test("getGeminiChatConfig is an alias of getRagChatConfig", () => {
  assert.equal(getGeminiChatConfig, getRagChatConfig);
});

test("getRagChatConfig prefers explicit RAG overrides", () => {
  const config = getRagChatConfig({
    RAG_CHAT_API_KEY: "rag-key",
    DASHSCOPE_API_KEY: "dashscope-key",
    GEMINI_CHAT_API_KEY: "gemini-chat-key",
    GEMINI_API_KEY: "gemini-key",
    RAG_CHAT_MODEL: "qwen-max",
    GEMINI_CHAT_MODEL: "gemini-2.5-flash",
    RAG_CHAT_BASE_URL: "https://example.com/rag",
    GEMINI_CHAT_BASE_URL: "https://example.com/gemini",
  });

  assert.deepEqual(config, {
    providerId: "dashscope",
    apiKey: "rag-key",
    model: "qwen-max",
    baseURL: "https://example.com/rag",
  });
});

test("getRagChatConfig falls back to DASHSCOPE_API_KEY before Gemini env vars", () => {
  const config = getRagChatConfig({
    DASHSCOPE_API_KEY: "dashscope-key",
    GEMINI_CHAT_API_KEY: "gemini-chat-key",
    GEMINI_API_KEY: "gemini-key",
  });

  assert.equal(config.apiKey, "dashscope-key");
  assert.equal(config.model, DASHSCOPE_DEFAULT_CHAT_MODEL);
  assert.equal(config.baseURL, DASHSCOPE_COMPATIBLE_BASE_URL);
});

test("getRagChatConfig falls back to Gemini-specific env vars", () => {
  const config = getRagChatConfig({
    GEMINI_CHAT_API_KEY: "gemini-chat-key",
    GEMINI_API_KEY: "gemini-key",
    GEMINI_CHAT_MODEL: "gemini-2.5-flash",
    GEMINI_CHAT_BASE_URL: "https://example.com/gemini",
  });

  assert.deepEqual(config, {
    providerId: "dashscope",
    apiKey: "gemini-chat-key",
    model: "gemini-2.5-flash",
    baseURL: "https://example.com/gemini",
  });
});

test("getRagChatConfig falls back to shared Gemini API key", () => {
  const config = getRagChatConfig({
    GEMINI_API_KEY: "gemini-key",
  });

  assert.equal(config.apiKey, "gemini-key");
  assert.equal(config.model, DASHSCOPE_DEFAULT_CHAT_MODEL);
  assert.equal(config.baseURL, DASHSCOPE_COMPATIBLE_BASE_URL);
});

test("Gemini OpenAI-compatible URL remains available as an explicit override", () => {
  const config = getRagChatConfig({
    RAG_CHAT_BASE_URL: GEMINI_OPENAI_BASE_URL,
    RAG_CHAT_MODEL: "gemini-2.5-pro",
    RAG_CHAT_API_KEY: "gemini-key",
  });

  assert.equal(config.baseURL, GEMINI_OPENAI_BASE_URL);
  assert.equal(config.model, "gemini-2.5-pro");
});
