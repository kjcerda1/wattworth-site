// Partner dashboard API (auth: Bearer <partner access key>)
//   GET   /api/partner            -> { partner, leads[] with history }
//   PATCH /api/partner            -> { lead_id, stage?, system_kw?, contract_value?, note?, lost_reason?, commission_dollars?, appointment_at?, message?, read? }
const db = require('../lib/db');
const { route, body, deny } = require('../lib/http');
const { partnerFrom } = require('../lib/auth');
const { applyUpdate, HttpError } = require('../lib/leads');

// Partners never see consent IP/UA or other partners' data.
const view = (l) => ({
  id: l.id, ref: l.ref, first_name: l.first_name, last_name: l.last_name, phone: l.phone, email: l.email,
  address: l.address, city: l.city, state: l.state, zip: l.zip, monthly_bill: l.monthly_bill, homeowner: l.homeowner, notes: l.notes,
  stage: l.stage, system_kw: l.system_kw, contract_value: l.contract_value, lost_reason: l.lost_reason, invalid_reason: l.invalid_reason, dispute_status: l.dispute_status, commission_cents: l.commission_cents,
  appointment_at: l.appointment_at || null,
  created_at: l.created_at, first_contacted_at: l.first_contacted_at, signed_at: l.signed_at, installed_at: l.installed_at,
});

module.exports = route(async (req, res) => {
  const partner = await partnerFrom(req);
  if (!partner) return deny(res);

  if (req.method === 'GET') {
    const leads = (await db.select('leads', { where: { partner_id: partner.id }, order: ['created_at', 'desc'], limit: 500 })).filter((l) => !l.duplicate_of);
    const ids = new Set(leads.map((l) => l.id));
    const events = (await db.select('lead_events', { order: ['created_at', 'desc'], limit: 2000 })).filter((e) => ids.has(e.lead_id) && !['delivery', 'confirm', 'privacy'].includes(e.type));
    const by = {};
    events.forEach((e) => (by[e.lead_id] = by[e.lead_id] || []).push({ type: e.type, actor: e.actor, from: e.from_value, to: e.to_value, note: e.note, at: e.created_at }));
    const msgs = (await db.select('messages', { order: ['created_at', 'asc'], limit: 5000 })).filter((m) => ids.has(m.lead_id));
    const mby = {};
    msgs.forEach((m) => (mby[m.lead_id] = mby[m.lead_id] || []).push({ from: m.sender, body: m.body, via: m.via, at: m.created_at, unread: m.sender === 'customer' && !m.read_by_partner_at }));
    return res.json({ partner: { name: partner.name, company: partner.company }, terms: { mode: partner.fee_mode === 'flat' ? 'flat' : 'split', owner_percent: partner.split_percent == null ? null : Number(partner.split_percent) }, leads: leads.map((l) => ({ ...view(l), history: by[l.id] || [], messages: mby[l.id] || [], unread: (mby[l.id] || []).filter((m) => m.unread).length })) });
  }

  if (req.method === 'PATCH') {
    const b = body(req);
    const lead = await db.get('leads', { id: b.lead_id });
    if (!lead || lead.partner_id !== partner.id) throw new HttpError(404, 'lead not found');
    if (b.read) for (const m of await db.select('messages', { where: { lead_id: lead.id, sender: 'customer', read_by_partner_at: null } })) await db.update('messages', { id: m.id }, { read_by_partner_at: new Date().toISOString() });
    const updated = await applyUpdate(lead, b, 'partner:' + partner.name);
    return res.json({ ok: true, lead: view(updated) });
  }
  res.status(405).json({ error: 'method_not_allowed' });
});
