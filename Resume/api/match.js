// ============================================================
//  api/match.js – ResumeAI Vercel Serverless Function
//
//  Route: POST /api/match
//
//  Multi-factor Job Match scoring:
//    50% Semantic similarity  (OpenAI embeddings + cosine)
//    30% Keyword coverage     (job keywords found in resume)
//    20% Skill category match (domain categories detected)
//
//  Returns:
//    { matchScore, semanticScore, keywordScore, categoryScore }
//
//  Environment variables required (set in Vercel dashboard):
//    OPENAI_API_KEY  – your OpenAI API key
// ============================================================

// ── Constants ─────────────────────────────────────────────────
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const EMBEDDING_MODEL = "text-embedding-3-small";

// ── Stop words (excluded from keyword extraction) ─────────────
const STOP_WORDS = new Set([
    "about", "above", "after", "again", "against", "also", "been", "before",
    "being", "below", "between", "both", "cannot", "could", "does", "doing",
    "down", "during", "each", "from", "further", "have", "having", "here",
    "into", "just", "like", "more", "most", "must", "only", "other", "over",
    "same", "should", "some", "such", "than", "that", "their", "them", "then",
    "there", "these", "they", "this", "those", "through", "under", "until",
    "very", "want", "well", "were", "what", "when", "where", "which", "while",
    "will", "with", "would", "your", "ability", "able", "work", "working",
    "experience", "required", "preferred", "including", "role", "team",
    "responsibilities", "qualifications", "years", "strong", "knowledge",
    "understanding", "using", "used", "ensure", "support", "provide",
]);

// ── Skill category definitions ────────────────────────────────
// Each category has keywords/phrases that indicate domain coverage.
const SKILL_CATEGORIES = {
    "SOC Operations": [
        "soc", "security operations center", "security operations",
        "siem", "splunk", "qradar", "sentinel", "log analysis",
        "event monitoring", "alert triage", "security analyst",
    ],
    "Incident Response": [
        "incident response", "incident handling", "forensics",
        "digital forensics", "malware analysis", "containment",
        "eradication", "recovery", "breach", "playbook",
        "incident management", "root cause analysis",
    ],
    "Threat Detection": [
        "threat detection", "threat hunting", "threat intelligence",
        "ioc", "indicators of compromise", "mitre att&ck",
        "behavioral analysis", "anomaly detection", "threat modeling",
        "cyber threat", "threat landscape",
    ],
    "Cloud Security": [
        "cloud security", "aws security", "azure security",
        "gcp security", "cloud infrastructure", "iam",
        "identity and access management", "zero trust",
        "cloud compliance", "cspm", "cwpp", "devsecops",
    ],
    "Vulnerability Management": [
        "vulnerability management", "vulnerability assessment",
        "penetration testing", "pen test", "nessus", "qualys",
        "rapid7", "cve", "patch management", "remediation",
        "vulnerability scanning", "risk assessment",
    ],
    "Security Monitoring": [
        "security monitoring", "continuous monitoring",
        "network monitoring", "ids", "ips", "intrusion detection",
        "intrusion prevention", "firewall", "endpoint detection",
        "edr", "ndr", "xdr", "soar",
    ],
};

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

// ── Extract keywords from text ────────────────────────────────
function extractKeywords(text) {
    if (typeof text !== "string") return [];

    const processed = text
        .toLowerCase()
        .replace(/[^\w\s]|_/g, " ");

    const words = processed.split(/\s+/);
    const keywords = new Set();

    for (const word of words) {
        if (word.length > 3 && !STOP_WORDS.has(word)) {
            keywords.add(word);
        }
    }

    return Array.from(keywords);
}

// ── Compute keyword coverage score ────────────────────────────
function computeKeywordCoverage(resumeText, jobDescription) {
    const jobKeywords = extractKeywords(jobDescription);
    const resumeKeywords = new Set(extractKeywords(resumeText));

    if (jobKeywords.length === 0) {
        return { score: 100, matchedSkills: [], missingSkills: [] };
    }

    const matchedSkills = [];
    const missingSkills = [];

    for (const kw of jobKeywords) {
        if (resumeKeywords.has(kw)) {
            matchedSkills.push(kw);
        } else {
            missingSkills.push(kw);
        }
    }

    const score = Math.round((matchedSkills.length / jobKeywords.length) * 100);
    return { score, matchedSkills, missingSkills };
}

// ── Compute skill category match score ────────────────────────
function computeCategoryScore(resumeText) {
    const lowerResume = resumeText.toLowerCase();
    const totalCategories = Object.keys(SKILL_CATEGORIES).length;
    let matchedCategories = 0;

    for (const [, keywords] of Object.entries(SKILL_CATEGORIES)) {
        const found = keywords.some((kw) => lowerResume.includes(kw));
        if (found) matchedCategories++;
    }

    return Math.round((matchedCategories / totalCategories) * 100);
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
    let body = req.body ?? {};
    if (typeof body === "string") {
        try {
            body = JSON.parse(body);
        } catch {
            return res.status(400).json({ error: "Invalid JSON in request body." });
        }
    }

    const { resumeText, jobDescription } = body;

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

    const safeResume = resumeText.trim().slice(0, 8000);
    const safeJob = jobDescription.trim().slice(0, 8000);

    // ── Factor 1: Semantic Similarity (50%) ─────────────────────
    let semanticScore = 0;

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

    if (!embeddingResponse.ok) {
        const errorBody = await embeddingResponse.json().catch(() => ({}));
        const detail = errorBody?.error?.message || `HTTP ${embeddingResponse.status}`;
        console.error("[ResumeAI] OpenAI API error:", detail);
        return res.status(502).json({ error: `OpenAI API error: ${detail}` });
    }

    const embeddingData = await embeddingResponse.json();
    const embeddings = embeddingData?.data;

    if (!embeddings || embeddings.length < 2) {
        console.error("[ResumeAI] Unexpected embeddings response:", embeddingData);
        return res.status(502).json({ error: "Unexpected response from OpenAI embeddings API." });
    }

    const similarity = cosineSimilarity(embeddings[0].embedding, embeddings[1].embedding);
    semanticScore = Math.round(Math.max(0, Math.min(1, similarity)) * 100);

    // ── Factor 2: Keyword Coverage (30%) ────────────────────────
    const keywordResult = computeKeywordCoverage(safeResume, safeJob);
    const keywordScore = keywordResult.score;
    const matchedSkills = keywordResult.matchedSkills;
    const missingSkills = keywordResult.missingSkills;

    // ── Factor 3: Skill Category Match (20%) ────────────────────
    const categoryScore = computeCategoryScore(safeResume);

    // ── Final weighted score ────────────────────────────────────
    const matchScore = Math.round(
        0.5 * semanticScore +
        0.3 * keywordScore +
        0.2 * categoryScore
    );

    console.log("[ResumeAI][match] Scores:", {
        matchScore, semanticScore, keywordScore, categoryScore,
        matchedSkills: matchedSkills.length,
        missingSkills: missingSkills.length,
    });

    return res.status(200).json({
        matchScore,
        semanticScore,
        keywordScore,
        categoryScore,
        matchedSkills,
        missingSkills,
    });
}
