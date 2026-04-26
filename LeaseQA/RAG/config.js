import path from "path";
import { getGeminiChatConfig } from "../shared/geminiOpenAI.js";

const parseInteger = (value, fallback) => {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const requireEnv = (name) => {
  const value = process.env[name];
  if ( !value ) {
    throw new Error(`${name} is not configured`);
  }
  return value;
};

export const getRagConfig = () => {
  const chat = getGeminiChatConfig();

  return {
    chatApiKey: chat.apiKey,
    chatModel: chat.model,
    chatBaseUrl: chat.baseURL,
    corpusRoot:
      process.env.RAG_CORPUS_ROOT ||
      path.resolve(process.cwd(), "../source/mass tenant rights"),
    manifestPath:
      process.env.RAG_CORPUS_MANIFEST ||
      path.resolve(
        process.env.RAG_CORPUS_ROOT ||
        path.resolve(process.cwd(), "../source/mass tenant rights"),
        "corpus_manifest.csv",
      ),
    ingestStatePath:
      process.env.RAG_INGEST_STATE_PATH ||
      path.resolve(process.cwd(), ".rag-knowledge-ingest-state.json"),
    sessionCollection:
      process.env.RAG_MILVUS_SESSION_COLLECTION || "leaseqa_session_chunks",
    knowledgeCollection:
      process.env.RAG_MILVUS_KNOWLEDGE_COLLECTION || "leaseqa_knowledge_chunks",
    milvusAddress: requireEnv("RAG_MILVUS_ADDRESS"),
    milvusToken: process.env.RAG_MILVUS_TOKEN || "",
    embeddingApiKey:
      process.env.GEMINI_API_KEY ||
      process.env.RAG_EMBEDDING_API_KEY ||
      requireEnv("GEMINI_API_KEY"),
    embeddingModel: process.env.RAG_EMBEDDING_MODEL || "gemini-embedding-001",
    embeddingBaseUrl:
      process.env.RAG_EMBEDDING_BASE_URL ||
      "https://generativelanguage.googleapis.com/v1beta/models",
    embeddingDimension: parseInteger(process.env.RAG_EMBEDDING_DIMENSION, 768),
    chunkSize: parseInteger(process.env.RAG_CHUNK_SIZE, 1200),
    chunkOverlap: parseInteger(process.env.RAG_CHUNK_OVERLAP, 200),
    knowledgeTopK: parseInteger(process.env.RAG_KNOWLEDGE_TOP_K, 8),
    sessionTopK: parseInteger(process.env.RAG_SESSION_TOP_K, 6),
    uploadFileSizeBytes: parseInteger(
      process.env.RAG_UPLOAD_MAX_BYTES,
      12 * 1024 * 1024,
    ),
    maxHistoryMessages: parseInteger(process.env.RAG_HISTORY_MESSAGES, 6),
  };
};
