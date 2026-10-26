/* Monthly fee statement for one partner. A deal belongs to the month it reached the fee trigger stage (UTC). */
const db = require('./db');
const W = require('./shared');
const { HttpError } = require('./leads');

async function build(month, partner_id) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) throw new HttpError(400, 'month must be YYYY-MM');
  const partner = await db.get('partners', { id: partner_id });
  if (!partner) throw new HttpError(404, 'partner not found');
  const tiers = await db.select('fee_tiers', { order: ['min_kw', 'asc'] });
  const leads = (await db.select('leads', { where: { partner_id } })).filter((l) => !l.duplicate_of);

  const lines = []; const unpriced = [];
  for (const l of leads) {
    const d = W.feeDate(l, W.FEE_TRIGGER) || (l.stage === 'invalid' ? l.signed_at : null);
    if (!d || String(d).slice(0, 7) !== month) continue;
    const f = W.feeFor(l, tiers, undefined, partner);
    const base = { ref: l.ref, name: `${l.first_name} ${(l.last_name || '').slice(0, 1)}${l.last_name ? '.' : ''}`.trim(), city: l.city, state: l.state, system_kw: l.system_kw, date: d, tier: f.tier || (W.tierFor(tiers, l.system_kw) || {}).label || null };
    if (['needs_size', 'no_tier', 'rate_unset', 'needs_commission', 'split_unset'].includes(f.state)) { unpriced.push({ ...base, reason: f.state }); continue; }
    if (f.state === 'not_yet' || f.state === 'on_hold') continue;
    const split = W.modeOf(partner) === 'split';
    let billed, paid;
    if (split) { billed = f.state === 'owed' || f.state === 'paid' ? f.share_cents : 0; paid = Math.min(f.collected_cents || 0, billed || 0); }
    else { billed = f.state === 'owed' || f.state === 'paid' ? f.cents : 0; paid = l.fee_paid_at ? f.cents : 0; }
    lines.push({ ...base, commission_cents: split ? (l.commission_cents == null ? null : Number(l.commission_cents)) : null, pct: split ? f.pct : null, fee_state: f.state, billed_cents: billed, paid_cents: paid,
      note: f.state === 'waived' ? 'Invalid lead, not billed' : f.state === 'credit_due' ? 'Invalid lead, credit for fee already paid' : '' });
  }
  lines.sort((a, b) => (a.date < b.date ? -1 : 1));
  const billed = lines.reduce((s, x) => s + x.billed_cents, 0);
  const paid = lines.reduce((s, x) => s + x.paid_cents, 0);
  const [y, m] = month.split('-').map(Number);
  return {
    number: `WW-${month.replace('-', '')}-${partner.id.slice(0, 4).toUpperCase()}`,
    month, month_label: new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    trigger_label: W.LABEL[W.FEE_TRIGGER],
    mode: W.modeOf(partner), split_percent: partner.split_percent == null ? null : Number(partner.split_percent),
    partner: { id: partner.id, name: partner.name, company: partner.company, email: partner.email },
    lines, unpriced,
    totals: { billed_cents: billed, paid_cents: paid, balance_cents: billed - paid },
    payment_note: process.env.STATEMENT_PAYMENT_NOTE || '',
    issuer: process.env.STATEMENT_ISSUER || 'WattWorth',
  };
}

module.exports = { build };
