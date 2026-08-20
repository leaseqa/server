export const DASHSCOPE_COMPATIBLE_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DASHSCOPE_DEFAULT_CHAT_MODEL = "qwen-plus";
export const DASHSCOPE_DEFAULT_EMBEDDING_MODEL = "text-embedding-v3";
export const DASHSCOPE_DEFAULT_EMBEDDING_DIMENSION = 1024;

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

export const getRagChatConfig = (env = process.env) => ({
  apiKey: firstConfigured(env, [
    "RAG_CHAT_API_KEY",
    "DASHSCOPE_API_KEY",
    "GEMINI_CHAT_API_KEY",
    "GEMINI_API_KEY",
  ]),
  model:
    env.RAG_CHAT_MODEL ||
    env.GEMINI_CHAT_MODEL ||
    DASHSCOPE_DEFAULT_CHAT_MODEL,
  baseURL:
    env.RAG_CHAT_BASE_URL ||
    env.GEMINI_CHAT_BASE_URL ||
    DASHSCOPE_COMPATIBLE_BASE_URL,
});

export const getGeminiChatConfig = getRagChatConfig;
