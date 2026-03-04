export default async function handler(req, res) {
    // 1. Accept only POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    try {
        const { resumeText, jobDescription } = req.body;

        // Validate inputs
        if (!resumeText || !jobDescription) {
            return res.status(400).json({ error: 'Both resumeText and jobDescription are required.' });
        }

        // 2. Extract keywords from both texts
        const resumeKeywords = extractKeywords(resumeText);
        const jobKeywords = extractKeywords(jobDescription);

        // Handle edge case where job description yields no keywords
        if (jobKeywords.length === 0) {
            return res.status(200).json({ score: 0, matched: [], missing: [] });
        }

        const matched = [];
        const missing = [];

        // 3. Compute matched and missing keywords
        // By matching the required job keywords against the resume keywords
        jobKeywords.forEach(keyword => {
            if (resumeKeywords.includes(keyword)) {
                matched.push(keyword);
            } else {
                missing.push(keyword);
            }
        });

        // Calculate ATS score (rounded) based on the formula: score = round((matched_keywords / job_keywords) * 100)
        const score = Math.round((matched.length / jobKeywords.length) * 100);

        // 4. Return JSON
        return res.status(200).json({
            score,
            matched,
            missing
        });
    } catch (error) {
        console.error('Error calculating ATS score:', error);
        return res.status(500).json({ error: 'Internal server error while processing ATS score.' });
    }
}

// 5. Helper function to extract keywords
function extractKeywords(text) {
    if (typeof text !== 'string') return [];

    // Common English stop words
    const stopWords = new Set([
        'about', 'above', 'after', 'again', 'against', 'aren', 'aren\'t', 'because', 'been', 'before', 'being', 'below',
        'between', 'both', 'cannot', 'could', 'couldn', 'couldn\'t', 'didn', 'didn\'t', 'does', 'doesn', 'doesn\'t', 'doing',
        'down', 'during', 'each', 'from', 'further', 'hadn', 'hadn\'t', 'hasn', 'hasn\'t', 'have', 'haven', 'haven\'t', 'having',
        'he\'d', 'he\'ll', 'he\'s', 'here', 'here\'s', 'hers', 'herself', 'himself', 'how\'s', 'i\'d', 'i\'ll', 'i\'m', 'i\'ve',
        'into', 'isn\'t', 'it\'s', 'itself', 'let\'s', 'more', 'most', 'mustn', 'mustn\'t', 'myself', 'only', 'other', 'ought',
        'ours', 'ourselves', 'over', 'same', 'shan', 'shan\'t', 'she\'d', 'she\'ll', 'she\'s', 'should', 'shouldn', 'shouldn\'t',
        'some', 'such', 'than', 'that', 'that\'s', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'there\'s', 'these',
        'they', 'they\'d', 'they\'ll', 'they\'re', 'they\'ve', 'this', 'those', 'through', 'under', 'until', 'very', 'wasn',
        'wasn\'t', 'we\'d', 'we\'ll', 'we\'re', 'we\'ve', 'were', 'weren', 'weren\'t', 'what', 'what\'s', 'when', 'when\'s',
        'where', 'where\'s', 'which', 'while', 'who\'s', 'whom', 'why\'s', 'with', 'won\'t', 'would', 'wouldn', 'wouldn\'t',
        'you\'d', 'you\'ll', 'you\'re', 'you\'ve', 'your', 'yours', 'yourself', 'yourselves', 'will', 'just', 'also', 'much',
        'many', 'like', 'well'
    ]);

    // - lowercase
    let processedText = text.toLowerCase();

    // - remove punctuation (replace with space to prevent words from merging)
    processedText = processedText.replace(/[^\w\s]|_/g, ' ');

    // Split into words by whitespace
    const words = processedText.split(/\s+/);

    // - remove duplicates (use a Set)
    const keywords = new Set();

    for (const word of words) {
        // - keep words length > 3
        // - remove stop words
        if (word.length > 3 && !stopWords.has(word)) {
            keywords.add(word);
        }
    }

    return Array.from(keywords);
}
