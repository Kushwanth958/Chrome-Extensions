# ResumeAI – Chrome Extension

AI-powered resume tailoring. Opens on any job posting, reads the description,
and rewrites your stored resume to match it using the OpenAI API.

---

## File Structure

```
resumeai-extension/
├── manifest.json     Chrome Extension Manifest V3 config
├── popup.html        Popup UI shell (two screens: onboarding + main)
├── popup.css         All styles — dark professional theme
├── popup.js          All popup logic (storage, scraping, OpenAI call, UI)
├── content.js        Injected into active tab to scrape visible page text
├── icons/
│   ├── icon16.png    Toolbar icon (16×16)
│   ├── icon48.png    Extension management page (48×48)
│   └── icon128.png   Chrome Web Store listing (128×128)
└── README.md
```

---

## Setup & Installation

### 1. Add icons
Create an `icons/` folder and place three PNG files:
`icon16.png`, `icon48.png`, `icon128.png`.
Any placeholder image works for local testing.

### 2. Load the extension in Chrome
1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `resumeai-extension/` folder

### 3. First-time setup in the popup
1. Click the ResumeAI icon in the Chrome toolbar
2. Upload your base resume (`.txt` recommended for clean parsing)
3. Paste your OpenAI API key (`sk-...`)
4. Click **Save & Continue**

### 4. Using the extension
1. Navigate to any job posting (LinkedIn, Indeed, Greenhouse, etc.)
2. Click the ResumeAI toolbar icon
3. Click **Tailor Resume to This Job**
4. Copy or download your tailored resume

---

## How It Works

```
User clicks "Tailor Resume"
        │
        ▼
popup.js → chrome.scripting.executeScript(content.js)
        │      Injects content.js into the active tab
        │      content.js walks the DOM, returns visible text
        ▼
popup.js → fetch(OpenAI Chat Completions API)
        │      system prompt: expert resume writer instructions
        │      user prompt:   base resume + scraped job text
        ▼
popup.js → renders tailored resume in the scrollable preview panel
        │
        ▼
User copies to clipboard or downloads as .txt
```

---

## Permissions Explained

| Permission     | Why it's needed |
|----------------|-----------------|
| `activeTab`    | Query the current tab's URL and ID |
| `scripting`    | Inject `content.js` into the active tab on demand |
| `storage`      | Persist the base resume and API key locally |
| `host_permissions: https://api.openai.com/*` | Allow the popup to call the OpenAI REST API |

---

## Notes

- **Your API key is stored locally** in `chrome.storage.local` and is only ever
  sent to `api.openai.com`. It never touches any other server.
- **PDF/DOCX parsing** is basic (FileReader reads raw bytes as text).
  For clean results, export your resume as `.txt` before uploading,
  or integrate [pdf.js](https://mozilla.github.io/pdf.js/) / [mammoth.js](https://github.com/mwilliamson/mammoth.js) later.
- The default model is `gpt-4o-mini` (fast, low cost). Change `OPENAI_MODEL`
  in `popup.js` to `gpt-4o` for higher quality output.
