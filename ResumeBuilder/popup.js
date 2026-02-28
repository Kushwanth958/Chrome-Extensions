// ============================================================
//  popup.js – ResumeAI
//  Entry point for the popup. Runs as an ES module (type="module"
//  declared in popup.html) so we can use top-level await.
//
//  Full flow:
//    1. On open: check chrome.storage.local for saved resume + key.
//       → No data  : show onboarding screen.
//       → Has data  : show main screen; populate current tab URL.
//    2. Onboarding: user picks a file + pastes API key → save both → main screen.
//    3. Main screen: "Tailor" button →
//         a. Inject content.js into the active tab to scrape job text.
//         b. Call OpenAI Chat API with the job text + saved resume.
//         c. Render the returned tailored resume in the preview panel.
//    4. Copy / Download act on the last generated result string.
//    5. Reset clears chrome.storage.local and returns to onboarding.
// ============================================================

// ── Storage keys ─────────────────────────────────────────────
// Single source of truth for key names used in chrome.storage.local
const STORAGE_KEY_RESUME  = "resumeai_base_resume";   // plaintext resume content
const STORAGE_KEY_API_KEY = "resumeai_api_key";        // OpenAI secret key

// ── OpenAI config ────────────────────────────────────────────
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL    = "gpt-4o-mini";   // fast + cheap; swap for gpt-4o if preferred
const MAX_TOKENS      = 2000;            // generous limit for a full resume

// ── DOM references ───────────────────────────────────────────
// Onboarding screen
const screenOnboarding = document.getElementById("screen-onboarding");
const dropZone         = document.getElementById("dropZone");
const fileInput        = document.getElementById("fileInput");
const fileChosen       = document.getElementById("fileChosen");
const fileName         = document.getElementById("fileName");
const btnClearFile     = document.getElementById("btnClearFile");
const apiKeyInput      = document.getElementById("apiKeyInput");
const btnSaveSetup     = document.getElementById("btnSaveSetup");
const setupError       = document.getElementById("setupError");

// Main screen
const screenMain    = document.getElementById("screen-main");
const jobUrl        = document.getElementById("jobUrl");
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

// ── State ────────────────────────────────────────────────────
let pickedFileText  = null;   // raw text from the uploaded file (onboarding)
let lastResult      = null;   // last AI-generated resume string (for copy/download)

// ============================================================
//  INIT – runs once when the popup opens
// ============================================================
async function init() {
  // Read both values at once from local storage
  const stored = await chrome.storage.local.get([STORAGE_KEY_RESUME, STORAGE_KEY_API_KEY]);

  if (stored[STORAGE_KEY_RESUME] && stored[STORAGE_KEY_API_KEY]) {
    // Returning user → go straight to main screen
    showScreen("main");
    await populateTabUrl();
  } else {
    // First-time user → show onboarding
    showScreen("onboarding");
  }
}

// ── Show / hide screens ──────────────────────────────────────
function showScreen(name) {
  // Toggle the `hidden` attribute to switch between screens.
  // Removing `hidden` triggers the CSS @keyframes screenIn animation.
  if (name === "onboarding") {
    screenMain.hidden       = true;
    screenOnboarding.hidden = false;
  } else {
    screenOnboarding.hidden = true;
    screenMain.hidden       = false;
  }
}

// ── Populate the job URL strip ───────────────────────────────
// Reads the URL of the currently active tab and displays it.
async function populateTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    jobUrl.textContent = tab?.url || "—";
  } catch {
    jobUrl.textContent = "Unable to read tab URL";
  }
}

// ============================================================
//  ONBOARDING LOGIC
// ============================================================

// ── Drop zone: click to open file picker ────────────────────
dropZone.addEventListener("click", () => fileInput.click());

// ── Drag-over visual feedback ────────────────────────────────
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

// ── File dropped on the drop zone ────────────────────────────
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFilePicked(file);
});

// ── File chosen via the <input type="file"> ──────────────────
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) handleFilePicked(file);
});

// ── Process the picked file ──────────────────────────────────
// We read it as plain text. PDF & DOCX will come through garbled,
// so we instruct users to use .txt for best results — or you can
// integrate pdf.js / mammoth.js for richer parsing later.
function handleFilePicked(file) {
  const reader = new FileReader();

  reader.onload = (e) => {
    pickedFileText = e.target.result;   // raw text content
    fileName.textContent = file.name;
    fileChosen.hidden = false;
    clearSetupError();
  };

  reader.onerror = () => {
    showSetupError("Could not read the file. Please try a .txt export of your resume.");
  };

  reader.readAsText(file);  // reads as UTF-8 text
}

// ── Clear selected file ──────────────────────────────────────
btnClearFile.addEventListener("click", () => {
  pickedFileText = null;
  fileInput.value = "";
  fileChosen.hidden = true;
});

// ── Save setup: validate → store → switch to main ────────────
btnSaveSetup.addEventListener("click", async () => {
  clearSetupError();

  // Validate: resume text must be present
  if (!pickedFileText || pickedFileText.trim().length === 0) {
    return showSetupError("Please upload your resume file first.");
  }

  // Validate: API key must start with "sk-"
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey.startsWith("sk-")) {
    return showSetupError("Please enter a valid OpenAI API key (starts with sk-).");
  }

  // Persist both values in chrome.storage.local
  // This survives popup closes and browser restarts.
  await chrome.storage.local.set({
    [STORAGE_KEY_RESUME]:  pickedFileText.trim(),
    [STORAGE_KEY_API_KEY]: apiKey,
  });

  // Transition to main screen
  showScreen("main");
  await populateTabUrl();
});

// ── Setup error helpers ──────────────────────────────────────
function showSetupError(msg) {
  setupError.textContent = msg;
  setupError.hidden = false;
}

function clearSetupError() {
  setupError.hidden = true;
  setupError.textContent = "";
}

// ============================================================
//  MAIN SCREEN LOGIC
// ============================================================

// ── Generate button: full tailor flow ────────────────────────
btnGenerate.addEventListener("click", async () => {
  hideError();
  setGenerating(true);

  try {
    // STEP 1 – Retrieve saved data from storage
    const stored = await chrome.storage.local.get([STORAGE_KEY_RESUME, STORAGE_KEY_API_KEY]);
    const baseResume = stored[STORAGE_KEY_RESUME];
    const apiKey     = stored[STORAGE_KEY_API_KEY];

    if (!baseResume || !apiKey) {
      throw new Error("Saved resume or API key missing. Please reset and set up again.");
    }

    // STEP 2 – Inject content.js into the active tab to scrape job text
    const jobText = await scrapeJobDescription();

    if (!jobText || jobText.trim().length < 100) {
      throw new Error(
        "Could not extract enough text from this page. " +
        "Make sure you're on a job description page and try again."
      );
    }

    // STEP 3 – Call the OpenAI API
    const tailoredResume = await callOpenAI(apiKey, baseResume, jobText);

    // STEP 4 – Render the result
    renderResult(tailoredResume);
    lastResult = tailoredResume;

    // Enable copy & download
    btnCopy.disabled     = false;
    btnDownload.disabled = false;
    previewHint.textContent = "AI-tailored · ready to use";

  } catch (err) {
    showError(err.message || "Something went wrong. Please try again.");
  } finally {
    setGenerating(false);
  }
});

// ── Inject content.js and return the scraped text ────────────
//
// chrome.scripting.executeScript injects the file into the active tab
// and returns whatever the script's last expression evaluated to.
// content.js returns a string (see content.js).
async function scrapeJobDescription() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) throw new Error("No active tab found.");

  // chrome:// and extension pages can't be scripted — guard against that.
  if (!tab.url?.startsWith("http")) {
    throw new Error(
      "ResumeAI can only read job pages on regular websites (http/https)."
    );
  }

  // executeScript returns an array of results (one per tab/frame).
  // We only target the main frame of the active tab, so result[0] is ours.
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: false },
    files:  ["content.js"],   // path relative to extension root
  });

  return results?.[0]?.result ?? "";
}

// ── Call the OpenAI Chat Completions API ─────────────────────
//
// Builds a two-message conversation:
//   system  → instructs the model on the task
//   user    → supplies both the resume and the job description
//
// Returns the assistant's message text (the tailored resume).
async function callOpenAI(apiKey, baseResume, jobDescription) {
  const systemPrompt = `You are an expert resume writer and ATS optimization specialist.
Your job is to rewrite the user's resume so it is perfectly tailored to the provided job description.

Rules:
- Keep all factual details (companies, titles, dates, education) exactly as given — never invent information.
- Reorder, rephrase, and emphasize bullet points to match the job's keywords and requirements.
- Use strong action verbs and quantify achievements where the original data supports it.
- Mirror the language and terminology used in the job description for ATS compatibility.
- Keep the output concise, scannable, and professional — no fluff.
- Output plain text formatted as a standard resume (no markdown, no JSON).`;

  const userPrompt = `Here is my current resume:\n\n${baseResume}\n\n` +
                     `Here is the job description I am applying to:\n\n${jobDescription}\n\n` +
                     `Please rewrite my resume to be perfectly tailored to this job.`;

  const response = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model:      OPENAI_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
    }),
  });

  // Handle non-2xx HTTP responses
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(`OpenAI API error: ${detail}`);
  }

  const data = await response.json();

  // Extract the assistant's reply text
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI returned an empty response. Please try again.");

  return text.trim();
}

// ── Render the tailored resume in the preview panel ──────────
function renderResult(text) {
  previewPanel.innerHTML = "";  // clear placeholder / previous result

  const pre = document.createElement("pre");
  pre.className = "preview-result";
  pre.textContent = text;   // textContent is safe — no XSS risk

  previewPanel.appendChild(pre);
}

// ── Copy result to clipboard ─────────────────────────────────
btnCopy.addEventListener("click", async () => {
  if (!lastResult) return;
  try {
    await navigator.clipboard.writeText(lastResult);
    showToast("Copied to clipboard ✓");
  } catch {
    showToast("Copy failed — try selecting text manually.");
  }
});

// ── Download result as a .txt file ───────────────────────────
// We create a temporary <a> element, set its href to a Blob URL,
// and programmatically click it. Chrome will prompt a file save.
btnDownload.addEventListener("click", () => {
  if (!lastResult) return;

  const blob = new Blob([lastResult], { type: "text/plain" });
  const url  = URL.createObjectURL(blob);

  const a    = document.createElement("a");
  a.href     = url;
  a.download = "tailored-resume.txt";
  a.click();

  // Clean up the object URL to free memory
  URL.revokeObjectURL(url);
  showToast("Download started ✓");
});

// ── Reset: wipe storage and return to onboarding ─────────────
btnReset.addEventListener("click", async () => {
  const confirmed = confirm(
    "This will clear your saved resume and API key. You'll need to set up again."
  );
  if (!confirmed) return;

  await chrome.storage.local.remove([STORAGE_KEY_RESUME, STORAGE_KEY_API_KEY]);

  // Reset UI state
  lastResult       = null;
  pickedFileText   = null;
  apiKeyInput.value = "";
  previewPanel.innerHTML = `
    <div class="preview-placeholder">
      <p>Your AI-tailored resume will appear here.</p>
      <p>Open a job posting, then click the button above.</p>
    </div>`;
  previewHint.textContent = 'Click "Tailor" to generate';
  btnCopy.disabled     = true;
  btnDownload.disabled = true;

  showScreen("onboarding");
});

// ── Loading state helpers ────────────────────────────────────
function setGenerating(isGenerating) {
  btnGenerate.disabled = isGenerating;
  genIdle.hidden       = isGenerating;
  genLoading.hidden    = !isGenerating;
}

// ── Error banner helpers ─────────────────────────────────────
function showError(msg) {
  errorMsg.textContent = msg;
  errorBanner.hidden   = false;
}

function hideError() {
  errorBanner.hidden = true;
  errorMsg.textContent = "";
}

// ── Toast helper ─────────────────────────────────────────────
let toastTimer = null;

function showToast(msg, duration = 2500) {
  toast.textContent = msg;
  toast.classList.add("show");

  // Clear any existing timer so rapid calls don't overlap
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), duration);
}

// ── Kick off ─────────────────────────────────────────────────
init();
