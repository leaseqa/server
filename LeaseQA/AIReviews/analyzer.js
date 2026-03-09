import OpenAI from "openai";
import { getGeminiChatConfig } from "../shared/geminiOpenAI.js";

const parseModelJson = (rawText) => {
    try {
        // Find the first '{' and the last '}'
        const firstOpen = rawText.indexOf('{');
        const lastClose = rawText.lastIndexOf('}');

        if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
            const jsonCandidate = rawText.substring(firstOpen, lastClose + 1);
            return JSON.parse(jsonCandidate);
        }
        return null;
    } catch {
        return null;
    }
};

export const analyzeContractText = async (text) => {
    const { apiKey, model, baseURL } = getGeminiChatConfig();
    if (!apiKey) {
        throw new Error("Missing Gemini chat API key. Please set RAG_CHAT_API_KEY, GEMINI_CHAT_API_KEY, or GEMINI_API_KEY.");
    }

    const openai = new OpenAI({
        baseURL,
        apiKey: apiKey,
    });

    const prompt = `You are a lease risk analyst. Return JSON in the exact format:
{
  "summary": "one-line summary",
  "highRisk": ["..."],
  "mediumRisk": ["..."],
  "lowRisk": ["..."],
  "recommendations": ["..."]
}
Strictly output valid JSON only. No markdown formatting. No trailing commas. Lease content:
${text.slice(0, 12000)}
`.trim();

    try {
        const completion = await openai.chat.completions.create({
            model,
            messages: [
                {
                    role: "system",
                    content: "You are a lease risk analyst. Always return valid JSON in the specified format."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            temperature: 0.3,
            max_tokens: 2000,
        });

        const rawText = completion.choices[0]?.message?.content || "";
        const parsed = parseModelJson(rawText);
        if (parsed) {
            return {
                summary: parsed.summary || "Analysis complete.",
                highRisk: parsed.highRisk || [],
                mediumRisk: parsed.mediumRisk || [],
                lowRisk: parsed.lowRisk || [],
                recommendations: parsed.recommendations || [],
            };
        }
        
        // Fallback if parsing absolutely failed
        return {
            summary: rawText || "No summary returned.",
            highRisk: [],
            mediumRisk: [],
            lowRisk: [],
            recommendations: [],
        };
    } catch (error) {
        const message = error?.message || `Gemini API request failed`;
        throw new Error(message);
    }
};
