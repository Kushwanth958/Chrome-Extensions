// ============================================================
//  overlay.js – ResumeNest Floating Button
//
//  Injected on job pages (LinkedIn, Indeed, Greenhouse, etc.)
//  Shows a small floating button that opens the side panel.
// ============================================================

(function () {
    // Don't inject twice
    if (document.getElementById("resumenest-overlay-btn")) return;

    // Detect job pages
    const host = location.hostname.toLowerCase();
    const path = location.pathname.toLowerCase();
    const isJobPage =
        host.includes("linkedin.com") && path.includes("/jobs/") ||
        host.includes("indeed.com") && (path.includes("/viewjob") || path.includes("/rc/clk")) ||
        host.includes("greenhouse.io") && path.includes("/jobs/") ||
        host.includes("lever.co") ||
        host.includes("careers") ||
        host.includes("jobs") ||
        document.title.toLowerCase().includes("job") ||
        document.title.toLowerCase().includes("career");

    if (!isJobPage) return;

    // Create floating button
    const btn = document.createElement("button");
    btn.id = "resumenest-overlay-btn";
    btn.textContent = "✨ Open ResumeNest Copilot";

    Object.assign(btn.style, {
        position: "fixed",
        bottom: "20px",
        right: "20px",
        zIndex: "999999",
        padding: "10px 18px",
        background: "#c8f55a",
        color: "#0d0d0d",
        border: "none",
        borderRadius: "24px",
        fontFamily: "'Segoe UI', 'Instrument Sans', sans-serif",
        fontSize: "13px",
        fontWeight: "600",
        cursor: "pointer",
        boxShadow: "0 4px 16px rgba(200, 245, 90, 0.35)",
        transition: "transform 0.15s, box-shadow 0.2s",
    });

    btn.addEventListener("mouseenter", () => {
        btn.style.transform = "translateY(-2px)";
        btn.style.boxShadow = "0 6px 24px rgba(200, 245, 90, 0.5)";
    });

    btn.addEventListener("mouseleave", () => {
        btn.style.transform = "translateY(0)";
        btn.style.boxShadow = "0 4px 16px rgba(200, 245, 90, 0.35)";
    });

    btn.addEventListener("click", () => {
        // Send message to background to open the side panel
        chrome.runtime.sendMessage({ action: "openSidePanel" });
    });

    document.body.appendChild(btn);
})();
