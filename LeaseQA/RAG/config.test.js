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
    RAG_EMBEDDING_TIMEOUT_MS: process.env.RAG_EMBEDDING_TIMEOUT_MS,
    RAG_CHAT_TIMEOUT_MS: process.env.RAG_CHAT_TIMEOUT_MS,
    RAG_VECTOR_TIMEOUT_MS: process.env.RAG_VECTOR_TIMEOUT_MS,
  };

  Object.entries(overrides).forEach(([key, value]) => {
    if ( value === undefined ) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });

  try {
    callback();
  } finally {
    Object.entries(original).forEach(([key, value]) => {
      if ( value === undefined ) {
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

test("getRagConfig defaults embedding, chat, and vector operations to separate bounded timeouts", () => {
  withEnv(
    {
      RAG_MILVUS_ADDRESS: "https://milvus.example.com",
      GEMINI_CHAT_API_KEY: "gemini-chat-key",
      GEMINI_API_KEY: "shared-gemini-key",
      RAG_EMBEDDING_TIMEOUT_MS: undefined,
      RAG_CHAT_TIMEOUT_MS: undefined,
      RAG_VECTOR_TIMEOUT_MS: undefined,
    },
    () => {
      const config = getRagConfig();

      assert.equal(config.embeddingTimeoutMs, 15_000);
      assert.equal(config.chatTimeoutMs, 45_000);
      assert.equal(config.vectorTimeoutMs, 10_000);
    },
  );
});

test("getRagConfig accepts positive timeout overrides", () => {
  withEnv(
    {
      RAG_MILVUS_ADDRESS: "https://milvus.example.com",
      GEMINI_CHAT_API_KEY: "gemini-chat-key",
      GEMINI_API_KEY: "shared-gemini-key",
      RAG_EMBEDDING_TIMEOUT_MS: "1200",
      RAG_CHAT_TIMEOUT_MS: "3400",
      RAG_VECTOR_TIMEOUT_MS: "5600",
    },
    () => {
      const config = getRagConfig();

      assert.equal(config.embeddingTimeoutMs, 1200);
      assert.equal(config.chatTimeoutMs, 3400);
      assert.equal(config.vectorTimeoutMs, 5600);
    },
  );
});

test("getRagConfig rejects non-positive timeout overrides in favor of bounded defaults", () => {
  withEnv(
    {
      RAG_MILVUS_ADDRESS: "https://milvus.example.com",
      GEMINI_CHAT_API_KEY: "gemini-chat-key",
      GEMINI_API_KEY: "shared-gemini-key",
      RAG_EMBEDDING_TIMEOUT_MS: "0",
      RAG_CHAT_TIMEOUT_MS: "-1",
      RAG_VECTOR_TIMEOUT_MS: "not-a-number",
    },
    () => {
      const config = getRagConfig();

      assert.equal(config.embeddingTimeoutMs, 15_000);
      assert.equal(config.chatTimeoutMs, 45_000);
      assert.equal(config.vectorTimeoutMs, 10_000);
    },
  );
});
