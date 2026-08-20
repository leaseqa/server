import { existsSync } from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
import {
  DASHSCOPE_COMPATIBLE_BASE_URL,
  DASHSCOPE_DEFAULT_EMBEDDING_DIMENSION,
  DASHSCOPE_DEFAULT_EMBEDDING_MODEL,
  GEMINI_DEFAULT_EMBEDDING_DIMENSION,
  GEMINI_DEFAULT_EMBEDDING_MODEL,
  GEMINI_EMBEDDING_BASE_URL,
  getRagChatConfig,
} from "../shared/geminiOpenAI.js";

const serverRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const CORPUS_RELATIVE_PATH = path.join(
  "resources",
  "rag-corpus",
  "mass tenant rights",
);

const parseInteger = (value, fallback) => {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parsePositiveInteger = (value, fallback) => {
  const parsed = parseInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
};

const requireEnv = (name) => {
  const value = process.env[name];
  if ( !value ) {
    throw new Error(`${name} is not configured`);
  }
  return value;
};

const firstConfigured = (names) => {
  for ( const name of names ) {
    const value = process.env[name];
    if ( value ) {
      return value;
    }
  }
  return "";
};

const requireFirstEnv = (names) => {
  const value = firstConfigured(names);
  if ( !value ) {
    throw new Error(`${names.join(", ")} is not configured`);
  }
  return value;
};

const resolveEmbeddingProvider = (value) => {
  const provider = String(value || "openai").toLowerCase();
  return provider === "gemini" ? "gemini" : "openai";
};

export const resolveCorpusRoot = ({
  env = process.env,
  serverRoot: providedServerRoot = serverRoot,
  existsFn = existsSync,
} = {}) => {
  if ( env.RAG_CORPUS_ROOT ) {
    return path.resolve(env.RAG_CORPUS_ROOT);
  }

  let current = path.resolve(providedServerRoot);
  while ( true ) {
    const parent = path.dirname(current);
    const candidate = path.join(parent, CORPUS_RELATIVE_PATH);
    if ( existsFn(candidate) ) {
      return candidate;
    }
    if ( parent === current ) {
      break;
    }
    current = parent;
  }

  return path.resolve(providedServerRoot, "..", CORPUS_RELATIVE_PATH);
};

export const getRagConfig = () => {
  const chat = getRagChatConfig();
  const corpusRoot = resolveCorpusRoot();
  const embeddingProvider = resolveEmbeddingProvider(
    process.env.RAG_EMBEDDING_PROVIDER,
  );
  const embeddingUsesGemini = embeddingProvider === "gemini";

  return {
    chatApiKey: chat.apiKey,
    chatModel: chat.model,
    chatBaseUrl: chat.baseURL,
    corpusRoot,
    manifestPath:
      process.env.RAG_CORPUS_MANIFEST ||
      path.resolve(corpusRoot, "corpus_manifest.csv"),
    ingestStatePath:
      process.env.RAG_INGEST_STATE_PATH ||
      path.resolve(process.cwd(), ".rag-knowledge-ingest-state.json"),
    sessionCollection:
      process.env.RAG_MILVUS_SESSION_COLLECTION || "leaseqa_session_chunks",
    knowledgeCollection:
      process.env.RAG_MILVUS_KNOWLEDGE_COLLECTION || "leaseqa_knowledge_chunks",
    milvusAddress: requireEnv("RAG_MILVUS_ADDRESS"),
    milvusToken: process.env.RAG_MILVUS_TOKEN || "",
    embeddingProvider,
    embeddingApiKey: requireFirstEnv([
      "RAG_EMBEDDING_API_KEY",
      "DASHSCOPE_API_KEY",
      "RAG_CHAT_API_KEY",
      "GEMINI_API_KEY",
      "GEMINI_CHAT_API_KEY",
    ]),
    embeddingModel:
      process.env.RAG_EMBEDDING_MODEL ||
      (embeddingUsesGemini
        ? GEMINI_DEFAULT_EMBEDDING_MODEL
        : DASHSCOPE_DEFAULT_EMBEDDING_MODEL),
    embeddingBaseUrl:
      process.env.RAG_EMBEDDING_BASE_URL ||
      (embeddingUsesGemini
        ? GEMINI_EMBEDDING_BASE_URL
        : DASHSCOPE_COMPATIBLE_BASE_URL),
    embeddingDimension: parseInteger(
      process.env.RAG_EMBEDDING_DIMENSIONS ||
        process.env.RAG_EMBEDDING_DIMENSION,
      embeddingUsesGemini
        ? GEMINI_DEFAULT_EMBEDDING_DIMENSION
        : DASHSCOPE_DEFAULT_EMBEDDING_DIMENSION,
    ),
    chunkSize: parseInteger(process.env.RAG_CHUNK_SIZE, 1200),
    chunkOverlap: parseInteger(process.env.RAG_CHUNK_OVERLAP, 200),
    knowledgeTopK: parseInteger(process.env.RAG_KNOWLEDGE_TOP_K, 8),
    sessionTopK: parseInteger(process.env.RAG_SESSION_TOP_K, 6),
    uploadFileSizeBytes: parseInteger(
      process.env.RAG_UPLOAD_MAX_BYTES,
      12 * 1024 * 1024,
    ),
    maxHistoryMessages: parseInteger(process.env.RAG_HISTORY_MESSAGES, 6),
    embeddingTimeoutMs: parsePositiveInteger(
      process.env.RAG_EMBEDDING_TIMEOUT_MS,
      15_000,
    ),
    chatTimeoutMs: parsePositiveInteger(process.env.RAG_CHAT_TIMEOUT_MS, 45_000),
    vectorTimeoutMs: parsePositiveInteger(
      process.env.RAG_VECTOR_TIMEOUT_MS,
      10_000,
    ),
  };
};
