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
const BACKEND_URL = "https://chromeextensions.vercel.app/Resume/api/generate";

// ── Storage key ───────────────────────────────────────────────
// Only the resume is stored locally now. No API key on the client.
const STORAGE_KEY_RESUME = "resumeai_base_resume";

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
let pickedFileText   = null;   // file content during onboarding
let scrapedJobText   = null;   // job description extracted from active tab
let lastResult       = null;   // last Claude output (for copy/download)

// ============================================================
//  INIT
// ============================================================
async function init() {
  const stored = await chrome.storage.local.get(STORAGE_KEY_RESUME);

  if (stored[STORAGE_KEY_RESUME]) {
    showScreen("main");
    // Auto-scrape immediately — no user action needed
    await autoScrapeJobDescription();
  } else {
    showScreen("onboarding");
  }
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

    const text = results?.[0]?.result ?? "";

    if (text.length < 150) {
      // content.js ran but didn't find enough text
      setExtractStatus("warn",
        "⚠",
        "Couldn't extract enough text. Make sure you're on a job description page."
      );
      // Don't lock the button — let the user try anyway
      btnGenerate.disabled = false;
      return;
    }

    // ── Success ─────────────────────────────────────────────────
    scrapedJobText = text;
    const wordCount = text.split(/\s+/).length;
    setExtractStatus("success",
      "✓",
      `Job description captured (${wordCount} words) — ready to tailor.`
    );
    btnGenerate.disabled = false;

  } catch (err) {
    setExtractStatus("error", "✕", `Could not read page: ${err.message}`);
    // Still enable the button so the user can retry after navigating
    btnGenerate.disabled = false;
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

// Read the picked file as UTF-8 text
function handleFilePicked(file) {
  const reader = new FileReader();

  reader.onload = (e) => {
    pickedFileText = e.target.result;
    fileName.textContent = file.name;
    fileChosen.hidden = false;
    clearSetupError();
  };

  reader.onerror = () => {
    showSetupError("Could not read the file. Please try a .txt export of your resume.");
  };

  reader.readAsText(file);
}

// Clear chosen file
btnClearFile.addEventListener("click", () => {
  pickedFileText  = null;
  fileInput.value = "";
  fileChosen.hidden = true;
});

// Save setup (resume only — no API key in v2)
btnSaveSetup.addEventListener("click", async () => {
  clearSetupError();

  if (!pickedFileText || pickedFileText.trim().length < 50) {
    return showSetupError("Please upload your resume file first.");
  }

  // Persist resume text locally
  await chrome.storage.local.set({
    [STORAGE_KEY_RESUME]: pickedFileText.trim(),
  });

  // Transition to main screen and immediately start scraping
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
  hideError();
  setGenerating(true);

  try {
    // ── Load saved resume ────────────────────────────────────
    const stored = await chrome.storage.local.get(STORAGE_KEY_RESUME);
    const baseResume = stored[STORAGE_KEY_RESUME];

    if (!baseResume) {
      throw new Error("No saved resume found. Please reset and upload your resume again.");
    }

    // ── Use scraped text or re-scrape if missing ─────────────
    let jobText = scrapedJobText;

    if (!jobText || jobText.trim().length < 150) {
      // Re-attempt a scrape in case the user navigated after opening
      await autoScrapeJobDescription();
      jobText = scrapedJobText;
    }

    if (!jobText || jobText.trim().length < 150) {
      throw new Error(
        "Not enough job description text found on this page. " +
        "Navigate to a job posting page and try again."
      );
    }

    // ── POST to the Vercel backend ────────────────────────────
    // The backend holds the Anthropic API key; we never touch it here.
    const response = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resume:         baseResume.trim(),
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
    showError(err.message || "Something went wrong. Please try again.");
  } finally {
    setGenerating(false);
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

  await chrome.storage.local.remove(STORAGE_KEY_RESUME);

  // Reset all runtime state
  scrapedJobText = null;
  lastResult     = null;
  pickedFileText = null;

  btnCopy.disabled     = true;
  btnDownload.disabled = true;
  previewPanel.innerHTML = `
    <div class="preview-placeholder">
      <p>Your Claude-tailored resume will appear here.</p>
      <p>Navigate to a job posting, then click Tailor.</p>
    </div>`;
  previewHint.textContent = "Ready when you are";

  showScreen("onboarding");
});

// ── UI state helpers ──────────────────────────────────────────
function setGenerating(on) {
  btnGenerate.disabled = on;
  genIdle.hidden       = on;
  genLoading.hidden    = !on;
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
