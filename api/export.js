// GET /api/export — CSV of deals. Admin token = all leads (+ fee columns). Partner key = only that partner's leads.
const db = require('../lib/db');
const W = require('../lib/shared');
const { route, deny } = require('../lib/http');
const { isAdmin, partnerFrom } = require('../lib/auth');

const cell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

module.exports = route(async (req, res) => {
  const admin = isAdmin(req);
  const partner = admin ? null : await partnerFrom(req);
  if (!admin && !partner) return deny(res);

  let leads = (await db.select('leads', { order: ['created_at', 'desc'], limit: 5000 })).filter((l) => !l.duplicate_of);
  if (partner) leads = leads.filter((l) => l.partner_id === partner.id);
  const tiers = await db.select('fee_tiers', { order: ['min_kw', 'asc'] });
  const pmap = Object.fromEntries((await db.select('partners', {})).map((p) => [p.id, p]));

  const head = ['ref', 'created', 'first_name', 'last_name', 'phone', 'email', 'city', 'state', 'zip', 'stage', 'system_kw', 'contract_value', 'first_contacted', 'signed', 'installed'];
  if (admin) head.push('partner_commission', 'your_share_dollars', 'received_dollars', 'balance_dollars', 'status', 'referrer_code');
  else head.push('your_commission');
  const rows = leads.map((l) => {
    const r = [l.ref, l.created_at, l.first_name, l.last_name, l.phone, l.email, l.city, l.state, l.zip, W.LABEL[l.stage], l.system_kw, l.contract_value, l.first_contacted_at, l.signed_at, l.installed_at];
    if (admin) { const f = W.feeFor(l, tiers, undefined, pmap[l.partner_id]); r.push(l.commission_cents == null ? '' : l.commission_cents / 100, f.share_cents == null ? '' : f.share_cents / 100, (f.collected_cents || 0) / 100, f.state === 'owed' ? f.cents / 100 : 0, f.state, l.referrer_code || ''); }
    else r.push(l.commission_cents == null ? '' : l.commission_cents / 100);
    return r.map(cell).join(',');
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="wattworth-deals.csv"');
  res.status(200).send([head.join(','), ...rows].join('\n'));
});
