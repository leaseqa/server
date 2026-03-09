import test from "node:test";
import assert from "node:assert/strict";
import { getRagConfig } from "./config.js";

const withEnv = (overrides, callback) => {
  const original = {
    RAG_MILVUS_ADDRESS: process.env.RAG_MILVUS_ADDRESS,
    GEMINI_CHAT_API_KEY: process.env.GEMINI_CHAT_API_KEY,
    GEMINI_CHAT_MODEL: process.env.GEMINI_CHAT_MODEL,
    GEMINI_CHAT_BASE_URL: process.env.GEMINI_CHAT_BASE_URL,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };

  Object.entries(overrides).forEach(([key, value]) => {
    process.env[key] = value;
  });

  try {
    callback();
  } finally {
    Object.entries(original).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  }
};

test("getRagConfig maps Gemini chat settings onto RAG chat fields", () => {
  withEnv(
    {
      RAG_MILVUS_ADDRESS: "https://milvus.example.com",
      GEMINI_CHAT_API_KEY: "gemini-chat-key",
      GEMINI_CHAT_MODEL: "gemini-2.5-pro",
      GEMINI_CHAT_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      GEMINI_API_KEY: "shared-gemini-key",
    },
    () => {
      const config = getRagConfig();

      assert.equal(config.chatApiKey, "gemini-chat-key");
      assert.equal(config.chatModel, "gemini-2.5-pro");
      assert.equal(
        config.chatBaseUrl,
        "https://generativelanguage.googleapis.com/v1beta/openai/",
      );
    },
  );
});
