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

test("POST /sessions propagates requestId and redacts provider failures", async (t) => {
  const app = express();
  const logs = [];
  let received;
  app.use((req, _res, next) => {
    req.session = { currentUser: { _id: "user-1" } };
    req.sessionID = "COOKIE_SECRET";
    req.requestId = "request-create-1";
    next();
  });
  app.use(
    routes.createRagRouter({
      logger: { error: (value) => logs.push(value) },
      createSessionWithOptionalInitialAnswer: async (input) => {
        received = input;
        throw Object.assign(new Error("PRIVATE_PROVIDER_RESPONSE"), {
          code: "PRIVATE_PROVIDER_CODE",
        });
      },
    }),
  );

  const server = await listen(app);
  t.after(() => server.close());
  const address = server.address();
  const form = new FormData();
  form.set("sourceText", "PRIVATE_EVIDENCE_TEXT");
  form.set("initialQuestion", "PRIVATE_QUESTION_TEXT");
  const response = await fetch(
    `http://127.0.0.1:${address.port}/sessions`,
    { method: "POST", body: form },
  );
  const body = await response.json();

  assert.equal(received.requestId, "request-create-1");
  assert.equal(response.status, 500);
  assert.deepEqual(body, {
    error: {
      code: "RAG_CREATE_FAILED",
      message: "Failed to start chat session.",
    },
  });
  assert.deepEqual(JSON.parse(logs[0]), {
    event: "rag_create_failed",
    requestId: "request-create-1",
    errorCode: "RAG_CREATE_FAILED",
  });
  assert.doesNotMatch(
    `${JSON.stringify(body)}${logs.join("\n")}`,
    /PRIVATE_PROVIDER_RESPONSE|PRIVATE_PROVIDER_CODE|PRIVATE_QUESTION_TEXT|PRIVATE_EVIDENCE_TEXT|COOKIE_SECRET/,
  );
});

test("POST /sessions/:id/messages redacts provider failures", async (t) => {
  const app = express();
  const logs = [];
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { currentUser: { _id: "user-1" } };
    req.sessionID = "COOKIE_SECRET";
    req.requestId = "request-message-1";
    next();
  });
  app.use(
    routes.createRagRouter({
      logger: { error: (value) => logs.push(value) },
      answerQuestion: async () => {
        throw Object.assign(
          new Error("Milvus UnexpectedError: PRIVATE_PROVIDER_REASON"),
          { code: "RAG_MILVUS_STATUS_ERROR" },
        );
      },
    }),
  );

  const server = await listen(app);
  t.after(() => server.close());
  const address = server.address();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/sessions/rag-session-1/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "PRIVATE_QUESTION_TEXT" }),
    },
  );
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.deepEqual(body, {
    error: {
      code: "RAG_MESSAGE_FAILED",
      message: "Failed to answer question.",
    },
  });
  assert.deepEqual(JSON.parse(logs[0]), {
    event: "rag_message_failed",
    requestId: "request-message-1",
    errorCode: "RAG_MILVUS_STATUS_ERROR",
  });
  assert.doesNotMatch(
    `${JSON.stringify(body)}${logs.join("\n")}`,
    /PRIVATE_PROVIDER_REASON|PRIVATE_QUESTION_TEXT|COOKIE_SECRET/,
  );
});

test("GET /sessions/:id redacts unexpected lookup failures", async (t) => {
  const app = express();
  const logs = [];
  app.use((req, _res, next) => {
    req.session = { currentUser: { _id: "user-1" } };
    req.sessionID = "COOKIE_SECRET";
    req.requestId = "request-get-1";
    next();
  });
  app.use(
    routes.createRagRouter({
      logger: { error: (value) => logs.push(value) },
      getViewerSession: async () => {
        throw new Error("PRIVATE_MONGO_HOST lookup failed");
      },
    }),
  );

  const server = await listen(app);
  t.after(() => server.close());
  const address = server.address();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/sessions/rag-session-1`,
  );
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.deepEqual(body, {
    error: {
      code: "RAG_SESSION_FAILED",
      message: "Failed to load chat session.",
    },
  });
  assert.doesNotMatch(
    `${JSON.stringify(body)}${logs.join("\n")}`,
    /PRIVATE_MONGO_HOST|COOKIE_SECRET/,
  );
});

const parseEventStream = (text) =>
  text
    .split("\n\n")
    .filter((block) => block && !block.startsWith(":"))
    .map((block) => [
      block.match(/^event: (.+)$/m)?.[1],
      JSON.parse(block.match(/^data: (.+)$/m)?.[1]),
    ]);

const createStreamingApp = ({ dependencies, session }) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = session || { currentUser: { _id: "user-1" } };
    req.sessionID = "COOKIE_SECRET";
    req.requestId = "request-stream-1";
    next();
  });
  app.use(routes.createRagRouter(dependencies));
  return app;
};

const postMessage = (address, { accept, message = "Is this deposit legal?" } = {}) =>
  fetch(`http://127.0.0.1:${address.port}/sessions/rag-session-1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accept ? { Accept: accept } : {}),
    },
    body: JSON.stringify({ message }),
  });

test("POST /sessions/:id/messages streams progress, then the JSON body as a done event", async (t) => {
  const result = {
    session: { _id: "rag-session-1", messages: [] },
    answer: "The deposit is capped.",
    citations: [],
  };
  const app = createStreamingApp({
    dependencies: {
      answerQuestion: async ({ onEvent }) => {
        onEvent("status", { stage: "retrieving" });
        onEvent("status", { stage: "generating" });
        onEvent("delta", { part: "summary", text: "The deposit" });
        return result;
      },
    },
  });

  const server = await listen(app);
  t.after(() => server.close());
  const response = await postMessage(server.address(), {
    accept: "text/event-stream",
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  assert.deepEqual(parseEventStream(await response.text()), [
    ["status", { stage: "retrieving" }],
    ["status", { stage: "generating" }],
    ["delta", { part: "summary", text: "The deposit" }],
    ["done", { data: result }],
  ]);
});

test("a failure after the stream opened arrives as a redacted error event", async (t) => {
  const logs = [];
  const app = createStreamingApp({
    dependencies: {
      logger: { error: (value) => logs.push(value) },
      answerQuestion: async ({ onEvent }) => {
        onEvent("status", { stage: "retrieving" });
        throw Object.assign(new Error("PRIVATE_PROVIDER_RESPONSE"), {
          code: "RAG_CHAT_FAILED",
        });
      },
    },
  });

  const server = await listen(app);
  t.after(() => server.close());
  const response = await postMessage(server.address(), {
    accept: "text/event-stream",
    message: "PRIVATE_QUESTION_TEXT",
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.deepEqual(parseEventStream(text), [
    ["status", { stage: "retrieving" }],
    [
      "error",
      {
        error: { code: "RAG_MESSAGE_FAILED", message: "Failed to answer question." },
        status: 500,
      },
    ],
  ]);
  assert.deepEqual(JSON.parse(logs[0]), {
    event: "rag_message_failed",
    requestId: "request-stream-1",
    errorCode: "RAG_CHAT_FAILED",
  });
  assert.doesNotMatch(
    `${text}${logs.join("\n")}`,
    /PRIVATE_PROVIDER_RESPONSE|PRIVATE_QUESTION_TEXT|COOKIE_SECRET/,
  );
});

test("a failure before any progress keeps its HTTP status when a stream was asked for", async (t) => {
  const app = createStreamingApp({
    dependencies: {
      logger: { error: () => {} },
      answerQuestion: async () => {
        throw new Error("Session not found");
      },
    },
  });

  const server = await listen(app);
  t.after(() => server.close());
  const response = await postMessage(server.address(), {
    accept: "text/event-stream",
  });

  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  assert.deepEqual(await response.json(), {
    error: { code: "NOT_FOUND", message: "Chat session not found" },
  });
});

test("callers that do not ask for a stream keep the JSON envelope", async (t) => {
  let listener;
  const result = { session: { _id: "rag-session-1" }, answer: "Yes.", citations: [] };
  const app = createStreamingApp({
    dependencies: {
      answerQuestion: async ({ onEvent }) => {
        listener = onEvent;
        return result;
      },
    },
  });

  const server = await listen(app);
  t.after(() => server.close());
  const response = await postMessage(server.address(), { accept: "*/*" });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: result });
  assert.equal(listener, undefined);
});

test("POST /sessions stores the browser session, then streams creation to a done event", async (t) => {
  const order = [];
  const created = { _id: "rag-session-2", status: "ready", messages: [] };
  const app = createStreamingApp({
    session: {
      ragGuest: { createdAt: "2026-11-08T00:00:00.000Z" },
      save: (callback) => {
        order.push("save");
        callback();
      },
    },
    dependencies: {
      createSessionWithOptionalInitialAnswer: async ({ onEvent, clientSessionId }) => {
        order.push("create");
        assert.equal(clientSessionId, "COOKIE_SECRET");
        onEvent("status", { stage: "indexing" });
        return created;
      },
    },
  });

  const server = await listen(app);
  t.after(() => server.close());
  const form = new FormData();
  form.set("sourceText", "Tenant pays two months' rent as a deposit.");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/sessions`, {
    method: "POST",
    headers: { Accept: "text/event-stream" },
    body: form,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(parseEventStream(await response.text()), [
    ["status", { stage: "indexing" }],
    ["done", { data: created }],
  ]);
  assert.deepEqual(order, ["save", "create"]);
});
