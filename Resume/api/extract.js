// ============================================================
//  api/extract.js – ResumeNest Vercel Serverless Function
//
//  Route: POST /api/extract
//
//  Accepts { rawText: string } — the full visible text of any page.
//  Sends it to Claude and asks it to extract only the job description.
//  Returns { jobDescription: string } or { error: string }.
//
//  This replaces all DOM heuristics — Claude understands context
//  and works on any site without selectors.
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

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: "Server configuration error. API key not set." });
    }

    // Trim raw text to avoid huge token bills — 12000 chars is plenty for any page
    const trimmedText = rawText.trim().slice(0, 12000);

    const systemPrompt = `You are a precise data extraction assistant. Your only job is to extract job description content from raw webpage text.

Extract and return ONLY:
- Job title
- Location / work arrangement (remote, hybrid, onsite)
- Job responsibilities / what you'll do
- Requirements / qualifications / must-have skills
- Preferred / nice-to-have skills
- Any compensation or benefits if listed

Rules:
- Return ONLY the extracted job description content, nothing else
- Do NOT include: company "About Us" paragraphs, marketing copy, navigation text, cookie banners, footer text, "Get Job Alerts", social media links, or any boilerplate
- Do NOT add any commentary, preamble, or explanation
- If the page does not contain a job description, return exactly: NOT_A_JOB_PAGE
- Preserve the original wording — do not paraphrase or summarize
- Keep section headers if they exist (e.g. "Responsibilities:", "Requirements:")`;

    const userPrompt = `Extract the job description from this webpage text:\n\n${trimmedText}`;

    let claudeResponse;
    try {
        claudeResponse = await fetch(ANTHROPIC_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: ANTHROPIC_MODEL,
                max_tokens: MAX_TOKENS,
                system: systemPrompt,
                messages: [{ role: "user", content: userPrompt }],
            }),
        });
    } catch (networkErr) {
        console.error("[ResumeNest/extract] Network error:", networkErr);
        return res.status(502).json({ error: "Could not reach the Anthropic API." });
    }

    if (!claudeResponse.ok) {
        const errorBody = await claudeResponse.json().catch(() => ({}));
        const detail = errorBody?.error?.message || `HTTP ${claudeResponse.status}`;
        console.error("[ResumeNest/extract] Anthropic error:", detail);
        return res.status(502).json({ error: `Anthropic API error: ${detail}` });
    }

    const claudeData = await claudeResponse.json();
    const extracted = claudeData?.content?.[0]?.text?.trim();

    if (!extracted) {
        return res.status(502).json({ error: "Claude returned an empty response." });
    }

    if (extracted === "NOT_A_JOB_PAGE") {
        return res.status(200).json({ jobDescription: null, isJobPage: false });
    }

    return res.status(200).json({ jobDescription: extracted, isJobPage: true });
}
