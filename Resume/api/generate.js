// ============================================================
//  api/generate.js – ResumeAI Vercel Serverless Function
//
//  Deployed to Vercel as a Node.js serverless function.
//  Route: POST /api/generate
//
//  Responsibilities:
//    1. Validate the incoming request body (resume + jobDescription).
//    2. Call the Anthropic Claude API using the ANTHROPIC_API_KEY
//       environment variable set securely in the Vercel dashboard.
//    3. Return the tailored resume text as JSON.
//
//  The API key is NEVER exposed to the client. The extension only
//  ever talks to this endpoint, not to Anthropic directly.
//
//  Environment variables required (set in Vercel dashboard):
//    ANTHROPIC_API_KEY  – your Anthropic secret key (sk-ant-...)
//
//  Vercel deployment:
//    - Place this file at /api/generate.js in your project root.
//    - Vercel auto-detects files in /api and deploys them as
//      serverless functions with no extra configuration needed.
//    - The function runs on Node.js 18.x runtime by default.
// ============================================================

// ── Constants ─────────────────────────────────────────────────
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL      = "claude-sonnet-4-6";   // fast, high-quality
const MAX_TOKENS        = 2048;                   // enough for a full tailored resume
const ATS_MAX_TOKENS    = 512;                    // enough for score + keywords + 1 sentence

// ── CORS headers ──────────────────────────────────────────────
// The extension popup's origin is a chrome-extension:// URL.
// We allow all origins here since the only sensitive operation
// (the API key) lives server-side and is never returned to clients.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace  = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

  const candidate = trimmed.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

// ── Main handler ──────────────────────────────────────────────
// Vercel serverless functions export a default async function
// that receives a Node.js IncomingMessage (req) and ServerResponse (res).
export default async function handler(req, res) {

  // ── Handle CORS pre-flight (OPTIONS) ────────────────────────
  // Browsers and extensions send an OPTIONS request before POST
  // when the origins differ. We respond 204 (No Content) to allow it.
  if (req.method === "OPTIONS") {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }

  // ── Only accept POST ─────────────────────────────────────────
  if (req.method !== "POST") {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  // ── Parse and validate the request body ─────────────────────
  // Vercel automatically parses JSON bodies when Content-Type is
  // application/json, so req.body is already an object.
  const { resume, jobDescription } = req.body ?? {};

  if (!resume || typeof resume !== "string" || resume.trim().length < 50) {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: "Missing or too-short `resume` field in request body." });
  }

  if (!jobDescription || typeof jobDescription !== "string" || jobDescription.trim().length < 50) {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(400).json({ error: "Missing or too-short `jobDescription` field in request body." });
  }

  // ── Verify the server-side API key is present ────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[ResumeAI] ANTHROPIC_API_KEY environment variable is not set.");
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(500).json({ error: "Server configuration error. API key not set." });
  }

  // ── Build the Claude prompt ──────────────────────────────────
  //
  // System prompt:  defines Claude's persona, strict rules, and output format.
  // User message:   injects the candidate's resume + the scraped job description.
  //
  // Design decisions:
  //  - "strict foundation" rule prevents hallucination of fake experience.
  //  - Explicit section order (Summary → Experience → Skills → Education)
  //    ensures consistent, parseable output every time.
  //  - "ATS-optimised" and keyword-mirroring instruction maximises match rate.
  //  - "plain text only" avoids markdown asterisks appearing in downloaded files.

  const systemPrompt = `You are an elite resume writer and ATS (Applicant Tracking System) optimization specialist with 15 years of experience helping candidates land interviews at top companies.

Your task is to rewrite a candidate's resume so it is perfectly tailored to a specific job description.

STRICT RULES — follow every one without exception:
1. FOUNDATION: The candidate's original resume is the strict foundation. Never fabricate, invent, or embellish any experience, company name, job title, date, metric, technology, or credential that does not already appear in their resume.
2. KEYWORDS: Extract the most important skills, tools, and phrases from the job description and mirror their exact wording throughout the resume. ATS systems match exact strings.
3. TRUTHFUL TAILORING: You may reorder bullet points, rephrase accomplishments using stronger verbs, cut irrelevant content, and elevate the most relevant experience — but only using information already present.
4. METRICS: Where the original resume has quantified achievements, preserve and prominently feature them. Do not invent numbers.
5. FORMAT: Output the resume in exactly this order of sections:
   SUMMARY
   EXPERIENCE
   SKILLS
   EDUCATION
6. PLAIN TEXT: Use plain text only. No markdown, no asterisks, no bullet unicode symbols — use a hyphen (-) for bullet points. No JSON. No commentary.
7. LENGTH: Aim for one tight page worth of content. Cut filler phrases (e.g. "responsible for", "worked on"). Every word must earn its place.
8. PROFESSIONAL TONE: Confident, active voice throughout.`;

  const userPrompt =
    `CANDIDATE'S ORIGINAL RESUME:\n` +
    `${"─".repeat(60)}\n` +
    `${resume.trim()}\n\n` +
    `JOB DESCRIPTION THEY ARE APPLYING TO:\n` +
    `${"─".repeat(60)}\n` +
    `${jobDescription.trim()}\n\n` +
    `Please produce the tailored resume now, following all rules exactly.`;

  // ── Call the Anthropic Claude API ───────────────────────────
  // Using the raw fetch API (available in Node 18+) so we don't need
  // to install the @anthropic-ai/sdk package — keeps the function lean.
  let claudeResponse;
  try {
    claudeResponse = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,             // Anthropic uses x-api-key, not Bearer
        "anthropic-version": "2023-06-01",        // required header; locks API contract
      },
      body: JSON.stringify({
        model:      CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system:     systemPrompt,                 // system is a top-level field in Anthropic API
        messages: [
          { role: "user", content: userPrompt }
        ],
      }),
    });
  } catch (networkErr) {
    console.error("[ResumeAI] Network error calling Anthropic:", networkErr);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(502).json({ error: "Could not reach the Anthropic API. Please try again." });
  }

  // ── Handle non-2xx from Anthropic ───────────────────────────
  if (!claudeResponse.ok) {
    const errorBody = await claudeResponse.json().catch(() => ({}));
    const detail    = errorBody?.error?.message || `HTTP ${claudeResponse.status}`;
    console.error("[ResumeAI] Anthropic API error:", detail);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(502).json({ error: `Claude API error: ${detail}` });
  }

  // ── Extract the generated text ───────────────────────────────
  // Anthropic response shape:
  // { content: [ { type: "text", text: "..." } ], ... }
  const claudeData   = await claudeResponse.json();
  const tailoredText = claudeData?.content?.[0]?.text?.trim();

  if (!tailoredText) {
    console.error("[ResumeAI] Anthropic returned empty content:", claudeData);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(502).json({ error: "Claude returned an empty response. Please try again." });
  }

  // ── ATS scoring call (second Claude request) ─────────────────
  const atsSystemPrompt = `You are an ATS (Applicant Tracking System) evaluator.

Compare the tailored resume against the job description and output ONLY a valid JSON object with exactly these fields:
- score: number from 0 to 100 (integer preferred)
- matchedKeywords: array of strings (keywords/skills/phrases present in BOTH resume and job description)
- missingKeywords: array of strings (important keywords/skills/phrases present in the job description but NOT in the resume)
- advice: one sentence string with the most impactful improvement to increase the score

Rules:
- Output JSON only. No markdown. No code fences. No extra keys.
- Keep keyword strings short (1-4 words) and deduplicate.
- If unsure about a keyword match, treat it as missing.`;

  const atsUserPrompt =
    `TAILORED RESUME:\n` +
    `${"─".repeat(60)}\n` +
    `${tailoredText}\n\n` +
    `JOB DESCRIPTION:\n` +
    `${"─".repeat(60)}\n` +
    `${jobDescription.trim()}\n\n` +
    `Return the JSON now.`;

  let atsResponse;
  try {
    atsResponse = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:       CLAUDE_MODEL,
        max_tokens:  ATS_MAX_TOKENS,
        temperature: 0.2,
        system:      atsSystemPrompt,
        messages: [
          { role: "user", content: atsUserPrompt }
        ],
      }),
    });
  } catch (networkErr) {
    console.error("[ResumeAI] Network error calling Anthropic (ATS):", networkErr);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(502).json({ error: "Could not reach the Anthropic API for ATS scoring. Please try again." });
  }

  if (!atsResponse.ok) {
    const errorBody = await atsResponse.json().catch(() => ({}));
    const detail    = errorBody?.error?.message || `HTTP ${atsResponse.status}`;
    console.error("[ResumeAI] Anthropic API ATS error:", detail);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(502).json({ error: `Claude API ATS error: ${detail}` });
  }

  const atsData = await atsResponse.json();
  const atsText = atsData?.content?.[0]?.text?.trim();
  const atsObj  = extractJsonObject(atsText);

  if (!atsObj || typeof atsObj !== "object") {
    console.error("[ResumeAI] ATS scoring returned non-JSON:", { atsText, atsData });
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(502).json({ error: "Claude returned an invalid ATS scoring response. Please try again." });
  }

  const atsScore = {
    score: typeof atsObj.score === "number" ? Math.max(0, Math.min(100, Math.round(atsObj.score))) : 0,
    matchedKeywords: Array.isArray(atsObj.matchedKeywords) ? atsObj.matchedKeywords.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()) : [],
    missingKeywords: Array.isArray(atsObj.missingKeywords) ? atsObj.missingKeywords.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()) : [],
    advice: typeof atsObj.advice === "string" ? atsObj.advice.trim() : "",
  };

  // ── Return tailored resume + ATS result ───────────────────────
  Object.entries({ ...CORS_HEADERS, "Content-Type": "application/json" }).forEach(([k, v]) => res.setHeader(k, v));
  return res.status(200).json({ tailoredResume: tailoredText, atsScore });
}
