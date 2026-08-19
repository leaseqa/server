import test from "node:test";
import assert from "node:assert/strict";

import {
  createChatClient,
  invokeChatModel,
  postGeminiEmbedding,
} from "./service.js";

const retryPolicy = {
  sleep: async () => {},
  random: () => 0.5,
};

test("postGeminiEmbedding retries a transient HTTP response through an injected fetch fake", async () => {
  let attempts = 0;
  const observedSignals = [];

  const vector = await postGeminiEmbedding({
    config: {
      embeddingBaseUrl: "https://embedding.invalid/models",
      embeddingModel: "fake-embedding-model",
      embeddingApiKey: "fake-key",
      embeddingDimension: 3,
      embeddingTimeoutMs: 100,
    },
    text: "tenant rights",
    taskType: "RETRIEVAL_QUERY",
    fetchFn: async (url, options) => {
      attempts += 1;
      observedSignals.push(options.signal);
      if ( attempts === 1 ) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: { message: "temporarily unavailable" } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ embedding: { values: [0.1, 0.2, 0.3] } }),
      };
    },
    retryPolicy,
  });

  assert.deepEqual(vector, [0.1, 0.2, 0.3]);
  assert.equal(attempts, 2);
  assert.ok(observedSignals.every((signal) => signal instanceof AbortSignal));
});

test("postGeminiEmbedding does not retry an HTTP 400 response", async () => {
  let attempts = 0;

  await assert.rejects(
    postGeminiEmbedding({
      config: {
        embeddingBaseUrl: "https://embedding.invalid/models",
        embeddingModel: "fake-embedding-model",
        embeddingApiKey: "fake-key",
        embeddingDimension: 3,
        embeddingTimeoutMs: 100,
      },
      text: "tenant rights",
      taskType: "RETRIEVAL_QUERY",
      fetchFn: async () => {
        attempts += 1;
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: "invalid request" } }),
        };
      },
      retryPolicy,
    }),
    /invalid request/,
  );

  assert.equal(attempts, 1);
});

test("postGeminiEmbedding retries HTTP 5xx responses whose body is not JSON", async () => {
  let attempts = 0;

  const vector = await postGeminiEmbedding({
    config: {
      embeddingBaseUrl: "https://embedding.invalid/models",
      embeddingModel: "fake-embedding-model",
      embeddingApiKey: "fake-key",
      embeddingDimension: 2,
      embeddingTimeoutMs: 100,
    },
    text: "tenant rights",
    taskType: "RETRIEVAL_QUERY",
    fetchFn: async () => {
      attempts += 1;
      if ( attempts === 1 ) {
        return {
          ok: false,
          status: 503,
          json: async () => {
            throw new SyntaxError("Unexpected token '<'");
          },
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ embedding: { values: [0.1, 0.2] } }),
      };
    },
    retryPolicy,
  });

  assert.deepEqual(vector, [0.1, 0.2]);
  assert.equal(attempts, 2);
});

test("invokeChatModel retries transient model failures and passes the message array", async () => {
  let attempts = 0;
  const messages = [
    { role: "system", content: "fixed instructions" },
    { role: "user", content: "untrusted data" },
  ];
  const chatModel = {
    invoke: async (receivedMessages, options) => {
      attempts += 1;
      assert.deepEqual(receivedMessages, messages);
      assert.ok(options.signal instanceof AbortSignal);
      if ( attempts === 1 ) {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      }
      return { content: "model answer" };
    },
  };

  const response = await invokeChatModel({
    config: { chatTimeoutMs: 100 },
    chatModel,
    messages,
    retryPolicy,
  });

  assert.deepEqual(response, { content: "model answer" });
  assert.equal(attempts, 2);
});

test("createChatClient disables internal retries so total provider attempts stay capped at three", async () => {
  let providerAttempts = 0;

  class RetryAwareFakeChatModel {
    constructor(options) {
      this.internalMaxRetries = options.maxRetries ?? 6;
    }

    async invoke() {
      let lastError;
      for (
        let attempt = 0;
        attempt <= this.internalMaxRetries;
        attempt += 1
      ) {
        providerAttempts += 1;
        lastError = Object.assign(new Error("provider unavailable"), {
          status: 503,
        });
      }
      throw lastError;
    }
  }

  const chatModel = createChatClient(
    {
      chatApiKey: "fake-key",
      chatModel: "fake-model",
      chatBaseUrl: "https://chat.invalid/v1",
      chatTimeoutMs: 100,
    },
    { ChatModelClass: RetryAwareFakeChatModel },
  );

  await assert.rejects(
    invokeChatModel({
      config: { chatTimeoutMs: 100 },
      chatModel,
      messages: [{ role: "user", content: "test" }],
      retryPolicy,
    }),
    /provider unavailable/,
  );

  assert.equal(providerAttempts, 3);
});
