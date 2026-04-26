import test from "node:test";
import assert from "node:assert/strict";
import { GEMINI_OPENAI_BASE_URL, getGeminiChatConfig, } from "./geminiOpenAI.js";

test("getGeminiChatConfig uses Gemini defaults", () => {
  const config = getGeminiChatConfig({});

  assert.equal(config.apiKey, "");
  assert.equal(config.model, "gemini-2.5-pro");
  assert.equal(config.baseURL, GEMINI_OPENAI_BASE_URL);
});

test("getGeminiChatConfig prefers explicit RAG overrides", () => {
  const config = getGeminiChatConfig({
    RAG_CHAT_API_KEY: "rag-key",
    GEMINI_CHAT_API_KEY: "gemini-chat-key",
    GEMINI_API_KEY: "gemini-key",
    RAG_CHAT_MODEL: "gemini-3-flash-preview",
    GEMINI_CHAT_MODEL: "gemini-2.5-flash",
    RAG_CHAT_BASE_URL: "https://example.com/rag",
    GEMINI_CHAT_BASE_URL: "https://example.com/gemini",
  });

  assert.deepEqual(config, {
    apiKey: "rag-key",
    model: "gemini-3-flash-preview",
    baseURL: "https://example.com/rag",
  });
});

test("getGeminiChatConfig falls back to Gemini-specific env vars", () => {
  const config = getGeminiChatConfig({
    GEMINI_CHAT_API_KEY: "gemini-chat-key",
    GEMINI_API_KEY: "gemini-key",
    GEMINI_CHAT_MODEL: "gemini-2.5-flash",
    GEMINI_CHAT_BASE_URL: "https://example.com/gemini",
  });

  assert.deepEqual(config, {
    apiKey: "gemini-chat-key",
    model: "gemini-2.5-flash",
    baseURL: "https://example.com/gemini",
  });
});

test("getGeminiChatConfig falls back to shared Gemini API key", () => {
  const config = getGeminiChatConfig({
    GEMINI_API_KEY: "gemini-key",
  });

  assert.equal(config.apiKey, "gemini-key");
  assert.equal(config.model, "gemini-2.5-pro");
  assert.equal(config.baseURL, GEMINI_OPENAI_BASE_URL);
});
