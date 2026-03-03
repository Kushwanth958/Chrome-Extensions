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

9. FORMAT RULES:
- Use plain text only.
- No markdown.
- No JSON.
- Use hyphen (-) for bullet points.
- No commentary before or after the resume.
- No explanations.

10. FINAL CHECK:
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
