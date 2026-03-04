// ============================================================
//  sidepanel.js – Resume AI Copilot
//  ES module (type="module" set in sidepanel.html).
//
//  Full-height Chrome Side Panel implementation.
//  All AI calls go through the Vercel serverless function.
//
//  Flow:
//    1. Panel opens → check chrome.storage.local for saved resume.
//       → No resume : show onboarding (upload file only).
//       → Has resume : show main screen → auto-scrape job description.
//    2. Auto-scrape: inject content.js → extract text → update status UI.
//       → Success : enable Generate button.
//       → Failure  : show warning; user can still try to generate.
//    3. Generate clicked → POST { resume, jobDescription } to BACKEND_URL
//       → render Claude's response in preview panel.
//    4. Copy / Download work on the last result string.
//    5. Reset clears storage and returns to onboarding.
// ============================================================

// ── Backend URL ───────────────────────────────────────────────
const BACKEND_URL = "https://chromeextensions.vercel.app/api/generate";

// ── Storage keys ──────────────────────────────────────────────
const STORAGE_KEY_RESUME_TEXT = "resumeText";
const LEGACY_STORAGE_KEY_RESUME = "resumeai_base_resume";
const STORAGE_KEY_LAST_RESUME = "lastTailoredResume";
const STORAGE_KEY_LAST_ATS = "lastATSScore";

// ── DOM — Onboarding screen ───────────────────────────────────
const screenOnboarding = document.getElementById("screen-onboarding");
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const fileChosen = document.getElementById("fileChosen");
const fileName = document.getElementById("fileName");
const btnClearFile = document.getElementById("btnClearFile");
const btnSaveSetup = document.getElementById("btnSaveSetup");
const setupError = document.getElementById("setupError");

// ── DOM — Main screen ─────────────────────────────────────────
const screenMain = document.getElementById("screen-main");
const jobUrl = document.getElementById("jobUrl");
const extractStatus = document.getElementById("extractStatus");
const extractIcon = document.getElementById("extractIcon");
const extractText = document.getElementById("extractText");
const btnGenerate = document.getElementById("btnGenerate");
const genIdle = btnGenerate.querySelector(".gen-idle");
const genLoading = btnGenerate.querySelector(".gen-loading");
const errorBanner = document.getElementById("errorBanner");
const errorMsg = document.getElementById("errorMsg");
const previewPanel = document.getElementById("previewPanel");
const previewHint = document.getElementById("previewHint");
const btnCopy = document.getElementById("btnCopy");
const btnDownload = document.getElementById("btnDownload");
const btnReset = document.getElementById("btnReset");
const toast = document.getElementById("toast");

// ── DOM — Match Analysis panel ───────────────────────────────
const matchAnalysisEl = document.getElementById("matchAnalysis");
const matchScoreValueEl = document.getElementById("matchScoreValue");
const matchBarFillEl = document.getElementById("matchBarFill");
const matchStrengthsEl = document.getElementById("matchStrengths");
const matchWeakAreasEl = document.getElementById("matchWeakAreas");

// ── State ─────────────────────────────────────────────────────
let pickedResumeText = null;
let scrapedJobText = null;
let lastResult = null;

let isCalling = false;
let lastCallTimestamp = 0;
let lastClickTimestamp = 0;

const CLICK_DEBOUNCE_MS = 500;
const CALL_COOLDOWN_MS = 15_000;

function updateGenerateButtonState() {
    const hasResume =
        typeof pickedResumeText === "string" && pickedResumeText.trim().length > 0;
    const hasJob =
        typeof scrapedJobText === "string" && scrapedJobText.trim().length >= 150;
    const canGenerate = hasResume && hasJob && !isCalling;
    btnGenerate.disabled = !canGenerate;
}

// ============================================================
//  INIT
// ============================================================
async function init() {
    isCalling = false;
    setGenerating(false);
    hideError();
    btnCopy.disabled = true;
    btnDownload.disabled = true;
    lastResult = null;

    const stored = await chrome.storage.local.get([
        STORAGE_KEY_RESUME_TEXT,
        LEGACY_STORAGE_KEY_RESUME,
        STORAGE_KEY_LAST_RESUME,
        STORAGE_KEY_LAST_ATS,
        "jobMatchScore",
        "applyReadiness",
        "scoreExplanation",
    ]);

    if (typeof stored[STORAGE_KEY_RESUME_TEXT] === "string" && stored[STORAGE_KEY_RESUME_TEXT].trim()) {
        pickedResumeText = stored[STORAGE_KEY_RESUME_TEXT];

        showScreen("main");
        updateGenerateButtonState();
        showToast("Resume loaded ✓", 1800);

        // Restore last generate result
        if (typeof stored[STORAGE_KEY_LAST_RESUME] === "string" && stored[STORAGE_KEY_LAST_RESUME]) {
            lastResult = stored[STORAGE_KEY_LAST_RESUME];
            renderResult(lastResult);
            btnCopy.disabled = false;
            btnDownload.disabled = false;
            previewHint.textContent = "Claude-tailored · ATS-ready";
        }

        if (stored[STORAGE_KEY_LAST_ATS] && typeof stored[STORAGE_KEY_LAST_ATS] === "object") {
            renderATSScore(stored[STORAGE_KEY_LAST_ATS]);
        }

        if (stored.jobMatchScore !== null && stored.jobMatchScore !== undefined) {
            populateMatchAnalysis(stored.jobMatchScore);
        }

        if (stored.applyReadiness && typeof stored.applyReadiness === "object") {
            renderApplyReadiness(
                stored.applyReadiness.score,
                stored.applyReadiness.recommendation,
                stored.applyReadiness.suggestions
            );
        }

        if (stored.scoreExplanation && typeof stored.scoreExplanation === "string") {
            renderScoreExplanation(stored.scoreExplanation);
        }

        await autoScrapeJobDescription();
    } else {
        if (stored[LEGACY_STORAGE_KEY_RESUME]) {
            showToast("Please re-upload your resume (TXT recommended).", 2600);
        }
        showScreen("onboarding");
    }

    updateGenerateButtonState();
}

// ── Screen switcher ───────────────────────────────────────────
function showScreen(name) {
    if (name === "onboarding") {
        screenMain.hidden = true;
        screenOnboarding.hidden = false;
    } else {
        screenOnboarding.hidden = true;
        screenMain.hidden = false;
    }
}

// ============================================================
//  AUTO-SCRAPE (with retry for dynamic pages like LinkedIn)
// ============================================================
const SCRAPE_MAX_RETRIES = 5;
const SCRAPE_RETRY_DELAY_MS = 1200;

async function autoScrapeJobDescription() {
    let tab;
    try {
        [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        jobUrl.textContent = tab?.url ?? "—";
    } catch {
        jobUrl.textContent = "Unable to read tab";
    }

    if (!tab?.url?.startsWith("http")) {
        setExtractStatus("warn",
            "⚠",
            "Open a job posting page, then click the extension icon again."
        );
        return;
    }

    // Check if this is a known dynamic job site (needs retries)
    const tabUrl = (tab.url || "").toLowerCase();
    const isDynamicSite =
        tabUrl.includes("linkedin.com") ||
        tabUrl.includes("indeed.com") ||
        tabUrl.includes("greenhouse.io") ||
        tabUrl.includes("lever.co");

    setExtractStatus("loading", "⏳", "Reading job description…");

    for (let attempt = 1; attempt <= SCRAPE_MAX_RETRIES; attempt++) {
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: false },
                files: ["content.js"],
            });

            const raw = results?.[0]?.result;
            const payload = (raw && typeof raw === "object" && "isJobPage" in raw)
                ? raw
                : { isJobPage: true, text: typeof raw === "string" ? raw : "" };

            console.log(`[Resume AI Copilot] Scrape attempt ${attempt}/${SCRAPE_MAX_RETRIES}:`, payload.reason, `(${(payload.text || "").length} chars)`);

            // Not a job page at all — stop retrying
            if (!payload.isJobPage) {
                scrapedJobText = null;
                setExtractStatus(
                    "warn",
                    "⚠",
                    "No job description detected on this page. Please navigate to a job posting."
                );
                updateGenerateButtonState();
                return;
            }

            const text = payload.text || "";

            // Success — got enough text
            if (text.length >= 150) {
                scrapedJobText = text;
                const wordCount = text.split(/\s+/).length;
                setExtractStatus(
                    "success",
                    "✓",
                    `Job description captured (${wordCount} words) — ready to tailor.`
                );
                updateGenerateButtonState();
                return;
            }

            // Dynamic content not ready yet — retry if on a known dynamic site
            const shouldRetry = isDynamicSite && attempt < SCRAPE_MAX_RETRIES &&
                (payload.reason === "dynamic_not_ready" || payload.reason === "full_body_fallback" || text.length < 150);

            if (shouldRetry) {
                setExtractStatus("loading", "⏳", `Waiting for page to load… (attempt ${attempt}/${SCRAPE_MAX_RETRIES})`);
                await new Promise(r => setTimeout(r, SCRAPE_RETRY_DELAY_MS));
                continue;
            }

            // Not enough text and no more retries
            setExtractStatus(
                "warn",
                "⚠",
                "Couldn't extract enough text. Make sure you're on a job description page."
            );
            scrapedJobText = null;
            updateGenerateButtonState();
            return;

        } catch (err) {
            // On error, retry if we have attempts left for dynamic sites
            if (isDynamicSite && attempt < SCRAPE_MAX_RETRIES) {
                console.warn(`[Resume AI Copilot] Scrape attempt ${attempt} failed, retrying...`, err.message);
                await new Promise(r => setTimeout(r, SCRAPE_RETRY_DELAY_MS));
                continue;
            }
            setExtractStatus("error", "✕", `Could not read page: ${err.message}`);
            scrapedJobText = null;
            updateGenerateButtonState();
            return;
        }
    }
}

function setExtractStatus(state, icon, text) {
    extractStatus.className = "extract-status";
    if (state === "success") extractStatus.classList.add("is-success");
    if (state === "warn") extractStatus.classList.add("is-warn");
    if (state === "error") extractStatus.classList.add("is-error");
    extractIcon.textContent = icon;
    extractText.textContent = text;
}

// ============================================================
//  ONBOARDING
// ============================================================
dropZone.addEventListener("click", () => fileInput.click());

dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));

dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFilePicked(file);
});

fileInput.addEventListener("change", () => {
    if (fileInput.files?.[0]) handleFilePicked(fileInput.files[0]);
});

function getFileExt(name) {
    const idx = String(name || "").lastIndexOf(".");
    return idx >= 0 ? String(name).slice(idx + 1).toLowerCase() : "";
}

function normalizeExtractedText(text) {
    return String(text || "")
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Could not read file as text."));
        reader.readAsText(file);
    });
}

function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read file as binary."));
        reader.readAsArrayBuffer(file);
    });
}

async function extractPdfTextFromArrayBuffer(arrayBuffer) {
    const pdfjsLib = globalThis.pdfjsLib;
    if (!pdfjsLib?.getDocument) {
        throw new Error("PDF reader not available.");
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc =
        chrome.runtime.getURL("lib/pdf.worker.js");

    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    const pages = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const content = await page.getTextContent();
        const line = (content.items || [])
            .map((it) => (it && typeof it.str === "string" ? it.str : ""))
            .filter(Boolean)
            .join(" ");
        pages.push(line);
    }

    return pages.join("\n\n");
}

async function extractDocTextFromArrayBuffer(arrayBuffer) {
    const mammoth = globalThis.mammoth;
    if (!mammoth?.extractRawText) {
        throw new Error("DOC/DOCX reader not available.");
    }
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result?.value || "";
}

async function extractTextFromFile(file) {
    const ext = getFileExt(file?.name);

    if (ext === "txt") {
        return await readFileAsText(file);
    }

    if (ext === "pdf") {
        const buf = await readFileAsArrayBuffer(file);
        return await extractPdfTextFromArrayBuffer(buf);
    }

    if (ext === "doc" || ext === "docx") {
        const buf = await readFileAsArrayBuffer(file);
        return await extractDocTextFromArrayBuffer(buf);
    }

    throw new Error("Unsupported file type.");
}

async function handleFilePicked(file) {
    clearSetupError();
    pickedResumeText = null;
    updateGenerateButtonState();

    try {
        const rawText = await extractTextFromFile(file);
        const text = normalizeExtractedText(rawText);

        if (!text) {
            throw new Error("Empty extracted text.");
        }

        pickedResumeText = text;
        await chrome.storage.local.set({ [STORAGE_KEY_RESUME_TEXT]: text });
        await chrome.storage.local.remove(LEGACY_STORAGE_KEY_RESUME);

        fileName.textContent = file.name;
        fileChosen.hidden = false;
        updateGenerateButtonState();
    } catch (err) {
        console.error("[Resume AI Copilot] Resume text extraction failed", err);
        pickedResumeText = null;
        fileChosen.hidden = true;
        showSetupError(
            "This file could not be read. Please try uploading a .txt version of your resume."
        );
        updateGenerateButtonState();
    }
}

btnClearFile.addEventListener("click", async () => {
    pickedResumeText = null;
    fileInput.value = "";
    fileChosen.hidden = true;
    await chrome.storage.local.remove(STORAGE_KEY_RESUME_TEXT);
    updateGenerateButtonState();
});

btnSaveSetup.addEventListener("click", async () => {
    clearSetupError();

    if (
        typeof pickedResumeText !== "string" ||
        pickedResumeText.trim().length === 0
    ) {
        return showSetupError("Please upload your resume file first.");
    }

    await chrome.storage.local.set({
        [STORAGE_KEY_RESUME_TEXT]: pickedResumeText.trim(),
    });
    await chrome.storage.local.remove(LEGACY_STORAGE_KEY_RESUME);

    showScreen("main");
    await autoScrapeJobDescription();
});

function showSetupError(msg) {
    setupError.textContent = msg;
    setupError.hidden = false;
}
function clearSetupError() {
    setupError.hidden = true;
    setupError.textContent = "";
}

// ============================================================
//  GENERATE — calls the Vercel serverless function
// ============================================================
btnGenerate.addEventListener("click", async () => {
    const now = Date.now();
    console.log("[Resume AI Copilot] Generate button clicked at", new Date(now).toISOString());

    // Debounce rapid clicks
    if (now - lastClickTimestamp < CLICK_DEBOUNCE_MS) {
        console.log("[Resume AI Copilot] Ignoring click (debounced)");
        return;
    }
    lastClickTimestamp = now;

    // Prevent duplicate in-flight calls
    if (isCalling) {
        console.log("[Resume AI Copilot] Ignoring click (call already in progress)");
        return;
    }

    // Enforce cooldown between calls
    if (lastCallTimestamp && now - lastCallTimestamp < CALL_COOLDOWN_MS) {
        const remainingMs = CALL_COOLDOWN_MS - (now - lastCallTimestamp);
        const remainingSec = Math.ceil(remainingMs / 1000);
        showError(`Please wait ${remainingSec}s before generating another tailored resume.`);
        return;
    }

    hideError();
    isCalling = true;
    lastCallTimestamp = now;
    setGenerating(true);

    try {
        // Load saved resume
        const stored = await chrome.storage.local.get(STORAGE_KEY_RESUME_TEXT);
        const baseResumeText = stored[STORAGE_KEY_RESUME_TEXT];

        if (typeof baseResumeText !== "string" || !baseResumeText.trim()) {
            throw new Error("Saved resume is invalid. Please reset and upload your resume again.");
        }

        pickedResumeText = baseResumeText;

        const jobText = scrapedJobText;
        if (!jobText || jobText.trim().length < 150) {
            throw new Error(
                "No job description detected on this page. Please navigate to a job posting and try again."
            );
        }

        // POST to the Vercel backend
        const response = await fetch(BACKEND_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                resumeText: baseResumeText.trim(),
                jobDescription: jobText.trim(),
            }),
        });

        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body?.error || `Server error: HTTP ${response.status}`);
        }

        const data = await response.json();
        const tailored = data?.tailoredResume;
        const atsScore = data?.atsScore;
        let jobMatchScore = null;

        if (!pickedResumeText || !jobText) {
            console.warn("[Resume AI Copilot] Missing resume or job description for match score");
        } else {
            try {
                const matchResponse = await fetch(
                    "https://chromeextensions.vercel.app/api/match",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            resumeText: pickedResumeText.trim(),
                            jobDescription: jobText.trim(),
                        }),
                    }
                );

                const matchData = await matchResponse.json();
                jobMatchScore = matchData?.matchScore !== undefined ? matchData : null;
            } catch (err) {
                console.warn("[Resume AI Copilot] Match score failed", err);
            }
        }

        if (!tailored) {
            throw new Error("The server returned an empty response. Please try again.");
        }

        // Render the result
        renderResult(cleanClaudeOutput(tailored));
        lastResult = tailored;

        if (atsScore && typeof atsScore === "object") {
            renderATSScore(atsScore);
        }

        if (jobMatchScore !== null && jobMatchScore !== undefined) {
            populateMatchAnalysis(jobMatchScore);
        }

        // Apply Readiness
        let applyReadiness = null;
        if (jobMatchScore !== null && jobMatchScore !== undefined && atsScore && typeof atsScore === "object") {
            const jmScore = typeof jobMatchScore === "object" ? jobMatchScore.matchScore : jobMatchScore;
            const arScore = Math.round((jmScore * 0.6) + ((atsScore.score || 0) * 0.4));

            let recommendation;
            if (arScore >= 80) recommendation = "Strongly Apply";
            else if (arScore >= 60) recommendation = "Apply with Improvements";
            else if (arScore >= 40) recommendation = "Improve Resume First";
            else recommendation = "Not a Good Match";

            const missingKeywords = Array.isArray(atsScore.missingKeywords) ? atsScore.missingKeywords : [];
            const suggestions = missingKeywords.slice(0, 3).map(k =>
                `Add experience or mention of "${k}" if relevant to your work.`
            );

            applyReadiness = { score: arScore, recommendation, suggestions };
            renderApplyReadiness(arScore, recommendation, suggestions);
        }

        // Score Explanation
        let scoreExplanation = null;
        if (jobMatchScore !== null && jobMatchScore !== undefined && atsScore && typeof atsScore === "object") {
            scoreExplanation = generateScoreExplanation(atsScore, jobMatchScore);
            renderScoreExplanation(scoreExplanation);
        }

        // Persist across sessions
        chrome.storage.local.set({
            [STORAGE_KEY_LAST_RESUME]: tailored,
            [STORAGE_KEY_LAST_ATS]: atsScore ?? null,
            jobMatchScore: jobMatchScore ?? null,
            applyReadiness: applyReadiness,
            scoreExplanation: scoreExplanation,
        });

        btnCopy.disabled = false;
        btnDownload.disabled = false;
        previewHint.textContent = "Claude-tailored · ATS-ready";

    } catch (err) {
        console.error("[Resume AI Copilot] Generate call failed", err);
        showError(err.message || "Something went wrong. Please try again.");
    } finally {
        isCalling = false;
        setGenerating(false);
        console.log("[Resume AI Copilot] Generate call finished");
    }
});

// ── Clean Claude output ─────────────────────────────────────
function cleanClaudeOutput(text) {
    return text.replace(/Job Match Score[\s\S]*?\n\n/gi, "").trim();
}

// ── Render the tailored resume ────────────────────────────────
function renderResult(text) {
    previewPanel.innerHTML = "";

    const SECTION_HEADINGS = /^(SUMMARY|EXPERIENCE|SKILLS|EDUCATION)$/im;

    const pre = document.createElement("pre");
    pre.className = "preview-result";

    const lines = text.split("\n");
    lines.forEach((line, i) => {
        if (SECTION_HEADINGS.test(line.trim())) {
            const span = document.createElement("span");
            span.className = "section-heading";
            span.textContent = line.trim().toUpperCase();
            pre.appendChild(span);
        } else {
            pre.appendChild(document.createTextNode(line + (i < lines.length - 1 ? "\n" : "")));
        }
    });

    previewPanel.appendChild(pre);
}

// ── Render the ATS score block ───────────────────────────────
function renderATSScore(score) {
    const existing = document.getElementById("ats-score-block");
    if (existing) existing.remove();

    const block = document.createElement("div");
    block.id = "ats-score-block";
    block.className = "ats-score-block";

    const pct = Math.min(100, Math.max(0, Number(score.score) || 0));
    const matchedList = Array.isArray(score.matchedKeywords) ? score.matchedKeywords : [];
    const missingList = Array.isArray(score.missingKeywords) ? score.missingKeywords : [];

    block.innerHTML = `
    <div class="ats-header">
      <span class="ats-label">ATS Score</span>
      <span class="ats-score-value">${pct}<span class="ats-score-unit">/100</span></span>
    </div>
    <div class="ats-bar-track"><div class="ats-bar-fill" style="width:${pct}%"></div></div>
    ${matchedList.length
            ? `<p class="ats-section-label">✓ Matched keywords</p>
           <p class="ats-keywords ats-matched">${matchedList.join(", ")}</p>`
            : ""
        }
    ${missingList.length
            ? `<p class="ats-section-label">✗ Missing keywords</p>
           <p class="ats-keywords ats-missing">${missingList.join(", ")}</p>`
            : ""
        }
    ${score.advice
            ? `<p class="ats-advice">💡 ${score.advice}</p>`
            : ""
        }
  `;

    previewPanel.appendChild(block);
}

function renderJobMatchScore(score) {
    const existing = document.getElementById("job-match-block");
    if (existing) existing.remove();

    const block = document.createElement("div");
    block.id = "job-match-block";
    block.className = "job-match-block";

    const isObject = score !== null && typeof score === "object";
    const matchScore = isObject ? score.matchScore : score;
    const semanticScore = isObject ? score.semanticScore : null;
    const keywordScore = isObject ? score.keywordScore : null;
    const categoryScore = isObject ? score.categoryScore : null;

    const breakdownHtml = (semanticScore !== null)
        ? `<div style="margin-top:8px;font-size:11px;color:var(--text-muted);">
         <div>Semantic Similarity: <strong>${semanticScore}%</strong></div>
         <div>Keyword Coverage: <strong>${keywordScore}%</strong></div>
         <div>Skill Category Match: <strong>${categoryScore}%</strong></div>
       </div>`
        : "";

    block.innerHTML = `
    <div style="margin-top:12px;padding:12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface-2);">
      <span style="font-weight:bold;color:var(--text);">Job Match Score</span>
      <div style="font-size:20px;font-weight:bold;margin-top:4px;color:var(--accent);">
        ${matchScore}%
      </div>
      ${breakdownHtml}
    </div>
  `;

    previewPanel.appendChild(block);
}

// ── Render Apply Readiness block ──────────────────────────────
function renderApplyReadiness(score, recommendation, suggestions) {
    const existing = document.getElementById("apply-readiness-block");
    if (existing) existing.remove();

    const block = document.createElement("div");
    block.id = "apply-readiness-block";

    const suggestionsHtml = Array.isArray(suggestions) && suggestions.length
        ? `<div style="margin-top:8px;">
         <strong>Suggestions:</strong>
         <ul style="margin:4px 0 0 16px;padding:0;">
           ${suggestions.map(s => `<li style="margin-bottom:4px;font-size:11px;color:var(--text-dim);">${s}</li>`).join("")}
         </ul>
       </div>`
        : "";

    block.innerHTML = `
    <div style="margin-top:12px;padding:12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface-2);">
      <strong style="color:var(--text);">Apply Readiness Score</strong>
      <div style="font-size:22px;font-weight:bold;margin-top:4px;color:var(--accent-2);">
        ${score}%
      </div>
      <div style="margin-top:6px;font-size:12px;color:var(--text-dim);">
        Recommendation: <strong style="color:var(--text);">${recommendation}</strong>
      </div>
      ${suggestionsHtml}
    </div>
  `;

    previewPanel.appendChild(block);
}

// ── Generate score explanation text ───────────────────────────
function generateScoreExplanation(atsScore, jobMatchData) {
    const lines = [];
    const missingKeywords = Array.isArray(atsScore.missingKeywords) ? atsScore.missingKeywords : [];
    const isObject = jobMatchData !== null && typeof jobMatchData === "object";
    const semanticScore = isObject ? jobMatchData.semanticScore : null;
    const keywordScore = isObject ? jobMatchData.keywordScore : null;
    const categoryScore = isObject ? jobMatchData.categoryScore : null;
    const matchScore = isObject ? jobMatchData.matchScore : jobMatchData;

    if (semanticScore !== null && semanticScore < 50) {
        lines.push("The role emphasizes different responsibilities than those highlighted in your resume. Consider restructuring your experience to better align with the job's focus areas.");
    } else if (semanticScore !== null && semanticScore < 70) {
        lines.push("Your resume has some overlap with the role's focus, but there's room to better align your experience with the job's core responsibilities.");
    }

    if (keywordScore !== null && keywordScore < 30) {
        const topMissing = missingKeywords.slice(0, 4).join(", ");
        lines.push("The job description requires specific tools and technologies that are not currently mentioned in your resume" + (topMissing ? " (such as " + topMissing + ")" : "") + ". Adding relevant experience with these tools can significantly improve your match.");
    } else if (keywordScore !== null && keywordScore < 60) {
        lines.push("Some of the key terms from the job description are missing from your resume. Incorporating relevant keywords naturally into your experience can boost your ATS and match scores.");
    }

    if (categoryScore !== null && categoryScore >= 80 && keywordScore !== null && keywordScore < 50) {
        lines.push("Great news — your core skill categories strongly match this role! The lower keyword score is due to specific technologies the job mentions. Your foundational skills position you well, and adding those specific tools to your resume could make a big difference.");
    }

    if (missingKeywords.length > 0 && missingKeywords.length <= 5) {
        lines.push("Consider adding experience with: " + missingKeywords.join(", ") + ". Even brief mentions of relevant projects or coursework can help.");
    } else if (missingKeywords.length > 5) {
        const shown = missingKeywords.slice(0, 5).join(", ");
        lines.push("There are " + missingKeywords.length + " keywords from the job description not found in your resume. Key ones to focus on: " + shown + ". Prioritize the ones most relevant to your actual experience.");
    }

    if (matchScore >= 70) {
        lines.push("Overall, your profile is a strong match for this role. A few targeted tweaks could push your score even higher!");
    } else if (matchScore >= 50) {
        lines.push("You have a solid foundation for this role. With some targeted adjustments to highlight relevant experience and add missing keywords, you can improve your match significantly.");
    } else {
        lines.push("This role has a different focus than your current resume highlights. Consider whether you have transferable skills that could be repositioned to better match the requirements.");
    }

    return lines.join("\n\n");
}

// ── Render score explanation block ────────────────────────────
function renderScoreExplanation(explanationText) {
    const existing = document.getElementById("score-explanation-block");
    if (existing) existing.remove();

    if (!explanationText) return;

    const block = document.createElement("div");
    block.id = "score-explanation-block";

    const paragraphs = explanationText.split("\n\n")
        .filter(function (p) { return p.trim(); })
        .map(function (p) { return '<p style="margin:0 0 8px 0;line-height:1.5;font-size:11.5px;color:var(--text-dim);">' + p + '</p>'; })
        .join("");

    block.innerHTML =
        '<div style="margin-top:12px;padding:12px;border:1px solid rgba(124,111,255,0.2);border-radius:var(--radius);background:var(--accent-dim);">' +
        '<strong style="display:block;margin-bottom:8px;color:var(--text);">📊 Score Explanation</strong>' +
        '<div>' +
        paragraphs +
        '</div></div>';

    previewPanel.appendChild(block);
}

// ── Populate Match Analysis panel ─────────────────────────────
function populateMatchAnalysis(matchData) {
    if (!matchAnalysisEl) return;

    const isObject = matchData !== null && typeof matchData === "object";
    const score = isObject ? matchData.matchScore : matchData;
    const matched = isObject && Array.isArray(matchData.matchedSkills) ? matchData.matchedSkills : [];
    const missing = isObject && Array.isArray(matchData.missingSkills) ? matchData.missingSkills : [];

    if (score === null || score === undefined) return;

    // Score + progress bar
    matchScoreValueEl.textContent = score + "%";
    matchBarFillEl.style.width = Math.min(100, Math.max(0, score)) + "%";

    // Strengths chips
    matchStrengthsEl.innerHTML = "";
    const showMatched = matched.slice(0, 8);
    const strengthsCol = matchStrengthsEl.parentElement;
    if (showMatched.length === 0) {
        strengthsCol.hidden = true;
    } else {
        strengthsCol.hidden = false;
        showMatched.forEach(function (skill) {
            const chip = document.createElement("span");
            chip.className = "match-skill-chip match-skill-chip--good";
            chip.textContent = "✔ " + skill;
            matchStrengthsEl.appendChild(chip);
        });
    }

    // Weak Areas chips
    matchWeakAreasEl.innerHTML = "";
    const showMissing = missing.slice(0, 8);
    const weakCol = matchWeakAreasEl.parentElement;
    if (showMissing.length === 0) {
        weakCol.hidden = true;
    } else {
        weakCol.hidden = false;
        showMissing.forEach(function (skill) {
            const chip = document.createElement("span");
            chip.className = "match-skill-chip match-skill-chip--weak";
            chip.textContent = "✘ " + skill;
            matchWeakAreasEl.appendChild(chip);
        });
    }

    matchAnalysisEl.hidden = false;
}

// ── Copy (Optimize Resume button) ────────────────────────────
btnCopy.addEventListener("click", async () => {
    if (!lastResult) return;
    try {
        await navigator.clipboard.writeText(lastResult);
        showToast("Copied to clipboard ✓");
    } catch {
        showToast("Copy failed — try selecting the text manually.");
    }
});

// ── Download as .txt ──────────────────────────────────────────
btnDownload.addEventListener("click", () => {
    if (!lastResult) return;

    const blob = new Blob([lastResult], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tailored-resume.txt";
    a.click();
    URL.revokeObjectURL(url);
    showToast("Download started ✓");
});

// ── Download PDF ──────────────────────────────────────────────
document.getElementById("downloadPDF").addEventListener("click", () => {
    if (!lastResult) return;

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
        format: "a4",
        unit: "in"
    });

    const margin = 0.75;
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const maxLineWidth = pageWidth - margin * 2;

    const headingSize = 13;
    const bodySize = 11;

    let cursorY = margin;

    const SECTION_HEADINGS = /^(SUMMARY|EXPERIENCE|SKILLS|EDUCATION)$/im;
    const lines = lastResult.split('\n');

    lines.forEach(line => {
        const text = line.trim();
        if (!text) {
            cursorY += 0.15;
            if (cursorY > pageHeight - margin) {
                doc.addPage();
                cursorY = margin;
            }
            return;
        }

        let isHeading = SECTION_HEADINGS.test(text);
        if (isHeading) {
            doc.setFont("helvetica", "bold");
            doc.setFontSize(headingSize);
            cursorY += 0.1;
        } else {
            doc.setFont("helvetica", "normal");
            doc.setFontSize(bodySize);
        }

        const splitLines = doc.splitTextToSize(text, maxLineWidth);

        splitLines.forEach(splitLine => {
            if (cursorY > pageHeight - margin - 0.2) {
                doc.addPage();
                cursorY = margin;
                if (isHeading) {
                    doc.setFont("helvetica", "bold");
                    doc.setFontSize(headingSize);
                } else {
                    doc.setFont("helvetica", "normal");
                    doc.setFontSize(bodySize);
                }
            }
            doc.text(splitLine, margin, cursorY + ((isHeading ? headingSize : bodySize) / 72));
            cursorY += (isHeading ? headingSize : bodySize) / 72 * 1.5;
        });
    });

    doc.save("ResumeAI_Resume.pdf");
    showToast("PDF download started ✓");
});

// ── Download DOCX ─────────────────────────────────────────────
document.getElementById("downloadDOC").addEventListener("click", async () => {
    if (!lastResult) return;

    const { Document, Packer, Paragraph, TextRun } = window.docx;

    const SECTION_HEADINGS = /^(SUMMARY|EXPERIENCE|SKILLS|EDUCATION)$/im;
    const lines = lastResult.split('\n');
    const children = [];

    for (const line of lines) {
        const text = line.trim();
        if (!text) {
            children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
            continue;
        }

        if (SECTION_HEADINGS.test(text)) {
            children.push(new Paragraph({
                children: [
                    new TextRun({
                        text: text.toUpperCase(),
                        bold: true,
                        size: 26,
                    }),
                ],
                spacing: { before: 240, after: 120 },
            }));
        } else {
            children.push(new Paragraph({
                children: [
                    new TextRun({
                        text: text,
                        size: 22,
                    }),
                ],
                spacing: { after: 120 },
            }));
        }
    }

    const docFile = new Document({
        sections: [{
            properties: {
                page: {
                    margin: {
                        top: 1080,
                        right: 1080,
                        bottom: 1080,
                        left: 1080,
                    },
                },
            },
            children: children,
        }],
    });

    const blob = await Packer.toBlob(docFile);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ResumeAI_Resume.docx";
    a.click();
    URL.revokeObjectURL(url);
    showToast("DOCX download started ✓");
});

// ── Reset: clear storage → back to onboarding ────────────────
btnReset.addEventListener("click", async () => {
    const confirmed = confirm(
        "This will clear your saved resume. You'll need to upload it again."
    );
    if (!confirmed) return;

    await chrome.storage.local.remove([
        STORAGE_KEY_RESUME_TEXT,
        LEGACY_STORAGE_KEY_RESUME,
        STORAGE_KEY_LAST_RESUME,
        STORAGE_KEY_LAST_ATS,
    ]);

    scrapedJobText = null;
    lastResult = null;
    pickedResumeText = null;

    btnCopy.disabled = true;
    btnDownload.disabled = true;
    previewPanel.innerHTML = `
    <div class="preview-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
      <p>Your Claude-tailored resume will appear here.</p>
      <p>Navigate to a job posting, then click <strong>Generate Resume</strong>.</p>
    </div>`;
    previewHint.textContent = "Ready when you are";

    showScreen("onboarding");
    updateGenerateButtonState();
});

// ── UI state helpers ──────────────────────────────────────────
function setGenerating(on) {
    genIdle.hidden = on;
    genLoading.hidden = !on;
    updateGenerateButtonState();
}

function showError(msg) {
    errorMsg.textContent = msg;
    errorBanner.hidden = false;
}

function hideError() {
    errorBanner.hidden = true;
    errorMsg.textContent = "";
}

let toastTimer = null;
function showToast(msg, ms = 2500) {
    toast.textContent = msg;
    toast.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), ms);
}

// ── Boot ──────────────────────────────────────────────────────
init();
