import { existsSync } from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
import {
  fingerprintEmbeddingProvider,
  getRagChatConfig,
  getRagProvider,
  getRagRerankConfig,
} from "../shared/ragProviders.js";

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

const parseNumber = (value, fallback) => {
  const parsed = Number.parseFloat(value || "");
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseRate = (value, fallback) => {
  const parsed = Number.parseFloat(value || "");
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
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

export const resolveCorpusRoot = ({
  env = process.env,
  serverRoot: providedServerRoot = serverRoot,
  existsFn = existsSync,
} = {}) => {
  if ( env.RAG_CORPUS_ROOT ) {
    return path.resolve(env.RAG_CORPUS_ROOT);
  }

  // The corpus is committed inside this repository, so the checkout itself is
  // the first candidate. Testing only the parents would silently resolve to a
  // stale workspace-level copy and ingest the wrong bytes.
  let current = path.resolve(providedServerRoot);
  while ( true ) {
    const candidate = path.join(current, CORPUS_RELATIVE_PATH);
    if ( existsFn(candidate) ) {
      return candidate;
    }
    const parent = path.dirname(current);
    if ( parent === current ) {
      break;
    }
    current = parent;
  }

  return path.resolve(providedServerRoot, CORPUS_RELATIVE_PATH);
};

export const getRagConfig = () => {
  const provider = getRagProvider();
  const chat = getRagChatConfig();
  const rerank = getRagRerankConfig();
  const corpusRoot = resolveCorpusRoot();

  return {
    ragProvider: provider.id,
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
    embeddingProvider: fingerprintEmbeddingProvider(provider.id),
    embeddingTransport: provider.embeddingTransport,
    embeddingPath: provider.embeddingPath,
    embeddingApiKey: requireFirstEnv(provider.embeddingApiKeyEnv),
    embeddingModel:
      process.env.RAG_EMBEDDING_MODEL || provider.embeddingModel,
    embeddingBaseUrl:
      process.env.RAG_EMBEDDING_BASE_URL || provider.embeddingBaseUrl,
    embeddingDimension: parseInteger(
      process.env.RAG_EMBEDDING_DIMENSIONS ||
        process.env.RAG_EMBEDDING_DIMENSION,
      provider.embeddingDimension,
    ),
    chunkSize: parseInteger(process.env.RAG_CHUNK_SIZE, 1200),
    chunkOverlap: parseInteger(process.env.RAG_CHUNK_OVERLAP, 200),
    // Candidates fetched from each corpus source group before ranking. The
    // reranker sees every one of them, so this sets recall, not answer length.
    candidatesPerGroup: parsePositiveInteger(
      process.env.RAG_CANDIDATES_PER_GROUP,
      10,
    ),
    evidenceLimit: parsePositiveInteger(process.env.RAG_EVIDENCE_LIMIT, 6),
    rerankEnabled: rerank.enabled,
    rerankBaseUrl: rerank.baseURL,
    rerankModel: rerank.model,
    rerankApiKey: rerank.apiKey,
    rerankRawScores: rerank.rawScores,
    rerankTimeoutMs: parsePositiveInteger(
      process.env.RAG_RERANK_TIMEOUT_MS,
      15_000,
    ),
    // On the reranker's own scale: a 0-1 relevance score, or zhipu's raw logit.
    minRerankScore: parseNumber(
      process.env.RAG_MIN_RERANK_SCORE,
      rerank.minScore,
    ),
    ingestGateEnabled: process.env.RAG_INGEST_GATE !== "off",
    ingestGateMinHitRate: parseRate(
      process.env.RAG_INGEST_GATE_MIN_HIT_RATE,
      0.9,
    ),
    sessionTopK: parseInteger(process.env.RAG_SESSION_TOP_K, 6),
    minSupportScore: parseRate(process.env.RAG_MIN_SUPPORT_SCORE, 0.025),
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
