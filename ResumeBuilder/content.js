// ============================================================
//  content.js – ResumeAI
//  Injected on-demand into the active tab by popup.js.
//  Sole responsibility: scrape visible text from the page
//  and return it to the popup via the executeScript return value.
// ============================================================

// ── Text Extraction ──────────────────────────────────────────
// We walk every visible text node in the document body and
// collect the content. This works across all job-board layouts
// (LinkedIn, Indeed, Greenhouse, Lever, Workday, etc.) without
// needing site-specific selectors.

(function extractJobDescription() {
  // Elements whose text is never useful (scripts, styles, hidden UI)
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME",
    "HEADER", "FOOTER", "NAV", "ASIDE"
  ]);

  // Recursively collect visible text from the DOM tree
  function collectText(node, parts) {
    // Skip non-content element types
    if (node.nodeType === Node.ELEMENT_NODE) {
      // Skip hidden elements
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return;

      // Skip navigation / boilerplate tags
      if (SKIP_TAGS.has(node.tagName)) return;

      // Recurse into children
      for (const child of node.childNodes) {
        collectText(child, parts);
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      // Grab non-empty text content
      const text = node.textContent.trim();
      if (text.length > 0) parts.push(text);
    }
  }

  const parts = [];
  collectText(document.body, parts);

  // Join with newlines and collapse excessive whitespace / blank lines
  const rawText = parts.join("\n");
  const cleaned = rawText
    .replace(/\n{3,}/g, "\n\n")   // collapse 3+ blank lines → 2
    .replace(/ {2,}/g, " ")        // collapse multiple spaces
    .trim();

  // ── Return value ─────────────────────────────────────────────
  // chrome.scripting.executeScript captures the last expression
  // evaluated in the injected function, which we read in popup.js.
  return cleaned;
})();
