import test from "node:test";
import assert from "node:assert/strict";

import ragSessionSchema from "./schema.js";
import * as milvus from "./milvus.js";
import * as service from "./service.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

test("RAG sessions expire 30 days after creation through a Mongo TTL index", () => {
  const expiresAt = ragSessionSchema.path("expiresAt");
  assert.ok(expiresAt, "expiresAt must be persisted");

  const before = Date.now();
  const defaultExpiry = expiresAt.getDefault(null, false);
  const after = Date.now();
  assert.ok(defaultExpiry instanceof Date);
  assert.ok(defaultExpiry.getTime() >= before + THIRTY_DAYS_MS);
  assert.ok(defaultExpiry.getTime() <= after + THIRTY_DAYS_MS);

  const ttlIndex = ragSessionSchema
    .indexes()
    .find(([fields]) => fields.expiresAt === 1);
  assert.deepEqual(ttlIndex, [
    { expiresAt: 1 },
    { expireAfterSeconds: 0 },
  ]);
});

test("session deletion verifies ownership and removes vectors before Mongo", async () => {
  const calls = [];
  const session = {
    _id: "rag-session-1",
    userId: { toString: () => "user-1" },
    clientSessionId: "browser-a",
  };

  const result = await service.deleteViewerSession(
    {
      sessionId: "rag-session-1",
      userId: "user-1",
      clientSessionId: "browser-a",
    },
    {
      config: { sessionCollection: "leaseqa_session_chunks" },
      findSessionById: async () => session,
      deleteSessionChunks: async (sessionId) => calls.push(`vector:${sessionId}`),
      deleteSession: async (sessionId) => calls.push(`mongo:${sessionId}`),
    },
  );

  assert.deepEqual(calls, ["vector:rag-session-1", "mongo:rag-session-1"]);
  assert.deepEqual(result, { sessionId: "rag-session-1", deleted: true });
});

test("guest sessions can only be deleted by their originating browser session", async () => {
  const session = {
    _id: "guest-session",
    userId: null,
    clientSessionId: "browser-a",
  };
  const dependencies = {
    config: { sessionCollection: "leaseqa_session_chunks" },
    findSessionById: async () => session,
    deleteSessionChunks: async () => {},
    deleteSession: async () => {},
  };

  await assert.rejects(
    service.deleteViewerSession(
      {
        sessionId: "guest-session",
        userId: null,
        clientSessionId: "browser-b",
      },
      dependencies,
    ),
    /do not have access/,
  );
});

test("a vector deletion failure keeps Mongo data and returns a stable retryable error", async () => {
  let mongoDeleted = false;

  await assert.rejects(
    service.deleteViewerSession(
      {
        sessionId: "rag-session-2",
        userId: "user-2",
        clientSessionId: "browser-a",
      },
      {
        config: { sessionCollection: "leaseqa_session_chunks" },
        findSessionById: async () => ({
          _id: "rag-session-2",
          userId: { toString: () => "user-2" },
        }),
        deleteSessionChunks: async () => {
          throw new Error("Milvus unavailable");
        },
        deleteSession: async () => {
          mongoDeleted = true;
        },
      },
    ),
    (error) => {
      assert.equal(error.code, "RAG_SESSION_DELETE_RETRYABLE");
      assert.equal(error.retryable, true);
      return true;
    },
  );

  assert.equal(mongoDeleted, false);
});

test("a Mongo deletion failure is retryable after vectors were removed", async () => {
  let vectorsDeleted = false;

  await assert.rejects(
    service.deleteViewerSession(
      {
        sessionId: "rag-session-3",
        userId: "user-3",
        clientSessionId: "browser-a",
      },
      {
        config: { sessionCollection: "leaseqa_session_chunks" },
        findSessionById: async () => ({
          _id: "rag-session-3",
          userId: { toString: () => "user-3" },
        }),
        deleteSessionChunks: async () => {
          vectorsDeleted = true;
        },
        deleteSession: async () => {
          throw new Error("Mongo unavailable");
        },
      },
    ),
    (error) => error.code === "RAG_SESSION_DELETE_RETRYABLE",
  );

  assert.equal(vectorsDeleted, true);
});

test("deleteSessionChunks succeeds when the vector collection is already absent", async () => {
  let mutationCalled = false;
  const client = {
    hasCollection: async () => ({ value: false }),
    delete: async () => {
      mutationCalled = true;
    },
  };

  await milvus.deleteSessionChunks({
    config: { vectorTimeoutMs: 100 },
    collectionName: "leaseqa_session_chunks",
    sessionId: "already-gone",
    client,
  });

  assert.equal(mutationCalled, false);
});
