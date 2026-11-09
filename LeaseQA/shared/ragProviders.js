export const DASHSCOPE_COMPATIBLE_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DASHSCOPE_DEFAULT_CHAT_MODEL = "qwen-plus";
export const DASHSCOPE_DEFAULT_EMBEDDING_MODEL = "text-embedding-v3";
export const DASHSCOPE_DEFAULT_EMBEDDING_DIMENSION = 1024;

export const ARK_COMPATIBLE_BASE_URL =
  "https://ark.cn-beijing.volces.com/api/plan/v3";
export const ARK_DEFAULT_CHAT_MODEL = "doubao-seed-2.0-lite";
export const ARK_DEFAULT_EMBEDDING_MODEL = "doubao-embedding-vision";
export const ARK_DEFAULT_EMBEDDING_DIMENSION = 1024;

// Zhipu BigModel (open.bigmodel.cn). glm-5.3-flash always thinks; the reasoning
// comes back in reasoning_content, separate from the JSON answer in content.
// embedding-3 defaults to 2048-d, so the 1024 here is load-bearing: it is what
// the Milvus collections were created with.
export const ZHIPU_COMPATIBLE_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
export const ZHIPU_DEFAULT_CHAT_MODEL = "glm-5.3-flash";
export const ZHIPU_DEFAULT_EMBEDDING_MODEL = "embedding-3";
export const ZHIPU_DEFAULT_EMBEDDING_DIMENSION = 1024;
export const ZHIPU_DEFAULT_RERANK_MODEL = "rerank";
// BigModel's normalized relevance_score is the sigmoid of a logit that runs
// from about 8 to 23 on this corpus, so every candidate scores 0.9993 or more
// and they tie. The raw logit keeps the order, so zhipu ranks and abstains on
// it. Both bounds come from scripts/report-rag-retrieval.js on the 61-case
// eval set (2026-11-09, 20 candidates per group). The best chunk scored
// 15.3-23.6 for answerable questions, 11.8-16.2 for out-of-scope ones and 14.9
// for the tenant question the handbook cannot support, so no single floor
// separates them. Below the floor, midway between 14.9 and 15.3, the answer
// abstains. From the floor up to the bound, which clears the strongest
// out-of-scope score by more than a point, the chat model first says whether
// the question is about renting in Massachusetts at all.
export const ZHIPU_DEFAULT_MIN_RERANK_SCORE = 15.1;
export const ZHIPU_DEFAULT_SCOPE_CHECK_BELOW = 17.5;

const firstConfigured = (env, names) => {
  for ( const name of names ) {
    const value = env[name];
    if ( value ) {
      return value;
    }
  }
  return "";
};

// All providers speak the OpenAI-compatible interface. Each preset only
// supplies default base URLs, models, and key-resolution order; every field
// can be overridden per-request via RAG_CHAT_* / RAG_EMBEDDING_* env vars.
export const RAG_PROVIDERS = {
  dashscope: {
    id: "dashscope",
    aliases: ["aliyun", "qwen", "openai"],
    embeddingTransport: "openai",
    embeddingPath: "embeddings",
    chatBaseUrl: DASHSCOPE_COMPATIBLE_BASE_URL,
    chatModel: DASHSCOPE_DEFAULT_CHAT_MODEL,
    embeddingBaseUrl: DASHSCOPE_COMPATIBLE_BASE_URL,
    embeddingModel: DASHSCOPE_DEFAULT_EMBEDDING_MODEL,
    embeddingDimension: DASHSCOPE_DEFAULT_EMBEDDING_DIMENSION,
    apiKeyEnv: ["RAG_CHAT_API_KEY", "DASHSCOPE_API_KEY", "ARK_API_KEY"],
    embeddingApiKeyEnv: [
      "RAG_EMBEDDING_API_KEY",
      "DASHSCOPE_API_KEY",
      "ARK_API_KEY",
      "RAG_CHAT_API_KEY",
    ],
  },
  ark: {
    id: "ark",
    aliases: ["volc", "volcengine", "doubao", "huoshan"],
    embeddingTransport: "openai",
    embeddingPath: "embeddings/multimodal",
    chatBaseUrl: ARK_COMPATIBLE_BASE_URL,
    chatModel: ARK_DEFAULT_CHAT_MODEL,
    embeddingBaseUrl: ARK_COMPATIBLE_BASE_URL,
    embeddingModel: ARK_DEFAULT_EMBEDDING_MODEL,
    embeddingDimension: ARK_DEFAULT_EMBEDDING_DIMENSION,
    apiKeyEnv: ["RAG_CHAT_API_KEY", "ARK_API_KEY", "DASHSCOPE_API_KEY"],
    embeddingApiKeyEnv: [
      "RAG_EMBEDDING_API_KEY",
      "ARK_API_KEY",
      "DASHSCOPE_API_KEY",
      "RAG_CHAT_API_KEY",
    ],
  },
  zhipu: {
    id: "zhipu",
    aliases: ["zhipuai", "bigmodel", "glm"],
    embeddingTransport: "openai",
    embeddingPath: "embeddings",
    chatBaseUrl: ZHIPU_COMPATIBLE_BASE_URL,
    chatModel: ZHIPU_DEFAULT_CHAT_MODEL,
    embeddingBaseUrl: ZHIPU_COMPATIBLE_BASE_URL,
    embeddingModel: ZHIPU_DEFAULT_EMBEDDING_MODEL,
    embeddingDimension: ZHIPU_DEFAULT_EMBEDDING_DIMENSION,
    // Deliberately no fallback to ARK_API_KEY or DASHSCOPE_API_KEY: those stay
    // set in production after a switch, and a BigModel request signed with
    // either one fails authentication.
    apiKeyEnv: ["RAG_CHAT_API_KEY", "ZHIPU_API_KEY"],
    embeddingApiKeyEnv: ["RAG_EMBEDDING_API_KEY", "ZHIPU_API_KEY", "RAG_CHAT_API_KEY"],
    rerankBaseUrl: ZHIPU_COMPATIBLE_BASE_URL,
    rerankModel: ZHIPU_DEFAULT_RERANK_MODEL,
    rerankRawScores: true,
    rerankMinScore: ZHIPU_DEFAULT_MIN_RERANK_SCORE,
    rerankScopeCheckBelow: ZHIPU_DEFAULT_SCOPE_CHECK_BELOW,
    rerankApiKeyEnv: ["RAG_RERANK_API_KEY", "ZHIPU_API_KEY", "RAG_CHAT_API_KEY"],
  },
};

const PROVIDER_BY_ALIAS = Object.fromEntries(
  Object.values(RAG_PROVIDERS).flatMap((provider) => [
    [provider.id, provider.id],
    ...provider.aliases.map((alias) => [alias, provider.id]),
  ]),
);

const inferProviderId = (env = {}) => {
  const base = `${env.RAG_CHAT_BASE_URL || ""} ${env.RAG_EMBEDDING_BASE_URL || ""}`;
  if ( /volces\.com/i.test(base) ) {
    return "ark";
  }
  if ( /bigmodel\.cn/i.test(base) ) {
    return "zhipu";
  }
  return "dashscope";
};

export const resolveRagProviderId = (env = process.env) => {
  const requested = String(
    env.RAG_PROVIDER || env.RAG_EMBEDDING_PROVIDER || "",
  ).toLowerCase();
  if ( requested && PROVIDER_BY_ALIAS[requested] ) {
    return PROVIDER_BY_ALIAS[requested];
  }
  return inferProviderId(env);
};

export const getRagProvider = (env = process.env) =>
  RAG_PROVIDERS[resolveRagProviderId(env)];

export const getRagChatConfig = (env = process.env) => {
  const provider = getRagProvider(env);
  return {
    providerId: provider.id,
    apiKey: firstConfigured(env, provider.apiKeyEnv),
    model: env.RAG_CHAT_MODEL || provider.chatModel,
    baseURL: env.RAG_CHAT_BASE_URL || provider.chatBaseUrl,
  };
};

// Only the Zhipu preset ships a reranker. Any provider can still use one by
// setting RAG_RERANK_BASE_URL and RAG_RERANK_MODEL for a service with the
// common POST {base}/rerank shape (BigModel, Jina and Cohere all use it).
// RAG_RERANK=off falls back to the hybrid search's own fused order.
export const getRagRerankConfig = (env = process.env) => {
  const provider = getRagProvider(env);
  const baseURL = env.RAG_RERANK_BASE_URL || provider.rerankBaseUrl || "";
  const model = env.RAG_RERANK_MODEL || provider.rerankModel || "";
  return {
    enabled: env.RAG_RERANK !== "off" && Boolean(baseURL && model),
    baseURL,
    model,
    rawScores: env.RAG_RERANK_RAW_SCORES
      ? env.RAG_RERANK_RAW_SCORES === "true"
      : Boolean(provider.rerankRawScores),
    // A 0-1 relevance score's floor unless the preset knows its scale.
    minScore: provider.rerankMinScore ?? 0.5,
    // No scope-check band unless the preset measured one on its scale.
    scopeCheckBelow: provider.rerankScopeCheckBelow ?? null,
    apiKey: firstConfigured(
      env,
      provider.rerankApiKeyEnv || ["RAG_RERANK_API_KEY", ...provider.apiKeyEnv],
    ),
  };
};

// Label used only for corpus versioning (changing embedding vector space
// forces a re-ingest). DashScope, Ark and Zhipu are all OpenAI-compatible in
// transport but produce different vectors, so they keep distinct labels.
export const fingerprintEmbeddingProvider = (providerId) =>
  providerId === "dashscope" ? "openai" : providerId;
