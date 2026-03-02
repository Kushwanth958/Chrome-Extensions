// ============================================================
//  api/generate.js – ResumeAI Vercel Serverless Function
//
//  Deployed to Vercel as a Node.js serverless function.
//  Route: POST /api/generate
//
//  Responsibilities:
//    1. Validate the incoming request body (resume + jobDescription).
//    2. Parse the uploaded resume file (PDF/DOCX/TXT) into plain text.
//    3. Call the Anthropic Claude API using the ANTHROPIC_API_KEY
//       environment variable set securely in the Vercel dashboard.
//    4. Return the tailored resume text as JSON.
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

// import pdf from "pdf-parse";
// import mammoth from "mammoth";

// ── Constants ─────────────────────────────────────────────────
const ANTHROPIC_MODEL   = "claude-sonnet-4-6";           // Anthropic Claude model
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TOKENS        = 2500;                          // upper bound for structured JSON resume

function trimJobDescription(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 30 &&
        !/equal opportunity|privacy|terms|cookie|benefits|accommodation|about us/i.test(
          l
        )
    )
    .join("\n")
    .slice(0, 6000); // hard cap characters
}

// ── CORS headers ──────────────────────────────────────────────
// The extension popup's origin is a chrome-extension:// URL.
// We allow all origins here since the only sensitive operation
// (the API key) lives server-side and is never returned to clients.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function extractResumeText(fileObj) {
  if (!fileObj || typeof fileObj !== "object") {
    throw new Error("Invalid resume payload.");
  }

  const fileName = typeof fileObj.fileName === "string" ? fileObj.fileName : "";
  const base64 = typeof fileObj.base64 === "string" ? fileObj.base64 : "";

  if (!fileName || !base64) {
    throw new Error("Invalid resume payload.");
  }

  const buffer = Buffer.from(base64, "base64");
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith(".pdf")) {
    const parsed = await pdf(buffer);
    return parsed.text || "";
  }

  if (lowerName.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  if (lowerName.endsWith(".txt")) {
    return buffer.toString("utf8");
  }

  throw new Error("Unsupported file format.");
}

// ── Main handler ──────────────────────────────────────────────
// Vercel serverless functions export a default async function
// that receives a Node.js IncomingMessage (req) and ServerResponse (res).
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // ── Handle CORS pre-flight (OPTIONS) ────────────────────────
  // Browsers and extensions send an OPTIONS request before POST
  // when the origins differ. We respond 204 (No Content) to allow it.
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // ── Only accept POST ─────────────────────────────────────────
  if (req.method !== "POST") {
    return res
      .status(405)
      .json({ error: "Method not allowed. Use POST." });
  }

  // ── Parse and validate the request body ─────────────────────
  // Vercel automatically parses JSON bodies when Content-Type is
  // application/json, so req.body is already an object.
  const { resumeText: resumeTextRaw, resume, jobDescription } = req.body ?? {};

  const hasResumeText =
    typeof resumeTextRaw === "string" && resumeTextRaw.trim().length > 0;
  const hasResumeFileObject = resume && typeof resume === "object";

  if (!jobDescription || typeof jobDescription !== "string" || jobDescription.trim().length < 50) {
    return res
      .status(400)
      .json({ error: "Missing or too-short `jobDescription` field in request body." });
  }

  const cleanedJobDescription = trimJobDescription(jobDescription);

  let resumeText;
  try {
    if (hasResumeText) {
      resumeText = resumeTextRaw;
    } else if (hasResumeFileObject) {
      // Backwards compatibility for older clients that still send base64.
      resumeText = await extractResumeText(resume);
    } else {
      return res
        .status(400)
        .json({
          error:
            "Missing resume content. Provide `resumeText` (plain text) or a legacy `resume` file object.",
        });
    }
  } catch (err) {
    console.error("[ResumeAI] Failed to parse resume file:", err);
    const msg = err?.message || "";
    if (msg.includes("Unsupported file format") || msg.includes("Invalid resume payload")) {
      return res.status(400).json({ error: msg || "Unsupported resume file format." });
    }
    return res
      .status(500)
      .json({
        error:
          "Failed to read resume file. Please try again with a valid PDF, DOCX, or TXT file.",
      });
  }

  const safeResumeText = (resumeText || "").slice(0, 8000);

  console.log("Resume text length:", resumeText ? resumeText.length : 0);
  console.log("Safe resume text length:", safeResumeText.length);
  console.log("Job description length:", cleanedJobDescription.length);

  // ── Verify the server-side API key is present ────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[ResumeAI] ANTHROPIC_API_KEY environment variable is not set.");
    return res
      .status(500)
      .json({ error: "Server configuration error. API key not set." });
  }

  // ── Build the Anthropic prompt ───────────────────────────────
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
6. PLAIN TEXT: Use plain text only. No markdown, no asterisks, no bullet unicode symbols — use a hyphen (-) for bullet points.
7. LENGTH: Aim for one tight page worth of content. Cut filler phrases (e.g. "responsible for", "worked on"). Every word must earn its place.
8. PROFESSIONAL TONE: Confident, active voice throughout.

After outputting the tailored resume in plain text, append a valid JSON object on a new line with the following fields:
- score (number 0–100)
- matchedKeywords (array of strings)
- missingKeywords (array of strings)
- advice (one sentence string)

Output ONLY the resume followed by the JSON object.
No markdown. No code fences. No commentary.`;

  const userPrompt =
    `CANDIDATE'S ORIGINAL RESUME:\n` +
    `${"─".repeat(60)}\n` +
    `${safeResumeText.trim()}\n\n` +
    `JOB DESCRIPTION THEY ARE APPLYING TO:\n` +
    `${"─".repeat(60)}\n` +
    `${cleanedJobDescription}\n\n` +
    `Please produce the tailored resume now, following all rules exactly.`;

  // ── Call the Anthropic Claude API ────────────────────────────
  // Using the raw fetch API (available in Node 18+), no client SDK needed.
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
            content: [
              {
                type: "text",
                text: userPrompt,
              },
            ],
          },
        ],
      }),
    });
  } catch (networkErr) {
    console.error("[ResumeAI] Network error calling Anthropic Claude:", networkErr);
    return res
      .status(502)
      .json({ error: "Could not reach the Anthropic API. Please try again." });
  }

  // ── Handle non-2xx from Claude ───────────────────────────────
  if (!claudeResponse.ok) {
    const errorBody = await claudeResponse.json().catch(() => ({}));
    const detail    = errorBody?.error?.message || `HTTP ${claudeResponse.status}`;
    console.error("[ResumeAI] Anthropic API error:", detail);
    return res
      .status(502)
      .json({ error: `Anthropic API error: ${detail}` });
  }

  // ── Extract and parse the generated JSON ──────────────────────
  // Anthropic Messages API response shape:
  // { content: [ { type: "text", text: "..." } ], ... }
  const claudeData = await claudeResponse.json();
  const rawText = claudeData?.content?.[0]?.text?.trim();

  if (!rawText) {
    console.error("[ResumeAI] Claude returned empty content:", claudeData);
    return res
      .status(502)
      .json({ error: "Claude returned an empty response. Please try again." });
  }

  let parsedObject = null;

  try {
    parsedObject = JSON.parse(rawText);
  } catch {
    const firstBrace = rawText.indexOf("{");
    const lastBrace = rawText.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const candidate = rawText.slice(firstBrace, lastBrace + 1);
      try {
        parsedObject = JSON.parse(candidate);
      } catch {
        parsedObject = null;
      }
    }
  }

  if (!parsedObject || typeof parsedObject !== "object") {
    console.error("[ResumeAI] Claude returned invalid JSON:", { rawText });
    return res
      .status(502)
      .json({ error: "Claude returned invalid JSON. Please try again." });
  }

  const requiredKeys = ["summary", "skills", "experience", "education"];
  for (const key of requiredKeys) {
    if (!(key in parsedObject)) {
      console.error("[ResumeAI] Missing required key in JSON response:", key, parsedObject);
      return res
        .status(502)
        .json({ error: "Claude returned JSON missing required fields. Please try again." });
    }
  }

  return res.status(200).json({
    resumeData: parsedObject,
  });
}
