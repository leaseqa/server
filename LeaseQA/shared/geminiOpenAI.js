export const GEMINI_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/";

export const getGeminiChatConfig = (env = process.env) => ({
  apiKey:
    env.RAG_CHAT_API_KEY || env.GEMINI_CHAT_API_KEY || env.GEMINI_API_KEY || "",
  model: env.RAG_CHAT_MODEL || env.GEMINI_CHAT_MODEL || "gemini-2.5-pro",
  baseURL:
    env.RAG_CHAT_BASE_URL ||
    env.GEMINI_CHAT_BASE_URL ||
    GEMINI_OPENAI_BASE_URL,
});
