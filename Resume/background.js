// ============================================================
//  background.js – ResumeNest Service Worker
//
//  Opens the side panel when the extension icon is clicked.
//  Uses the Chrome Side Panel API (Manifest V3).
// ============================================================

// When the extension icon is clicked, open the side panel
chrome.action.onClicked.addListener(async (tab) => {
    try {
        await chrome.sidePanel.open({ tabId: tab.id });
    } catch (err) {
        console.error("[ResumeNest] Failed to open side panel:", err);
    }
});

// Set the side panel behavior to open on action click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[ResumeNest] setPanelBehavior error:", err));

// Listen for messages from overlay.js to open the side panel
chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.action === "openSidePanel" && sender.tab) {
        chrome.sidePanel.open({ tabId: sender.tab.id })
            .catch((err) => console.error("[ResumeNest] Failed to open side panel:", err));
    }
});
