// POST /api/inbound — lets the partner's OWN system (CRM, Zapier, Make, a spreadsheet script) push status updates
// without using the dashboard. Auth: the same partner access key (Authorization: Bearer wp_... or X-API-Key).
// Body: one update or { updates: [...] }. Each: { ref | lead_id, stage?, system_kw?, contract_value?, commission_dollars?, note?, lost_reason? }
const db = require('../lib/db');
const { route, body, deny } = require('../lib/http');
const { partnerFrom } = require('../lib/auth');
const { applyUpdate } = require('../lib/leads');

module.exports = route(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const partner = await partnerFrom(req);
  if (!partner) return deny(res);
  const b = body(req);
  const list = Array.isArray(b.updates) ? b.updates.slice(0, 100) : [b];
  const results = [];
  for (const u of list) {
    try {
      const where = u.lead_id ? { id: u.lead_id } : { ref: String(u.ref || '').toUpperCase() };
      const lead = await db.get('leads', where);
      if (!lead || lead.partner_id !== partner.id) { results.push({ ref: u.ref || u.lead_id, ok: false, error: 'not_found' }); continue; }
      const updated = await applyUpdate(lead, u, 'partner:' + partner.name + ' (api)');
      results.push({ ref: updated.ref, ok: true, stage: updated.stage });
    } catch (e) {
      results.push({ ref: u.ref || u.lead_id, ok: false, error: e.status ? e.message : 'server_error' });
    }
  }
  res.json({ results });
});
