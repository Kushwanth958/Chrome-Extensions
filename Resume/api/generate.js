// ============================================================
//  api/generate.js – ResumeAI Vercel Serverless Function
//
//  Deployed to Vercel as a Node.js serverless function.
//  Route: POST /api/generate
//
//  Responsibilities:
//    1. Validate the incoming request body (resumeText + jobDescription).
//    2. Call the Anthropic Claude API using the ANTHROPIC_API_KEY
//       environment variable set securely in the Vercel dashboard.
//    3. Return the tailored resume as plain text wrapped in JSON:
//       { tailoredResume: "..." }
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
const MAX_TOKENS = 2048;

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

  // ── Verify the server-side API key ──────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[ResumeAI] ANTHROPIC_API_KEY is not set.");
    return res.status(500).json({ error: "Server configuration error. API key not set." });
  }

  // ── System prompt ────────────────────────────────────────────
  const systemPrompt = `You are an elite resume writer and ATS (Applicant Tracking System) optimization specialist with 15 years of experience helping candidates land interviews at top companies.

Your task is to rewrite a candidate's resume so it is perfectly tailored to a specific job description.

STRICT RULES — follow every one without exception:
1. FOUNDATION: The candidate's original resume is the strict foundation. Never fabricate, invent, or embellish any experience, company name, job title, date, metric, technology, or credential that does not already appear in their resume.
2. KEYWORDS: Extract the most important skills, tools, and phrases from the job description and mirror their exact wording throughout the resume. ATS systems match exact strings.
3. TRUTHFUL TAILORING: You may reorder bullet points, rephrase accomplishments using stronger verbs, cut irrelevant content, and elevate the most relevant experience — but only using information already present.
4. METRICS: Where the original resume has quantified achievements, preserve and prominently feature them. Do not invent numbers.
5. SECTIONS: Output the resume using these standard sections (omit any that are not applicable):
   Name
   Contact Information
   Professional Summary
   Skills
   Experience
   Education
   Certifications
   Projects
6. PLAIN TEXT: Use plain text only. No markdown, no asterisks, no bullet unicode symbols — use a hyphen (-) for bullet points.
7. LENGTH: Aim for one tight page worth of content. Cut filler phrases (e.g. "responsible for", "worked on"). Every word must earn its place.
8. PROFESSIONAL TONE: Confident, active voice throughout.

Output ONLY the tailored resume as plain text. No JSON. No commentary. No code fences.`;

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
    console.error("[ResumeAI] Network error calling Anthropic:", networkErr);
    return res.status(502).json({ error: "Could not reach the Anthropic API. Please try again." });
  }

  // ── Handle non-2xx from Claude ───────────────────────────────
  if (!claudeResponse.ok) {
    const errorBody = await claudeResponse.json().catch(() => ({}));
    const detail = errorBody?.error?.message || `HTTP ${claudeResponse.status}`;
    console.error("[ResumeAI] Anthropic API error:", detail);
    return res.status(502).json({ error: `Anthropic API error: ${detail}` });
  }

  // ── Extract plain-text response ──────────────────────────────
  const claudeData = await claudeResponse.json();
  const responseText = claudeData?.content?.[0]?.text?.trim();

  if (!responseText) {
    console.error("[ResumeAI] Claude returned empty content:", claudeData);
    return res.status(502).json({ error: "Claude returned an empty response. Please try again." });
  }

  return res.status(200).json({ tailoredResume: responseText });
}
