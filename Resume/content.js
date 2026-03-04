// ============================================================
//  content.js – ResumeNest
//
//  Injected on-demand by sidepanel.js via executeScript.
//  Universal job description extraction with dynamic DOM waiting.
//
//  Strategy:
//    1. Wait for DOM content to load (poll body text length)
//    2. Try known selectors
//    3. Find largest readable text block
//    4. Fallback to document.body.innerText
//
//  Returns: { isJobPage: boolean, text: string, reason: string }
// ============================================================

(async function extractJobDescription() {

  console.log("[ResumeNest] Starting job description extraction...");

  const MIN_LENGTH = 200;

  // ── Helpers ─────────────────────────────────────────────────

  function cleanText(raw) {
    return raw
      .replace(/\s+/g, " ")
      .replace(/\n{2,}/g, "\n\n")
      .trim();
  }

  function trySelectors(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const text = cleanText(el.innerText || el.textContent || "");
        if (text.length >= MIN_LENGTH) {
          return text;
        }
      } catch { }
    }
    return null;
  }

  // ── STEP 0: Wait for dynamic DOM content ───────────────────
  // Poll every 300ms until body text > 1000 chars or 6s timeout
  const MAX_WAIT = 6000;
  const POLL_INTERVAL = 300;
  const BODY_THRESHOLD = 1000;

  await new Promise((resolve) => {
    const start = Date.now();

    const timer = setInterval(() => {
      const bodyLen = (document.body?.innerText || "").length;

      if (bodyLen > BODY_THRESHOLD || Date.now() - start >= MAX_WAIT) {
        clearInterval(timer);
        console.log("[ResumeNest] DOM ready. Body text length:", bodyLen, "| Waited:", Date.now() - start, "ms");
        resolve();
      }
    }, POLL_INTERVAL);
  });

  // ── STEP 1: Try known selectors ────────────────────────────
  const SELECTORS = [
    // LinkedIn
    ".jobs-description__content",
    ".jobs-box__html-content",
    ".jobs-description-content__text",
    "About the job",
    "[class*='jobs-description']",

    // Indeed
    "#jobDescriptionText",
    ".jobsearch-jobDescriptionText",

    // Greenhouse
    ".job__description",
    ".job-post-content",

    // Lever
    ".posting-description",

    // Workday
    "[data-automation-id='jobPostingDescription']",

    // iCIMS / SmartRecruiters / Ashby
    ".iCIMS_JobContent",
    ".job-sections",
    ".ashby-job-posting-brief-description",

    // Generic
    ".jobs-description",
    ".job-description",
    "#job-description",
    "#jobDescription",
    ".jobDescription",
    "main",
    "article",
    "[role='main']",
  ];

  const selectorText = trySelectors(SELECTORS);
  if (selectorText) {
    console.log("[ResumeNest] Extraction method: selector_match");
    console.log("[ResumeNest] Extracted text length:", selectorText.length);
    return {
      isJobPage: true,
      text: selectorText,
      reason: "selector_match",
    };
  }

  // ── STEP 2: Largest readable text block ────────────────────
  // Search all block elements, ignore nav/footer/header/aside,
  // pick the one with the most text (>500 chars)
  console.log("[ResumeNest] Selectors failed — searching for largest text block...");

  const SKIP_TAGS = new Set(["NAV", "FOOTER", "HEADER", "ASIDE"]);

  function isInsideSkipped(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      if (SKIP_TAGS.has(node.tagName)) return true;
      node = node.parentElement;
    }
    return false;
  }

  let bestText = "";
  let bestLength = 0;
  const candidates = document.querySelectorAll("div, section, article, main");

  for (const el of candidates) {
    // Skip elements inside nav, footer, header, aside
    if (isInsideSkipped(el)) continue;

    // Skip hidden elements
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
    } catch { continue; }

    const text = (el.innerText || "").trim();

    if (text.length > 500 && text.length > bestLength) {
      bestLength = text.length;
      bestText = text;
    }
  }

  if (bestText) {
    const cleaned = cleanText(bestText);
    console.log("[ResumeNest] Extraction method: largest_block");
    console.log("[ResumeNest] Extracted text length:", cleaned.length);
    return {
      isJobPage: true,
      text: cleaned,
      reason: "largest_block",
    };
  }

  // ── STEP 3: Full body text fallback ────────────────────────
  const bodyText = cleanText(document.body?.innerText || "");
  console.log("[ResumeNest] Extraction method: body_fallback");
  console.log("[ResumeNest] Extracted text length:", bodyText.length);

  if (bodyText.length < MIN_LENGTH) {
    return {
      isJobPage: false,
      text: "",
      reason: "not_enough_text",
    };
  }

  return {
    isJobPage: true,
    text: bodyText.slice(0, 8000),
    reason: "body_fallback",
  };

})();

// ── SPA Navigation Detection ─────────────────────────────────
if (!window.__resumeNest_spaWatcher) {
  window.__resumeNest_spaWatcher = true;
  let lastUrl = location.href;

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      console.log("[ResumeNest] SPA navigation detected:", lastUrl);
      try {
        chrome.runtime.sendMessage({ action: "jobPageChanged", url: lastUrl });
      } catch { }
    }
  }, 1000);
}
