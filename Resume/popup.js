// ============================================================
//  popup.js – ResumeAI v2
//  ES module (type="module" set in popup.html).
//
//  What changed from v1:
//    - ANTHROPIC_API_KEY is gone from the client entirely.
//    - All AI calls go through the Vercel serverless function
//      at BACKEND_URL. The key lives only on Vercel.
//    - Onboarding only asks for the base resume file (no API key field).
//    - content.js is injected immediately when the main screen opens,
//      not on button click. The job description is auto-scraped.
//    - The Generate button is disabled until scraping completes.
//    - Claude's output is rendered with highlighted section headings.
//
//  Full flow:
//    1. Popup opens → check chrome.storage.local for saved resume.
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
// Point this at your deployed Vercel project URL.
// During local development you can use: "http://localhost:3000/api/generate"
const BACKEND_URL = "https://chromeextensions.vercel.app/api/generate";

// ── Storage key ───────────────────────────────────────────────
// Store only extracted plain text. Never store/send binary.
// Requirement: save to chrome.storage.local with key `resumeText`.
const STORAGE_KEY_RESUME_TEXT = "resumeText";
// Legacy v2 key (base64 object). We no longer use it, but we remove it on reset/save.
const LEGACY_STORAGE_KEY_RESUME = "resumeai_base_resume";

// ── DOM — Onboarding screen ───────────────────────────────────
const screenOnboarding = document.getElementById("screen-onboarding");
const dropZone         = document.getElementById("dropZone");
const fileInput        = document.getElementById("fileInput");
const fileChosen       = document.getElementById("fileChosen");
const fileName         = document.getElementById("fileName");
const btnClearFile     = document.getElementById("btnClearFile");
const btnSaveSetup     = document.getElementById("btnSaveSetup");
const setupError       = document.getElementById("setupError");

// ── DOM — Main screen ─────────────────────────────────────────
const screenMain    = document.getElementById("screen-main");
const jobUrl        = document.getElementById("jobUrl");
const extractStatus = document.getElementById("extractStatus");
const extractIcon   = document.getElementById("extractIcon");
const extractText   = document.getElementById("extractText");
const btnGenerate   = document.getElementById("btnGenerate");
const genIdle       = btnGenerate.querySelector(".gen-idle");
const genLoading    = btnGenerate.querySelector(".gen-loading");
const errorBanner   = document.getElementById("errorBanner");
const errorMsg      = document.getElementById("errorMsg");
const previewPanel  = document.getElementById("previewPanel");
const previewHint   = document.getElementById("previewHint");
const btnCopy       = document.getElementById("btnCopy");
const btnDownload   = document.getElementById("btnDownload");
const btnReset      = document.getElementById("btnReset");
const toast         = document.getElementById("toast");

// ── State ─────────────────────────────────────────────────────
let pickedResumeText = null;   // plain resume text during onboarding
let scrapedJobText   = null;   // job description extracted from active tab
let lastResult       = null;   // last Claude output (for copy/download)

// Gemini / backend call protections
let isCalling          = false;           // true while a generate call is in flight
let lastCallTimestamp  = 0;               // ms since epoch when the last call started
let lastClickTimestamp = 0;               // for debounce of rapid clicks

const CLICK_DEBOUNCE_MS = 500;            // ignore clicks inside this window
const CALL_COOLDOWN_MS  = 15_000;         // minimum gap between generate calls (15s)

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
  // Reset UI state on popup open so the spinner is never shown
  // unless a real backend call is in flight.
  isCalling = false;
  setGenerating(false);
  hideError();
  btnCopy.disabled = true;
  btnDownload.disabled = true;
  lastResult = null;

  const stored = await chrome.storage.local.get([
    STORAGE_KEY_RESUME_TEXT,
    LEGACY_STORAGE_KEY_RESUME,
  ]);

  if (typeof stored[STORAGE_KEY_RESUME_TEXT] === "string" && stored[STORAGE_KEY_RESUME_TEXT].trim()) {
    // Restore plain resume text into memory for this popup session.
    pickedResumeText = stored[STORAGE_KEY_RESUME_TEXT];

    showScreen("main");
    // Resume already saved from a previous session:
    // start with Tailor disabled, then scan the current page.
    updateGenerateButtonState();
    showToast("Resume loaded \u2713", 1800);
    await autoScrapeJobDescription();
  } else {
    // If legacy base64 resume exists, force re-upload (we no longer send binary).
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
    screenMain.hidden       = true;
    screenOnboarding.hidden = false;
  } else {
    screenOnboarding.hidden = true;
    screenMain.hidden       = false;
  }
}

// ============================================================
//  AUTO-SCRAPE — runs as soon as the main screen is shown
// ============================================================
async function autoScrapeJobDescription() {
  // ── Show the current tab URL ────────────────────────────────
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    jobUrl.textContent = tab?.url ?? "—";
  } catch {
    jobUrl.textContent = "Unable to read tab";
  }

  // ── Guard: only HTTP pages can be scripted ──────────────────
  if (!tab?.url?.startsWith("http")) {
    setExtractStatus("warn",
      "⚠",
      "Open a job posting page, then click the extension icon again."
    );
    return;
  }

  // ── Inject content.js and await the result ──────────────────
  setExtractStatus("loading", "⏳", "Reading job description…");

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files:  ["content.js"],
    });

    const raw = results?.[0]?.result;

    // Support both the new structured shape from content.js and
    // older plain-string returns for backwards compatibility.
    const payload = (raw && typeof raw === "object" && "isJobPage" in raw)
      ? raw
      : { isJobPage: true, text: typeof raw === "string" ? raw : "" };

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

    if (text.length < 150) {
      setExtractStatus(
        "warn",
        "⚠",
        "Couldn't extract enough text. Make sure you're on a job description page."
      );
      scrapedJobText = null;
      updateGenerateButtonState();
      return;
    }

    // ── Success ─────────────────────────────────────────────────
    scrapedJobText = text;
    const wordCount = text.split(/\s+/).length;
    setExtractStatus(
      "success",
      "✓",
      `Job description captured (${wordCount} words) — ready to tailor.`
    );
    updateGenerateButtonState();

  } catch (err) {
    setExtractStatus("error", "✕", `Could not read page: ${err.message}`);
    // On error we keep Tailor disabled until a successful scan.
    scrapedJobText = null;
    updateGenerateButtonState();
  }
}

// ── Extract status helper ─────────────────────────────────────
// state: "loading" | "success" | "warn" | "error"
function setExtractStatus(state, icon, text) {
  extractStatus.className = "extract-status";   // reset modifiers
  if (state === "success") extractStatus.classList.add("is-success");
  if (state === "warn")    extractStatus.classList.add("is-warn");
  if (state === "error")   extractStatus.classList.add("is-error");

  extractIcon.textContent = icon;
  extractText.textContent = text;
}

// ============================================================
//  ONBOARDING
// ============================================================

// Click drop zone → open file picker
dropZone.addEventListener("click", () => fileInput.click());

// Drag-over effects
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));

// File dropped
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFilePicked(file);
});

// File picker changed
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

  // Required for PDF.js when loaded from CDN.
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

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

// Read the picked file and extract plain text (never base64)
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
    // Persist immediately after successful extraction.
    await chrome.storage.local.set({ [STORAGE_KEY_RESUME_TEXT]: text });
    await chrome.storage.local.remove(LEGACY_STORAGE_KEY_RESUME);

    fileName.textContent = file.name;
    fileChosen.hidden = false;
    updateGenerateButtonState();
  } catch (err) {
    console.error("[ResumeAI][popup] Resume text extraction failed", err);
    pickedResumeText = null;
    fileChosen.hidden = true;
    showSetupError(
      "This file could not be read. Please try uploading a .txt version of your resume."
    );
    updateGenerateButtonState();
  }
}

// Clear chosen file
btnClearFile.addEventListener("click", async () => {
  pickedResumeText = null;
  fileInput.value = "";
  fileChosen.hidden = true;
  await chrome.storage.local.remove(STORAGE_KEY_RESUME_TEXT);
  updateGenerateButtonState();
});

// Save setup (resume only — no API key in v2)
btnSaveSetup.addEventListener("click", async () => {
  clearSetupError();

  if (
    typeof pickedResumeText !== "string" ||
    pickedResumeText.trim().length === 0
  ) {
    return showSetupError("Please upload your resume file first.");
  }

  // Persist plain extracted text locally
  await chrome.storage.local.set({
    [STORAGE_KEY_RESUME_TEXT]: pickedResumeText.trim(),
  });
  // Ensure legacy binary payload is not kept around.
  await chrome.storage.local.remove(LEGACY_STORAGE_KEY_RESUME);

  // Transition to main screen and immediately start scraping the
  // current page for a job description. Tailor remains disabled
  // until a valid job description is found.
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
  console.log("[ResumeAI][popup] Tailor button clicked at", new Date(now).toISOString());

  // ── Debounce rapid clicks ─────────────────────────────────────
  if (now - lastClickTimestamp < CLICK_DEBOUNCE_MS) {
    console.log("[ResumeAI][popup] Ignoring click (debounced)");
    return;
  }
  lastClickTimestamp = now;

  // ── Prevent duplicate in-flight calls ─────────────────────────
  if (isCalling) {
    console.log("[ResumeAI][popup] Ignoring click (call already in progress)");
    return;
  }

  // ── Enforce cooldown between calls ────────────────────────────
  if (lastCallTimestamp && now - lastCallTimestamp < CALL_COOLDOWN_MS) {
    const remainingMs = CALL_COOLDOWN_MS - (now - lastCallTimestamp);
    const remainingSec = Math.ceil(remainingMs / 1000);
    console.log("[ResumeAI][popup] Ignoring click (cooldown active)", {
      remainingMs,
      remainingSec,
    });
    showError(`Please wait ${remainingSec}s before generating another tailored resume.`);
    return;
  }

  hideError();
  isCalling = true;
  lastCallTimestamp = now;
  setGenerating(true);
  console.log("[ResumeAI][popup] Starting backend generate call", {
    backendUrl: BACKEND_URL,
  });

  try {
    // ── Load saved resume ────────────────────────────────────
    const stored = await chrome.storage.local.get(STORAGE_KEY_RESUME_TEXT);
    const baseResumeText = stored[STORAGE_KEY_RESUME_TEXT];

    if (typeof baseResumeText !== "string" || !baseResumeText.trim()) {
      throw new Error("Saved resume is invalid. Please reset and upload your resume again.");
    }

    // Keep in-memory copy in sync (plain text)
    pickedResumeText = baseResumeText;

    // ── Use scraped text — Tailor should only be reachable after
    // a successful scan that detected a job description.
    const jobText = scrapedJobText;

    if (!jobText || jobText.trim().length < 150) {
      throw new Error(
        "No job description detected on this page. Please navigate to a job posting and try again."
      );
    }

    // ── POST to the Vercel backend ────────────────────────────
    // The backend holds the Anthropic API key; we never touch it here.
    const response = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resumeText:     baseResumeText.trim(),
        jobDescription: jobText.trim(),
      }),
    });

    // ── Handle HTTP errors from our backend ──────────────────
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body?.error || `Server error: HTTP ${response.status}`);
    }

    const data = await response.json();
    const tailored = data?.tailoredResume;

    if (!tailored) {
      throw new Error("The server returned an empty response. Please try again.");
    }

    // ── Render the result ─────────────────────────────────────
    renderResult(tailored);
    lastResult = tailored;

    btnCopy.disabled     = false;
    btnDownload.disabled = false;
    previewHint.textContent = "Claude-tailored · ATS-ready";

  } catch (err) {
    console.error("[ResumeAI][popup] Generate call failed", err);
    showError(err.message || "Something went wrong. Please try again.");
  } finally {
    isCalling = false;
    setGenerating(false);
    console.log("[ResumeAI][popup] Backend generate call finished");
  }
});

// ── Render the tailored resume ────────────────────────────────
// Highlights section headings (SUMMARY, EXPERIENCE, SKILLS, EDUCATION)
// that Claude is instructed to output, making the preview scannable.
function renderResult(text) {
  previewPanel.innerHTML = "";

  const SECTION_HEADINGS = /^(SUMMARY|EXPERIENCE|SKILLS|EDUCATION)$/im;

  const pre = document.createElement("pre");
  pre.className = "preview-result";

  // Split on lines; wrap section headings in a styled <span>
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (SECTION_HEADINGS.test(line.trim())) {
      const span = document.createElement("span");
      span.className   = "section-heading";
      span.textContent = line.trim().toUpperCase();
      pre.appendChild(span);
    } else {
      pre.appendChild(document.createTextNode(line + (i < lines.length - 1 ? "\n" : "")));
    }
  });

  previewPanel.appendChild(pre);
}

// ── Copy ──────────────────────────────────────────────────────
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
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = "tailored-resume.txt";
  a.click();
  URL.revokeObjectURL(url);
  showToast("Download started ✓");
});

// ── Reset: clear storage → back to onboarding ────────────────
btnReset.addEventListener("click", async () => {
  const confirmed = confirm(
    "This will clear your saved resume. You'll need to upload it again."
  );
  if (!confirmed) return;

  await chrome.storage.local.remove([STORAGE_KEY_RESUME_TEXT, LEGACY_STORAGE_KEY_RESUME]);

  // Reset all runtime state
  scrapedJobText = null;
  lastResult     = null;
  pickedResumeText = null;

  btnCopy.disabled     = true;
  btnDownload.disabled = true;
  previewPanel.innerHTML = `
    <div class="preview-placeholder">
      <p>Your Claude-tailored resume will appear here.</p>
      <p>Navigate to a job posting, then click Tailor.</p>
    </div>`;
  previewHint.textContent = "Ready when you are";

  showScreen("onboarding");
  updateGenerateButtonState();
});

// ── UI state helpers ──────────────────────────────────────────
function setGenerating(on) {
  genIdle.hidden       = on;
  genLoading.hidden    = !on;
  updateGenerateButtonState();
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorBanner.hidden   = false;
}

function hideError() {
  errorBanner.hidden   = true;
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
