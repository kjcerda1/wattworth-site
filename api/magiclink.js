// POST /api/magiclink {email} -> emails the customer their private tracker link. Always answers the same way.
const db = require('../lib/db');
const { route, body } = require('../lib/http');
const { sendPortalLink } = require('../lib/portal');

module.exports = route(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const email = String(body(req).email || '').trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    const rows = [...(await db.select('leads', { where: { email } })), ...(email.toLowerCase() !== email ? await db.select('leads', { where: { email: email.toLowerCase() } }) : [])]
      .filter((l) => !l.duplicate_of && l.portal_token && !l.deletion_requested_at)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const lead = rows[0];
    if (lead && (!lead.portal_link_sent_at || Date.now() - new Date(lead.portal_link_sent_at).getTime() > 600e3)) await sendPortalLink(lead);
  }
  res.json({ ok: true });   // same answer whether or not we found anything
});
