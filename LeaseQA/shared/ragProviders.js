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

export const GEMINI_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/";
export const GEMINI_EMBEDDING_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";
export const GEMINI_DEFAULT_CHAT_MODEL = "gemini-2.5-pro";
export const GEMINI_DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
export const GEMINI_DEFAULT_EMBEDDING_DIMENSION = 768;

const firstConfigured = (env, names) => {
  for ( const name of names ) {
    const value = env[name];
    if ( value ) {
      return value;
    }
  }
  return "";
};

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
    apiKeyEnv: [
      "RAG_CHAT_API_KEY",
      "DASHSCOPE_API_KEY",
      "ARK_API_KEY",
      "GEMINI_CHAT_API_KEY",
      "GEMINI_API_KEY",
    ],
    embeddingApiKeyEnv: [
      "RAG_EMBEDDING_API_KEY",
      "DASHSCOPE_API_KEY",
      "ARK_API_KEY",
      "RAG_CHAT_API_KEY",
      "GEMINI_API_KEY",
      "GEMINI_CHAT_API_KEY",
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
    apiKeyEnv: [
      "RAG_CHAT_API_KEY",
      "ARK_API_KEY",
      "DASHSCOPE_API_KEY",
      "GEMINI_CHAT_API_KEY",
      "GEMINI_API_KEY",
    ],
    embeddingApiKeyEnv: [
      "RAG_EMBEDDING_API_KEY",
      "ARK_API_KEY",
      "DASHSCOPE_API_KEY",
      "RAG_CHAT_API_KEY",
      "GEMINI_API_KEY",
      "GEMINI_CHAT_API_KEY",
    ],
  },
  gemini: {
    id: "gemini",
    aliases: [],
    embeddingTransport: "gemini",
    embeddingPath: "",
    chatBaseUrl: GEMINI_OPENAI_BASE_URL,
    chatModel: GEMINI_DEFAULT_CHAT_MODEL,
    embeddingBaseUrl: GEMINI_EMBEDDING_BASE_URL,
    embeddingModel: GEMINI_DEFAULT_EMBEDDING_MODEL,
    embeddingDimension: GEMINI_DEFAULT_EMBEDDING_DIMENSION,
    apiKeyEnv: [
      "RAG_CHAT_API_KEY",
      "GEMINI_CHAT_API_KEY",
      "GEMINI_API_KEY",
      "ARK_API_KEY",
      "DASHSCOPE_API_KEY",
    ],
    embeddingApiKeyEnv: [
      "RAG_EMBEDDING_API_KEY",
      "GEMINI_API_KEY",
      "GEMINI_CHAT_API_KEY",
      "ARK_API_KEY",
      "DASHSCOPE_API_KEY",
    ],
  },
};

const PROVIDER_BY_ALIAS = Object.fromEntries(
  Object.values(RAG_PROVIDERS).flatMap((provider) => [
    [provider.id, provider.id],
    ...provider.aliases.map((alias) => [alias, provider.id]),
  ]),
);

const inferProviderId = (env = {}) => {
  const base = `${env.RAG_CHAT_BASE_URL || ""} ${env.RAG_EMBEDDING_BASE_URL || ""} ${env.GEMINI_CHAT_BASE_URL || ""}`;
  if ( /volces\.com/i.test(base) ) {
    return "ark";
  }
  if ( /googleapis\.com/i.test(base) ) {
    return "gemini";
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
    model:
      env.RAG_CHAT_MODEL || env.GEMINI_CHAT_MODEL || provider.chatModel,
    baseURL:
      env.RAG_CHAT_BASE_URL ||
      env.GEMINI_CHAT_BASE_URL ||
      provider.chatBaseUrl,
  };
};

export const getGeminiChatConfig = getRagChatConfig;

export const fingerprintEmbeddingProvider = (providerId) =>
  providerId === "dashscope" ? "openai" : providerId;
