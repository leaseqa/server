import path from "path";
import fs from "fs/promises";
import { v4 as uuidv4 } from "uuid";
import { ChatOpenAI } from "@langchain/openai";
import * as dao from "./dao.js";
import { getRagConfig } from "./config.js";
import {
  createTextPreview,
  extractTextFromUpload,
  splitTextToChunks,
} from "./text.js";
import {
  buildRetrievalQuestion,
  buildKnowledgeSearchPlan,
  rankKnowledgeChunks,
} from "./retrievalPolicy.js";
import {
  hasReliableCitationSupport,
  selectCitationChunks,
} from "./citationSelection.js";
import {
  deleteChunkRows,
  hasChunkCollection,
  insertChunkRows,
  resetCollection,
  searchHybridChunks,
} from "./milvus.js";
import {
  clearIngestState,
  createInitialIngestState,
  readIngestState,
  writeIngestState,
} from "./ingestState.js";

const dedupeById = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
};

const sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const getMessageText = (message) => {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("\n")
      .trim();
  }
  return "";
};

const postGeminiEmbedding = async ({ config, text, taskType, title }) => {
  const requestUrl = `${config.embeddingBaseUrl}/${config.embeddingModel}:embedContent?key=${config.embeddingApiKey}`;
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(requestUrl, {
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
    });

    const payload = await response.json();
    if (response.ok && Array.isArray(payload?.embedding?.values)) {
      return payload.embedding.values;
    }

    const errorMessage =
      payload?.error?.message || "Gemini embedding request failed";
    const shouldRetry =
      response.status === 429 || response.status >= 500 || !response.ok;

    if (!shouldRetry || attempt === maxAttempts) {
      throw new Error(errorMessage);
    }

    await sleep(500 * 2 ** (attempt - 1));
  }
};

const createEmbeddingsClient = (config) => ({
  embedDocuments: async (texts) => {
    const vectors = [];
    const batchSize = 8;

    for (let index = 0; index < texts.length; index += batchSize) {
      const batch = texts.slice(index, index + batchSize);
      const embeddedBatch = await Promise.all(
        batch.map((text) =>
          postGeminiEmbedding({
            config,
            text,
            taskType: "RETRIEVAL_DOCUMENT",
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
    }),
});

const createChatClient = (config) => {
  if (!config.chatApiKey) {
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

const formatContextBlock = (chunks) =>
  chunks
    .map(
      (chunk, index) =>
        `[${index + 1}] ${chunk.source_name} | group=${chunk.source_group} | chapter=${chunk.chapter_ref || "n/a"}\n${chunk.text}`,
    )
    .join("\n\n");

const buildPrompt = ({ question, history, sessionChunks, knowledgeChunks }) =>
  `
You are LeaseQA. Answer in simple, direct language for a low-reading-level user.
Use only the supplied context. If the context is insufficient, say that clearly.
Do not present yourself as a lawyer. Do not claim certainty beyond the sources.
Prefer the tenant-rights knowledge base when it directly answers the question.
If the uploaded document changes the answer, explain that difference plainly.

Recent conversation:
${history || "None"}

Uploaded document context:
${sessionChunks.length > 0 ? formatContextBlock(sessionChunks) : "None"}

Tenant-rights knowledge base context:
${knowledgeChunks.length > 0 ? formatContextBlock(knowledgeChunks) : "None"}

User question:
${question}

Respond with:
1. A short answer.
2. Key reasons or steps.
3. A one-sentence disclaimer that this is legal information, not legal advice.
`.trim();

const buildInsufficientSupportAnswer = () =>
  [
    "1. I could not find enough support in the uploaded document or the tenant-rights materials to answer that reliably.",
    "2. Please ask a narrower question, quote the specific lease clause, or upload more of the relevant document.",
    "3. This is legal information, not legal advice.",
  ].join("\n\n");

const ensureViewerCanAccess = ({ session, userId, clientSessionId }) => {
  if (!session) {
    throw new Error("Session not found");
  }
  if (session.userId) {
    if (!userId || session.userId.toString() !== userId.toString()) {
      throw new Error("You do not have access to this session");
    }
    return;
  }
  if (session.clientSessionId !== clientSessionId) {
    throw new Error("You do not have access to this session");
  }
};

const getKnowledgeResults = async ({ config, vector, question }) => {
  const searchPlan = buildKnowledgeSearchPlan(question, config);
  const groupedResults = await Promise.all(
    searchPlan.map(({ group, limit, chapterRef }) =>
      searchHybridChunks({
        config,
        collectionName: config.knowledgeCollection,
        denseVector: vector,
        sparseText: question,
        limit,
        filter: chapterRef
          ? `source_group == "${group}" && chapter_ref == "${chapterRef}"`
          : `source_group == "${group}"`,
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
  } catch (error) {
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
}) => {
  const config = getRagConfig();
  const session = await dao.findSessionById(sessionId);
  ensureViewerCanAccess({ session, userId, clientSessionId });

  if (session.status !== "ready") {
    throw new Error("Session is not ready yet");
  }

  const embeddings = createEmbeddingsClient(config);
  const chatModel = createChatClient(config);
  const retrievalQuestion = buildRetrievalQuestion({
    question,
    sourceTextPreview: session.sourceTextPreview,
    messages: session.messages,
  });
  const questionVector = await embeddings.embedQuery(retrievalQuestion);
  const [sessionChunks, knowledgeChunks] = await Promise.all([
    searchHybridChunks({
      config,
      collectionName: config.sessionCollection,
      denseVector: questionVector,
      sparseText: retrievalQuestion,
      limit: config.sessionTopK,
      filter: `session_id == "${sessionId}"`,
    }),
    getKnowledgeResults({
      config,
      vector: questionVector,
      question: retrievalQuestion,
    }),
  ]);

  const history = session.messages
    .slice(-config.maxHistoryMessages)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");

  const prompt = buildPrompt({
    question,
    history,
    sessionChunks,
    knowledgeChunks,
  });

  const citationChunks = selectCitationChunks({
    question,
    sessionChunks,
    knowledgeChunks,
    limit: 6,
  });
  const hasReliableSupport = hasReliableCitationSupport({
    question,
    citationChunks,
  });
  const answer = hasReliableSupport
    ? getMessageText(await chatModel.invoke(prompt))
    : buildInsufficientSupportAnswer();
  const citations = hasReliableSupport ? citationChunks.map(buildCitation) : [];

  const updatedSession = await dao.appendMessages(sessionId, [
    {
      role: "user",
      content: question,
      citations: [],
      createdAt: new Date(),
    },
    {
      role: "assistant",
      content: answer,
      citations,
      createdAt: new Date(),
    },
  ]);

  return {
    session: updatedSession,
    answer,
    citations,
  };
};

const parseManifestLine = (line) => {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      const nextChar = line[index + 1];
      if (inQuotes && nextChar === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
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
  if (reset || !state) {
    return true;
  }
  if (!collectionExists) {
    return true;
  }
  if (state.collectionName !== config.knowledgeCollection) {
    return true;
  }
  if (state.manifestPath !== config.manifestPath) {
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
  const collectionExists = await hasChunkCollection({
    config,
    collectionName: config.knowledgeCollection,
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
    await resetCollection({ config, collectionName: config.knowledgeCollection });
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

  for (let index = startIndex; index < endIndex; index += 1) {
    const item = manifest[index];
    console.info(
      `[RAG ingest] ${index + 1}/${manifest.length} ${item.file_name}`,
    );

    await deleteChunkRows({
      config,
      collectionName: config.knowledgeCollection,
      filter: `file_path == "${item.file_path}"`,
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
    await insertChunkRows({
      config,
      collectionName: config.knowledgeCollection,
      rows: buildKnowledgeChunkRows({ item, documents, vectors }),
      dimension: vectors[0]?.length || 0,
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

  if (endIndex >= manifest.length) {
    await clearIngestState({ statePath: config.ingestStatePath });
  }
};
