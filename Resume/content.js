// ============================================================
//  content.js – ResumeNest
//
//  Injected on all pages via manifest.json.
//  Handles SPA navigation detection so the side panel re-scrapes
//  when the user clicks a different job on LinkedIn or similar SPAs.
//
//  NOTE: Job description extraction is handled inline by
//  sidepanel.js via chrome.scripting.executeScript({ func: ... }).
//  This file does NOT do any scraping.
// ============================================================

// ── Click "Show More" buttons to expand job descriptions ─────
try {
  const showMoreBtn = document.querySelector(
    "button[aria-label*='more'], button[aria-expanded='false']"
  );
  if (showMoreBtn) showMoreBtn.click();
} catch { }

// ── SPA Navigation Detection (jobId-based) ────────────────────
// Watches for a job ID appearing/changing via URL params or DOM attribute.
// Handles both linkedin.com/jobs/view/<id> and search results pages
// where the detail panel loads inline without a full URL change.
if (!window.__resumeNest_spaWatcher) {
  window.__resumeNest_spaWatcher = true;
  let lastJobId = null;

  function getCurrentJobId() {
    // 1. Standard LinkedIn job view URL param
    const params = new URLSearchParams(window.location.search);
    const fromParam = params.get("currentJobId") || params.get("jobId");
    if (fromParam) return fromParam;

    // 2. Inline job detail panel (LinkedIn search results sidebar)
    const fromDom = document.querySelector("[data-job-id]")?.dataset?.jobId;
    if (fromDom) return fromDom;

    return null;
  }

  setInterval(() => {
    const jobId = getCurrentJobId();
    if (jobId && jobId !== lastJobId) {
      lastJobId = jobId;
      console.log("[ResumeNest] New job detected:", jobId);
      // Delay so LinkedIn has time to render the new job description
      setTimeout(() => {
        try {
          chrome.runtime.sendMessage({
            action: "jobPageChanged",
            jobId: jobId,
            url: location.href,
          });
        } catch { }
      }, 1500);
    }
  }, 1000);
}
