// ============================================================
//  content.js – ResumeNest
//
//  Injected on-demand into the active tab by sidepanel.js via
//  chrome.scripting.executeScript when the panel requests a read.
//  This script NEVER performs any network or API calls; it only
//  reads from the DOM and returns plain text to the side panel.
//
//  Strategy:
//    1. Wait for dynamic content to load (MutationObserver + timeout).
//    2. Try known job-board CSS selectors first (fast, precise).
//    3. Try generic career-page selectors (company sites).
//    4. Fall back to largest text block heuristic.
//    5. Last resort: extract and clean document.body.innerText.
//
//  Return value: { isJobPage, text, reason }
//  chrome.scripting.executeScript captures the resolved value of
//  the async IIFE as the result.
// ============================================================

(async function extractJobDescription() {

  console.log("[ResumeNest][content] Extracting job description from DOM (with dynamic wait).");

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

    // ─── Cisco / Phenom ───
    ".job-description",
    ".job-details",
    "[class*='job-detail']",
    "[class*='jobDetail']",

    // ─── Amazon / generic ATS ───
    ".jobDetailBody",
    ".job-detail-body",
    "#job-detail",
    "#jobDetail",

    // ─── Attribute-based fuzzy matches ───
    "[class*='job-description']",
    "[class*='jobDescription']",
    "[class*='job_description']",
    "[id*='job-description']",
    "[id*='jobDescription']",

    // ─── Generic career page selectors ───
    // These catch company career sites (Cisco, Amazon, Workday, etc.)
    // that use standard semantic elements or common class names.
    "main",
    "[role='main']",
    "article",
    ".job-description",
    ".jobDescription",
    ".job-description-content",
    ".jobDescriptionContent",
    ".content",
    "#job-description",
    "#jobDescription",
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
    // Workday
    "[data-automation-id='jobPostingDescription']",
    // Generic
    ".job-description",
    ".jobDescription",
  ];

  // ── Helpers ─────────────────────────────────────────────────

  /** Clean extracted text: collapse whitespace, multiple newlines, trim */
  function cleanText(str) {
    return str
      .replace(/\r\n/g, "\n")          // normalize line endings
      .replace(/\t/g, " ")             // tabs → spaces
      .replace(/ {2,}/g, " ")          // collapse multiple spaces
      .replace(/\n{3,}/g, "\n\n")      // collapse 3+ newlines → 2
      .replace(/^\s+|\s+$/gm, "")      // trim each line
      .replace(/\n{3,}/g, "\n\n")      // re-collapse after line trim
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
        const text = cleanText(el.innerText || el.textContent || "");
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
  // For known job portals and career URL patterns, skip the keyword check — we trust the URL.
  const hostname = location.hostname.toLowerCase();
  const pathname = location.pathname.toLowerCase();

  const isKnownJobSite =
    // Major job boards
    hostname.includes("linkedin.com") ||
    hostname.includes("indeed.com") ||
    hostname.includes("greenhouse.io") ||
    hostname.includes("lever.co") ||
    hostname.includes("workday.com") ||
    hostname.includes("smartrecruiters.com") ||
    hostname.includes("ashbyhq.com") ||
    hostname.includes("icims.com") ||
    hostname.includes("workable.com") ||
    hostname.includes("myworkdayjobs.com") ||
    hostname.includes("taleo.net") ||
    hostname.includes("brassring.com") ||
    hostname.includes("successfactors.com") ||
    hostname.includes("jobvite.com") ||
    hostname.includes("recruiting.ultipro.com") ||
    hostname.includes("phenom.com") ||
    hostname.includes("cisco.com") ||
    hostname.includes("amazon.jobs") ||
    // Company career subdomains (e.g. careers.google.com, jobs.netflix.com)
    hostname.startsWith("careers.") ||
    hostname.startsWith("jobs.") ||
    // Career URL paths on company sites (e.g. google.com/careers/...)
    pathname.includes("/careers") ||
    pathname.includes("/jobs/") ||
    pathname.includes("/job/") ||
    pathname.includes("/posting/") ||
    pathname.includes("/position/") ||
    pathname.includes("/opening/") ||
    pathname.includes("/apply/");

  // NOTE: We intentionally do NOT check page keywords here (before dynamic wait).
  // On React/SPA sites the job content hasn't rendered yet at this point,
  // so a keyword scan would give a false negative. Instead we proceed to the
  // selector checks, and only do the keyword fallback at the very end.
  if (!isKnownJobSite) {
    // Quick sanity check on immediately-visible text only — don't bail yet
    const quickText = cleanText(document.body?.innerText || "");
    const quickLooksLikeJob = pageLooksLikeJob(quickText);
    // If neither URL nor visible text suggests a job page, bail early
    if (!quickLooksLikeJob) {
      console.log("[ResumeNest][content] Not a job page (no keywords, no known URL pattern).");
      return {
        isJobPage: false,
        text: "",
        reason: "no_job_keywords",
      };
    }
  }

  // ── 1. IMMEDIATE SELECTOR CHECK ────────────────────────────
  // Try selectors right away — works on static pages.
  const immediateMatch = trySelectors(KNOWN_SELECTORS);
  if (immediateMatch) {
    console.log("[ResumeNest][content] Matched selector:", immediateMatch.selector);
    console.log("[ResumeNest] Extracted job text length:", immediateMatch.text.length);
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
  console.log("[ResumeNest][content] No immediate match — waiting for dynamic content…");

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
        console.log("[ResumeNest][content] Dynamic match:", dynamicMatch.selector, `(${dynamicMatch.text.length} chars)`);
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
        console.log("[ResumeNest][content] Delayed selector match:", allMatch.selector, `(${allMatch.text.length} chars)`);
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
        console.log("[ResumeNest][content] Observer match:", match.selector, `(${match.text.length} chars)`);
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
      console.log("[ResumeNest][content] Dynamic wait timed out after", MAX_WAIT_MS, "ms");
      finish(null); // null = no dynamic match found
    }, MAX_WAIT_MS);
  });

  if (dynamicResult) {
    console.log("[ResumeNest] Extracted job text length:", dynamicResult.text.length);
    return dynamicResult;
  }

  // ── 3. LARGEST TEXT BLOCK FALLBACK ──────────────────────────
  // When selectors fail (e.g. job boards changed their DOM),
  // find the largest meaningful block of text on the page.
  // This is resilient to DOM structure changes.
  console.log("[ResumeNest][content] Falling back to largest text block detection.");

  // Tags whose content we never want
  const SKIP_ANCESTOR_TAGS = new Set(["NAV", "FOOTER", "HEADER", "ASIDE"]);

  // Words that signal boilerplate / non-job content
  const BOILERPLATE_WORDS = ["cookie", "privacy", "terms", "sign up", "sign in", "log in", "subscribe"];

  function isInsideSkippedAncestor(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      if (SKIP_ANCESTOR_TAGS.has(node.tagName)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function looksLikeBoilerplate(text) {
    const lower = text.slice(0, 300).toLowerCase(); // check first 300 chars
    let matchCount = 0;
    for (const word of BOILERPLATE_WORDS) {
      if (lower.includes(word)) matchCount++;
    }
    // If multiple boilerplate words appear in the opening text, skip it
    return matchCount >= 2;
  }

  function extractLargestTextBlock() {
    const candidates = document.querySelectorAll("article, section, main, div");
    let best = "";
    let maxLength = 0;

    for (const el of candidates) {
      // Skip hidden elements
      try {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
      } catch {
        continue;
      }

      // Skip elements inside nav, footer, header, aside
      if (isInsideSkippedAncestor(el)) continue;

      const text = (el.innerText || "").trim();

      // Must have enough content (use MIN_LENGTH, not a higher threshold)
      if (text.length < MIN_LENGTH) continue;

      // Skip boilerplate blocks (cookie banners, privacy notices, etc.)
      if (looksLikeBoilerplate(text)) continue;

      if (text.length > maxLength) {
        maxLength = text.length;
        best = text;
      }
    }

    return best;
  }

  const largestBlock = extractLargestTextBlock();
  if (largestBlock && largestBlock.length >= MIN_LENGTH) {
    const cleaned = cleanText(largestBlock);
    console.log("[ResumeNest][content] Largest text block found.");
    console.log("[ResumeNest] Extracted job text length:", cleaned.length);
    return {
      isJobPage: true,
      text: cleaned,
      reason: "largest_text_block",
    };
  }

  // ── 4. FULL PAGE TEXT FALLBACK ─────────────────────────────
  // If all else fails, extract readable text from the entire page.
  // Clean it thoroughly before returning.
  console.log("[ResumeNest][content] Falling back to full page body text.");

  const rawBodyText = document.body?.innerText || "";
  const bodyText = cleanText(rawBodyText);

  console.log("[ResumeNest] Extracted job text length:", bodyText.length);

  if (!bodyText || bodyText.length < MIN_LENGTH) {
    console.log("[ResumeNest][content] Body text too short or empty.");
    return {
      isJobPage: false,
      text: "",
      reason: "empty_body",
    };
  }

  return {
    isJobPage: true,
    text: bodyText.slice(0, 8000),  // cap at 8k chars to stay within token limits
    reason: "full_body_fallback",
  };

})();

// ============================================================
//  SPA NAVIGATION DETECTION (LinkedIn, Indeed, etc.)
//
//  LinkedIn is a Single Page Application — clicking a different
//  job listing changes the URL but does NOT reload the page.
//  This polling loop detects URL changes and notifies the
//  extension so sidepanel.js can re-scrape the new job.
//
//  Guard: only one instance runs per page (idempotent).
// ============================================================
if (!window.__resumeNest_spaWatcher) {
  window.__resumeNest_spaWatcher = true;

  let lastUrl = location.href;

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      console.log("[ResumeNest][content] SPA navigation detected:", lastUrl);

      // Notify the extension that the job page changed
      try {
        chrome.runtime.sendMessage({ action: "jobPageChanged", url: lastUrl });
      } catch {
        // Extension context may have been invalidated — ignore
      }
    }
  }, 1000);
}
