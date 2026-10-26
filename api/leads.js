// POST /api/leads  — public intake from the WattWorth funnel. Stores the lead + consent record and sends it to the partner.
const { route, body, ip } = require('../lib/http');
const { createLead } = require('../lib/leads');

module.exports = route(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const out = await createLead(body(req), { ip: ip(req), ua: req.headers['user-agent'] });
  // Never leak internals to the browser: receipt, short reference, and (new leads only) the customer's own private tracker token + referral code.
  res.status(201).json({ ok: true, ref: out.ref || null, portal_token: out.portal_token || null, own_code: out.own_code || null, existing_tracker: !!out.existing_tracker });
});
