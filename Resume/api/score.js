// ============================================================
//  api/score.js – ResumeNest Vercel Serverless Function
//
//  Route: POST /api/score
//
//  Accepts { resumeText: string, jobDescription: string }
//  Runs ATS scoring entirely in JS (no extra deps).
//  Returns { score, breakdown } — score is 0-100.
// ============================================================

// ── Stop-word list (common English words that aren't skills) ──
const STOP_WORDS = new Set([
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
    "by", "from", "up", "about", "into", "through", "during", "before", "after",
    "above", "below", "between", "each", "few", "more", "most", "other", "some",
    "such", "no", "not", "only", "same", "so", "than", "too", "very", "can", "will",
    "just", "should", "now", "also", "both", "its", "this", "that", "these", "those",
    "are", "was", "were", "is", "be", "been", "being", "have", "has", "had", "do", "does",
    "did", "would", "could", "may", "might", "shall", "which", "who", "whom", "how",
    "all", "any", "been", "being", "her", "him", "his", "she", "he", "they", "their",
    "we", "our", "you", "your", "my", "me", "us", "it", "as", "if", "what", "when",
    "where", "why", "then", "there", "here", "have", "been", "get", "make", "use",
    "work", "per", "via", "etc", "well", "new", "high", "strong", "good", "able",
    "team", "based", "role", "join", "help", "work", "years", "year", "time", "day",
]);

// ── Section heading patterns (for completeness check) ─────────
const SECTION_PATTERNS = {
    Summary: /\b(summary|objective|profile|about me|professional summary)\b/i,
    Experience: /\b(experience|work history|employment|career|positions?)\b/i,
    Skills: /\b(skills?|technical skills?|competenc|expertise|technologies)\b/i,
    Education: /\b(education|degree|university|college|academic|qualification)\b/i,
};

// ── Helpers ───────────────────────────────────────────────────
function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9#+.\-\s]/g, " ")
        .split(/\s+/)
        .filter(t => t.length >= 3 && !STOP_WORDS.has(t));
}

function countWords(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
}

// ── Scoring sub-functions ─────────────────────────────────────
function scoreKeywords(resumeLower, jobDesc) {
    const jobTokens = tokenize(jobDesc);
    if (!jobTokens.length) return { score: 0, max: 50, matched: 0, total: 0, keywords: [] };

    // Deduplicate, keep up to 60 most relevant tokens
    const unique = [...new Set(jobTokens)].slice(0, 60);
    const matched = unique.filter(kw => resumeLower.includes(kw));

    const raw = matched.length / unique.length;
    return {
        score: Math.round(raw * 50),
        max: 50,
        matched: matched.length,
        total: unique.length,
        keywords: matched.slice(0, 10), // top 10 for display
    };
}

function scoreSections(resumeText) {
    const found = [];
    for (const [name, pattern] of Object.entries(SECTION_PATTERNS)) {
        if (pattern.test(resumeText)) found.push(name);
    }
    return {
        score: found.length * 5,
        max: 20,
        found,
    };
}

function scoreAchievements(resumeText) {
    // Split into lines, count lines with numbers or % symbols
    const lines = resumeText.split(/\n/);
    const bulletLines = lines.filter(l => /^[\s•\-\*]/.test(l) || l.trim().startsWith("-"));
    const withNumbers = bulletLines.filter(l => /\d+(%|\+|x|\s*million|\s*billion|\s*k\b)?/i.test(l));
    const count = withNumbers.length;
    return {
        score: Math.min(count, 5) * 2,
        max: 10,
        quantifiedLines: count,
    };
}

function scoreLength(resumeText) {
    const words = countWords(resumeText);
    let score;
    if (words >= 400 && words <= 800) score = 5;
    else if ((words >= 200 && words < 400) || (words > 800 && words <= 1200)) score = 3;
    else score = 1;
    return { score, max: 5, wordCount: words };
}

// ── Normalise raw score out of 85 → 100 ──────────────────────
// Max raw = 50 + 20 + 10 + 5 = 85
function normalize(raw) {
    return Math.min(100, Math.round((raw / 85) * 100));
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed. Use POST." });
    }

    const { resumeText, jobDescription } = req.body ?? {};

    if (typeof resumeText !== "string" || resumeText.trim().length < 50) {
        return res.status(400).json({ error: "Missing or too-short `resumeText`." });
    }
    if (typeof jobDescription !== "string" || jobDescription.trim().length < 50) {
        return res.status(400).json({ error: "Missing or too-short `jobDescription`." });
    }

    const resumeLower = resumeText.toLowerCase();

    const keywords = scoreKeywords(resumeLower, jobDescription);
    const sections = scoreSections(resumeText);
    const achievements = scoreAchievements(resumeText);
    const length = scoreLength(resumeText);

    const rawTotal = keywords.score + sections.score + achievements.score + length.score;
    const score = normalize(rawTotal);

    return res.status(200).json({
        score,
        breakdown: { keywords, sections, achievements, length },
    });
}
