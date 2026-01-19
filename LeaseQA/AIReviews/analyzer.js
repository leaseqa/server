import OpenAI from "openai";

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
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        throw new Error("Missing DEEPSEEK_API_KEY environment variable. Please add it to your .env file.");
    }

    const openai = new OpenAI({
        baseURL: 'https://api.deepseek.com',
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
            model: "deepseek-chat",
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
        const message = error?.message || `DeepSeek API request failed`;
        throw new Error(message);
    }
};
