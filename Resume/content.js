// ============================================================
//  content.js – Resume AI Copilot
//
//  Injected on-demand into the active tab by sidepanel.js via
//  chrome.scripting.executeScript when the panel requests a read.
//  This script NEVER performs any network or API calls; it only
//  reads from the DOM and returns plain text to the side panel.
//
//  Strategy:
//    1. Wait for dynamic content to load (MutationObserver + timeout).
//    2. Try known job-board CSS selectors first (fast, precise).
//    3. Fall back to a heuristic that finds the largest block of
//       prose text on the page (works on any site).
//    4. Clean and return the text so sidepanel.js can pass it to Claude.
//
//  Return value: { isJobPage, text, reason }
//  chrome.scripting.executeScript captures the resolved value of
//  the async IIFE as the result.
// ============================================================

(async function extractJobDescription() {

  console.log("[Resume AI Copilot][content] Extracting job description from DOM (with dynamic wait).");

  // ── Config ──────────────────────────────────────────────────
  const MIN_LENGTH = 200;
  const MAX_WAIT_MS = 6000;       // max time to wait for dynamic content
  const POLL_INTERVAL_MS = 300;   // how often to check for selectors

  const KEY_PHRASES = [
    "job description",
    "responsibilities",
    "requirements",
    "qualifications",
    "experience required",
    "about the role",
    "what you will do",
    "what you'll do",
    "who you are",
    "about this role",
    "role overview",
    "position summary",
    "job summary",
    "key responsibilities",
    "minimum qualifications",
    "preferred qualifications",
  ];

  // ── Known selectors on major job boards ─────────────────────
  // Listed in priority order. First match with enough text wins.
  const KNOWN_SELECTORS = [
    // ─── LinkedIn ───
    ".jobs-description__content",
    ".jobs-box__html-content",
    ".jobs-description-content__text",
    ".jobs-unified-top-card__job-insight",
    "[class*='jobs-description']",
    ".job-view-layout",

    // ─── Indeed ───
    "#jobDescriptionText",
    ".jobsearch-jobDescriptionText",
    ".jobsearch-JobComponent-description",

    // ─── Greenhouse ───
    "#content",
    ".job__description",
    ".job-post-content",
    "#app_body",

    // ─── Lever ───
    ".posting-description",
    ".section-wrapper",
    ".posting-page",

    // ─── Workday ───
    "[data-automation-id='jobPostingDescription']",
    ".css-kyg8or",

    // ─── Workable ───
    ".job-description",
    ".job-description-wrapper",

    // ─── SmartRecruiters ───
    ".job-sections",
    ".job-ad-display",

    // ─── Ashby ───
    ".ashby-job-posting-brief-description",

    // ─── iCIMS ───
    ".iCIMS_JobContent",

    // ─── Generic fallbacks ───
    "[class*='job-description']",
    "[class*='jobDescription']",
    "[class*='job_description']",
    "[id*='job-description']",
    "[id*='jobDescription']",
    "article",
    "main",
  ];

  // ── Priority selectors (sites with dynamic rendering) ──────
  // These are checked first during the MutationObserver wait loop.
  // If any of these match, we know the dynamic content has loaded.
  const DYNAMIC_SELECTORS = [
    // LinkedIn (React-rendered)
    ".jobs-description__content",
    ".jobs-box__html-content",
    ".jobs-description-content__text",
    // Indeed
    "#jobDescriptionText",
    // Greenhouse
    "#content .job__description",
    // Lever
    ".posting-description",
  ];

  // ── Helpers ─────────────────────────────────────────────────

  function collapseWhitespace(str) {
    return str
      .replace(/\r\n/g, "\n")
      .replace(/\t/g, " ")
      .replace(/ {2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function pageLooksLikeJob(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return KEY_PHRASES.some((phrase) => lower.includes(phrase));
  }

  function trySelectors(selectors) {
    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        if (!el) continue;
        const text = collapseWhitespace(el.innerText || el.textContent || "");
        if (text.length >= MIN_LENGTH) {
          return { el, text, selector };
        }
      } catch {
        // Invalid selector — skip
      }
    }
    return null;
  }

  // ── 0. QUICK PAGE-LEVEL CHECK ──────────────────────────────
  const fullPageText = collapseWhitespace(document.body?.innerText || "");
  const isLikelyJobPage = pageLooksLikeJob(fullPageText);

  // For known job portals, skip the keyword check — we trust the URL.
  const hostname = location.hostname.toLowerCase();
  const isKnownJobSite =
    hostname.includes("linkedin.com") ||
    hostname.includes("indeed.com") ||
    hostname.includes("greenhouse.io") ||
    hostname.includes("lever.co") ||
    hostname.includes("workday.com") ||
    hostname.includes("smartrecruiters.com") ||
    hostname.includes("ashbyhq.com") ||
    hostname.includes("icims.com") ||
    hostname.includes("workable.com");

  if (!isLikelyJobPage && !isKnownJobSite) {
    return {
      isJobPage: false,
      text: "",
      reason: "no_job_keywords",
    };
  }

  // ── 1. IMMEDIATE SELECTOR CHECK ────────────────────────────
  // Try selectors right away — works on static pages.
  const immediateMatch = trySelectors(KNOWN_SELECTORS);
  if (immediateMatch) {
    console.log(`[Resume AI Copilot][content] Matched selector: ${immediateMatch.selector} (${immediateMatch.text.length} chars)`);
    return {
      isJobPage: true,
      text: immediateMatch.text,
      reason: "selector_match",
    };
  }

  // ── 2. WAIT FOR DYNAMIC CONTENT (MutationObserver) ─────────
  // LinkedIn and other React-based sites load job descriptions
  // after the initial DOM render. We observe DOM mutations and
  // poll for our target selectors.
  console.log("[Resume AI Copilot][content] No immediate match — waiting for dynamic content…");

  const dynamicResult = await new Promise((resolve) => {
    let resolved = false;

    function finish(result) {
      if (resolved) return;
      resolved = true;
      if (observer) observer.disconnect();
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve(result);
    }

    // Poll for selectors periodically
    const pollTimer = setInterval(() => {
      // Try priority dynamic selectors first
      const dynamicMatch = trySelectors(DYNAMIC_SELECTORS);
      if (dynamicMatch) {
        console.log(`[Resume AI Copilot][content] Dynamic match: ${dynamicMatch.selector} (${dynamicMatch.text.length} chars)`);
        finish({
          isJobPage: true,
          text: dynamicMatch.text,
          reason: "dynamic_selector_match",
        });
        return;
      }

      // Then try all selectors
      const allMatch = trySelectors(KNOWN_SELECTORS);
      if (allMatch) {
        console.log(`[Resume AI Copilot][content] Delayed selector match: ${allMatch.selector} (${allMatch.text.length} chars)`);
        finish({
          isJobPage: true,
          text: allMatch.text,
          reason: "delayed_selector_match",
        });
      }
    }, POLL_INTERVAL_MS);

    // MutationObserver to trigger re-checks on DOM changes
    const observer = new MutationObserver(() => {
      const match = trySelectors(DYNAMIC_SELECTORS);
      if (match) {
        console.log(`[Resume AI Copilot][content] Observer match: ${match.selector} (${match.text.length} chars)`);
        finish({
          isJobPage: true,
          text: match.text,
          reason: "observer_match",
        });
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Timeout fallback — don't wait forever
    const timeoutTimer = setTimeout(() => {
      console.log("[Resume AI Copilot][content] Dynamic wait timed out after", MAX_WAIT_MS, "ms");
      finish(null); // null = no dynamic match found
    }, MAX_WAIT_MS);
  });

  if (dynamicResult) {
    return dynamicResult;
  }

  // ── 3. HEURISTIC FALLBACK ──────────────────────────────────
  // Walk every block-level element and score by text length.
  // The longest prose block is most likely the job description.
  console.log("[Resume AI Copilot][content] Falling back to heuristic block detection.");

  const BLOCK_TAGS = new Set([
    "DIV", "SECTION", "ARTICLE", "MAIN",
    "P", "UL", "OL", "TABLE"
  ]);

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME",
    "HEADER", "FOOTER", "NAV", "ASIDE", "FORM"
  ]);

  let bestElement = null;
  let bestLength = 0;

  const candidates = document.querySelectorAll(
    "div, section, article, main"
  );

  for (const el of candidates) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (SKIP_TAGS.has(el.tagName)) continue;

    const directBlockChildren = [...el.children].filter(
      (c) => BLOCK_TAGS.has(c.tagName)
    ).length;
    if (directBlockChildren > 12) continue;

    const text = collapseWhitespace(el.innerText || el.textContent || "");
    if (text.length > bestLength) {
      bestLength = text.length;
      bestElement = el;
    }
  }

  if (bestElement && bestLength >= MIN_LENGTH) {
    return {
      isJobPage: true,
      text: collapseWhitespace(bestElement.innerText || bestElement.textContent),
      reason: "heuristic_block",
    };
  }

  // ── 4. LAST RESORT ────────────────────────────────────────
  const bodyText = collapseWhitespace(document.body?.innerText || "");
  if (!bodyText) {
    return {
      isJobPage: false,
      text: "",
      reason: "empty_body",
    };
  }

  return {
    isJobPage: true,
    text: bodyText.slice(0, 8000),
    reason: "full_body_fallback",
  };

})();
