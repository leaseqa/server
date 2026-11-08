import test from "node:test";
import assert from "node:assert/strict";
import { createSessionWithOptionalInitialAnswer } from "./service.js";

const buildSession = (id) => ({
  _id: { toString: () => id },
  messages: [],
});

test("pasted text sessions auto-answer when an initial question is provided", async () => {
  const session = buildSession("session-text");
  const updatedSession = {
    ...session,
    messages: [
      { role: "user", content: "Why does this clause mention tenant obligations?" },
      { role: "assistant", content: "It requires tenants to ..." },
    ],
  };

  let answerCalled = false;
  const result = await createSessionWithOptionalInitialAnswer({
    userId: "user-1",
    clientSessionId: "client-1",
    sourceText: "Clause text",
    file: null,
    initialQuestion: "What does this clause mean?",
    createSessionFn: async () => session,
    answerFn: async ({ question, sessionId }) => {
      answerCalled = true;
      assert.equal(question, "What does this clause mean?");
      assert.equal(sessionId, "session-text");
      return { session: updatedSession };
    },
    recordActivityFn: async () => {
    },
  });

  assert.equal(answerCalled, true);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, "user");
});

test("uploaded-file sessions also auto-answer when an initial question is provided", async () => {
  const session = buildSession("session-upload");
  const updatedSession = {
    ...session,
    messages: [
      { role: "user", content: "Please summarize" },
      { role: "assistant", content: "This document raises a security-deposit dispute." },
    ],
  };
  let answerCalled = false;

  const result = await createSessionWithOptionalInitialAnswer({
    userId: "user-2",
    clientSessionId: "client-2",
    sourceText: "",
    file: { originalname: "doc.pdf" },
    initialQuestion: "Please summarize",
    createSessionFn: async () => session,
    answerFn: async ({ question, sessionId }) => {
      answerCalled = true;
      assert.equal(question, "Please summarize");
      assert.equal(sessionId, "session-upload");
      return { session: updatedSession };
    },
    recordActivityFn: async () => {
    },
  });

  assert.equal(answerCalled, true);
  assert.equal(result.messages.length, 2);
});

test("pasted text sessions still return the created session if the automatic answer fails", async () => {
  const session = buildSession("session-fallback");

  const result = await createSessionWithOptionalInitialAnswer({
    userId: "user-3",
    clientSessionId: "client-3",
    sourceText: "Clause text",
    file: null,
    initialQuestion: "What does this clause mean?",
    createSessionFn: async () => session,
    answerFn: async () => {
      throw new Error("chat model unavailable");
    },
    recordActivityFn: async () => {
    },
  });

  assert.equal(result._id.toString(), "session-fallback");
  assert.equal(result.messages.length, 0);
});

test("initial answer receives the request id and logs only stable redacted failure fields", async () => {
  const session = buildSession("session-observed-bootstrap");
  const logs = [];

  const result = await createSessionWithOptionalInitialAnswer({
    userId: "user-observed",
    clientSessionId: "COOKIE_SECRET",
    requestId: "request-bootstrap-1",
    sourceText: "PRIVATE_EVIDENCE_TEXT",
    file: null,
    initialQuestion: "PRIVATE_QUESTION_TEXT",
    createSessionFn: async () => session,
    answerFn: async (input) => {
      assert.equal(input.requestId, "request-bootstrap-1");
      throw Object.assign(new Error("PRIVATE_PROVIDER_RESPONSE"), {
        code: "RAG_CHAT_FAILED",
      });
    },
    recordActivityFn: async () => {},
    logger: { error: (value) => logs.push(value) },
  });

  assert.equal(result, session);
  assert.deepEqual(JSON.parse(logs[0]), {
    event: "rag_initial_question_failed",
    requestId: "request-bootstrap-1",
    errorCode: "RAG_CHAT_FAILED",
  });
  assert.doesNotMatch(
    logs[0],
    /PRIVATE_PROVIDER_RESPONSE|PRIVATE_QUESTION_TEXT|PRIVATE_EVIDENCE_TEXT|COOKIE_SECRET/,
  );
});

test("logged-in sessions write an ai review activity after creation", async () => {
  const session = buildSession("session-activity");
  const recorded = [];

  const result = await createSessionWithOptionalInitialAnswer({
    userId: "user-9",
    clientSessionId: "client-9",
    sourceText: "Clause text",
    file: null,
    initialQuestion: "",
    createSessionFn: async () => session,
    answerFn: async () => {
      throw new Error("should not run");
    },
    recordActivityFn: async (payload) => {
      recorded.push(payload);
    },
  });

  assert.equal(result._id.toString(), "session-activity");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].type, "ai_review_created");
  assert.equal(recorded[0].userId, "user-9");
  assert.equal(recorded[0].metadata.sessionId, "session-activity");
});

test("progress from indexing and from the first answer reaches the same listener", async () => {
  const session = buildSession("session-progress");
  const events = [];
  const onEvent = (event, data) => events.push([event, data]);

  await createSessionWithOptionalInitialAnswer({
    userId: null,
    clientSessionId: "client-1",
    sourceText: "Clause text",
    file: null,
    initialQuestion: "What does this clause mean?",
    onEvent,
    createSessionFn: async (input) => {
      input.onEvent("status", { stage: "indexing" });
      return session;
    },
    answerFn: async (input) => {
      input.onEvent("status", { stage: "retrieving" });
      input.onEvent("delta", { part: "summary", text: "It means" });
      return { session };
    },
  });

  assert.deepEqual(events, [
    ["status", { stage: "indexing" }],
    ["status", { stage: "retrieving" }],
    ["delta", { part: "summary", text: "It means" }],
  ]);
});
