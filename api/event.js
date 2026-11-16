// POST /api/event  — first-party funnel analytics beacon. Anonymous, allowlisted, no PII, no IP stored.
const { route, body, ip } = require('../lib/http');
const events = require('../lib/events');

module.exports = route(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  // The browser already skips tracking under Global Privacy Control / Do Not Track; honor the headers here too.
  const optOut = req.headers['sec-gpc'] === '1' || req.headers.dnt === '1';
  const b = body(req);
  const out = await events.record(b.events || [], { ip: ip(req), optOut });
  res.status(202).json({ ok: true, stored: out.stored });
});
