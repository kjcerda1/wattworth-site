const crypto = require('crypto');
const db = require('./db');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newKey = () => 'wp_' + crypto.randomBytes(24).toString('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function bearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return (m && m[1].trim()) || req.headers['x-api-key'] || '';
}

function isAdmin(req) {
  const t = process.env.ADMIN_TOKEN;
  const given = bearer(req);
  return !!t && !!given && safeEqual(given, t);
}

async function partnerFrom(req) {
  const given = bearer(req);
  if (!given || !String(given).startsWith('wp_')) return null;
  const p = await db.get('partners', { key_hash: sha(given) });
  return p && p.active ? p : null;
}

module.exports = { sha, newKey, isAdmin, partnerFrom, safeEqual };
