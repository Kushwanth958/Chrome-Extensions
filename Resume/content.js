// ============================================================
//  content.js – ResumeNest
//
//  Injected as a content script on job sites (LinkedIn, Indeed,
//  Greenhouse, Lever) via manifest.json → overlay.js handles
//  the floating button. This file handles only SPA navigation
//  detection so the side panel can re-scrape automatically.
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

// ── SPA Navigation Detection ─────────────────────────────────
// Polls for URL changes on LinkedIn and other SPAs.
// When it detects a navigation (e.g. user clicked a different job),
// it sends a "jobPageChanged" message so the side panel re-scrapes.
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
