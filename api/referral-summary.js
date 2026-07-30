const crypto = require('crypto');

const GENERIC_ACCESS_ERROR = 'Dashboard access was not found.';
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;
const throttle = globalThis.__wattworthReferralThrottle || new Map();
globalThis.__wattworthReferralThrottle = throttle;

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function setDashboardHeaders(res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

function requestKey(req) {
  const forwarded = clean(req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']), 120).split(',')[0].trim();
  return forwarded || (req.socket && req.socket.remoteAddress) || 'local';
}

function rateLimited(req) {
  const now = Date.now();
  const key = requestKey(req);
  const bucket = throttle.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  bucket.count += 1;
  throttle.set(key, bucket);
  for (const [bucketKey, value] of throttle) {
    if (now > value.resetAt + RATE_LIMIT_WINDOW_MS) throttle.delete(bucketKey);
  }
  return bucket.count > RATE_LIMIT_MAX;
}

function accessHash(value) {
  const token = clean(value, 500);
  if (token.length < 32) return '';
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function genericAccessFailure(res) {
  return res.status(404).json({ error: GENERIC_ACCESS_ERROR });
}

module.exports = async function handler(req, res) {
  setDashboardHeaders(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (rateLimited(req)) return res.status(429).json({ error: 'Please wait before trying again.' });

  const hash = accessHash(req.query && req.query.access);
  if (!hash) return genericAccessFailure(res);

  const webhook = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  const secret = process.env.WATTWORTH_WEBHOOK_SECRET;
  if (!webhook || !secret) return res.status(503).json({ error: 'Referral dashboard is not configured yet.' });

  try {
    const target = new URL(webhook);
    target.searchParams.set('secret', secret);
    target.searchParams.set('action', 'referral-summary');
    target.searchParams.set('accessHash', hash);
    const response = await fetch(target);
    const summary = await response.json().catch(() => ({}));
    if (!response.ok || !summary.ok) return genericAccessFailure(res);
    const counts = summary.counts || {};
    return res.status(200).json({
      ok: true,
      counts: {
        total: Number(counts.total || 0),
        pending: Number(counts.pending || 0),
        qualified: Number(counts.qualified || 0),
        completed: Number(counts.completed || 0),
      }
    });
  } catch (error) {
    return res.status(502).json({ error: 'We could not load that referral dashboard. Please try again.' });
  }
};