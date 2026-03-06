// ============================================================
//  api/extract.js – ResumeNest Vercel Serverless Function
//
//  Route: POST /api/extract
//
//  Accepts { rawText: string } — full visible text of any page.
//  Uses Gemini 2.0 Flash (free tier) to extract the job description.
//  Returns { jobDescription: string, isJobPage: bool }
//
//  Environment variable required (Vercel dashboard):
//    GEMINI_API_KEY  — from aistudio.google.com
// ============================================================

const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_OUTPUT_TOKENS = 2048;

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed. Use POST." });
    }

    const { rawText } = req.body ?? {};

    if (typeof rawText !== "string" || rawText.trim().length < 100) {
        return res.status(400).json({ error: "Missing or too-short `rawText` field." });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: "Server configuration error. GEMINI_API_KEY not set." });
    }

    const trimmedText = rawText.trim().slice(0, 12000);

    const prompt = `You are a precise data extraction assistant. Extract ONLY the job description content from the webpage text below.

Return ONLY these sections if present:
- Job title
- Location / work arrangement (remote, hybrid, onsite)
- Responsibilities / what you'll do
- Requirements / qualifications / must-have skills
- Preferred / nice-to-have skills
- Compensation or benefits (if listed)

Rules:
- Return ONLY the extracted job description, nothing else
- Do NOT include: company "About Us" text, marketing copy, navigation, cookie banners, footer, "Get Job Alerts", or any boilerplate
- Do NOT add commentary, preamble, or explanation
- If the page has no job description, return exactly: NOT_A_JOB_PAGE
- Preserve original wording — do not paraphrase
- Keep section headers if they exist (e.g. "Responsibilities:", "Requirements:")

Webpage text:
${trimmedText}`;

    let geminiResponse;
    try {
        geminiResponse = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    maxOutputTokens: MAX_OUTPUT_TOKENS,
                    temperature: 0.1,
                },
            }),
        });
    } catch (networkErr) {
        console.error("[ResumeNest/extract] Network error calling Gemini:", networkErr);
        return res.status(502).json({ error: "Could not reach the Gemini API." });
    }

    if (!geminiResponse.ok) {
        const errorBody = await geminiResponse.json().catch(() => ({}));
        const detail = errorBody?.error?.message || `HTTP ${geminiResponse.status}`;
        console.error("[ResumeNest/extract] Gemini API error:", detail);
        return res.status(502).json({ error: `Gemini API error: ${detail}` });
    }

    const geminiData = await geminiResponse.json();
    const extracted = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!extracted) {
        console.error("[ResumeNest/extract] Gemini returned empty response:", geminiData);
        return res.status(502).json({ error: "Gemini returned an empty response." });
    }

    if (extracted === "NOT_A_JOB_PAGE") {
        return res.status(200).json({ jobDescription: null, isJobPage: false });
    }

    return res.status(200).json({ jobDescription: extracted, isJobPage: true });
}