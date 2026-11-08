import test from "node:test";
import assert from "node:assert/strict";

import {
  retryTransient,
  runBoundedOperation,
  withTimeout,
} from "./operationPolicy.js";

test("withTimeout rejects overdue work with the stable RAG_TIMEOUT code", async () => {
  await assert.rejects(
    withTimeout(
      () => new Promise(() => {}),
      5,
      "chat generation",
    ),
    (error) => {
      assert.equal(error.code, "RAG_TIMEOUT");
      assert.match(error.message, /chat generation/);
      return true;
    },
  );
});

test("withTimeout clears its timer after the operation settles", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timerToken = { id: "timeout-token" };
  const clearedTimers = [];

  globalThis.setTimeout = () => timerToken;
  globalThis.clearTimeout = (timer) => {
    clearedTimers.push(timer);
  };

  try {
    const result = await withTimeout(
      async () => "finished",
      100,
      "embedding",
    );

    assert.equal(result, "finished");
    assert.deepEqual(clearedTimers, [timerToken]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("retryTransient retries an HTTP 429 failure", async () => {
  let attempts = 0;

  const result = await retryTransient(
    async () => {
      attempts += 1;
      if ( attempts === 1 ) {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      }
      return "ok";
    },
    { sleep: async () => {}, random: () => 0.5 },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

test("retryTransient retries an HTTP 5xx failure", async () => {
  let attempts = 0;

  const result = await retryTransient(
    async () => {
      attempts += 1;
      if ( attempts === 1 ) {
        throw Object.assign(new Error("provider unavailable"), {
          response: { status: 503 },
        });
      }
      return "ok";
    },
    { sleep: async () => {}, random: () => 0.5 },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

test("retryTransient retries a network failure", async () => {
  let attempts = 0;

  const result = await retryTransient(
    async () => {
      attempts += 1;
      if ( attempts === 1 ) {
        throw Object.assign(new Error("socket closed"), {
          code: "ECONNRESET",
        });
      }
      return "ok";
    },
    { sleep: async () => {}, random: () => 0.5 },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

test("retryTransient retries a Milvus gRPC unavailable failure", async () => {
  let attempts = 0;

  const result = await retryTransient(
    async () => {
      attempts += 1;
      if ( attempts === 1 ) {
        throw Object.assign(
          new Error("14 UNAVAILABLE: Connection dropped during RST_STREAM"),
          { code: 14 },
        );
      }
      return "ok";
    },
    { sleep: async () => {}, random: () => 0.5 },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

test("retryTransient retries a Milvus gRPC deadline failure", async () => {
  let attempts = 0;

  const result = await retryTransient(
    async () => {
      attempts += 1;
      if ( attempts === 1 ) {
        throw Object.assign(new Error("4 DEADLINE_EXCEEDED: deadline exceeded"), {
          code: 4,
        });
      }
      return "ok";
    },
    { sleep: async () => {}, random: () => 0.5 },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

test("retryTransient makes at most three total attempts", async () => {
  let attempts = 0;

  await assert.rejects(
    retryTransient(
      async () => {
        attempts += 1;
        throw Object.assign(new Error("still unavailable"), { status: 503 });
      },
      {
        maxAttempts: 99,
        sleep: async () => {},
        random: () => 0.5,
      },
    ),
    /still unavailable/,
  );

  assert.equal(attempts, 3);
});

test("retryTransient does not retry HTTP authentication or validation failures", async () => {
  for ( const status of [400, 401, 403] ) {
    let attempts = 0;

    await assert.rejects(
      retryTransient(
        async () => {
          attempts += 1;
          throw Object.assign(new Error(`HTTP ${status}`), { status });
        },
        { sleep: async () => {}, random: () => 0.5 },
      ),
      new RegExp(String(status)),
    );

    assert.equal(attempts, 1, `HTTP ${status} should not be retried`);
  }
});

test("retryTransient uses injected jitter and sleep with delays capped at two seconds", async () => {
  let attempts = 0;
  const delays = [];
  const randomValues = [];

  const result = await retryTransient(
    async () => {
      attempts += 1;
      if ( attempts < 3 ) {
        throw Object.assign(new Error("temporarily unavailable"), {
          statusCode: 503,
        });
      }
      return "ok";
    },
    {
      baseDelayMs: 1500,
      sleep: async (delay) => {
        delays.push(delay);
      },
      random: () => {
        randomValues.push("used");
        return 1;
      },
    },
  );

  assert.equal(result, "ok");
  assert.deepEqual(delays, [1800, 2000]);
  assert.equal(randomValues.length, 2);
});

test("runBoundedOperation applies a fresh timeout to each transient attempt", async () => {
  let attempts = 0;
  const delays = [];

  const result = await runBoundedOperation({
    label: "vector search",
    timeoutMs: 25,
    operation: async () => {
      attempts += 1;
      if ( attempts === 1 ) {
        throw Object.assign(new Error("service unavailable"), { status: 503 });
      }
      return "search result";
    },
    retryPolicy: {
      sleep: async (delay) => delays.push(delay),
      random: () => 0.5,
    },
  });

  assert.equal(result, "search result");
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [500]);
});

test("retryTransient lets the caller veto a retry the error alone would allow", async () => {
  let attempts = 0;
  const seenByVeto = [];
  const unavailable = Object.assign(new Error("unavailable"), { status: 503 });

  await assert.rejects(
    retryTransient(
      async () => {
        attempts += 1;
        throw unavailable;
      },
      {
        sleep: async () => {},
        shouldRetry: (error) => {
          seenByVeto.push(error);
          return false;
        },
      },
    ),
    unavailable,
  );

  assert.equal(attempts, 1);
  assert.deepEqual(seenByVeto, [unavailable]);
});
