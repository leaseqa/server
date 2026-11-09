import { createHash } from "node:crypto";
import path from "path";
import fs from "fs/promises";
import { v4 as uuidv4 } from "uuid";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import * as dao from "./dao.js";
import { getRagConfig } from "./config.js";
import { parseManifestCsv } from "./corpusManifest.js";
import {
  buildRagMessages,
  buildScopeCheckMessages,
  formatEvidenceSourceLabel,
  getEvidenceId,
  parseScopeVerdict,
} from "./prompt.js";
import { runBoundedOperation } from "./operationPolicy.js";
import { createDraftTracker } from "./answerDraft.js";
import {
  createTextPreview,
  extractCorpusPages,
  extractTextFromUpload,
  splitTextToChunks,
} from "./text.js";
import {
  buildKnowledgeSearchPlan,
  buildRetrievalQuestion,
  needsScopeCheck,
  rankEvidence,
  selectEvidence,
} from "./retrievalPolicy.js";
import { createRerankClient } from "./rerank.js";
import {
  deleteChunkRows,
  deleteSessionChunks as deleteMilvusSessionChunks,
  ensureCollectionLoaded,
  flushCollection,
  getAliasTarget,
  hasChunkCollection,
  insertChunkRows,
  listCollections,
  resetCollection,
  searchHybridChunks,
  activateCollectionAlias,
} from "./milvus.js";
import {
  buildCorpusIdentity,
  readActiveCorpusVersion,
  readIngestState,
  writeIngestState,
} from "./ingestState.js";
import { loadGateCases, runRetrievalGate } from "./corpusGate.js";
import { createActivity } from "../Activity/dao.js";
import { buildActivity } from "../Activity/service.js";

const getChunkKey = (item) =>
  item.id ||
  [
    item.source_group,
    item.source_name,
    item.chapter_ref,
    String(item.text || "").slice(0, 160),
  ].join("::");

const dedupeById = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = getChunkKey(item);
    if ( seen.has(key) ) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

// Progress is best effort, like the metrics: a listener that throws must not
// cost the renter an answer that would otherwise be stored and returned.
// Returns null when nobody is listening, so callers can skip the work. The
// reporter answers whether the event was delivered: a listener says no by
// returning false (the event stream does once its client has gone).
const createProgressReporter = (onEvent) =>
  onEvent
    ? (event, data) => {
        try {
          return onEvent(event, data) !== false;
        } catch {
          // Reporting must not change the result.
          return false;
        }
      }
    : null;

// A streamed chunk's answer text. Reasoning models (glm-5.3-flash) send their
// thinking separately, in additional_kwargs, so it never lands here; typed
// content parts other than text are skipped for the same reason.
const getChunkText = (chunk) => {
  if ( typeof chunk?.content === "string" ) {
    return chunk.content;
  }
  if ( Array.isArray(chunk?.content) ) {
    return chunk.content
      .map((part) => {
        if ( typeof part === "string" ) {
          return part;
        }
        return part?.type === "text" ? part.text || "" : "";
      })
      .join("");
  }
  return "";
};

const joinUrl = (base, suffix) =>
  `${String(base || "").replace(/\/+$/, "")}/${String(suffix || "").replace(
    /^\/+/,
    "",
  )}`;

const toEmbeddingTextType = (taskType) => {
  if ( taskType === "RETRIEVAL_QUERY" || taskType === "query" ) {
    return "query";
  }
  return "document";
};

const parseEmbeddingErrorMessage = (payload, fallback) =>
  payload?.error?.message || fallback;

const usesMultimodalEmbeddings = (config) =>
  /embedding-vision/i.test(String(config.embeddingModel || "")) ||
  /embeddings\/multimodal/i.test(String(config.embeddingBaseUrl || ""));

const unwrapEmbedding = (value) => {
  if ( !Array.isArray(value) || value.length === 0 ) {
    return null;
  }
  if ( typeof value[0] === "number" ) {
    return value;
  }
  if ( Array.isArray(value[0]) && typeof value[0][0] === "number" ) {
    return value[0];
  }
  return null;
};

const extractEmbeddingVector = (payload) =>
  unwrapEmbedding(payload?.data?.[0]?.embedding) ||
  unwrapEmbedding(payload?.data?.embedding);

export const postOpenAICompatibleEmbedding = async ({
                                                      config,
                                                      text,
                                                      taskType,
                                                      fetchFn = globalThis.fetch,
                                                      retryPolicy,
                                                    }) => {
  const embeddingPath =
    config.embeddingPath ||
    (usesMultimodalEmbeddings(config) ? "embeddings/multimodal" : "embeddings");
  const multimodal = embeddingPath.includes("multimodal");
  const requestUrl = joinUrl(config.embeddingBaseUrl, embeddingPath);

  return runBoundedOperation({
    label: "embedding request",
    timeoutMs: config.embeddingTimeoutMs,
    retryPolicy,
    operation: async (signal) => {
      const response = await fetchFn(requestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.embeddingApiKey}`,
        },
        body: JSON.stringify(
          multimodal
            ? {
                model: config.embeddingModel,
                input: [{ type: "text", text }],
                dimensions: config.embeddingDimension,
                encoding_format: "float",
              }
            : {
                model: config.embeddingModel,
                input: text,
                dimensions: config.embeddingDimension,
                encoding_format: "float",
                text_type: toEmbeddingTextType(taskType),
              },
        ),
        signal,
      });

      let payload;
      try {
        payload = await response.json();
      } catch ( cause ) {
        if ( response.ok ) {
          throw new Error("Embedding response was not valid JSON", { cause });
        }
        const error = new Error("Embedding request failed", { cause });
        error.status = response.status;
        throw error;
      }
      if ( response.ok ) {
        const vector = extractEmbeddingVector(payload);
        if ( vector ) {
          return vector;
        }
      }

      const error = new Error(
        parseEmbeddingErrorMessage(payload, "Embedding request failed"),
      );
      if ( !response.ok ) {
        error.status = response.status;
      }
      throw error;
    },
  });
};

export const createEmbeddingsClient = (config, dependencies = {}) => ({
  embedDocuments: async (texts) => {
    const vectors = [];
    const batchSize = config.ragProvider === "ark" ? 1 : 8;

    for ( let index = 0; index < texts.length; index += batchSize ) {
      const batch = texts.slice(index, index + batchSize);
      const embeddedBatch = await Promise.all(
        batch.map((text) =>
          postOpenAICompatibleEmbedding({
            config,
            text,
            taskType: "RETRIEVAL_DOCUMENT",
            ...dependencies,
          }),
        ),
      );
      vectors.push(...embeddedBatch);
      if ( config.ragProvider === "ark" && index + batchSize < texts.length ) {
        await new Promise((resolve) => {
          setTimeout(resolve, 200);
        });
      }
    }

    return vectors;
  },
  embedQuery: async (text) =>
    postOpenAICompatibleEmbedding({
      config,
      text,
      taskType: "RETRIEVAL_QUERY",
      ...dependencies,
    }),
});

/**
 * Streams the model's answer and resolves with the whole text. onText sees the
 * text so far after every chunk; each attempt starts from empty again. The
 * timeout bounds the whole stream, and transient failures are retried like any
 * other provider call unless retryPolicy.shouldRetry says otherwise.
 */
export const streamChatModel = ({
                                  config,
                                  chatModel,
                                  messages,
                                  retryPolicy,
                                  onText,
                                }) =>
  runBoundedOperation({
    label: "chat generation",
    timeoutMs: config.chatTimeoutMs,
    retryPolicy,
    operation: async (signal) => {
      let text = "";
      const stream = await chatModel.stream(messages, { signal });
      for await ( const chunk of stream ) {
        const piece = getChunkText(chunk);
        // Once the attempt has timed out, late chunks belong to nobody.
        if ( !piece || signal.aborted ) {
          continue;
        }
        text += piece;
        onText?.(text);
      }
      return text;
    },
  });

export const createChatClient = (
  config,
  { ChatModelClass = ChatOpenAI } = {},
) => {
  if ( !config.chatApiKey ) {
    throw new Error(
      "RAG_CHAT_API_KEY or the selected provider's key (ZHIPU_API_KEY, ARK_API_KEY, DASHSCOPE_API_KEY) is not configured",
    );
  }
  return new ChatModelClass({
    apiKey: config.chatApiKey,
    model: config.chatModel,
    temperature: 0.2,
    maxRetries: 0,
    // Token usage is never read, and asking for it adds stream_options to
    // every request, a field not every OpenAI-compatible provider accepts.
    streamUsage: false,
    configuration: { baseURL: config.chatBaseUrl },
  });
};

const buildChunkRows = ({ documents, vectors, sessionId }) =>
  documents.map((document, index) => ({
    id: `${sessionId}:${index}:${uuidv4()}`,
    text: document.pageContent,
    source_name: document.metadata.sourceName,
    source_group: document.metadata.sourceGroup,
    source_type: document.metadata.sourceType,
    chapter_ref: document.metadata.chapterRef || "",
    file_path: document.metadata.filePath || "",
    source_url: document.metadata.sourceUrl || "",
    session_id: sessionId,
    title_hint: document.metadata.titleHint || document.metadata.sourceName,
    priority: document.metadata.priority || "",
    embedding: vectors[index],
  }));

const createUploadedSourceMetadata = ({
                                        sessionId,
                                        sourceName,
                                        sourceKind,
                                        mimeType,
                                      }) => ({
  sourceName,
  sourceGroup: sourceKind === "upload" ? "upload" : "text",
  sourceType: sourceKind,
  chapterRef: null,
  filePath: null,
  sourceUrl: null,
  titleHint: sourceName,
  priority: "P0",
  sessionId,
  mimeType: mimeType || null,
});

const buildCitation = (chunk) => ({
  citationId: chunk.id || getChunkKey(chunk),
  sourceName: chunk.source_name,
  sourceGroup: chunk.source_group,
  sourceType: chunk.source_type,
  chapterRef: chunk.chapter_ref || null,
  filePath: chunk.file_path || null,
  sourceUrl: chunk.source_url || null,
  snippet: createTextPreview(chunk.text, 180),
});

export { formatEvidenceSourceLabel };

const stripFence = (text) =>
  text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

const extractJsonObject = (text) => {
  const stripped = stripFence(text);
  const match = stripped.match(/\{[\s\S]*\}/);
  return match ? match[0] : stripped;
};

const cleanSentence = (text) =>
  String(text || "")
    .replace(/^[*•\-\d.\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();

const buildAnswerContent = ({ summary, bullets }) =>
  [summary, ...bullets.map((bullet) => `• ${bullet.text}`)]
    .filter(Boolean)
    .join("\n");

const normalizeCitationIndices = (
  supports,
  citationIdToIndex,
) => {
  const resolved = (supports || [])
    .map((supportId) => citationIdToIndex[supportId])
    .filter((index) => Number.isInteger(index));
  return [...new Set(resolved)].slice(0, 2);
};

const structuredAnswerSchema = z
  .object({
    summary: z.string().trim().min(1),
    summarySupports: z.array(z.string().trim().min(1)).min(1).max(2),
    bullets: z
      .array(
        z
          .object({
            text: z.string().trim().min(1),
            supports: z.array(z.string().trim().min(1)).min(1).max(2),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();

export const normalizeAssistantAnswer = ({
                                           rawAnswer,
                                           citationIdToIndex,
                                         }) => {
  try {
    const parsed = structuredAnswerSchema.safeParse(
      JSON.parse(extractJsonObject(rawAnswer)),
    );
    if ( parsed.success ) {
      const summary = cleanSentence(parsed.data.summary);
      const summaryCitationIndices = normalizeCitationIndices(
        parsed.data.summarySupports,
        citationIdToIndex,
      );
      const bullets = parsed.data.bullets.map((bullet) => ({
        text: cleanSentence(bullet.text),
        citationIndices: normalizeCitationIndices(
          bullet.supports,
          citationIdToIndex,
        ),
      }));

      return {
        summary,
        summaryCitationIndices,
        bullets,
        content: buildAnswerContent({ summary, bullets }),
      };
    }
  } catch ( error ) {
    // Invalid model output follows the deterministic abstention path below.
  }

  return buildInsufficientSupportAnswer("model_output_invalid");
};

const buildInsufficientSupportAnswer = (abstentionReason) => {
  const summary =
    "I could not find enough support to answer that reliably from this source and the handbook.";
  const bullets = [
    {
      text: "Ask a narrower question or quote the specific clause you want reviewed.",
      citationIndices: [],
    },
  ];
  return {
    summary,
    summaryCitationIndices: [],
    bullets,
    content: buildAnswerContent({ summary, bullets }),
    abstentionReason,
  };
};

export const finalizeAssistantCitations = ({
                                             structuredAnswer,
                                             candidateCitations,
                                           }) => {
  const citations = Array.isArray(candidateCitations)
    ? candidateCitations
    : [];
  const supportedBullets = (structuredAnswer?.bullets || [])
    .map((bullet) => ({
      ...bullet,
      citationIndices: [...new Set(bullet.citationIndices || [])].filter(
        (index) =>
          Number.isInteger(index) && index >= 0 && index < citations.length,
      ),
    }))
    .filter((bullet) => bullet.citationIndices.length > 0);
  const summaryCitationIndices = [
    ...new Set(structuredAnswer?.summaryCitationIndices || []),
  ].filter(
    (index) =>
      Number.isInteger(index) && index >= 0 && index < citations.length,
  );
  const selectedIndices = [
    ...new Set([
      ...summaryCitationIndices,
      ...supportedBullets.flatMap((bullet) => bullet.citationIndices),
    ]),
  ];

  if ( summaryCitationIndices.length === 0 || supportedBullets.length === 0 ) {
    return {
      structuredAnswer: buildInsufficientSupportAnswer(
        structuredAnswer?.abstentionReason || "unsupported_citations",
      ),
      citations: [],
      hasExplicitSupport: false,
    };
  }

  const remappedIndices = new Map(
    selectedIndices.map((originalIndex, newIndex) => [originalIndex, newIndex]),
  );
  const bullets = supportedBullets.map((bullet) => ({
    ...bullet,
    citationIndices: bullet.citationIndices.map((index) =>
      remappedIndices.get(index)),
  }));
  const finalizedAnswer = {
    ...structuredAnswer,
    summaryCitationIndices: summaryCitationIndices.map((index) =>
      remappedIndices.get(index)),
    bullets,
    content: buildAnswerContent({
      summary: structuredAnswer.summary,
      bullets,
    }),
  };

  return {
    structuredAnswer: finalizedAnswer,
    citations: selectedIndices.map((index) => citations[index]),
    hasExplicitSupport: true,
  };
};

const ensureViewerCanAccess = ({ session, userId, clientSessionId }) => {
  if ( !session ) {
    throw new Error("Session not found");
  }
  if ( session.userId ) {
    if ( !userId || session.userId.toString() !== userId.toString() ) {
      throw new Error("You do not have access to this session");
    }
    return;
  }
  if ( session.clientSessionId !== clientSessionId ) {
    throw new Error("You do not have access to this session");
  }
};

export const retrieveKnowledgeCandidates = async ({
                                                  config,
                                                  vector,
                                                  question,
                                                  collectionName,
                                                  searchHybridChunksFn = searchHybridChunks,
                                                  retryPolicy,
                                                }) => {
  const targetCollection = collectionName || config.knowledgeCollection;
  const groupedResults = await Promise.all(
    buildKnowledgeSearchPlan(config).map(({ group, limit }) =>
      searchHybridChunksFn({
        config,
        collectionName: targetCollection,
        denseVector: vector,
        sparseText: question,
        limit,
        filter: `source_group == "${group}"`,
        retryPolicy,
      }),
    ),
  );

  return dedupeById(groupedResults.flat());
};

// What the model would be shown from the knowledge corpus alone. The ingest
// gate judges a staging collection by exactly this.
export const retrieveKnowledgeChunks = async ({
                                                config,
                                                vector,
                                                question,
                                                collectionName,
                                                searchHybridChunksFn,
                                                rerankClient = null,
                                                onRerankError,
                                                retryPolicy,
                                              }) => {
  const candidates = await retrieveKnowledgeCandidates({
    config,
    vector,
    question,
    collectionName,
    searchHybridChunksFn,
    retryPolicy,
  });
  const ranking = await rankEvidence({
    question,
    chunks: candidates,
    rerankClient,
    onRerankError,
  });
  return selectEvidence({ ranking, config });
};

export const createRagSession = async ({
                                         userId,
                                         clientSessionId,
                                         sourceText,
                                         file,
                                         onEvent,
                                       }) => {
  const config = getRagConfig();
  const embeddings = createEmbeddingsClient(config);

  const sourceKind = file ? "upload" : "text";
  const sourceName = file?.originalname || "pasted-text";
  const extractedText =
    sourceText?.trim() ||
    (await extractTextFromUpload({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
    }));

  const sourcePreview = createTextPreview(extractedText);
  const session = await dao.createSession({
    userId,
    clientSessionId,
    status: "indexing",
    sourceKind,
    sourceName,
    sourceMimeType: file?.mimetype || "text/plain",
    sourceTextPreview: sourcePreview,
    sourceCharCount: extractedText.length,
    messages: [],
  });
  // Only now: an unreadable or unsupported upload has already failed above,
  // with its own status code instead of an error inside an open stream.
  createProgressReporter(onEvent)?.("status", { stage: "indexing" });

  try {
    const documents = await splitTextToChunks({
      text: extractedText,
      metadata: createUploadedSourceMetadata({
        sessionId: session._id.toString(),
        sourceName,
        sourceKind,
        mimeType: file?.mimetype,
      }),
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
    });
    const vectors = await embeddings.embedDocuments(
      documents.map((document) => document.pageContent),
    );
    await insertChunkRows({
      config,
      collectionName: config.sessionCollection,
      rows: buildChunkRows({
        documents,
        vectors,
        sessionId: session._id.toString(),
      }),
      dimension: vectors[0]?.length || 0,
    });

    return dao.updateSession(session._id, {
      status: "ready",
      error: null,
    });
  } catch ( error ) {
    await dao.updateSession(session._id, {
      status: "failed",
      error: error.message || "Failed to index uploaded source",
    });
    throw error;
  }
};

export const listViewerSessions = ({ userId, clientSessionId }) =>
  dao.listSessionsForViewer({ userId, clientSessionId });

export const getViewerSession = async ({
                                         sessionId,
                                         userId,
                                         clientSessionId,
                                       }) => {
  const session = await dao.findSessionById(sessionId);
  ensureViewerCanAccess({ session, userId, clientSessionId });
  return session;
};

const createRetryableSessionDeleteError = (cause) => {
  const error = new Error("Session deletion did not complete", { cause });
  error.code = "RAG_SESSION_DELETE_RETRYABLE";
  error.retryable = true;
  return error;
};

export const getStableRagErrorCode = (error, fallback) => {
  const code = String(error?.code || "");
  return /^RAG_[A-Z0-9_]+$/.test(code) ? code : fallback;
};

const isInvalidSessionIdError = (error) =>
  error?.name === "CastError" ||
  error?.name === "BSONError" ||
  error?.name === "BSONTypeError";

export const deleteViewerSession = async (
  { sessionId, userId, clientSessionId },
  dependencies = {},
) => {
  const config = dependencies.config || getRagConfig();
  const findSessionById = dependencies.findSessionById || dao.findSessionById;
  const deleteSessionChunks =
    dependencies.deleteSessionChunks ||
    ((id) =>
      deleteMilvusSessionChunks({
        config,
        collectionName: config.sessionCollection,
        sessionId: id,
        retryPolicy: dependencies.retryPolicy,
      }));
  const deleteSession = dependencies.deleteSession || dao.deleteSession;
  let session;
  try {
    session = await findSessionById(sessionId);
  } catch ( cause ) {
    if ( isInvalidSessionIdError(cause) ) {
      throw new Error("Session not found");
    }
    throw createRetryableSessionDeleteError(cause);
  }
  ensureViewerCanAccess({ session, userId, clientSessionId });

  try {
    await deleteSessionChunks(sessionId);
    await deleteSession(sessionId);
  } catch ( cause ) {
    throw createRetryableSessionDeleteError(cause);
  }

  return { sessionId, deleted: true };
};

/**
 * onEvent(event, data), when given, hears progress as it happens:
 *   ("status", { stage: "retrieving" | "generating" })
 *   ("delta", { part: "summary", text } | { part: "bullet", index, text })
 * The deltas are a draft. The resolved answer is the one that counts: it can
 * drop bullets the evidence does not support, or abstain altogether.
 */
export const answerQuestion = async ({
                                       sessionId,
                                       userId,
                                       clientSessionId,
                                       question,
                                       requestId,
                                       onEvent,
                                     }, dependencies = {}) => {
  const config = dependencies.config || getRagConfig();
  const findSessionById = dependencies.findSessionById || dao.findSessionById;
  const appendMessages = dependencies.appendMessages || dao.appendMessages;
  const searchHybridChunksFn =
    dependencies.searchHybridChunks || searchHybridChunks;
  const retryPolicy = dependencies.retryPolicy;
  const clock = dependencies.clock || { now: () => performance.now() };
  const logger = dependencies.logger || console;
  const readCorpusVersion =
    dependencies.readActiveCorpusVersion || readActiveCorpusVersion;
  const report = createProgressReporter(onEvent);
  let retrievalStartedAt = null;
  let retrievalDurationMs = null;
  let evidenceRanking = null;
  let topEvidenceScore = null;
  let providerStartedAt = null;
  let providerDurationMs = 0;
  let selectedCitationIds = [];
  let abstained = false;
  let abstentionReason = null;
  let scopeCheck = null;
  let corpusVersion = null;
  try {
    corpusVersion = await readCorpusVersion({
      statePath: config.ingestStatePath,
    });
  } catch ( error ) {
    corpusVersion = null;
  }
  const emitMetric = (errorCode = null) => {
    const metric = {
      event: "rag_request",
      requestId: requestId || null,
      retrievalDurationMs,
      evidenceRanking,
      topEvidenceScore,
      providerDurationMs,
      selectedCitationIds,
      corpusVersion,
      abstained,
      abstentionReason,
      scopeCheck,
      errorCode,
    };
    try {
      logger.info(JSON.stringify(metric));
    } catch ( error ) {
      // Observability must not change request behavior.
    }
  };

  try {
    const session = await findSessionById(sessionId);
    ensureViewerCanAccess({ session, userId, clientSessionId });

    if ( session.status !== "ready" ) {
      throw new Error("Session is not ready yet");
    }
    // After the access and readiness checks, so those failures keep their own
    // status codes instead of arriving inside an open stream.
    report?.("status", { stage: "retrieving" });

    const embeddings =
      dependencies.embeddingsClient || createEmbeddingsClient(config);
    const chatModel = dependencies.chatModel || createChatClient(config);
    const rerankClient =
      dependencies.rerankClient === undefined
        ? createRerankClient(config, { retryPolicy })
        : dependencies.rerankClient;
    const retrievalQuestion = buildRetrievalQuestion({
      question,
      sourceTextPreview: session.sourceTextPreview,
      messages: session.messages,
    });
    retrievalStartedAt = clock.now();
    const questionVector = await embeddings.embedQuery(retrievalQuestion);
    const [sessionChunks, knowledgeCandidates] = await Promise.all([
    searchHybridChunksFn({
      config,
      collectionName: config.sessionCollection,
      denseVector: questionVector,
      sparseText: retrievalQuestion,
      limit: config.sessionTopK,
      filter: `session_id == "${sessionId}"`,
      retryPolicy,
    }),
    retrieveKnowledgeCandidates({
      config,
      vector: questionVector,
      question: retrievalQuestion,
      searchHybridChunksFn,
      retryPolicy,
    }),
    ]);
    const ranking = await rankEvidence({
      question: retrievalQuestion,
      chunks: dedupeById([...sessionChunks, ...knowledgeCandidates]),
      rerankClient,
      onRerankError: (error) => {
        try {
          logger.error(
            JSON.stringify({
              event: "rag_rerank_failed",
              requestId: requestId || null,
              errorCode: getStableRagErrorCode(error, "RAG_RERANK_FAILED"),
            }),
          );
        } catch {
          // Observability must not change request behavior.
        }
      },
    });
    retrievalDurationMs = Math.max(0, clock.now() - retrievalStartedAt);
    evidenceRanking = ranking.rankedBy;
    const topChunk = ranking.chunks[0];
    topEvidenceScore = topChunk
      ? Number(
          (ranking.rankedBy === "rerank"
            ? topChunk.rerank_score
            : topChunk.score || 0
          ).toFixed(4),
        )
      : null;
    corpusVersion =
      corpusVersion ||
      knowledgeCandidates.find((chunk) => chunk.corpus_version)?.corpus_version ||
      null;

  const history = session.messages
    .slice(-config.maxHistoryMessages)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");

  const evidence = selectEvidence({ ranking, config });
  // From the floor up to RAG_SCOPE_CHECK_BELOW an out-of-scope question can
  // score as well as an answerable one, so the model first says whether it is
  // about renting at all. It reads what the reranker read: the retrieval
  // question, which carries a follow-up's earlier turn and a clause
  // question's document. A failed check fails the request like a failed
  // answer: abstaining would tell the renter the handbook has nothing.
  if ( needsScopeCheck({ ranking, config }) ) {
    // What the error metric shows if the call throws.
    scopeCheck = "failed";
    providerStartedAt = clock.now();
    const verdict = await streamChatModel({
      config,
      chatModel,
      messages: buildScopeCheckMessages({ question: retrievalQuestion }),
      retryPolicy,
    });
    providerDurationMs += Math.max(0, clock.now() - providerStartedAt);
    providerStartedAt = null;
    scopeCheck = parseScopeVerdict(verdict) ? "in_scope" : "out_of_scope";
  }
  const supportedCitationChunks = scopeCheck === "out_of_scope" ? [] : evidence;
  const candidateCitations =
    supportedCitationChunks.length > 0
      ? supportedCitationChunks.map(buildCitation)
      : [];
  const citationIdToIndex = Object.fromEntries(
    candidateCitations.map((citation, index) => [getEvidenceId(index), index]),
  );
  const messages = buildRagMessages({
    question,
    history,
    supportChunks: supportedCitationChunks,
  });
  let candidateAnswer;
  if ( candidateCitations.length > 0 ) {
    report?.("status", { stage: "generating" });
    const draft = createDraftTracker();
    // Once part of the draft has reached the client, a fresh attempt would not
    // match what it shows, so from then on a failure ends the request. Before
    // that, including when the client left before any text, and always for
    // JSON callers, transient failures are retried.
    let draftShown = false;
    providerStartedAt = clock.now();
    const rawAnswer = await streamChatModel({
      config,
      chatModel,
      messages,
      retryPolicy: { ...retryPolicy, shouldRetry: () => !draftShown },
      onText: report
        ? (text) => {
            for ( const delta of draft.update(text) ) {
              if ( report("delta", delta) ) {
                draftShown = true;
              }
            }
          }
        : undefined,
    });
    providerDurationMs += Math.max(0, clock.now() - providerStartedAt);
    providerStartedAt = null;
    candidateAnswer = normalizeAssistantAnswer({
      rawAnswer,
      citationIdToIndex,
    });
  } else {
    candidateAnswer = buildInsufficientSupportAnswer(
      scopeCheck === "out_of_scope" ? "out_of_scope" : "insufficient_retrieval_support",
    );
  }
  const finalized = finalizeAssistantCitations({
    structuredAnswer: candidateAnswer,
    candidateCitations,
  });
  const structuredAnswer = finalized.structuredAnswer;
  const citations = finalized.citations;
  selectedCitationIds = citations.map((citation) => citation.citationId);
  abstained = citations.length === 0;
  abstentionReason = structuredAnswer.abstentionReason || null;

  const updatedSession = await appendMessages(sessionId, [
    {
      role: "user",
      content: question,
      citations: [],
      createdAt: new Date(),
    },
    {
      role: "assistant",
      content: structuredAnswer.content,
      summary: structuredAnswer.summary,
      summaryCitationIndices: structuredAnswer.summaryCitationIndices,
      bullets: structuredAnswer.bullets,
      citations,
      createdAt: new Date(),
    },
  ]);

    emitMetric();
    return {
      session: updatedSession,
      answer: structuredAnswer.content,
      citations,
    };
  } catch ( error ) {
    if ( retrievalStartedAt !== null && retrievalDurationMs === null ) {
      retrievalDurationMs = Math.max(0, clock.now() - retrievalStartedAt);
    }
    if ( providerStartedAt !== null ) {
      providerDurationMs += Math.max(0, clock.now() - providerStartedAt);
    }
    emitMetric(getStableRagErrorCode(error, "RAG_REQUEST_FAILED"));
    throw error;
  }
};

export const createSessionWithOptionalInitialAnswer = async ({
                                                               userId,
                                                               clientSessionId,
                                                               sourceText,
                                                               file,
                                                               initialQuestion,
                                                               requestId,
                                                               onEvent,
                                                               createSessionFn = createRagSession,
                                                               answerFn = answerQuestion,
                                                               recordActivityFn = createActivity,
                                                               logger = console,
                                                             }) => {
  const session = await createSessionFn({
    userId,
    clientSessionId,
    sourceText,
    file,
    onEvent,
  });
  if ( userId ) {
    try {
      await recordActivityFn(
        buildActivity({
          userId,
          type: "ai_review_created",
          title: "Created an AI review",
          summary: session.sourceName || "Started a new document review",
          href: `/ai-review?session=${session._id.toString()}`,
          surface: "account",
          metadata: {
            sessionId: session._id.toString(),
            sourceKind: session.sourceKind || (file ? "upload" : "text"),
          },
        }),
      );
    } catch ( error ) {
      try {
        logger.error(
          JSON.stringify({
            event: "rag_activity_record_failed",
            requestId: requestId || null,
            errorCode: getStableRagErrorCode(
              error,
              "RAG_ACTIVITY_RECORD_FAILED",
            ),
          }),
        );
      } catch {
        // Observability must not change request behavior.
      }
    }
  }
  const trimmedQuestion = initialQuestion?.trim();
  if ( !trimmedQuestion ) {
    return session;
  }
  try {
    const result = await answerFn({
      sessionId: session._id.toString(),
      userId,
      clientSessionId,
      question: trimmedQuestion,
      requestId,
      onEvent,
    });
    return result.session;
  } catch ( error ) {
    try {
      logger.error(
        JSON.stringify({
          event: "rag_initial_question_failed",
          requestId: requestId || null,
          errorCode: getStableRagErrorCode(
            error,
            "RAG_INITIAL_QUESTION_FAILED",
          ),
        }),
      );
    } catch {
      // Observability must not change request behavior.
    }
    return session;
  }
};

export const loadCorpusManifest = async ({ manifestPath } = {}) => {
  const resolvedManifestPath = manifestPath || getRagConfig().manifestPath;
  const raw = await fs.readFile(resolvedManifestPath, "utf-8");
  return parseManifestCsv(raw);
};

const buildKnowledgeChunkRows = ({
  item,
  documents,
  vectors,
  sourceHash,
  corpusVersion,
}) =>
  documents.map((document, index) => ({
    id: `kb:${corpusVersion.slice(0, 12)}:${sourceHash.slice(0, 12)}:${index}`,
    text: document.pageContent,
    source_name: item.file_name,
    source_group: item.source_group,
    source_type: item.source_type,
    chapter_ref: item.chapter_ref || "",
    file_path: item.file_path,
    source_url: item.source_url || "",
    session_id: "",
    title_hint: item.title_hint || item.file_name,
    priority: item.priority || "",
    source_hash: sourceHash,
    page: String(document.metadata.pageNumber || document.metadata.page || ""),
    section:
      document.metadata.section ||
      item.section ||
      item.title_hint ||
      item.chapter_ref ||
      "",
    corpus_version: corpusVersion,
    embedding: vectors[index],
  }));

const hashBuffer = (buffer) =>
  createHash("sha256").update(buffer).digest("hex");

export const ingestKnowledgeCorpus = async ({
                                              reset = false,
                                              limit = null,
                                            } = {}, dependencies = {}) => {
  const config = dependencies.config || getRagConfig();
  const readFile = dependencies.readFile || fs.readFile;
  const extractPages =
    dependencies.extractCorpusPages ||
    (dependencies.extractTextFromUpload
      ? async (input) => [
          {
            text: await dependencies.extractTextFromUpload(input),
            pageNumber: null,
          },
        ]
      : extractCorpusPages);
  const splitText = dependencies.splitTextToChunks || splitTextToChunks;
  const embeddings =
    dependencies.embeddingsClient || createEmbeddingsClient(config);
  const hasCollection =
    dependencies.hasChunkCollection || hasChunkCollection;
  const insertRows = dependencies.insertChunkRows || insertChunkRows;
  const deleteRows = dependencies.deleteChunkRows || deleteChunkRows;
  const resetCollectionFn = dependencies.resetCollection || resetCollection;
  const flushCollectionFn = dependencies.flushCollection || flushCollection;
  const loadCollectionFn =
    dependencies.ensureCollectionLoaded || ensureCollectionLoaded;
  const getAliasTargetFn = dependencies.getAliasTarget || getAliasTarget;
  const activateAliasFn =
    dependencies.activateCollectionAlias || activateCollectionAlias;
  const listCollectionsFn = dependencies.listCollections || listCollections;
  const readState = dependencies.readIngestState || readIngestState;
  const writeState = dependencies.writeIngestState || writeIngestState;
  const runGate =
    dependencies.runIngestGate ||
    (async ({ config: gateConfig, collectionName: gateCollection }) => {
      const rerankClient = createRerankClient(gateConfig);
      return runRetrievalGate({
        evalCases: await loadGateCases({}),
        collectionName: gateCollection,
        embedQuery: (question) => embeddings.embedQuery(question),
        retrieveChunks: ({ collectionName: target, vector, question }) =>
          retrieveKnowledgeChunks({
            config: gateConfig,
            vector,
            question,
            collectionName: target,
            rerankClient,
          }),
        minHitRate: gateConfig.ingestGateMinHitRate ?? 0.9,
      });
    });

  const manifestContents = await readFile(config.manifestPath, "utf-8");
  const manifest = parseManifestCsv(manifestContents);
  const sourceFiles = await Promise.all(
    manifest.map(async (item) => {
      const absolutePath = path.resolve(config.corpusRoot, item.file_path);
      const buffer = await readFile(absolutePath);
      return {
        item,
        absolutePath,
        buffer,
        sourceHash: hashBuffer(buffer),
      };
    }),
  );
  const identity = buildCorpusIdentity({
    manifestContents,
    sourceHashes: sourceFiles.map(({ sourceHash }) => sourceHash),
    embeddingFingerprint: [
      config.embeddingProvider || "",
      config.embeddingModel || "",
      String(config.embeddingDimension ?? ""),
    ].join(":"),
  });
  const alias = config.knowledgeCollection;
  const collectionName = `${alias}_${identity.corpusVersion.slice(0, 12)}`;
  const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const versionedCollectionPattern = new RegExp(
    `^${escapedAlias}_[a-f0-9]{12}$`,
  );
  const activeCollection = await getAliasTargetFn({ config, alias });
  const previousState = await readState({ statePath: config.ingestStatePath });

  const cleanupInactiveVersions = async (activeState) => {
    const pendingCollections = new Set(
      (activeState.pendingCollections || []).filter(
        (candidate) =>
          versionedCollectionPattern.test(candidate) &&
          candidate !== collectionName,
      ),
    );
    let discoveryFailed = false;
    try {
      const collections = await listCollectionsFn({ config });
      for ( const candidate of collections ) {
        if (
          versionedCollectionPattern.test(candidate) &&
          candidate !== collectionName
        ) {
          pendingCollections.add(candidate);
        }
      }
    } catch ( error ) {
      discoveryFailed = true;
      console.error(
        JSON.stringify({
          event: "rag_ingest_cleanup_discovery_failed",
          errorCode: error?.code || "RAG_INGEST_CLEANUP_FAILED",
        }),
      );
    }

    const failedCollections = [];
    for ( const oldCollection of pendingCollections ) {
      try {
        await resetCollectionFn({ config, collectionName: oldCollection });
      } catch ( error ) {
        failedCollections.push(oldCollection);
        console.error(
          JSON.stringify({
            event: "rag_ingest_cleanup_failed",
            collectionName: oldCollection,
            errorCode: error?.code || "RAG_INGEST_CLEANUP_FAILED",
          }),
        );
      }
    }

    return writeState({
      statePath: config.ingestStatePath,
      state: {
        ...activeState,
        cleanupPending: discoveryFailed || failedCollections.length > 0,
        pendingCollections: failedCollections,
      },
    });
  };

  if (
    activeCollection === collectionName &&
    previousState?.status === "active" &&
    previousState.corpusVersion === identity.corpusVersion
  ) {
    return previousState.cleanupPending === false
      ? previousState
      : cleanupInactiveVersions(previousState);
  }

  if ( activeCollection === collectionName ) {
    const reconstructedState = await writeState({
      statePath: config.ingestStatePath,
      state: {
        status: "active",
        alias,
        collectionName,
        corpusVersion: identity.corpusVersion,
        manifestSha256: identity.manifestSha256,
        manifestPath: config.manifestPath,
        sourceHashes: sourceFiles.map(({ item, sourceHash }) => ({
          filePath: item.file_path,
          sha256: sourceHash,
        })),
        nextIndex: manifest.length,
        lastCompletedFile: manifest.at(-1)?.file_name || null,
        activatedAt: previousState?.activatedAt || new Date().toISOString(),
        reconstructedAt: new Date().toISOString(),
        cleanupPending: true,
        pendingCollections: previousState?.pendingCollections || [],
      },
    });
    return cleanupInactiveVersions(reconstructedState);
  }

  const stagingExists = await hasCollection({
    config,
    collectionName,
  });
  const canResume =
    !reset &&
    stagingExists &&
    previousState?.status === "staging" &&
    previousState.corpusVersion === identity.corpusVersion &&
    previousState.collectionName === collectionName;

  if ( stagingExists && !canResume && activeCollection !== collectionName ) {
    await resetCollectionFn({
      config,
      collectionName,
    });
  }

  let ingestState = previousState;
  if ( !canResume ) {
    ingestState = await writeState({
      statePath: config.ingestStatePath,
      state: {
        status: "staging",
        alias,
        collectionName,
        corpusVersion: identity.corpusVersion,
        manifestSha256: identity.manifestSha256,
        manifestPath: config.manifestPath,
        sourceHashes: sourceFiles.map(({ item, sourceHash }) => ({
          filePath: item.file_path,
          sha256: sourceHash,
        })),
        nextIndex: 0,
        lastCompletedFile: null,
      },
    });
  }

  const startIndex = Math.max(0, ingestState?.nextIndex || 0);
  const endIndex =
    typeof limit === "number" && limit > 0
      ? Math.min(manifest.length, startIndex + limit)
      : manifest.length;

  for ( let index = startIndex; index < endIndex; index += 1 ) {
    const { item, buffer, sourceHash } = sourceFiles[index];
    console.info(
      `[RAG ingest] ${index + 1}/${manifest.length} ${item.file_name}`,
    );

    if ( canResume && index === startIndex ) {
      await loadCollectionFn({ config, collectionName });
      await deleteRows({
        config,
        collectionName,
        filter: `file_path == "${item.file_path.replaceAll('"', '\\"')}"`,
      });
    }

    const pages = await extractPages({
      buffer,
      originalName: item.file_name,
      mimeType: undefined,
    });
    const documents = (
      await Promise.all(
        pages.map(({ text, pageNumber }) =>
          splitText({
            text,
            metadata: {
              sourceName: item.file_name,
              sourceGroup: item.source_group,
              sourceType: item.source_type,
              chapterRef: item.chapter_ref || null,
              filePath: item.file_path,
              titleHint: item.title_hint || item.file_name,
              priority: item.priority || "",
              sourceHash,
              pageNumber,
              section:
                item.section || item.title_hint || item.chapter_ref || "",
            },
            chunkSize: config.chunkSize,
            chunkOverlap: config.chunkOverlap,
          }),
        ),
      )
    ).flat();
    const vectors = await embeddings.embedDocuments(
      documents.map((document) => document.pageContent),
    );
    await insertRows({
      config,
      collectionName,
      rows: buildKnowledgeChunkRows({
        item,
        documents,
        vectors,
        sourceHash,
        corpusVersion: identity.corpusVersion,
      }),
      dimension: vectors[0]?.length || 0,
    });

    ingestState = await writeState({
      statePath: config.ingestStatePath,
      state: {
        ...ingestState,
        nextIndex: index + 1,
        lastCompletedFile: item.file_name,
      },
    });
  }

  if ( endIndex < manifest.length ) {
    return ingestState;
  }

  await flushCollectionFn({ config, collectionName });
  await loadCollectionFn({ config, collectionName });

  let gate = null;
  if ( config.ingestGateEnabled !== false ) {
    gate = await runGate({ config, collectionName });
    console.info(
      JSON.stringify({
        event: "rag_ingest_gate_result",
        collectionName,
        passed: gate.passed,
        hitRate: Number(gate.hitRate.toFixed(4)),
        hits: gate.hits,
        total: gate.total,
      }),
    );

    if ( !gate.passed ) {
      const blockedState = await writeState({
        statePath: config.ingestStatePath,
        state: { ...ingestState, status: "staging", gate },
      });
      console.error(
        JSON.stringify({
          event: "rag_ingest_gate_failed",
          collectionName,
          hitRate: Number(gate.hitRate.toFixed(4)),
          minHitRate: gate.minHitRate,
          misses: gate.misses,
        }),
      );
      const error = new Error(
        `Corpus retrieval gate failed (${gate.hits}/${gate.total} hits, min ${gate.minHitRate}); alias not activated`,
      );
      error.code = "RAG_INGEST_GATE_FAILED";
      error.gate = gate;
      error.state = blockedState;
      throw error;
    }
  }

  await activateAliasFn({ config, alias, collectionName });

  const activeState = await writeState({
    statePath: config.ingestStatePath,
    state: {
      ...ingestState,
      status: "active",
      alias,
      collectionName,
      corpusVersion: identity.corpusVersion,
      manifestSha256: identity.manifestSha256,
      nextIndex: manifest.length,
      gate,
      activatedAt: new Date().toISOString(),
      cleanupPending: true,
      pendingCollections: [],
    },
  });
  return cleanupInactiveVersions(activeState);
};
