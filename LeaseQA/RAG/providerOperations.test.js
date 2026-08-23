import test from "node:test";
import assert from "node:assert/strict";

import {
  createChatClient,
  invokeChatModel,
  postOpenAICompatibleEmbedding,
} from "./service.js";

const retryPolicy = {
  sleep: async () => {},
  random: () => 0.5,
};

test("postOpenAICompatibleEmbedding posts Bearer auth to /embeddings with dimensions", async () => {
  let attempts = 0;
  let observedUrl;
  let observedOptions;

  const vector = await postOpenAICompatibleEmbedding({
    config: {
      embeddingBaseUrl: "https://dashscope.example/compatible-mode/v1/",
      embeddingModel: "text-embedding-v3",
      embeddingApiKey: "fake-dashscope-key",
      embeddingDimension: 1024,
      embeddingTimeoutMs: 100,
    },
    text: "tenant rights",
    fetchFn: async (url, options) => {
      attempts += 1;
      observedUrl = url;
      observedOptions = options;
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
        json: async () => ({
          data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
        }),
      };
    },
    retryPolicy,
  });

  assert.equal(
    observedUrl,
    "https://dashscope.example/compatible-mode/v1/embeddings",
  );
  assert.equal(
    observedOptions.headers.Authorization,
    "Bearer fake-dashscope-key",
  );
  assert.equal(observedOptions.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(observedOptions.body), {
    model: "text-embedding-v3",
    input: "tenant rights",
    dimensions: 1024,
    encoding_format: "float",
    text_type: "document",
  });
  assert.equal(String(observedUrl).includes("key="), false);
  assert.deepEqual(vector, [0.1, 0.2, 0.3]);
  assert.equal(attempts, 2);
  assert.ok(observedOptions.signal instanceof AbortSignal);
});

test("postOpenAICompatibleEmbedding uses Ark multimodal embeddings for vision models", async () => {
  let observedUrl;
  let observedBody;

  const vector = await postOpenAICompatibleEmbedding({
    config: {
      embeddingBaseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
      embeddingModel: "doubao-embedding-vision",
      embeddingPath: "embeddings/multimodal",
      embeddingApiKey: "fake-ark-key",
      embeddingDimension: 1024,
      embeddingTimeoutMs: 100,
    },
    text: "tenant rights",
    fetchFn: async (url, options) => {
      observedUrl = url;
      observedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { embedding: [[0.4, 0.5, 0.6]] },
        }),
      };
    },
    retryPolicy,
  });

  assert.equal(
    observedUrl,
    "https://ark.cn-beijing.volces.com/api/plan/v3/embeddings/multimodal",
  );
  assert.deepEqual(observedBody, {
    model: "doubao-embedding-vision",
    input: [{ type: "text", text: "tenant rights" }],
    dimensions: 1024,
    encoding_format: "float",
  });
  assert.deepEqual(vector, [0.4, 0.5, 0.6]);
});

test("postOpenAICompatibleEmbedding does not retry an HTTP 400 response", async () => {
  let attempts = 0;

  await assert.rejects(
    postOpenAICompatibleEmbedding({
      config: {
        embeddingBaseUrl: "https://dashscope.example/compatible-mode/v1",
        embeddingModel: "text-embedding-v3",
        embeddingApiKey: "fake-dashscope-key",
        embeddingDimension: 1024,
        embeddingTimeoutMs: 100,
      },
      text: "tenant rights",
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

test("postOpenAICompatibleEmbedding retries HTTP 5xx responses whose body is not JSON", async () => {
  let attempts = 0;

  const vector = await postOpenAICompatibleEmbedding({
    config: {
      embeddingBaseUrl: "https://dashscope.example/compatible-mode/v1",
      embeddingModel: "text-embedding-v3",
      embeddingApiKey: "fake-dashscope-key",
      embeddingDimension: 2,
      embeddingTimeoutMs: 100,
    },
    text: "tenant rights",
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
        json: async () => ({
          data: [{ embedding: [0.1, 0.2] }],
        }),
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
