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
  chatReply,
  storedCorpusVersion = "corpus-version-abc",
} = {}) => {
  const session = createSession();
  return {
    config: {
      maxHistoryMessages: 6,
      sessionCollection: "session_chunks",
      knowledgeCollection: "knowledge_chunks",
      sessionTopK: 6,
      candidatesPerGroup: 10,
      evidenceLimit: 6,
      minSupportScore: 0.025,
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
      // The model streams; each fake answers in one chunk.
      async *stream(...args) {
        const respond =
          chatReply ||
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
          }));
        yield await respond(...args);
      },
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
    evidenceRanking: "fusion",
    topEvidenceScore: 0.95,
    providerDurationMs: 15,
    selectedCitationIds: ["knowledge-citation-1"],
    corpusVersion: "corpus-version-abc",
    abstained: false,
    abstentionReason: null,
    scopeCheck: null,
    evidenceFromScopeQuery: null,
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
    chatReply: async () => {
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
    chatReply: async () => ({ content: "not valid json" }),
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

// The best chunk reranks into the scope-check band and the model answers the
// check with verdict.
const answerInScopeCheckBand = async (verdict, { clock = { now: () => 10 } } = {}) => {
  const logs = [];
  const dependencies = createDependencies({
    logs,
    clock,
    chatReply: async (messages) => ({
      content: /single word yes or no/i.test(messages[0].content)
        ? verdict
        : JSON.stringify({
            summary: "The handbook describes a deposit deadline.",
            summarySupports: ["c1"],
            bullets: [{ text: "The source states the deadline rule.", supports: ["c1"] }],
          }),
    }),
  });
  dependencies.config = { ...dependencies.config, minRerankScore: 15, scopeCheckBelow: 17.5 };
  dependencies.rerankClient = { rerank: async ({ documents }) => documents.map(() => 16) };

  await answerQuestion(
    {
      sessionId: "session-observed",
      userId: "user-observed",
      requestId: "request-scope-check",
      question: "PRIVATE_QUESTION_TEXT",
    },
    dependencies,
  );
  return JSON.parse(logs[0]);
};

test("answerQuestion records the scope check's verdict and tags an out-of-scope abstention", async () => {
  const inScope = await answerInScopeCheckBand("yes");
  assert.equal(inScope.scopeCheck, "in_scope");
  assert.equal(inScope.abstained, false);
  assert.equal(inScope.abstentionReason, null);

  const outOfScope = await answerInScopeCheckBand("no");
  assert.equal(outOfScope.scopeCheck, "out_of_scope");
  assert.equal(outOfScope.abstained, true);
  assert.equal(outOfScope.abstentionReason, "out_of_scope");
});

test("answerQuestion records whether the evidence came from the check's search query", async () => {
  assert.equal((await answerInScopeCheckBand("yes")).evidenceFromScopeQuery, false);
  assert.equal((await answerInScopeCheckBand("yes\ndeposit return deadline")).evidenceFromScopeQuery, true);
  // An out-of-scope question has nothing to re-rank.
  assert.equal((await answerInScopeCheckBand("no")).evidenceFromScopeQuery, null);
});

test("provider time counts the scope check and the answer together", async () => {
  // Retrieval 100-125, scope check 130-140, answer 150-165.
  const times = [100, 125, 130, 140, 150, 165];
  const metric = await answerInScopeCheckBand("yes", { clock: { now: () => times.shift() } });

  assert.equal(metric.retrievalDurationMs, 25);
  assert.equal(metric.providerDurationMs, 25);
});

// A failed check ends the request like a failed answer would: abstaining
// would tell the renter the handbook has nothing when the provider is down.
test("a scope check that fails ends the request, and the metric shows the check failed", async () => {
  const logs = [];
  const providerError = Object.assign(new Error("PRIVATE_PROVIDER_RESPONSE"), {
    code: "RAG_CHAT_FAILED",
  });
  const dependencies = createDependencies({
    logs,
    clock: { now: () => 10 },
    chatReply: async () => {
      throw providerError;
    },
  });
  dependencies.config = { ...dependencies.config, minRerankScore: 15, scopeCheckBelow: 17.5 };
  dependencies.rerankClient = { rerank: async ({ documents }) => documents.map(() => 16) };

  await assert.rejects(
    answerQuestion(
      {
        sessionId: "session-observed",
        userId: "user-observed",
        requestId: "request-scope-check-error",
        question: "PRIVATE_QUESTION_TEXT",
      },
      dependencies,
    ),
    providerError,
  );

  const metric = JSON.parse(logs[0]);
  assert.equal(metric.scopeCheck, "failed");
  assert.equal(metric.errorCode, "RAG_CHAT_FAILED");
  assert.doesNotMatch(logs[0], /PRIVATE_PROVIDER_RESPONSE|PRIVATE_QUESTION_TEXT/);
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

const askObserved = (dependencies, requestId) =>
  answerQuestion(
    {
      sessionId: "session-observed",
      userId: "user-observed",
      requestId,
      question: "PRIVATE_QUESTION_TEXT",
    },
    dependencies,
  );

test("answerQuestion ranks evidence by the reranker and records its top score", async () => {
  const logs = [];
  const dependencies = createDependencies({ logs, clock: { now: () => 10 } });
  dependencies.config = { ...dependencies.config, minRerankScore: 16.5 };
  dependencies.rerankClient = { rerank: async ({ documents }) => documents.map(() => 19.25) };

  const result = await askObserved(dependencies, "request-reranked");

  const metric = JSON.parse(logs[0]);
  assert.equal(result.citations.length, 1);
  assert.equal(metric.evidenceRanking, "rerank");
  assert.equal(metric.topEvidenceScore, 19.25);
  assert.equal(metric.abstained, false);
});

test("answerQuestion abstains without calling the model when the best reranked chunk is below the floor", async () => {
  const logs = [];
  let modelCalled = false;
  const dependencies = createDependencies({
    logs,
    clock: { now: () => 10 },
    chatReply: async () => {
      modelCalled = true;
      return { content: "{}" };
    },
  });
  dependencies.config = { ...dependencies.config, minRerankScore: 16.5 };
  dependencies.rerankClient = { rerank: async ({ documents }) => documents.map(() => 12.1) };

  const result = await askObserved(dependencies, "request-below-floor");

  const metric = JSON.parse(logs[0]);
  assert.equal(modelCalled, false);
  assert.deepEqual(result.citations, []);
  assert.equal(metric.abstained, true);
  assert.equal(metric.abstentionReason, "insufficient_retrieval_support");
  assert.equal(metric.topEvidenceScore, 12.1);
});

test("a failed rerank still answers from the fused order and logs only a stable code", async () => {
  const logs = [];
  const errors = [];
  const dependencies = createDependencies({ logs, clock: { now: () => 10 } });
  dependencies.logger = {
    info: (value) => logs.push(value),
    error: (value) => errors.push(value),
  };
  dependencies.rerankClient = {
    rerank: async () => {
      throw Object.assign(new Error("PRIVATE provider detail"), {
        code: "RAG_RERANK_FAILED",
      });
    },
  };

  const result = await askObserved(dependencies, "request-rerank-down");

  assert.equal(result.citations.length, 1);
  assert.equal(JSON.parse(logs[0]).evidenceRanking, "fusion");
  assert.deepEqual(errors.map((value) => JSON.parse(value)), [
    {
      event: "rag_rerank_failed",
      requestId: "request-rerank-down",
      errorCode: "RAG_RERANK_FAILED",
    },
  ]);
  assert.doesNotMatch(errors.join(""), /PRIVATE provider detail/);
});
