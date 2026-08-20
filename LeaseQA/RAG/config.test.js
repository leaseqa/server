import test from "node:test";
import assert from "node:assert/strict";
import { getRagConfig } from "./config.js";
import * as ragConfig from "./config.js";
import {
  DASHSCOPE_COMPATIBLE_BASE_URL,
  DASHSCOPE_DEFAULT_CHAT_MODEL,
  DASHSCOPE_DEFAULT_EMBEDDING_DIMENSION,
  DASHSCOPE_DEFAULT_EMBEDDING_MODEL,
  GEMINI_DEFAULT_EMBEDDING_DIMENSION,
  GEMINI_DEFAULT_EMBEDDING_MODEL,
  GEMINI_EMBEDDING_BASE_URL,
} from "../shared/geminiOpenAI.js";

const withEnv = (overrides, callback) => {
  const original = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );

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

test("getRagConfig defaults chat and embedding to DashScope OpenAI-compatible APIs", () => {
  withEnv(
    {
      RAG_MILVUS_ADDRESS: "https://milvus.example.com",
      DASHSCOPE_API_KEY: "dashscope-key",
      RAG_CHAT_API_KEY: undefined,
      RAG_CHAT_MODEL: undefined,
      RAG_CHAT_BASE_URL: undefined,
      RAG_EMBEDDING_API_KEY: undefined,
      RAG_EMBEDDING_MODEL: undefined,
      RAG_EMBEDDING_BASE_URL: undefined,
      RAG_EMBEDDING_DIMENSION: undefined,
      RAG_EMBEDDING_DIMENSIONS: undefined,
      RAG_EMBEDDING_PROVIDER: undefined,
      GEMINI_CHAT_API_KEY: undefined,
      GEMINI_CHAT_MODEL: undefined,
      GEMINI_CHAT_BASE_URL: undefined,
      GEMINI_API_KEY: undefined,
    },
    () => {
      const config = getRagConfig();

      assert.equal(config.chatApiKey, "dashscope-key");
      assert.equal(config.chatModel, DASHSCOPE_DEFAULT_CHAT_MODEL);
      assert.equal(config.chatBaseUrl, DASHSCOPE_COMPATIBLE_BASE_URL);
      assert.equal(config.embeddingProvider, "openai");
      assert.equal(config.embeddingApiKey, "dashscope-key");
      assert.equal(config.embeddingModel, DASHSCOPE_DEFAULT_EMBEDDING_MODEL);
      assert.equal(config.embeddingBaseUrl, DASHSCOPE_COMPATIBLE_BASE_URL);
      assert.equal(
        config.embeddingDimension,
        DASHSCOPE_DEFAULT_EMBEDDING_DIMENSION,
      );
    },
  );
});

test("getRagConfig maps Gemini chat settings onto RAG chat fields", () => {
  withEnv(
    {
      RAG_MILVUS_ADDRESS: "https://milvus.example.com",
      GEMINI_CHAT_API_KEY: "gemini-chat-key",
      GEMINI_CHAT_MODEL: "gemini-2.5-pro",
      GEMINI_CHAT_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      GEMINI_API_KEY: "shared-gemini-key",
      DASHSCOPE_API_KEY: undefined,
      RAG_CHAT_API_KEY: undefined,
      RAG_CHAT_MODEL: undefined,
      RAG_CHAT_BASE_URL: undefined,
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

test("getRagConfig prefers RAG_EMBEDDING_DIMENSIONS over the singular alias", () => {
  withEnv(
    {
      RAG_MILVUS_ADDRESS: "https://milvus.example.com",
      DASHSCOPE_API_KEY: "dashscope-key",
      RAG_EMBEDDING_DIMENSIONS: "768",
      RAG_EMBEDDING_DIMENSION: "512",
    },
    () => {
      const config = getRagConfig();
      assert.equal(config.embeddingDimension, 768);
    },
  );
});

test("getRagConfig uses Gemini embedding defaults when the provider is gemini", () => {
  withEnv(
    {
      RAG_MILVUS_ADDRESS: "https://milvus.example.com",
      GEMINI_API_KEY: "shared-gemini-key",
      RAG_EMBEDDING_PROVIDER: "gemini",
      DASHSCOPE_API_KEY: undefined,
      RAG_EMBEDDING_MODEL: undefined,
      RAG_EMBEDDING_BASE_URL: undefined,
      RAG_EMBEDDING_DIMENSION: undefined,
      RAG_EMBEDDING_DIMENSIONS: undefined,
    },
    () => {
      const config = getRagConfig();

      assert.equal(config.embeddingProvider, "gemini");
      assert.equal(config.embeddingModel, GEMINI_DEFAULT_EMBEDDING_MODEL);
      assert.equal(config.embeddingBaseUrl, GEMINI_EMBEDDING_BASE_URL);
      assert.equal(
        config.embeddingDimension,
        GEMINI_DEFAULT_EMBEDDING_DIMENSION,
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

test("corpus root prefers an explicit environment override", () => {
  assert.equal(
    ragConfig.resolveCorpusRoot({
      env: { RAG_CORPUS_ROOT: "/srv/leaseqa-corpus" },
      serverRoot: "/repo/.worktrees/server-engineering",
      existsFn: () => false,
    }),
    "/srv/leaseqa-corpus",
  );
});

test("corpus root discovery works from the original checkout and an isolated worktree", () => {
  const corpusRoot = "/repo/resources/rag-corpus/mass tenant rights";
  const existsFn = (candidate) => candidate === corpusRoot;

  assert.equal(
    ragConfig.resolveCorpusRoot({
      env: {},
      serverRoot: "/repo/server",
      existsFn,
    }),
    corpusRoot,
  );
  assert.equal(
    ragConfig.resolveCorpusRoot({
      env: {},
      serverRoot: "/repo/.worktrees/server-engineering",
      existsFn,
    }),
    corpusRoot,
  );
});
