/* Tiny helpers shared by the API routes. */
const { HttpError } = require('./leads');

function cors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (origin && (allowed.includes('*') || allowed.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

const ip = (req) => String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();

/** Wraps a handler: CORS, JSON errors, no stack traces to clients. */
const route = (fn) => async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (cors(req, res)) return;
  try { await fn(req, res); }
  catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error('[wattworth]', e);
    res.status(500).json({ error: 'server_error' });
  }
};
const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
const deny = (res, s = 401) => res.status(s).json({ error: s === 401 ? 'unauthorized' : 'forbidden' });

module.exports = { route, body, ip, deny };
