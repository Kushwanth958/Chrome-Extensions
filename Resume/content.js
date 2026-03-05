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

// ── SPA Navigation Detection (currentJobId-based) ─────────────
// Watches for LinkedIn's currentJobId query param changing instead
// of raw URL changes — avoids false positives from anchor/hash changes.
if (!window.__resumeNest_spaWatcher) {
  window.__resumeNest_spaWatcher = true;
  let lastJobId = null;

  function getCurrentJobId() {
    const params = new URLSearchParams(window.location.search);
    return params.get("currentJobId");
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
