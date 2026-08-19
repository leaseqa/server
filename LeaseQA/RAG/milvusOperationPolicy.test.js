import test from "node:test";
import assert from "node:assert/strict";
import {
  FAILOVER_HANDLER_KEY,
  isGlobalEndpoint,
  LoadState,
  MilvusClient,
} from "@zilliz/milvus2-sdk-node";

import {
  createMilvusClient,
  ensureCollectionLoaded,
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
    isGlobal: false,
  });
});

test("createMilvusClient disables SDK global failover replay even for an endpoint the SDK classifies as global", async () => {
  const globalAddress = "https://tenant.global-cluster.example.invalid:19530";
  assert.equal(isGlobalEndpoint(globalAddress), true);

  class NoConnectMilvusClient extends MilvusClient {
    constructor(options) {
      super({ ...options, __SKIP_CONNECT__: true });
    }
  }

  const client = createMilvusClient(
    { ...config, milvusAddress: globalAddress },
    { MilvusClientClass: NoConnectMilvusClient },
  );

  try {
    assert.equal(client.isGlobal, false);
    assert.equal(client.globalEndpoint, "");
    assert.equal(client.channelPool[FAILOVER_HANDLER_KEY], undefined);
  } finally {
    await client.closeConnection();
  }
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

test("ensureCollectionLoaded starts one async mutation and polls load state with the remaining total deadline", async () => {
  let now = 0;
  let loadAttempts = 0;
  const loadTimeouts = [];
  const stateTimeouts = [];
  const sleeps = [];
  const states = [LoadState.LoadStateLoading, LoadState.LoadStateLoaded];
  const client = {
    async loadCollectionAsync(request) {
      loadAttempts += 1;
      loadTimeouts.push(request.timeout);
      now += 100;
      return { error_code: "Success" };
    },
    async getLoadState(request) {
      stateTimeouts.push(request.timeout);
      now += 50;
      return { state: states.shift() };
    },
  };

  await ensureCollectionLoaded({
    config: { ...config, vectorTimeoutMs: 1_000 },
    client,
    collectionName: "knowledge",
    clock: { now: () => now },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    pollIntervalMs: 100,
  });

  assert.equal(loadAttempts, 1);
  assert.deepEqual(loadTimeouts, [1_000]);
  assert.deepEqual(stateTimeouts, [900, 750]);
  assert.deepEqual(sleeps, [100]);
});

test("ensureCollectionLoaded throws stable RAG_TIMEOUT at its absolute deadline", async () => {
  let now = 0;
  let loadAttempts = 0;
  const stateTimeouts = [];
  const sleeps = [];
  const client = {
    async loadCollectionAsync() {
      loadAttempts += 1;
      now += 100;
      return { error_code: "Success" };
    },
    async getLoadState(request) {
      stateTimeouts.push(request.timeout);
      now += 100;
      return { state: LoadState.LoadStateLoading };
    },
  };

  await assert.rejects(
    ensureCollectionLoaded({
      config: { ...config, vectorTimeoutMs: 500 },
      client,
      collectionName: "knowledge",
      clock: { now: () => now },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      pollIntervalMs: 200,
    }),
    (error) => {
      assert.equal(error.code, "RAG_TIMEOUT");
      assert.equal(error.timeoutMs, 500);
      return true;
    },
  );

  assert.equal(loadAttempts, 1);
  assert.deepEqual(stateTimeouts, [400, 100]);
  assert.deepEqual(sleeps, [200]);
});
