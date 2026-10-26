// GET /api/cron — scheduled by Vercel (see vercel.json).
//   /api/cron            retries failed deliveries (max 5 attempts each)
//   /api/cron?job=daily  owner digest + stale-lead nudges to partners
// Vercel sends Authorization: Bearer $CRON_SECRET automatically when CRON_SECRET is set.
const { route, deny } = require('../lib/http');
const { safeEqual } = require('../lib/auth');
const { run } = require('../lib/jobs');

module.exports = route(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const given = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!secret || !given || !safeEqual(given, secret)) return deny(res);
  res.json({ ok: true, ...(await run(req.query && req.query.job)) });
});
