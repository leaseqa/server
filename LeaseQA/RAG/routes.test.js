import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

import * as routes from "./routes.js";

const listen = async (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });

test("getUploadMaxBytes defaults to 20MB", () => {
  assert.equal(routes.getUploadMaxBytes({}), 20 * 1024 * 1024);
});

test("getUploadMaxBytes respects explicit env overrides", () => {
  assert.equal(
    routes.getUploadMaxBytes({ RAG_UPLOAD_MAX_BYTES: `${15 * 1024 * 1024}` }),
    15 * 1024 * 1024,
  );
});

test("guest RAG metadata expires after 30 days", () => {
  const now = new Date("2026-08-19T00:00:00.000Z");
  assert.deepEqual(routes.createGuestSessionMetadata(now), {
    createdAt: "2026-08-19T00:00:00.000Z",
    expiresAt: "2026-09-18T00:00:00.000Z",
  });
});

test("DELETE /sessions/:sessionId returns the standard data envelope", async (t) => {
  const app = express();
  app.use((req, _res, next) => {
    req.session = { currentUser: { _id: "user-1" } };
    req.sessionID = "browser-a";
    next();
  });
  app.use(
    routes.createRagRouter({
      deleteViewerSession: async (viewer) => ({
        sessionId: viewer.sessionId,
        deleted: true,
      }),
    }),
  );

  const server = await listen(app);
  t.after(() => server.close());
  const address = server.address();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/sessions/rag-session-1`,
    { method: "DELETE" },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    data: { sessionId: "rag-session-1", deleted: true },
  });
});

test("DELETE returns a stable retryable envelope when either store fails", async (t) => {
  const app = express();
  app.use((req, _res, next) => {
    req.session = { currentUser: { _id: "user-1" } };
    req.sessionID = "browser-a";
    next();
  });
  app.use(
    routes.createRagRouter({
      deleteViewerSession: async () => {
        const error = new Error("Session deletion did not complete");
        error.code = "RAG_SESSION_DELETE_RETRYABLE";
        throw error;
      },
    }),
  );

  const server = await listen(app);
  t.after(() => server.close());
  const address = server.address();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/sessions/rag-session-1`,
    { method: "DELETE" },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      code: "RAG_SESSION_DELETE_RETRYABLE",
      message: "Session deletion did not complete. Retry the request.",
    },
  });
});
