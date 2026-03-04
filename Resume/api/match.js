// ============================================================
//  api/match.js – ResumeAI Vercel Serverless Function
//
//  Route: POST /api/match
//
//  Computes semantic similarity between a resume and a job
//  description using OpenAI embedding vectors + cosine similarity.
//
//  Returns: { "matchScore": number }   (0–100 percentage)
//
//  Environment variables required (set in Vercel dashboard):
//    OPENAI_API_KEY  – your OpenAI API key
// ============================================================

// ── Constants ─────────────────────────────────────────────────
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const EMBEDDING_MODEL = "text-embedding-3-small";

// ── Cosine similarity (pure JS, no deps) ──────────────────────
function cosineSimilarity(vecA, vecB) {
    let dot = 0;
    let magA = 0;
    let magB = 0;

    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        magA += vecA[i] * vecA[i];
        magB += vecB[i] * vecB[i];
    }

    magA = Math.sqrt(magA);
    magB = Math.sqrt(magB);

    if (magA === 0 || magB === 0) return 0;

    return dot / (magA * magB);
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
    // ── CORS headers ────────────────────────────────────────────
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    // ── Handle CORS pre-flight ──────────────────────────────────
    if (req.method === "OPTIONS") {
        return res.status(204).end();
    }

    // ── Only accept POST ────────────────────────────────────────
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed. Use POST." });
    }

    // ── Parse and validate request body ─────────────────────────
    const { resumeText, jobDescription } = req.body ?? {};

    if (typeof resumeText !== "string" || resumeText.trim().length === 0) {
        return res.status(400).json({ error: "Missing or empty `resumeText` field." });
    }

    if (typeof jobDescription !== "string" || jobDescription.trim().length === 0) {
        return res.status(400).json({ error: "Missing or empty `jobDescription` field." });
    }

    // ── Verify the server-side API key ──────────────────────────
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error("[ResumeAI] OPENAI_API_KEY is not set.");
        return res.status(500).json({ error: "Server configuration error. API key not set." });
    }

    // Trim inputs to keep token usage low
    const safeResume = resumeText.trim().slice(0, 8000);
    const safeJob = jobDescription.trim().slice(0, 8000);

    // ── Call OpenAI Embeddings API (batch of 2) ─────────────────
    let embeddingResponse;
    try {
        embeddingResponse = await fetch(OPENAI_EMBEDDINGS_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: EMBEDDING_MODEL,
                input: [safeResume, safeJob],
            }),
        });
    } catch (networkErr) {
        console.error("[ResumeAI] Network error calling OpenAI:", networkErr);
        return res.status(502).json({ error: "Could not reach the OpenAI API. Please try again." });
    }

    // ── Handle non-2xx from OpenAI ──────────────────────────────
    if (!embeddingResponse.ok) {
        const errorBody = await embeddingResponse.json().catch(() => ({}));
        const detail = errorBody?.error?.message || `HTTP ${embeddingResponse.status}`;
        console.error("[ResumeAI] OpenAI API error:", detail);
        return res.status(502).json({ error: `OpenAI API error: ${detail}` });
    }

    // ── Extract embedding vectors ───────────────────────────────
    const embeddingData = await embeddingResponse.json();
    const embeddings = embeddingData?.data;

    if (!embeddings || embeddings.length < 2) {
        console.error("[ResumeAI] Unexpected embeddings response:", embeddingData);
        return res.status(502).json({ error: "Unexpected response from OpenAI embeddings API." });
    }

    const resumeVec = embeddings[0].embedding;
    const jobVec = embeddings[1].embedding;

    // ── Compute cosine similarity and convert to percentage ─────
    const similarity = cosineSimilarity(resumeVec, jobVec);
    const matchScore = Math.round(Math.max(0, Math.min(1, similarity)) * 100);

    return res.status(200).json({ matchScore });
}
