import test from "node:test";
import assert from "node:assert/strict";

import { createRerankClient } from "./rerank.js";

const config = {
  rerankEnabled: true,
  rerankBaseUrl: "https://rerank.invalid/api/paas/v4/",
  rerankModel: "rerank",
  rerankApiKey: "fake-rerank-key",
  rerankTimeoutMs: 1_000,
};

const retryPolicy = { sleep: async () => {}, random: () => 0.5 };

const jsonResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

test("no client is created when reranking is not configured", () => {
  assert.equal(createRerankClient({ ...config, rerankEnabled: false }), null);
});

test("rerank posts the question and documents and maps scores back by index", async () => {
  const requests = [];
  const client = createRerankClient(config, {
    retryPolicy,
    fetchFn: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(200, {
        results: [
          { index: 1, relevance_score: 0.91 },
          { index: 0, relevance_score: 0.12 },
        ],
      });
    },
  });

  const scores = await client.rerank({ query: "q", documents: ["a", "b"] });

  assert.deepEqual(scores, [0.12, 0.91]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://rerank.invalid/api/paas/v4/rerank");
  assert.equal(requests[0].init.headers.Authorization, "Bearer fake-rerank-key");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    model: "rerank",
    query: "q",
    documents: ["a", "b"],
    top_n: 2,
    return_documents: false,
  });
});

test("rerank truncates the query and documents to the provider's 4096 characters", async () => {
  let body;
  const client = createRerankClient(config, {
    retryPolicy,
    fetchFn: async (_url, init) => {
      body = JSON.parse(init.body);
      return jsonResponse(200, { results: [{ index: 0, relevance_score: 0.5 }] });
    },
  });

  await client.rerank({ query: "q".repeat(5_000), documents: ["d".repeat(5_000)] });

  assert.equal(body.query.length, 4_096);
  assert.equal(body.documents[0].length, 4_096);
});

test("more documents than one request allows are scored in batches, in order", async () => {
  const batchSizes = [];
  const client = createRerankClient(config, {
    retryPolicy,
    fetchFn: async (_url, init) => {
      const { documents } = JSON.parse(init.body);
      batchSizes.push(documents.length);
      return jsonResponse(200, {
        results: documents.map((document, index) => ({
          index,
          relevance_score: Number(document) / 1_000,
        })),
      });
    },
  });
  const documents = Array.from({ length: 130 }, (_, index) => String(index));

  const scores = await client.rerank({ query: "q", documents });

  assert.deepEqual(batchSizes, [128, 2]);
  assert.deepEqual(scores, documents.map((document) => Number(document) / 1_000));
});

test("an empty candidate list never reaches the provider", async () => {
  let called = false;
  const client = createRerankClient(config, {
    retryPolicy,
    fetchFn: async () => {
      called = true;
      return jsonResponse(200, { results: [] });
    },
  });

  assert.deepEqual(await client.rerank({ query: "q", documents: [] }), []);
  assert.equal(called, false);
});

test("a rate-limited rerank is retried", async () => {
  let attempts = 0;
  const client = createRerankClient(config, {
    retryPolicy,
    fetchFn: async () => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse(429, { error: { message: "slow down" } })
        : jsonResponse(200, { results: [{ index: 0, relevance_score: 0.7 }] });
    },
  });

  assert.deepEqual(await client.rerank({ query: "q", documents: ["a"] }), [0.7]);
  assert.equal(attempts, 2);
});

test("a rejected rerank fails once with a stable code and the HTTP status", async () => {
  let attempts = 0;
  const client = createRerankClient(config, {
    retryPolicy,
    fetchFn: async () => {
      attempts += 1;
      return jsonResponse(401, { error: { message: "bad key" } });
    },
  });

  await assert.rejects(client.rerank({ query: "q", documents: ["a"] }), (error) => {
    assert.equal(error.code, "RAG_RERANK_FAILED");
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(attempts, 1);
});

test("a response that leaves a document unscored is an error, not a zero", async () => {
  const client = createRerankClient(config, {
    retryPolicy,
    fetchFn: async () => jsonResponse(200, { results: [{ index: 0, relevance_score: 0.7 }] }),
  });

  await assert.rejects(
    client.rerank({ query: "q", documents: ["a", "b"] }),
    /did not score every document/,
  );
});
