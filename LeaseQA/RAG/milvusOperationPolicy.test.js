import test from "node:test";
import assert from "node:assert/strict";

import {
  createMilvusClient,
  runMilvusMutation,
  runMilvusRead,
} from "./milvus.js";

const config = {
  milvusAddress: "milvus.invalid:19530",
  milvusToken: "fake-token",
  vectorTimeoutMs: 10_000,
};

test("createMilvusClient disables SDK retries and configures the vector deadline", () => {
  let receivedOptions;

  class FakeMilvusClient {
    constructor(options) {
      receivedOptions = options;
    }
  }

  createMilvusClient(config, { MilvusClientClass: FakeMilvusClient });

  assert.deepEqual(receivedOptions, {
    address: "milvus.invalid:19530",
    token: "fake-token",
    maxRetries: 0,
    timeout: 10_000,
  });
});

test("runMilvusRead keeps total SDK attempts at three and passes a deadline to every RPC", async () => {
  let providerAttempts = 0;
  const deadlines = [];

  class RetryAwareFakeMilvusClient {
    constructor(options) {
      this.internalMaxRetries = options.maxRetries ?? 3;
    }

    async hasCollection(request) {
      deadlines.push(request.timeout);
      let lastError;
      for (
        let attempt = 0;
        attempt <= this.internalMaxRetries;
        attempt += 1
      ) {
        providerAttempts += 1;
        lastError = Object.assign(new Error("14 UNAVAILABLE"), { code: 14 });
      }
      throw lastError;
    }
  }

  const client = createMilvusClient(config, {
    MilvusClientClass: RetryAwareFakeMilvusClient,
  });

  await assert.rejects(
    runMilvusRead({
      config,
      client,
      method: "hasCollection",
      request: { collection_name: "knowledge" },
      retryPolicy: {
        sleep: async () => {},
        random: () => 0.5,
      },
    }),
    /UNAVAILABLE/,
  );

  assert.equal(providerAttempts, 3);
  assert.deepEqual(deadlines, [10_000, 10_000, 10_000]);
});

test("runMilvusMutation waits for the real RPC deadline and never starts a concurrent retry", async () => {
  let now = 0;
  let providerAttempts = 0;
  let activeAttempts = 0;
  let maximumConcurrentAttempts = 0;
  const scheduled = [];
  const fakeClock = {
    setTimeout(callback, delay) {
      scheduled.push({ at: now + delay, callback });
    },
    advance(milliseconds) {
      now += milliseconds;
      const due = scheduled.filter((entry) => entry.at <= now);
      scheduled.splice(0, due.length);
      due.forEach((entry) => entry.callback());
    },
  };
  const client = {
    insert(request) {
      providerAttempts += 1;
      activeAttempts += 1;
      maximumConcurrentAttempts = Math.max(
        maximumConcurrentAttempts,
        activeAttempts,
      );
      return new Promise((resolve, reject) => {
        fakeClock.setTimeout(() => {
          activeAttempts -= 1;
          reject(Object.assign(new Error("deadline exceeded"), {
            code: "RAG_TIMEOUT",
          }));
        }, request.timeout);
      });
    },
  };

  const resultPromise = runMilvusMutation({
    config,
    client,
    method: "insert",
    request: { collection_name: "session", data: [{ id: "row-1" }] },
  });

  assert.equal(providerAttempts, 1);
  assert.equal(activeAttempts, 1);
  fakeClock.advance(10_000);
  await assert.rejects(resultPromise, /deadline exceeded/);
  assert.equal(providerAttempts, 1);
  assert.equal(activeAttempts, 0);
  assert.equal(maximumConcurrentAttempts, 1);
});
