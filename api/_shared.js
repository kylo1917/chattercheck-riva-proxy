const ALLOWED_ORIGINS = new Set([
  'https://kylo1917.github.io',
]);

// Sets CORS headers for browser callers, and returns whether this request is
// allowed to proceed at all. Unlike CORS headers alone (which only stop a
// *browser* from reading the response), this actually rejects the request —
// closing the gap where a direct script call (curl, another server) could
// bypass CORS entirely since it's a browser-only convention.
function enforceOrigin(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    return true;
  }
  res.status(403).json({ error: 'Origin not allowed' });
  return false;
}

// Simple in-memory sliding-window limiter, keyed by caller IP. This resets on
// cold start and isn't shared across concurrent instances, so it's not a
// perfect global limiter — but it's a real, meaningful deterrent against a
// single source hammering the endpoint, without needing a paid external
// rate-limiting service for a proxy at this scale.
const hits = new Map();
const WINDOW_MS = 60000;
const MAX_PER_WINDOW = 20;
function rateLimited(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const timestamps = (hits.get(ip) || []).filter((t) => t > windowStart);
  timestamps.push(now);
  hits.set(ip, timestamps);
  if (hits.size > 5000) hits.clear(); // crude memory guard against unbounded growth
  return timestamps.length > MAX_PER_WINDOW;
}

module.exports = { enforceOrigin, rateLimited };
