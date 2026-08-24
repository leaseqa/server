import test from "node:test";
import assert from "node:assert/strict";

import { answerQuestion } from "./service.js";

const createSession = () => ({
  _id: "session-observed",
  status: "ready",
  userId: "user-observed",
  clientSessionId: null,
  sourceTextPreview: "private uploaded preview",
  messages: [],
});

const createDependencies = ({
  logs,
  clock,
  embedQuery,
  chatInvoke,
  storedCorpusVersion = "corpus-version-abc",
} = {}) => {
  const session = createSession();
  return {
    config: {
      maxHistoryMessages: 6,
      sessionCollection: "session_chunks",
      knowledgeCollection: "knowledge_chunks",
      sessionTopK: 6,
      knowledgeTopK: 8,
      vectorTimeoutMs: 100,
      chatTimeoutMs: 100,
      ingestStatePath: "/tmp/not-read-by-test",
      embeddingApiKey: "SECRET_PROVIDER_KEY",
    },
    findSessionById: async () => session,
    embeddingsClient: {
      embedQuery: embedQuery || (async () => [0.1, 0.2, 0.3]),
    },
    searchHybridChunks: async ({ collectionName }) =>
      collectionName === "session_chunks"
        ? []
        : [
            {
              id: "knowledge-citation-1",
              source_name: "tenant-handbook.pdf",
              source_group: "chapters",
              source_type: "handbook",
              chapter_ref: "3",
              file_path: "handbook/ch03.pdf",
              source_url: "",
              text: "PRIVATE_EVIDENCE_TEXT deposit return deadline",
              corpus_version: "corpus-version-from-vector",
              score: 0.95,
            },
          ],
    chatModel: {
      invoke:
        chatInvoke ||
        (async () => ({
          content: JSON.stringify({
            summary: "The handbook describes a deposit deadline.",
            summarySupports: ["c1"],
            bullets: [
              {
                text: "The source states the deadline rule.",
                supports: ["c1"],
              },
            ],
          }),
        })),
    },
    appendMessages: async (_sessionId, messages) => ({ ...session, messages }),
    readActiveCorpusVersion: async () => storedCorpusVersion,
    logger: { info: (value) => logs.push(value) },
    clock,
  };
};

test("answerQuestion emits request-scoped timings, citations, version, and abstention", async () => {
  const logs = [];
  const times = [100, 125, 130, 145];
  const dependencies = createDependencies({
    logs,
    clock: { now: () => times.shift() },
  });

  await answerQuestion(
    {
      sessionId: "session-observed",
      userId: "user-observed",
      clientSessionId: "COOKIE_SECRET",
      requestId: "request-123",
      question: "PRIVATE_QUESTION_TEXT about my deposit",
    },
    dependencies,
  );

  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0]), {
    event: "rag_request",
    requestId: "request-123",
    retrievalDurationMs: 25,
    providerDurationMs: 15,
    selectedCitationIds: ["knowledge-citation-1"],
    corpusVersion: "corpus-version-abc",
    abstained: false,
    abstentionReason: null,
    errorCode: null,
  });
  assert.doesNotMatch(
    logs[0],
    /PRIVATE_QUESTION_TEXT|PRIVATE_EVIDENCE_TEXT|SECRET_PROVIDER_KEY|COOKIE_SECRET|private uploaded preview/,
  );
});

test("answerQuestion records a redacted stable error metric before rethrowing", async () => {
  const logs = [];
  const providerError = Object.assign(new Error("PRIVATE_PROVIDER_RESPONSE"), {
    code: "RAG_TIMEOUT",
  });
  const dependencies = createDependencies({
    logs,
    clock: { now: () => 10 },
    embedQuery: async () => {
      throw providerError;
    },
  });

  await assert.rejects(
    answerQuestion(
      {
        sessionId: "session-observed",
        userId: "user-observed",
        clientSessionId: "COOKIE_SECRET",
        requestId: "request-error",
        question: "PRIVATE_QUESTION_TEXT",
      },
      dependencies,
    ),
    providerError,
  );

  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(logs[0]).errorCode, "RAG_TIMEOUT");
  assert.doesNotMatch(
    logs[0],
    /PRIVATE_PROVIDER_RESPONSE|PRIVATE_QUESTION_TEXT|SECRET_PROVIDER_KEY|COOKIE_SECRET/,
  );
});

test("provider failures retain elapsed provider time without logging the response", async () => {
  const logs = [];
  const times = [10, 20, 30, 45];
  const providerError = Object.assign(new Error("PRIVATE_PROVIDER_RESPONSE"), {
    code: "RAG_CHAT_FAILED",
  });
  const dependencies = createDependencies({
    logs,
    clock: { now: () => times.shift() },
    chatInvoke: async () => {
      throw providerError;
    },
  });

  await assert.rejects(
    answerQuestion(
      {
        sessionId: "session-observed",
        userId: "user-observed",
        requestId: "request-provider-error",
        question: "PRIVATE_QUESTION_TEXT",
      },
      dependencies,
    ),
    providerError,
  );

  const metric = JSON.parse(logs[0]);
  assert.equal(metric.retrievalDurationMs, 10);
  assert.equal(metric.providerDurationMs, 15);
  assert.equal(metric.errorCode, "RAG_CHAT_FAILED");
  assert.doesNotMatch(logs[0], /PRIVATE_PROVIDER_RESPONSE|PRIVATE_QUESTION_TEXT/);
});

test("answerQuestion tags the abstention reason when retrieval never clears the support floor", async () => {
  const logs = [];
  const dependencies = createDependencies({
    logs,
    clock: { now: () => 10 },
  });
  dependencies.searchHybridChunks = async () => [];

  await answerQuestion(
    {
      sessionId: "session-observed",
      userId: "user-observed",
      requestId: "request-no-support",
      question: "PRIVATE_QUESTION_TEXT",
    },
    dependencies,
  );

  const metric = JSON.parse(logs[0]);
  assert.equal(metric.abstained, true);
  assert.equal(metric.abstentionReason, "insufficient_retrieval_support");
});

test("answerQuestion tags the abstention reason when the model's structured output fails validation", async () => {
  const logs = [];
  const dependencies = createDependencies({
    logs,
    clock: { now: () => 10 },
    chatInvoke: async () => ({ content: "not valid json" }),
  });

  await answerQuestion(
    {
      sessionId: "session-observed",
      userId: "user-observed",
      requestId: "request-bad-model-output",
      question: "PRIVATE_QUESTION_TEXT",
    },
    dependencies,
  );

  const metric = JSON.parse(logs[0]);
  assert.equal(metric.abstained, true);
  assert.equal(metric.abstentionReason, "model_output_invalid");
});

test("corpus version falls back to retrieved version metadata when local state is absent", async () => {
  const logs = [];
  const dependencies = createDependencies({
    logs,
    clock: { now: () => 10 },
    storedCorpusVersion: null,
  });

  await answerQuestion(
    {
      sessionId: "session-observed",
      userId: "user-observed",
      requestId: "request-vector-version",
      question: "deposit deadline",
    },
    dependencies,
  );

  assert.equal(
    JSON.parse(logs[0]).corpusVersion,
    "corpus-version-from-vector",
  );
});
