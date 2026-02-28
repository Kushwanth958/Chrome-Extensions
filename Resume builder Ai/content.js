// ============================================================
//  content.js – ResumeAI
//
//  Injected on-demand into the active tab by popup.js via
//  chrome.scripting.executeScript the moment the popup opens.
//  No user interaction required — extraction is fully automatic.
//
//  Strategy:
//    1. Try known job-board CSS selectors first (fast, precise).
//    2. Fall back to a heuristic that finds the largest block of
//       prose text on the page (works on any site).
//    3. Clean and return the text so popup.js can pass it to Claude.
//
//  Return value: a plain string.
//  chrome.scripting.executeScript captures the last evaluated
//  expression in the injected IIFE as the result.
// ============================================================

(function extractJobDescription() {

  // ── 1. TARGETED SELECTORS ──────────────────────────────────
  // Known containers on popular job boards. Listed in priority order.
  // We try each selector and take the first match with enough text.
  const KNOWN_SELECTORS = [
    // LinkedIn
    ".jobs-description__content",
    ".jobs-box__html-content",
    // Indeed
    "#jobDescriptionText",
    ".jobsearch-jobDescriptionText",
    // Greenhouse
    "#content",
    ".job__description",
    // Lever
    ".posting-description",
    ".section-wrapper",
    // Workday
    "[data-automation-id='jobPostingDescription']",
    // Workable
    ".job-description",
    // SmartRecruiters
    ".job-sections",
    // Ashby
    ".ashby-job-posting-brief-description",
    // Generic fallbacks
    "[class*='job-description']",
    "[class*='jobDescription']",
    "[class*='job_description']",
    "[id*='job-description']",
    "[id*='jobDescription']",
    "article",
    "main",
  ];

  // Minimum character threshold — anything shorter is likely a nav link or stub
  const MIN_LENGTH = 200;

  // Try each selector; return the first element whose text is long enough
  for (const selector of KNOWN_SELECTORS) {
    const el = document.querySelector(selector);
    if (!el) continue;

    const text = collapseWhitespace(el.innerText || el.textContent || "");
    if (text.length >= MIN_LENGTH) {
      return text;
    }
  }

  // ── 2. HEURISTIC FALLBACK ──────────────────────────────────
  // Walk every block-level element and score by text length.
  // The longest prose block is most likely the job description.
  // This works on custom company career pages with no known selectors.

  const BLOCK_TAGS = new Set([
    "DIV", "SECTION", "ARTICLE", "MAIN",
    "P", "UL", "OL", "TABLE"
  ]);

  // Elements whose content we never want (boilerplate / chrome)
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME",
    "HEADER", "FOOTER", "NAV", "ASIDE", "FORM"
  ]);

  let bestElement = null;
  let bestLength  = 0;

  // querySelectorAll is faster than manual tree-walking for this purpose
  const candidates = document.querySelectorAll(
    "div, section, article, main"
  );

  for (const el of candidates) {
    // Skip invisible elements
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;

    // Skip known boilerplate containers
    if (SKIP_TAGS.has(el.tagName)) continue;

    // Skip elements that are purely wrappers (contain many child blocks)
    // — we want leaf-ish nodes with actual prose, not the whole page body.
    const directBlockChildren = [...el.children].filter(
      (c) => BLOCK_TAGS.has(c.tagName)
    ).length;
    if (directBlockChildren > 12) continue;  // too much nesting = layout wrapper

    const text = collapseWhitespace(el.innerText || el.textContent || "");
    if (text.length > bestLength) {
      bestLength  = text.length;
      bestElement = el;
    }
  }

  if (bestElement && bestLength >= MIN_LENGTH) {
    return collapseWhitespace(bestElement.innerText || bestElement.textContent);
  }

  // ── 3. LAST RESORT ────────────────────────────────────────
  // Return the entire body text, heavily truncated.
  // Claude will still find the relevant parts but this is a weak signal.
  const bodyText = collapseWhitespace(document.body.innerText || "");
  return bodyText.slice(0, 8000);  // cap at 8k chars to stay within token limits

  // ── Utility ───────────────────────────────────────────────
  function collapseWhitespace(str) {
    return str
      .replace(/\r\n/g, "\n")       // normalise line endings
      .replace(/\t/g, " ")           // tabs → spaces
      .replace(/ {2,}/g, " ")        // collapse multiple spaces
      .replace(/\n{3,}/g, "\n\n")   // max two consecutive newlines
      .trim();
  }

})();
