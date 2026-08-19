import path from "path";
import fs from "fs/promises";
import { v4 as uuidv4 } from "uuid";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import * as dao from "./dao.js";
import { getRagConfig } from "./config.js";
import {
  buildRagMessages,
  formatEvidenceSourceLabel,
  getEvidenceId,
} from "./prompt.js";
import { runBoundedOperation } from "./operationPolicy.js";
import { createTextPreview, extractTextFromUpload, splitTextToChunks, } from "./text.js";
import { buildKnowledgeSearchPlan, buildRetrievalQuestion, rankKnowledgeChunks, } from "./retrievalPolicy.js";
import {
  hasReliableCitationSupport,
  questionNeedsHandbookSupport,
  selectCitationChunks,
} from "./citationSelection.js";
import {
  deleteChunkRows,
  hasChunkCollection,
  insertChunkRows,
  resetCollection,
  searchHybridChunks,
} from "./milvus.js";
import { clearIngestState, createInitialIngestState, readIngestState, writeIngestState, } from "./ingestState.js";
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

const getMessageText = (message) => {
  if ( typeof message.content === "string" ) {
    return message.content;
  }
  if ( Array.isArray(message.content) ) {
    return message.content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("\n")
      .trim();
  }
  return "";
};

export const postGeminiEmbedding = async ({
                                            config,
                                            text,
                                            taskType,
                                            title,
                                            fetchFn = globalThis.fetch,
                                            retryPolicy,
                                          }) => {
  const requestUrl = `${config.embeddingBaseUrl}/${config.embeddingModel}:embedContent?key=${config.embeddingApiKey}`;

  return runBoundedOperation({
    label: "embedding request",
    timeoutMs: config.embeddingTimeoutMs,
    retryPolicy,
    operation: async (signal) => {
      const response = await fetchFn(requestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: {
            parts: [{ text }],
          },
          taskType,
          title: title || undefined,
          outputDimensionality: config.embeddingDimension,
        }),
        signal,
      });

      let payload;
      try {
        payload = await response.json();
      } catch ( cause ) {
        if ( response.ok ) {
          throw new Error("Gemini embedding response was not valid JSON", {
            cause,
          });
        }
        const error = new Error("Gemini embedding request failed", { cause });
        error.status = response.status;
        throw error;
      }
      if ( response.ok && Array.isArray(payload?.embedding?.values) ) {
        return payload.embedding.values;
      }

      const error = new Error(
        payload?.error?.message || "Gemini embedding request failed",
      );
      if ( !response.ok ) {
        error.status = response.status;
      }
      throw error;
    },
  });
};

const createEmbeddingsClient = (config, dependencies = {}) => ({
  embedDocuments: async (texts) => {
    const vectors = [];
    const batchSize = 8;

    for ( let index = 0; index < texts.length; index += batchSize ) {
      const batch = texts.slice(index, index + batchSize);
      const embeddedBatch = await Promise.all(
        batch.map((text) =>
          postGeminiEmbedding({
            config,
            text,
            taskType: "RETRIEVAL_DOCUMENT",
            ...dependencies,
          }),
        ),
      );
      vectors.push(...embeddedBatch);
    }

    return vectors;
  },
  embedQuery: async (text) =>
    postGeminiEmbedding({
      config,
      text,
      taskType: "RETRIEVAL_QUERY",
      ...dependencies,
    }),
});

export const invokeChatModel = ({
                                  config,
                                  chatModel,
                                  messages,
                                  retryPolicy,
                                }) =>
  runBoundedOperation({
    label: "chat generation",
    timeoutMs: config.chatTimeoutMs,
    retryPolicy,
    operation: (signal) => chatModel.invoke(messages, { signal }),
  });

export const runVectorOperation = ({
                                     config,
                                     label,
                                     operation,
                                     retryPolicy,
                                   }) =>
  runBoundedOperation({
    label,
    timeoutMs: config.vectorTimeoutMs,
    retryPolicy,
    operation,
  });

const createChatClient = (config) => {
  if ( !config.chatApiKey ) {
    throw new Error(
      "RAG_CHAT_API_KEY, GEMINI_CHAT_API_KEY, or GEMINI_API_KEY is not configured",
    );
  }
  return new ChatOpenAI({
    apiKey: config.chatApiKey,
    model: config.chatModel,
    temperature: 0.2,
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
      const bullets = parsed.data.bullets.map((bullet) => ({
        text: cleanSentence(bullet.text),
        citationIndices: normalizeCitationIndices(
          bullet.supports,
          citationIdToIndex,
        ),
      }));

      return {
        summary,
        bullets,
        content: buildAnswerContent({ summary, bullets }),
      };
    }
  } catch ( error ) {
    // Invalid model output follows the deterministic abstention path below.
  }

  return buildInsufficientSupportAnswer();
};

const buildInsufficientSupportAnswer = () => {
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
    bullets,
    content: buildAnswerContent({ summary, bullets }),
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
  const selectedIndices = [
    ...new Set(supportedBullets.flatMap((bullet) => bullet.citationIndices)),
  ];

  if ( selectedIndices.length === 0 ) {
    return {
      structuredAnswer: buildInsufficientSupportAnswer(),
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

export const resolveSupportedCitationChunks = ({
                                                 question,
                                                 citationChunks,
                                                 knowledgeChunks,
                                               }) => {
  const questionNeedsDualSupport = questionNeedsHandbookSupport(question);
  const hasDirectSupport = hasReliableCitationSupport({
    question,
    citationChunks,
  });
  if ( hasDirectSupport ) {
    return citationChunks;
  }

  if ( questionNeedsDualSupport ) {
    return [];
  }

  if ( knowledgeChunks.length > 0 ) {
    return dedupeById([
      ...citationChunks,
      ...rankKnowledgeChunks(question, knowledgeChunks),
    ]).slice(0, 6);
  }

  return [];
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

const getKnowledgeResults = async ({
                                     config,
                                     vector,
                                     question,
                                     searchHybridChunksFn = searchHybridChunks,
                                     retryPolicy,
                                   }) => {
  const searchPlan = buildKnowledgeSearchPlan(question, config);
  const groupedResults = await Promise.all(
    searchPlan.map(({ group, limit, chapterRef }) =>
      runVectorOperation({
        config,
        label: `knowledge vector search (${group})`,
        retryPolicy,
        operation: () =>
          searchHybridChunksFn({
            config,
            collectionName: config.knowledgeCollection,
            denseVector: vector,
            sparseText: question,
            limit,
            filter: chapterRef
              ? `source_group == "${group}" && chapter_ref == "${chapterRef}"`
              : `source_group == "${group}"`,
          }),
      }),
    ),
  );

  return rankKnowledgeChunks(question, dedupeById(groupedResults.flat())).slice(
    0,
    config.knowledgeTopK,
  );
};

export const createRagSession = async ({
                                         userId,
                                         clientSessionId,
                                         sourceText,
                                         file,
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
    await runVectorOperation({
      config,
      label: "session vector insert",
      operation: () =>
        insertChunkRows({
          config,
          collectionName: config.sessionCollection,
          rows: buildChunkRows({
            documents,
            vectors,
            sessionId: session._id.toString(),
          }),
          dimension: vectors[0]?.length || 0,
        }),
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

export const answerQuestion = async ({
                                       sessionId,
                                       userId,
                                       clientSessionId,
                                       question,
                                     }, dependencies = {}) => {
  const config = dependencies.config || getRagConfig();
  const findSessionById = dependencies.findSessionById || dao.findSessionById;
  const appendMessages = dependencies.appendMessages || dao.appendMessages;
  const searchHybridChunksFn =
    dependencies.searchHybridChunks || searchHybridChunks;
  const retryPolicy = dependencies.retryPolicy;
  const session = await findSessionById(sessionId);
  ensureViewerCanAccess({ session, userId, clientSessionId });

  if ( session.status !== "ready" ) {
    throw new Error("Session is not ready yet");
  }

  const embeddings =
    dependencies.embeddingsClient || createEmbeddingsClient(config);
  const chatModel = dependencies.chatModel || createChatClient(config);
  const retrievalQuestion = buildRetrievalQuestion({
    question,
    sourceTextPreview: session.sourceTextPreview,
    messages: session.messages,
  });
  const questionVector = await embeddings.embedQuery(retrievalQuestion);
  const [sessionChunks, knowledgeChunks] = await Promise.all([
    runVectorOperation({
      config,
      label: "session vector search",
      retryPolicy,
      operation: () =>
        searchHybridChunksFn({
          config,
          collectionName: config.sessionCollection,
          denseVector: questionVector,
          sparseText: retrievalQuestion,
          limit: config.sessionTopK,
          filter: `session_id == "${sessionId}"`,
        }),
    }),
    getKnowledgeResults({
      config,
      vector: questionVector,
      question: retrievalQuestion,
      searchHybridChunksFn,
      retryPolicy,
    }),
  ]);

  const history = session.messages
    .slice(-config.maxHistoryMessages)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");

  const citationChunks = selectCitationChunks({
    question,
    sessionChunks,
    knowledgeChunks,
    limit: 6,
  });
  const supportedCitationChunks = resolveSupportedCitationChunks({
    question,
    citationChunks,
    knowledgeChunks,
  });
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
  const candidateAnswer =
    candidateCitations.length > 0
      ? normalizeAssistantAnswer({
        rawAnswer: getMessageText(
          await invokeChatModel({
            config,
            chatModel,
            messages,
            retryPolicy,
          }),
        ),
        citationIdToIndex,
      })
      : buildInsufficientSupportAnswer();
  const finalized = finalizeAssistantCitations({
    structuredAnswer: candidateAnswer,
    candidateCitations,
  });
  const structuredAnswer = finalized.structuredAnswer;
  const citations = finalized.citations;

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
      bullets: structuredAnswer.bullets,
      citations,
      createdAt: new Date(),
    },
  ]);

  return {
    session: updatedSession,
    answer: structuredAnswer.content,
    citations,
  };
};

export const createSessionWithOptionalInitialAnswer = async ({
                                                               userId,
                                                               clientSessionId,
                                                               sourceText,
                                                               file,
                                                               initialQuestion,
                                                               createSessionFn = createRagSession,
                                                               answerFn = answerQuestion,
                                                               recordActivityFn = createActivity,
                                                             }) => {
  const session = await createSessionFn({
    userId,
    clientSessionId,
    sourceText,
    file,
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
      console.error("[RAG] Failed to record ai review activity:", error);
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
    });
    return result.session;
  } catch ( error ) {
    console.error(
      "[RAG] Initial question failed after session creation:",
      error,
    );
    return session;
  }
};

const parseManifestLine = (line) => {
  const values = [];
  let current = "";
  let inQuotes = false;

  for ( let index = 0; index < line.length; index += 1 ) {
    const char = line[index];
    if ( char === '"' ) {
      const nextChar = line[index + 1];
      if ( inQuotes && nextChar === '"' ) {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if ( char === "," && !inQuotes ) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
};

export const loadCorpusManifest = async () => {
  const config = getRagConfig();
  const raw = await fs.readFile(config.manifestPath, "utf-8");
  const [headerLine, ...lines] = raw.split(/\r?\n/).filter(Boolean);
  const headers = parseManifestLine(headerLine);

  return lines.map((line) => {
    const values = parseManifestLine(line);
    return headers.reduce(
      (record, header, index) => ({
        ...record,
        [header]: values[index] || "",
      }),
      {},
    );
  });
};

const buildKnowledgeChunkRows = ({ item, documents, vectors }) =>
  documents.map((document, index) => ({
    id: `kb:${item.file_name}:${index}`,
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
    embedding: vectors[index],
  }));

const buildFreshIngestState = (config) =>
  createInitialIngestState({
    collectionName: config.knowledgeCollection,
    manifestPath: config.manifestPath,
  });

const shouldRestartIngest = ({ state, config, collectionExists, reset }) => {
  if ( reset || !state ) {
    return true;
  }
  if ( !collectionExists ) {
    return true;
  }
  if ( state.collectionName !== config.knowledgeCollection ) {
    return true;
  }
  if ( state.manifestPath !== config.manifestPath ) {
    return true;
  }
  return false;
};

export const ingestKnowledgeCorpus = async ({
                                              reset = false,
                                              limit = null,
                                            } = {}) => {
  const config = getRagConfig();
  const embeddings = createEmbeddingsClient(config);
  const manifest = await loadCorpusManifest();
  const collectionExists = await runVectorOperation({
    config,
    label: "knowledge collection lookup",
    operation: () =>
      hasChunkCollection({
        config,
        collectionName: config.knowledgeCollection,
      }),
  });
  const previousState = await readIngestState({
    statePath: config.ingestStatePath,
  });

  let ingestState = previousState;
  if (
    shouldRestartIngest({
      state: previousState,
      config,
      collectionExists,
      reset,
    })
  ) {
    await runVectorOperation({
      config,
      label: "knowledge collection reset",
      operation: () =>
        resetCollection({
          config,
          collectionName: config.knowledgeCollection,
        }),
    });
    ingestState = await writeIngestState({
      statePath: config.ingestStatePath,
      state: buildFreshIngestState(config),
    });
  }

  const startIndex = Math.max(0, ingestState?.nextIndex || 0);
  const endIndex =
    typeof limit === "number" && limit > 0
      ? Math.min(manifest.length, startIndex + limit)
      : manifest.length;

  for ( let index = startIndex; index < endIndex; index += 1 ) {
    const item = manifest[index];
    console.info(
      `[RAG ingest] ${index + 1}/${manifest.length} ${item.file_name}`,
    );

    await runVectorOperation({
      config,
      label: "knowledge vector delete",
      operation: () =>
        deleteChunkRows({
          config,
          collectionName: config.knowledgeCollection,
          filter: `file_path == "${item.file_path}"`,
        }),
    });

    const absolutePath = path.resolve(config.corpusRoot, item.file_path);
    const text = await extractTextFromUpload({
      buffer: await fs.readFile(absolutePath),
      originalName: item.file_name,
      mimeType: undefined,
    });
    const documents = await splitTextToChunks({
      text,
      metadata: {
        sourceName: item.file_name,
        sourceGroup: item.source_group,
        sourceType: item.source_type,
        chapterRef: item.chapter_ref || null,
        filePath: item.file_path,
        titleHint: item.title_hint || item.file_name,
        priority: item.priority || "",
      },
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
    });
    const vectors = await embeddings.embedDocuments(
      documents.map((document) => document.pageContent),
    );
    await runVectorOperation({
      config,
      label: "knowledge vector insert",
      operation: () =>
        insertChunkRows({
          config,
          collectionName: config.knowledgeCollection,
          rows: buildKnowledgeChunkRows({ item, documents, vectors }),
          dimension: vectors[0]?.length || 0,
        }),
    });

    ingestState = await writeIngestState({
      statePath: config.ingestStatePath,
      state: {
        ...ingestState,
        nextIndex: index + 1,
        lastCompletedFile: item.file_name,
      },
    });
  }

  if ( endIndex >= manifest.length ) {
    await clearIngestState({ statePath: config.ingestStatePath });
  }
};
