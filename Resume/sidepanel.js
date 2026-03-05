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
const BACKEND_URL  = "https://chromeextensions.vercel.app/api/generate";
const EXTRACT_URL  = BACKEND_URL.replace("/api/generate", "/api/extract");

// ── Storage keys ──────────────────────────────────────────────
const STORAGE_KEY_RESUME_TEXT = "resumeText";
const STORAGE_KEY_LAST_RESUME = "lastTailoredResume";


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

// ── DOM — URL paste fallback ──────────────────────────────────
const urlFallback = document.getElementById("urlFallback");
const urlInput = document.getElementById("urlInput");
const btnFetchUrl = document.getElementById("btnFetchUrl");
const urlFetchStatus = document.getElementById("urlFetchStatus");

// ── DOM — ATS Score card ──────────────────────────────────────
const scoreCard = document.getElementById("scoreCard");
const scoreBeforeRing = document.getElementById("scoreBeforeRing");
const scoreBeforeNum = document.getElementById("scoreBeforeNum");
const scoreBeforeBar = document.getElementById("scoreBeforeBar");
const scoreAfterCol = document.getElementById("scoreAfterCol");
const scoreAfterRing = document.getElementById("scoreAfterRing");
const scoreAfterNum = document.getElementById("scoreAfterNum");
const scoreAfterBar = document.getElementById("scoreAfterBar");
const scoreBreakdown = document.getElementById("scoreBreakdown");

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
        STORAGE_KEY_LAST_RESUME,
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
            document.getElementById("downloadPDF").disabled = false;
            document.getElementById("downloadDOC").disabled = false;
            previewHint.textContent = "Claude-tailored · Ready to use";
        }

        await autoScrapeJobDescription();
    } else {
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
//  SPA NAVIGATION — re-scrape when user clicks a new job
//  (content.js watches currentJobId and sends this message)
// ============================================================
let lastScrapedJobId = null;

chrome.runtime.onMessage.addListener((message) => {
    if (message.action !== "jobPageChanged") return;

    // Only act if we're on the main screen (resume already uploaded)
    if (screenMain.hidden) return;

    // Deduplicate — skip if we already scraped this exact job
    if (message.jobId && message.jobId === lastScrapedJobId) return;
    lastScrapedJobId = message.jobId ?? null;

    console.log("[ResumeNest] New job detected, re-scraping:", message.jobId ?? message.url);

    // Reset stale state
    scrapedJobText = null;
    scoreCard.hidden = true;
    urlInput.value = "";
    urlFetchStatus.textContent = "";
    urlFetchStatus.className = "url-fallback-status";
    updateGenerateButtonState();

    showToast("New job detected — re-scanning…", 2000);

    // content.js already waited 1500ms before sending — scrape immediately
    autoScrapeJobDescription();
});


//  AUTO-SCRAPE (with retry for dynamic pages like LinkedIn)
// ============================================================
const SCRAPE_MAX_RETRIES    = 3;
const SCRAPE_RETRY_DELAY_MS = 1200;

// ── JD verification — pure JS, no API cost ───────────────────────────────
// After the DOM scorer picks its best block, this confirms it is actually
// a job description — not "About Us" copy, not a nav bar, not legal text.
// Returns true only if the text contains STRUCTURAL evidence of a real JD.
function isConfirmedJobDescription(text) {
    if (!text || text.length < 300) return false;
    const t = text.toLowerCase();

    // 1. Explicit section headers — the clearest possible signal
    const hasHeaders = /\b(responsibilities|requirements|qualifications|what you['']ll do|what you will do|key responsibilities|key requirements|about the role|about this role|your role|the role)\b/.test(t);

    // 2. Bullet lines with job-action verbs (e.g. "- Collaborate with...", "• Develop...")
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    const actionBullets = lines.filter(l =>
        /^[-•*·▪▸→✓✔]/.test(l) &&
        /\b(develop|design|build|implement|manage|lead|collaborate|analyze|create|support|maintain|work with|own|drive|define|deliver|oversee|ensure|identify|write|test|review|coordinate)\b/i.test(l)
    );
    const hasActionBullets = actionBullets.length >= 2;

    // 3. Experience / education requirements
    const hasRequirements =
        /\b(\d+\+?\s*years?\s*(of\s*)?(experience|exp)\b|bachelor|master|degree|bs\b|ms\b|b\.s\.|m\.s\.)/i.test(text) &&
        /\b(experience|skills?|knowledge|proficiency|familiarity)\b/i.test(t);

    // Must satisfy at least 2 of the 3 signals — one match could be coincidence
    const signals = [hasHeaders, hasActionBullets, hasRequirements].filter(Boolean).length;
    return signals >= 2;
}

async function autoScrapeJobDescription() {
    let tab;
    try {
        [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        jobUrl.textContent = tab?.url ?? "—";
    } catch {
        jobUrl.textContent = "Unable to read tab";
    }

    if (!tab?.id) {
        setExtractStatus("warn", "⚠", "Open a job posting page, then click the extension icon again.");
        return;
    }

    const isDynamicSite = /linkedin\.com|indeed\.com|greenhouse\.io|lever\.co|myworkdayjobs|icims\.com|smartrecruiters|jobvite|ashbyhq|rippling\.com|notion\.site/.test(
        (tab.url || "").toLowerCase()
    );

    setExtractStatus("loading", "⏳", "Reading job description…");

    // ── Phase 1: DOM extraction ──────────────────────────────────────────
    // Grab the best candidate block. For LinkedIn, use known selectors.
    // For everything else, use the keyword scorer.
    // No Claude yet — zero API cost.
    let domText = "";

    for (let attempt = 1; attempt <= SCRAPE_MAX_RETRIES; attempt++) {
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: false },
                func: async function () {

                    function cleanText(t) {
                        return t.replace(/\t/g, " ").replace(/[ ]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
                    }

                    const url = location.href;

                    // ── LinkedIn (search panel + direct page) ────────────
                    if (url.includes("linkedin.com/jobs")) {
                        const start = Date.now();
                        while (Date.now() - start < 6000) {
                            const el = document.querySelector(
                                ".jobs-description__content, .jobs-description-content__text, " +
                                ".jobs-box__html-content, [data-view-name='job-details']"
                            );
                            if (el && el.innerText.trim().length > 300) {
                                const btn = el.querySelector("button.jobs-description__footer-button, button[aria-label*='more']");
                                if (btn) { btn.click(); await new Promise(r => setTimeout(r, 600)); }
                                return cleanText(el.innerText.trim()).slice(0, 8000);
                            }
                            await new Promise(r => setTimeout(r, 400));
                        }
                        return "";
                    }

                    // ── Universal scorer for all other sites ─────────────
                    const JD_KEYWORDS = [
                        "responsibilities", "requirements", "qualifications",
                        "what you'll do", "you will", "about the role",
                        "key responsibilities", "duties", "years of experience",
                        "bachelor", "master", "degree", "must have", "nice to have",
                        "proficiency", "knowledge of", "experience with", "experience in",
                    ];

                    const HARD_DISQUALIFIERS = [
                        /NYSE\s*:\s*\w+/, /BSE\s*:\s*\d+/, /NSE\s*:\s*\w+/,
                        /\d{2,3},\d{3}\s*employees/i,
                    ];

                    const MARKETING_PENALTIES = [
                        "our mission", "our vision", "founded in", "publicly traded",
                        "fortune 500", "industry leader", "equal opportunity",
                        "privacy policy", "terms of use", "stock exchange",
                        "business partners across", "visit us at www",
                    ];

                    function scoreBlock(el) {
                        const text = (el.innerText || "").trim();
                        if (text.length < 300 || text.length > 25000) return 0;
                        const lower = text.toLowerCase();
                        for (const re of HARD_DISQUALIFIERS) { if (re.test(text)) return 0; }

                        let score = 0;
                        for (const kw of JD_KEYWORDS) { if (lower.includes(kw)) score += 8; }

                        const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
                        const bullets = lines.filter(l => /^[-•*·▪▸→✓✔]/.test(l) || /^\d+[.)]/.test(l));
                        score += (bullets.length / Math.max(lines.length, 1)) * 40;

                        if (text.length >= 300 && text.length <= 6000) score += 20;
                        for (const p of MARKETING_PENALTIES) { if (lower.includes(p)) score -= 15; }
                        if (el.querySelector("ul, ol")) score += 15;
                        if (/responsibilities|requirements|qualifications/i.test(text)) score += 25;

                        return Math.max(score, 0);
                    }

                    let bestEl = null, bestScore = 0, bestText = "";
                    document.querySelectorAll("div, section, article, main").forEach(el => {
                        if (el.closest("nav, header, footer, aside, [role='navigation']")) return;
                        if (el.offsetParent === null) return;
                        const s = scoreBlock(el);
                        if (s > bestScore) { bestScore = s; bestText = (el.innerText || "").trim(); bestEl = el; }
                    });

                    return bestText.length >= 300 ? cleanText(bestText).slice(0, 8000) : "";
                },
            });

            const text = (results?.[0]?.result || "").trim();
            console.log(`[ResumeNest] DOM attempt ${attempt}: ${text.length} chars`);

            if (text.length >= 300) {
                domText = text;
                break;
            }

            // Page not ready — retry for dynamic sites
            if (isDynamicSite && attempt < SCRAPE_MAX_RETRIES) {
                setExtractStatus("loading", "⏳", `Waiting for page to load… (attempt ${attempt}/${SCRAPE_MAX_RETRIES})`);
                await new Promise(r => setTimeout(r, SCRAPE_RETRY_DELAY_MS));
                continue;
            }

            break;

        } catch (err) {
            if (isDynamicSite && attempt < SCRAPE_MAX_RETRIES) {
                await new Promise(r => setTimeout(r, SCRAPE_RETRY_DELAY_MS));
                continue;
            }
            setExtractStatus("error", "✕", `Could not read page: ${err.message}`);
            updateGenerateButtonState();
            return;
        }
    }

    // ── Phase 2: JS verification — is the DOM text actually a JD? ────────
    // This is the key question. No API cost. Pure string analysis.
    // The isConfirmedJobDescription() check looks for structural JD evidence:
    //   - explicit section headers (Responsibilities, Requirements, etc.)
    //   - bullet points with job action verbs (develop, manage, collaborate...)
    //   - experience/education requirements (3+ years, Bachelor's degree...)
    // Two of the three signals must be present. If they are, we're done.
    // If not, the DOM grabbed the wrong content — call Claude to recover.

    if (domText && isConfirmedJobDescription(domText)) {
        // ✅ High confidence — real JD found, no API call needed
        console.log("[ResumeNest] JD verified by structural analysis. No Claude needed.");
        scrapedJobText = domText;
        const wordCount = domText.split(/\s+/).length;
        setExtractStatus("success", "✓", `Job description captured (${wordCount} words) — ready to tailor.`);
        updateGenerateButtonState();
        chrome.storage.local.get(STORAGE_KEY_RESUME_TEXT).then(stored => {
            const resume = stored[STORAGE_KEY_RESUME_TEXT];
            if (resume) fetchAtsScore(resume, domText).then(d => renderScoreCard(d, "before"));
        }).catch(() => {});
        return;
    }

    // ── Phase 3: Claude fallback — only fires when verification fails ─────
    // At this point we KNOW the DOM text is not a proper job description.
    // We send the full body text (not the scorer's best-guess block) to Claude
    // so it has the best possible chance of finding the real content.
    console.log("[ResumeNest] DOM text failed JD verification — falling back to Claude.");
    setExtractStatus("loading", "⏳", "Analysing page with AI…");

    // Get full body text for Claude (more context = better extraction)
    let bodyText = domText; // fallback if executeScript fails
    try {
        const bodyResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: false },
            func: function () {
                const noise = document.querySelectorAll("nav, header, footer, aside, script, style, noscript");
                noise.forEach(el => el.setAttribute("data-rn-skip", "1"));
                const text = (document.body.innerText || "").trim().slice(0, 12000);
                noise.forEach(el => el.removeAttribute("data-rn-skip"));
                return text;
            },
        });
        bodyText = bodyResults?.[0]?.result || domText;
    } catch { /* use domText as fallback */ }

    try {
        const response = await fetch(EXTRACT_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rawText: bodyText }),
        });

        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body?.error || `Server error: HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!data.isJobPage || !data.jobDescription) {
            setExtractStatus("warn", "⚠", "This doesn't look like a job posting page.");
            scrapedJobText = null;
            updateGenerateButtonState();
            return;
        }

        scrapedJobText = data.jobDescription;
        const wordCount = scrapedJobText.split(/\s+/).length;
        setExtractStatus("success", "✓", `Job description captured (${wordCount} words) — ready to tailor.`);
        updateGenerateButtonState();
        chrome.storage.local.get(STORAGE_KEY_RESUME_TEXT).then(stored => {
            const resume = stored[STORAGE_KEY_RESUME_TEXT];
            if (resume) fetchAtsScore(resume, scrapedJobText).then(d => renderScoreCard(d, "before"));
        }).catch(() => {});

    } catch (err) {
        console.error("[ResumeNest] Claude fallback failed:", err.message);
        setExtractStatus("error", "✕", `Could not extract job description: ${err.message}`);
        scrapedJobText = null;
        updateGenerateButtonState();
    }
}

// ============================================================
//  ATS SCORE — call /api/score and render result
// ============================================================
const SCORE_URL = BACKEND_URL.replace("/api/generate", "/api/score");

async function fetchAtsScore(resumeText, jobDescription) {
    try {
        const res = await fetch(SCORE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ resumeText, jobDescription }),
        });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

function scoreColorClass(score) {
    if (score <= 50) return "score-red";
    if (score <= 74) return "score-orange";
    return "score-green";
}

function renderScoreCard(data, slot) {
    if (!data || typeof data.score !== "number") return;

    const score = data.score;
    const cls = scoreColorClass(score);
    const ring = slot === "before" ? scoreBeforeRing : scoreAfterRing;
    const numEl = slot === "before" ? scoreBeforeNum : scoreAfterNum;
    const barEl = slot === "before" ? scoreBeforeBar : scoreAfterBar;

    // Show the card
    scoreCard.hidden = false;
    if (slot === "after") scoreAfterCol.hidden = false;

    // Number
    numEl.textContent = score;

    // Ring colour
    ring.className = `score-ring ${cls}`;

    // Animated bar (defer 1 frame so transition fires)
    barEl.className = `score-bar ${cls}`;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => { barEl.style.width = `${score}%`; });
    });

    // Breakdown chips (only update on "before" to avoid overwriting both)
    if (slot === "before" && data.breakdown) {
        const b = data.breakdown;
        scoreBreakdown.innerHTML = [
            `<span class="score-chip">🔑 Keywords <span class="score-chip-value">${b.keywords?.matched ?? 0}/${b.keywords?.total ?? 0}</span></span>`,
            `<span class="score-chip">📋 Sections <span class="score-chip-value">${b.sections?.found?.length ?? 0}/4</span></span>`,
            `<span class="score-chip">📊 Metrics <span class="score-chip-value">${b.achievements?.quantifiedLines ?? 0} lines</span></span>`,
            `<span class="score-chip">📝 Length <span class="score-chip-value">${b.length?.wordCount ?? 0} words</span></span>`,
        ].join("");
    }
}

// ============================================================
//  URL PASTE FALLBACK — fetch job description via backend
// ============================================================
btnFetchUrl.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) {
        urlFetchStatus.textContent = "Please paste a valid URL.";
        urlFetchStatus.className = "url-fallback-status error";
        return;
    }

    try {
        new URL(url); // validate URL format
    } catch {
        urlFetchStatus.textContent = "Invalid URL format.";
        urlFetchStatus.className = "url-fallback-status error";
        return;
    }

    btnFetchUrl.disabled = true;
    urlFetchStatus.textContent = "Fetching job description…";
    urlFetchStatus.className = "url-fallback-status";

    try {
        const scrapeUrl = BACKEND_URL.replace("/api/generate", "/api/scrape");
        const response = await fetch(scrapeUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
        });

        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body?.error || `Server error: HTTP ${response.status}`);
        }

        const data = await response.json();
        const jobDesc = data?.jobDescription;

        if (!jobDesc || jobDesc.trim().length < 100) {
            throw new Error("Could not extract enough text from that URL.");
        }

        scrapedJobText = jobDesc;
        const wordCount = jobDesc.split(/\s+/).length;
        setExtractStatus(
            "success",
            "✓",
            `Job description fetched (${wordCount} words) — ready to tailor.`
        );
        urlFetchStatus.textContent = "";
        updateGenerateButtonState();

        // Fire before-score (non-blocking)
        chrome.storage.local.get(STORAGE_KEY_RESUME_TEXT).then(stored => {
            const resume = stored[STORAGE_KEY_RESUME_TEXT];
            if (resume) fetchAtsScore(resume, jobDesc).then(d => renderScoreCard(d, "before"));
        }).catch(() => { });
    } catch (err) {
        urlFetchStatus.textContent = err.message;
        urlFetchStatus.className = "url-fallback-status error";
    } finally {
        btnFetchUrl.disabled = false;
    }
});

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

async function extractPdfText(arrayBuffer) {
    const pdfjsLib = globalThis.pdfjsLib;
    if (!pdfjsLib?.getDocument) {
        throw new Error("PDF library not loaded. Please reload the extension.");
    }

    pdfjsLib.GlobalWorkerOptions.workerSrc =
        chrome.runtime.getURL("js/pdf.worker.min.js");

    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    const pages = [];

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const line = (content.items || [])
            .map((it) => (it && typeof it.str === "string" ? it.str : ""))
            .filter(Boolean)
            .join(" ");
        pages.push(line);
    }

    return pages.join("\n\n");
}

async function extractDocxText(arrayBuffer) {
    const mammoth = globalThis.mammoth;
    if (!mammoth?.extractRawText) {
        throw new Error("DOCX library not loaded. Please reload the extension.");
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
        return await extractPdfText(buf);
    }

    if (ext === "doc" || ext === "docx") {
        const buf = await readFileAsArrayBuffer(file);
        return await extractDocxText(buf);
    }

    throw new Error("Unsupported file type. Please upload a PDF, DOCX, or TXT file.");
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

        if (!tailored) {
            throw new Error("The server returned an empty response. Please try again.");
        }

        // Render the result
        renderResult(tailored);
        lastResult = tailored;

        // Persist across sessions
        chrome.storage.local.set({
            [STORAGE_KEY_LAST_RESUME]: tailored,
        });

        btnCopy.disabled = false;
        btnDownload.disabled = false;
        document.getElementById("downloadPDF").disabled = false;
        document.getElementById("downloadDOC").disabled = false;
        previewHint.textContent = "Claude-tailored · Ready to use";

        // After score — show in the ATS Match Score card above
        if (scrapedJobText) {
            fetchAtsScore(tailored, scrapedJobText)
                .then(d => renderScoreCard(d, "after"))
                .catch(() => { });
        }

    } catch (err) {
        console.error("[Resume AI Copilot] Generate call failed", err);
        showError(err.message || "Something went wrong. Please try again.");
    } finally {
        isCalling = false;
        setGenerating(false);
        console.log("[Resume AI Copilot] Generate call finished");
    }
});



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

    const SECTION_HEADINGS = /^(SUMMARY|PROFESSIONAL SUMMARY|EXPERIENCE|WORK EXPERIENCE|SKILLS|TECHNICAL SKILLS|EDUCATION|LICENSES & CERTIFICATIONS|CONTACT INFORMATION)$/im;
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

    const SECTION_HEADINGS = /^(SUMMARY|PROFESSIONAL SUMMARY|EXPERIENCE|WORK EXPERIENCE|SKILLS|TECHNICAL SKILLS|EDUCATION|LICENSES & CERTIFICATIONS|CONTACT INFORMATION)$/im;
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
        STORAGE_KEY_LAST_RESUME,
    ]);

    scrapedJobText = null;
    lastResult = null;
    pickedResumeText = null;

    btnCopy.disabled = true;
    btnDownload.disabled = true;
    document.getElementById("downloadPDF").disabled = true;
    document.getElementById("downloadDOC").disabled = true;
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

// ── SPA Navigation Listener ──────────────────────────────────
// content.js polls for URL changes on LinkedIn and other SPAs.
// When it detects a navigation (e.g. user clicked a different job),
// it sends a "jobPageChanged" message. We re-scrape automatically.
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "jobPageChanged") {
        console.log("[ResumeNest] SPA navigation detected, re-scraping:", message.url);
        showToast("New job detected — re-scanning…", 2000);
        autoScrapeJobDescription();
    }
});
