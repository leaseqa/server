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
    recordActivityFn: async () => {},
  });

  assert.equal(answerCalled, true);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, "user");
});

test("uploaded-file sessions skip the auto-answer flow", async () => {
  const session = buildSession("session-upload");
  let answerCalled = false;

  const result = await createSessionWithOptionalInitialAnswer({
    userId: "user-2",
    clientSessionId: "client-2",
    sourceText: "",
    file: { originalname: "doc.pdf" },
    initialQuestion: "Please summarize",
    createSessionFn: async () => session,
    answerFn: async () => {
      answerCalled = true;
      return { session };
    },
    recordActivityFn: async () => {},
  });

  assert.equal(answerCalled, false);
  assert.equal(result.messages.length, 0);
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
    recordActivityFn: async () => {},
  });

  assert.equal(result._id.toString(), "session-fallback");
  assert.equal(result.messages.length, 0);
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
