# ResumeAI v2 – Chrome Extension + Vercel Backend

AI-powered resume tailoring powered by **Claude claude-sonnet-4-6** via a **Vercel serverless function**.
The Anthropic API key never touches the browser — it lives exclusively on Vercel.

---

## File Structure

```
resumeai-extension/
├── manifest.json          Chrome Extension Manifest V3
├── popup.html             Two-screen popup UI (onboarding + main)
├── popup.css              Dark professional theme
├── popup.js               All popup logic — no API key, calls Vercel backend
├── content.js             Auto-injected scraper; extracts job text immediately on popup open
├── api/
│   └── generate.js        Vercel serverless function — holds ANTHROPIC_API_KEY, calls Claude
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Architecture

```
Chrome Extension (popup.js)
        │
        │  POST { resume, jobDescription }
        ▼
Vercel Serverless Function (api/generate.js)
        │  ANTHROPIC_API_KEY stored in Vercel env vars
        │  Calls Claude claude-sonnet-4-6 via Anthropic Messages API
        ▼
Anthropic API → tailored resume text
        │
        ▼
Extension popup renders result
```

The browser **never sees the API key**. The only data sent from the extension
to the backend is the resume text and job description text.

---

## Deployment: Vercel Backend

### 1. Create a Vercel project

```bash
npm i -g vercel
cd resumeai-extension
vercel
```

### 2. Set the environment variable

In the Vercel dashboard → your project → Settings → Environment Variables:

```
ANTHROPIC_API_KEY = sk-ant-...
```

Or via CLI:

```bash
vercel env add ANTHROPIC_API_KEY
```

### 3. Deploy

```bash
vercel --prod
```

Your function will be live at:
`https://your-project.vercel.app/api/generate`

### 4. Update popup.js

Replace the placeholder in `popup.js`:

```js
const BACKEND_URL = "https://your-project.vercel.app/api/generate";
```

---

## Deployment: Chrome Extension

### 1. Add icons

Create an `icons/` folder with:
- `icon16.png` (16×16 px)
- `icon48.png` (48×48 px)
- `icon128.png` (128×128 px)

Any placeholder PNG works for local testing.

### 2. Load unpacked in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `resumeai-extension/` folder

### 3. First-time setup

1. Click the ResumeAI toolbar icon
2. Drop your resume file onto the upload zone (`.txt` recommended)
3. Click **Save & Continue**

### 4. Using the extension

1. Navigate to any job posting (LinkedIn, Indeed, Greenhouse, etc.)
2. Click the ResumeAI toolbar icon
3. The job description is **automatically extracted** — no click needed
4. Click **Tailor Resume to This Job**
5. Copy or download your Claude-tailored resume

---

## What Changed from v1

| | v1 | v2 |
|---|---|---|
| API | OpenAI GPT-4o-mini (direct) | Anthropic Claude claude-sonnet-4-6 (via Vercel) |
| API key location | User's browser (chrome.storage) | Vercel environment variable only |
| Onboarding | Resume file + API key | Resume file only |
| Job scraping | On button click | Automatically on popup open |
| Scraper strategy | Generic DOM walk | Targeted selectors + heuristic fallback |
| Output format | Plain text | Structured sections: Summary, Experience, Skills, Education |

---

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Query the active tab's URL and ID |
| `scripting` | Inject `content.js` into the tab to scrape job text |
| `storage` | Persist the user's base resume locally |
| `host_permissions: *.vercel.app` | Allow the popup to POST to your Vercel backend |
