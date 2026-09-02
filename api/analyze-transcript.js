const { enforceOrigin } = require('./_shared');

// Deliberately stricter than the generic 20/min limiter in _shared.js — this
// endpoint costs real (if small) money per call, unlike the free NVIDIA
// tier, so a runaway client or accidental double-click storm should hit a
// wall fast rather than quietly running up a bill.
const hits = new Map();
const WINDOW_MS = 60000;
const MAX_PER_WINDOW = 5;
function analysisRateLimited(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const timestamps = (hits.get(ip) || []).filter((t) => t > windowStart);
  timestamps.push(now);
  hits.set(ip, timestamps);
  if (hits.size > 5000) hits.clear();
  return timestamps.length > MAX_PER_WINDOW;
}

const MODEL = 'claude-haiku-4-5-20251001'; // cheapest current Claude model — plenty for spotting errors in a lesson transcript
const MAX_TRANSCRIPT_CHARS = 8000; // bounds input cost regardless of how long a session ran

const TOOL = {
  name: 'record_mistakes',
  description: 'Records the language mistakes found in the transcript.',
  input_schema: {
    type: 'object',
    properties: {
      mistakes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Exact quote of what the student said, verbatim from the transcript.' },
            correction: { type: 'string', description: 'The corrected version of that quote.' },
            category: { type: 'string', enum: ['grammar', 'vocab', 'usage'] },
            explanation: { type: 'string', description: 'One plain-English sentence explaining the rule the student got wrong.' },
            example: { type: 'string', description: 'One short example sentence demonstrating correct usage.' },
          },
          required: ['text', 'correction', 'category', 'explanation', 'example'],
        },
      },
    },
    required: ['mistakes'],
  },
};

function buildSystemPrompt(lang, watchlist) {
  const focus = watchlist && watchlist.length
    ? ` The tutor is currently focusing on these constructs with this student, so pay extra attention to them (but don't limit yourself to only these): ${watchlist.join(', ')}.`
    : '';
  return `You are helping a private language tutor review a lesson transcript. The student is learning ${lang || 'a new language'}.` +
    ` The transcript may mix the tutor's and student's speech with no speaker labels — infer from context which lines are the student's, and only flag the STUDENT's mistakes. Skip the tutor's own explanations, corrections, and casual chat entirely.` +
    ` Only flag genuine grammar, word-choice, or usage errors you're confident about — skip filler words, disfluencies, and stylistic variation that isn't actually wrong. If there are no real mistakes, call the tool with an empty list rather than inventing something.` +
    focus +
    ` Call record_mistakes with your findings.`;
}

async function analyze(apiKey, transcriptText, lang, watchlist) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1536,
      temperature: 0,
      system: buildSystemPrompt(lang, watchlist),
      messages: [{ role: 'user', content: transcriptText }],
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'record_mistakes' },
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error((data.error && data.error.message) || `HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'record_mistakes');
  return (toolUse && toolUse.input && toolUse.input.mistakes) || [];
}

module.exports = async (req, res) => {
  if (!enforceOrigin(req, res)) return;
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Anthropic-Api-Key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (analysisRateLimited(req)) return res.status(429).json({ error: 'Too many analysis requests — slow down a little' });

  const apiKey = req.headers['x-anthropic-api-key'];
  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(400).json({ error: 'X-Anthropic-Api-Key header is required' });
  }

  const body = req.body || {};
  const lines = Array.isArray(body.transcript) ? body.transcript : null;
  if (!lines || !lines.length) return res.status(400).json({ error: 'transcript is required' });

  let transcriptText = lines.map((l) => (l && l.text ? String(l.text) : '')).filter(Boolean).join('\n');
  let truncated = false;
  if (transcriptText.length > MAX_TRANSCRIPT_CHARS) {
    transcriptText = transcriptText.slice(0, MAX_TRANSCRIPT_CHARS);
    truncated = true;
  }
  if (!transcriptText.trim()) return res.status(400).json({ error: 'transcript has no text' });

  const watchlist = Array.isArray(body.watchlist) ? body.watchlist.filter((w) => typeof w === 'string') : [];

  try {
    const mistakes = await analyze(apiKey, transcriptText, body.lang, watchlist);
    return res.status(200).json({ mistakes, truncated });
  } catch (err) {
    if (err.status === 401) {
      return res.status(401).json({ error: 'That Anthropic key was rejected — double check it was copied correctly.' });
    }
    if (err.status === 429) {
      return res.status(429).json({ error: 'Rate limited by Anthropic right now — try again shortly.' });
    }
    console.error('analyze-transcript error:', err.message);
    return res.status(502).json({ error: 'Analysis failed', detail: err.message });
  }
};
