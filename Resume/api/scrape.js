// ============================================================
//  api/scrape.js – ResumeNest Vercel Serverless Function
//
//  Route: POST /api/scrape
//
//  Accepts { url: string }, fetches the page HTML, uses cheerio
//  to extract the largest meaningful text block (tries known
//  job-description selectors first, then heuristic largest block).
//  Returns { jobDescription: string }.
// ============================================================

import * as cheerio from "cheerio";

// ── Known job description selectors (mirrors sidepanel.js) ────
const JOB_SELECTORS = [
    // LinkedIn
    ".jobs-description__content", ".jobs-box__html-content",
    ".jobs-description-content__text",
    // Indeed
    "#jobDescriptionText", ".jobsearch-jobDescriptionText",
    // Greenhouse / Lever
    ".job__description", ".job-post-content", ".posting-description",
    // Workday
    "[data-automation-id='jobPostingDescription']",
    // iCIMS
    ".iCIMS_JobContent", ".iCIMS_Expandable_Container",
    // SmartRecruiters
    ".job-sections", ".details-content",
    // Jobvite
    ".jv-job-detail-description",
    // Ashby
    ".ashby-job-posting-brief-description",
    // Generic
    "[itemprop='description']",
    ".job-description", "#job-description", "#jobDescription",
    ".jobDescription", ".job-details", ".jobDetailBody",
];

// ── Tags to skip for largest-block heuristic ──────────────────
const SKIP_TAGS = new Set(["nav", "footer", "header", "aside", "script", "style", "noscript"]);

function cleanText(raw) {
    return raw
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed. Use POST." });
    }

    const { url } = req.body ?? {};

    if (typeof url !== "string" || !url.trim()) {
        return res.status(400).json({ error: "Missing or empty `url` field." });
    }

    // Validate URL
    let parsedUrl;
    try {
        parsedUrl = new URL(url.trim());
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
            throw new Error("bad protocol");
        }
    } catch {
        return res.status(400).json({ error: "Invalid URL. Must start with http:// or https://." });
    }

    try {
        // Fetch the page HTML
        const response = await fetch(parsedUrl.href, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
            redirect: "follow",
            signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
            return res.status(502).json({
                error: `Failed to fetch URL (HTTP ${response.status}).`,
            });
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        // Remove unwanted elements
        $("script, style, noscript, svg, img, iframe, nav, footer, header").remove();

        // Step 1: Try known selectors
        let jobText = "";
        for (const sel of JOB_SELECTORS) {
            const el = $(sel).first();
            if (el.length) {
                const text = cleanText(el.text());
                if (text.length >= 200) {
                    jobText = text;
                    break;
                }
            }
        }

        // Step 2: Largest meaningful text block
        if (!jobText) {
            let bestText = "";
            let bestLen = 0;

            $("div, section, article, main").each((_, el) => {
                const $el = $(el);

                // Skip elements inside nav/header/footer
                if ($el.closest("nav, footer, header, aside").length) return;

                const text = $el.text().trim();
                if (text.length > 500 && text.length > bestLen) {
                    bestLen = text.length;
                    bestText = text;
                }
            });

            if (bestText) {
                jobText = cleanText(bestText);
            }
        }

        // Step 3: Body fallback
        if (!jobText) {
            const bodyText = cleanText($("body").text());
            if (bodyText.length >= 200) {
                jobText = bodyText.slice(0, 8000);
            }
        }

        if (!jobText || jobText.length < 100) {
            return res.status(422).json({
                error: "Could not extract a meaningful job description from that URL.",
            });
        }

        // Cap at 8000 chars
        return res.status(200).json({
            jobDescription: jobText.slice(0, 8000),
        });

    } catch (err) {
        console.error("[ResumeNest] /api/scrape error:", err);

        if (err.name === "TimeoutError" || err.name === "AbortError") {
            return res.status(504).json({ error: "Request timed out while fetching the URL." });
        }

        return res.status(500).json({
            error: `Failed to scrape URL: ${err.message}`,
        });
    }
}
