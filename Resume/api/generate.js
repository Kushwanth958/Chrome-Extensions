// ============================================================
//  api/generate.js – ResumeNest Vercel Serverless Function
//
//  Deployed to Vercel as a Node.js serverless function.
//  Route: POST /api/generate
//
//  Responsibilities:
//    1. Validate the incoming request body (resumeText + jobDescription).
//    2. Check SHA-256 cache — return cached result if available.
//    3. Call the Anthropic Claude API using the ANTHROPIC_API_KEY
//       environment variable set securely in the Vercel dashboard.
//    4. Cache the result (24-hour TTL) and return it.
//
//  The API key is NEVER exposed to the client. The extension only
//  ever talks to this endpoint, not to Anthropic directly.
//
//  Environment variables required (set in Vercel dashboard):
//    ANTHROPIC_API_KEY  – your Anthropic Claude API key
//
//  Vercel deployment:
//    - Place this file at /api/generate.js in your project root.
//    - Vercel auto-detects files in /api and deploys them as
//      serverless functions with no extra configuration needed.
//    - The function runs on Node.js 18.x runtime by default.
// ============================================================

// ── Constants ─────────────────────────────────────────────────
const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS = 4096;

// ── In-memory response cache (survives Vercel warm starts) ───
// Key: simple hash of (resumeText + jobDescription)
// Value: { data, expiresAt }
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const cache = new Map();

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0; // Convert to 32-bit integer
  }
  return "h_" + Math.abs(hash).toString(36);
}

function getCacheKey(resume, jobDesc) {
  return simpleHash(resume + jobDesc);
}

function getCachedResult(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedResult(key, data) {
  if (cache.size > 200) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now > v.expiresAt) cache.delete(k);
    }
  }
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── Job description cleaner ───────────────────────────────────
function trimJobDescription(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 30 &&
        !/equal opportunity|privacy|terms|cookie|benefits|accommodation|about us/i.test(l)
    )
    .join("\n")
    .slice(0, 6000);
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // ── Handle CORS pre-flight ───────────────────────────────────
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // ── Only accept POST ─────────────────────────────────────────
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  // ── Parse and validate request body ─────────────────────────
  const { resumeText, jobDescription } = req.body ?? {};

  if (typeof resumeText !== "string" || resumeText.trim().length === 0) {
    return res.status(400).json({ error: "Missing or empty `resumeText` field." });
  }

  if (typeof jobDescription !== "string" || jobDescription.trim().length < 50) {
    return res.status(400).json({ error: "Missing or too-short `jobDescription` field." });
  }

  const safeResumeText = resumeText.trim().slice(0, 8000);
  const cleanedJobDescription = trimJobDescription(jobDescription);

  // ── Check cache before calling Claude ────────────────────────
  const cacheKey = getCacheKey(safeResumeText, cleanedJobDescription);
  const cached = getCachedResult(cacheKey);
  if (cached) {
    console.log("[ResumeNest] Cache hit — returning cached result.");
    return res.status(200).json({ ...cached, cached: true });
  }

  // ── Verify the server-side API key ──────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[ResumeNest] ANTHROPIC_API_KEY is not set.");
    return res.status(500).json({ error: "Server configuration error. API key not set." });
  }

  // ── System prompt ────────────────────────────────────────────
  const systemPrompt = `You are an elite executive-level resume strategist and ATS optimization expert with 15+ years of experience placing candidates in competitive technical roles.

Your task is to strategically transform and tailor the candidate's resume to align as closely as possible with the provided job description.

CRITICAL RULES — FOLLOW STRICTLY:

1. FOUNDATION RULE:
The original resume is the only source of truth. You may NOT fabricate companies, job titles, certifications, dates, metrics, or experience that do not exist in the base resume.

2. STRATEGIC REPOSITIONING:
Reposition the candidate's profile to strongly match the target role.
Translate existing experience into language that mirrors the job description.
If the role emphasizes data analysis, present cybersecurity tasks through an analytical lens.
If the role emphasizes engineering, emphasize technical implementation depth.

3. PRIORITIZATION:
Reorder and emphasize skills and accomplishments that are directly relevant to the job description.
Deprioritize or remove content that is unrelated to the target role.

4. KEYWORD MIRRORING:
Extract high-impact keywords, tools, frameworks, and terminology from the job description.
Naturally integrate them using the exact wording when possible.
ATS systems prioritize exact string matches.

5. DEPTH ALIGNMENT:
If the job description mentions:
- statistical methods
- hypothesis testing
- predictive models
- data standards
- scripting
- Splunk
- compliance frameworks
Ensure those themes are explicitly reflected in the resume when supported by the base experience.

6. SENIORITY ALIGNMENT:
Position the candidate at the strongest defensible seniority level based on their experience.
If total years are lower than required, emphasize depth, complexity, scale, and measurable impact.

7. METRICS:
Preserve all existing quantified achievements.
Do NOT invent numbers.
Enhance impact language around measurable results.

8. OUTPUT STRUCTURE:
Generate a professional, ATS-optimized resume in clean plain text format using this structure:

NAME
CONTACT INFORMATION

PROFESSIONAL SUMMARY

SKILLS

EXPERIENCE

LICENSES & CERTIFICATIONS (if applicable)

EDUCATION

9. EVIDENCE-BASED SKILLS:
Skills must not be listed as isolated keywords. Every skill must be clearly supported by demonstrated experience in the Experience section. The Skills section must only reflect capabilities that are evidenced in the candidate’s work history.

10. NO UNSUPPORTED KEYWORDS:
If a job description mentions a skill that cannot be supported by the candidate’s original resume, do not include it. Never fabricate, stretch, or imply unsupported experience.

11. INTERVIEWER VALIDATION TEST:
Before finalizing output, internally verify that if an interviewer asked the candidate to elaborate on every listed skill or bullet point, the candidate could confidently answer based solely on their original resume experience. If not, remove or revise it.

12. ATS OPTIMIZATION REQUIREMENT:
Ensure all critical job description terminology appears naturally in the resume when supported by experience. Use exact phrasing for required tools, systems, and technical skills to maximize ATS matching probability.

13. ATS SCORING OUTPUT REQUIREMENT:
After generating the full tailored resume, append exactly:

ATS_SCORE_JSON:
{
  "score": integer 0-100,
  "matchedKeywords": array of strings,
  "missingKeywords": array of strings,
  "advice": one concise improvement sentence
}

Rules for the ATS block:
- Output the complete resume first.
- Then output ATS_SCORE_JSON on a new line.
- The JSON must be valid.
- No markdown, no extra commentary.

14. FORMAT RULES:
- Use plain text only.
- No markdown.
- No JSON in the resume body.
- Use hyphen (-) for bullet points.
- No commentary before or after the resume (the ATS_SCORE_JSON block is the only permitted addition after the resume).
- No explanations.

15. FINAL CHECK:
The final resume must read as if it was specifically written for THIS exact job — not as a generic resume rewrite.`;

  const userPrompt =
    `CANDIDATE'S ORIGINAL RESUME:\n` +
    `${"─".repeat(60)}\n` +
    `${safeResumeText}\n\n` +
    `JOB DESCRIPTION THEY ARE APPLYING TO:\n` +
    `${"─".repeat(60)}\n` +
    `${cleanedJobDescription}\n\n` +
    `Please produce the tailored resume now, following all rules exactly.`;

  // ── Call the Anthropic Claude API ────────────────────────────
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
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userPrompt }],
          },
        ],
      }),
    });
  } catch (networkErr) {
    console.error("[ResumeNest] Network error calling Anthropic:", networkErr);
    return res.status(502).json({ error: "Could not reach the Anthropic API. Please try again." });
  }

  // ── Handle non-2xx from Claude ───────────────────────────────
  if (!claudeResponse.ok) {
    const errorBody = await claudeResponse.json().catch(() => ({}));
    const detail = errorBody?.error?.message || `HTTP ${claudeResponse.status}`;
    console.error("[ResumeNest] Anthropic API error:", detail);
    return res.status(502).json({ error: `Anthropic API error: ${detail}` });
  }

  // ── Extract and split Claude's response ─────────────────────
  const claudeData = await claudeResponse.json();
  const responseText = claudeData?.content?.[0]?.text?.trim();
  const stopReason = claudeData?.stop_reason;

  console.log("[ResumeNest] Claude stop_reason:", stopReason, "| Response length:", responseText?.length);
  console.log("[ResumeNest] Response preview:", responseText?.slice(0, 200));

  if (stopReason === "max_tokens") {
    console.warn("[ResumeNest] Claude response was TRUNCATED (hit max_tokens limit).");
  }

  if (!responseText) {
    console.error("[ResumeNest] Claude returned empty content:", claudeData);
    return res.status(502).json({ error: "Claude returned an empty response. Please try again." });
  }

  // ── Split resume body from ATS score block ───────────────────
  const ATS_DELIMITER = "ATS_SCORE_JSON:";
  const delimiterIndex = responseText.indexOf(ATS_DELIMITER);

  // If ATS block is missing (truncation), return resume with default score
  // instead of failing the entire request
  if (delimiterIndex === -1) {
    console.warn("[ResumeNest] ATS_SCORE_JSON block missing — returning resume with default score.");
    const defaultAts = {
      score: 0,
      matchedKeywords: [],
      missingKeywords: [],
      advice: "ATS score unavailable — Claude response was truncated. Try again."
    };

    const result = { tailoredResume: responseText, atsScore: defaultAts };
    setCachedResult(cacheKey, result);
    return res.status(200).json(result);
  }

  const tailoredResume = responseText.slice(0, delimiterIndex).trim();
  const rawAtsJson = responseText.slice(delimiterIndex + ATS_DELIMITER.length).trim();

  let atsScore;
  try {
    atsScore = JSON.parse(rawAtsJson);
  } catch (parseErr) {
    console.error("[ResumeNest] Failed to parse ATS_SCORE_JSON:", rawAtsJson);
    return res.status(502).json({ error: "ATS score JSON is invalid. Please try again." });
  }

  // ── Cache the successful result ──────────────────────────────
  const result = { tailoredResume, atsScore };
  setCachedResult(cacheKey, result);
  console.log("[ResumeNest] Result cached. Cache size:", cache.size);

  return res.status(200).json(result);
}
