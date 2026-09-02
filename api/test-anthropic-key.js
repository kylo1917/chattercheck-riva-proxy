const { enforceOrigin, rateLimited } = require('./_shared');

// A single-token request — a negligible fraction of a cent — purely to
// confirm the key is valid before the tutor relies on it for real analysis.
async function testKey(apiKey) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error((data.error && data.error.message) || `HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
}

module.exports = async (req, res) => {
  if (!enforceOrigin(req, res)) return;
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-Anthropic-Api-Key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (rateLimited(req)) return res.status(429).json({ ok: false, error: 'Too many requests — slow down a little' });

  const apiKey = req.headers['x-anthropic-api-key'];
  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(400).json({ ok: false, error: 'X-Anthropic-Api-Key header is required' });
  }
  try {
    await testKey(apiKey);
    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err.status === 401) {
      return res.status(200).json({ ok: false, error: 'That key was rejected by Anthropic — double check it was copied correctly.' });
    }
    if (err.status === 429) {
      return res.status(200).json({ ok: false, error: 'Rate limited right now — the key itself looks fine, try again shortly.' });
    }
    return res.status(200).json({ ok: false, error: err.message || 'Could not verify the key' });
  }
};
