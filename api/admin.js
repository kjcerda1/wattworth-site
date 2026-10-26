// Owner dashboard API (auth: Bearer ADMIN_TOKEN)
//   GET  /api/admin                 -> everything the dashboard renders
//   POST /api/admin {action,...}    -> resend | fee_paid | payout_paid | set_tiers | create_partner | update_partner | rotate_key | admin_update | record_payment | erase_lead
const db = require('../lib/db');
const W = require('../lib/shared');
const { route, body, deny } = require('../lib/http');
const { isAdmin, newKey, sha } = require('../lib/auth');
const { retryDelivery, applyUpdate, resolveDispute, event, HttpError, clean, normPhone } = require('../lib/leads');
const { emailReady, smsReady } = require('../lib/mail');

const partnerView = (p) => ({ public_phone: p.public_phone || null, fee_mode: p.fee_mode === 'flat' ? 'flat' : 'split', split_percent: p.split_percent == null ? null : Number(p.split_percent), ads_paid_by: p.ads_paid_by || null, id: p.id, name: p.name, company: p.company, email: p.email, phone: p.phone, webhook_url: p.webhook_url, has_webhook_secret: !!p.webhook_secret, is_default: p.is_default, active: p.active, created_at: p.created_at });

function pctOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!(n >= 0 && n <= 100)) throw new HttpError(400, 'Your share must be between 0 and 100 percent');
  return n;
}

module.exports = route(async (req, res) => {
  if (!isAdmin(req)) return deny(res);

  if (req.method === 'GET') {
    const [leads, deliveries, payouts, tiers, partners, events, ad_spend, messages] = await Promise.all([
      db.select('leads', { order: ['created_at', 'desc'], limit: 2000 }),
      db.select('deliveries', { order: ['created_at', 'desc'], limit: 2000 }),
      db.select('referral_payouts', { order: ['created_at', 'desc'], limit: 2000 }),
      db.select('fee_tiers', { order: ['min_kw', 'asc'] }),
      db.select('partners', { order: ['created_at', 'asc'] }),
      db.select('lead_events', { order: ['created_at', 'desc'], limit: 300 }),
      db.select('ad_spend', { order: ['month', 'desc'], limit: 500 }),
      db.select('messages', { limit: 20000 }),
    ]);
    const summary = W.buildSummary({ leads, deliveries, payouts, tiers, ad_spend, partners, messages });
    const pn = Object.fromEntries(partners.map((p) => [p.id, p.name]));
    const pmap = Object.fromEntries(partners.map((p) => [p.id, p]));
    const ref = Object.fromEntries(leads.map((l) => [l.id, l]));
    return res.json({
      mode: db.mode(),
      setup: { database: db.mode() === 'supabase', email: emailReady(), sms: smsReady(), ownerAlerts: !!(process.env.OWNER_EMAIL || process.env.OWNER_PHONE), cron: !!process.env.CRON_SECRET, appUrl: !!process.env.APP_URL },
      config: { feeTrigger: W.FEE_TRIGGER, stages: W.STAGES },
      ...summary,
      leads: leads.map((l) => ({ ...l, portal_token: undefined, consent_ip: undefined, consent_user_agent: undefined, partner_name: pn[l.partner_id] || null, fee: l.fee || W.feeFor(l, tiers, undefined, pmap[l.partner_id]) })),
      deliveries: deliveries.map((d) => ({ ...d, lead_ref: ref[d.lead_id] && ref[d.lead_id].ref, lead_name: ref[d.lead_id] && ref[d.lead_id].first_name, partner_name: pn[d.partner_id] })),
      payouts: payouts.map((p) => ({ ...p, lead_ref: ref[p.lead_id] && ref[p.lead_id].ref, stage: ref[p.lead_id] && ref[p.lead_id].stage })),
      tiers, ad_spend, partners: partners.map(partnerView),
      events: events.map((e) => ({ ...e, lead_ref: ref[e.lead_id] && ref[e.lead_id].ref })),
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const b = body(req);

  switch (b.action) {
    case 'resend': {
      const d = await retryDelivery(b.delivery_id);
      return res.json({ ok: true, delivery: d });
    }
    case 'fee_paid': {
      // "Settled": everything you are owed on this deal has been received (or undo it)
      const lead = await db.get('leads', { id: b.lead_id });
      if (!lead) throw new HttpError(404, 'lead not found');
      const partner = lead.partner_id ? await db.get('partners', { id: lead.partner_id }) : null;
      const tiers = await db.select('fee_tiers', {});
      const paid = b.paid !== false;
      const patch = { fee_paid_at: paid ? new Date().toISOString() : null };
      if (W.modeOf(partner) === 'split') {
        const f = W.feeFor(lead, tiers, undefined, partner);
        patch.commission_collected_cents = paid ? (f.share_cents != null ? f.share_cents : lead.commission_collected_cents || 0) : 0;
      }
      await db.update('leads', { id: lead.id }, patch);
      await event(lead.id, 'fee', 'admin', null, paid ? 'paid' : 'unpaid', null);
      return res.json({ ok: true });
    }
    case 'record_payment': {
      // Part of your share arrived (commissions often pay in stages)
      const lead = await db.get('leads', { id: b.lead_id });
      if (!lead) throw new HttpError(404, 'lead not found');
      const amt = Math.round(Number(b.amount_dollars) * 100);
      if (!(amt > 0) || amt > 1e9) throw new HttpError(400, 'Enter the dollar amount you received');
      const partner = lead.partner_id ? await db.get('partners', { id: lead.partner_id }) : null;
      const collected = Number(lead.commission_collected_cents || 0) + amt;
      const patch = { commission_collected_cents: collected };
      const f = W.feeFor({ ...lead, commission_collected_cents: collected }, [], undefined, partner);
      if (f.state === 'paid') patch.fee_paid_at = new Date().toISOString();
      await db.update('leads', { id: lead.id }, patch);
      await event(lead.id, 'fee', 'admin', null, 'received $' + (amt / 100).toFixed(2), null);
      return res.json({ ok: true });
    }
    case 'payout_paid': {
      const p = await db.get('referral_payouts', { id: b.payout_id });
      if (!p) throw new HttpError(404, 'payout not found');
      const paid = b.paid !== false;
      await db.update('referral_payouts', { id: p.id }, { status: paid ? 'paid' : 'pending', paid_at: paid ? new Date().toISOString() : null });
      await event(p.lead_id, 'payout', 'admin', null, `${p.milestone} ${paid ? 'paid' : 'pending'}`, null);
      return res.json({ ok: true });
    }
    case 'set_tiers': {
      const rows = Array.isArray(b.tiers) ? b.tiers : [];
      for (const t of rows) {
        const cents = t.fee_dollars === '' || t.fee_dollars == null ? null : Math.round(Number(t.fee_dollars) * 100);
        if (cents !== null && !(cents >= 0)) throw new HttpError(400, 'invalid fee');
        await db.update('fee_tiers', { id: t.id }, { fee_cents: cents, label: clean(t.label, 60) || 'Tier', min_kw: Number(t.min_kw), max_kw: t.max_kw === '' || t.max_kw == null ? null : Number(t.max_kw) });
      }
      return res.json({ ok: true });
    }
    case 'create_partner': {
      const key = newKey();
      const all = await db.select('partners', {});
      const p = await db.insert('partners', {
        name: clean(b.name, 80) || 'Partner', company: clean(b.company, 120), email: clean(b.email, 200), phone: b.phone ? normPhone(b.phone) : null,
        webhook_url: clean(b.webhook_url, 500), webhook_secret: b.webhook_url ? newKey().slice(3) : null,
        public_phone: b.public_phone ? normPhone(b.public_phone) : null,
        fee_mode: b.fee_mode === 'flat' ? 'flat' : 'split', split_percent: pctOrNull(b.split_percent), ads_paid_by: ['partner', 'owner'].includes(b.ads_paid_by) ? b.ads_paid_by : null,
        key_hash: sha(key), is_default: all.length === 0 || b.is_default === true, active: true,
      });
      if (p.is_default) for (const o of all) if (o.is_default) await db.update('partners', { id: o.id }, { is_default: false });
      // The access key is shown exactly once.
      return res.status(201).json({ ok: true, partner: partnerView(p), access_key: key, webhook_secret: p.webhook_secret });
    }
    case 'update_partner': {
      const p = await db.get('partners', { id: b.partner_id });
      if (!p) throw new HttpError(404, 'partner not found');
      const set = {};
      ['name', 'company', 'email', 'webhook_url'].forEach((k) => { if (b[k] !== undefined) set[k] = clean(b[k], 500); });
      if (b.phone !== undefined) set.phone = b.phone ? normPhone(b.phone) : null;
      if (b.active !== undefined) set.active = !!b.active;
      if (b.public_phone !== undefined) set.public_phone = b.public_phone ? normPhone(b.public_phone) : null;
      if (b.fee_mode !== undefined) set.fee_mode = b.fee_mode === 'flat' ? 'flat' : 'split';
      if (b.split_percent !== undefined) set.split_percent = pctOrNull(b.split_percent);
      if (b.ads_paid_by !== undefined) set.ads_paid_by = ['partner', 'owner'].includes(b.ads_paid_by) ? b.ads_paid_by : null;
      if (b.is_default === true) { for (const o of await db.select('partners', { where: { is_default: true } })) await db.update('partners', { id: o.id }, { is_default: false }); set.is_default = true; }
      await db.update('partners', { id: p.id }, set);
      return res.json({ ok: true });
    }
    case 'rotate_key': {
      const p = await db.get('partners', { id: b.partner_id });
      if (!p) throw new HttpError(404, 'partner not found');
      const key = newKey();
      await db.update('partners', { id: p.id }, { key_hash: sha(key) });
      return res.json({ ok: true, access_key: key });
    }
    case 'resolve_dispute': {
      const l = await resolveDispute(b.lead_id, b.accept === true);
      return res.json({ ok: true, lead: { id: l.id, stage: l.stage, dispute_status: l.dispute_status } });
    }
    case 'add_spend': {
      const dollars = Number(b.amount_dollars);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(b.month || '') || !(dollars >= 0) || dollars > 10000000) throw new HttpError(400, 'Enter a month and a dollar amount');
      const row = await db.insert('ad_spend', { month: b.month, source: clean(b.source, 60), amount_cents: Math.round(dollars * 100), note: clean(b.note, 200) });
      return res.status(201).json({ ok: true, id: row.id });
    }
    case 'delete_spend': {
      await db.remove('ad_spend', { id: b.id });
      return res.json({ ok: true });
    }
    case 'erase_lead': {
      // Privacy request: remove the person and everything attached to them
      const lead = await db.get('leads', { id: b.lead_id });
      if (!lead) throw new HttpError(404, 'lead not found');
      for (const t of ['messages', 'push_subscriptions', 'deliveries', 'lead_events', 'referral_payouts']) await db.remove(t, { lead_id: lead.id });
      await db.remove('leads', { id: lead.id });
      return res.json({ ok: true });
    }
    case 'admin_update': {
      const lead = await db.get('leads', { id: b.lead_id });
      if (!lead) throw new HttpError(404, 'lead not found');
      const u = await applyUpdate(lead, b, 'admin');
      return res.json({ ok: true, lead: { id: u.id, stage: u.stage } });
    }
    default:
      throw new HttpError(400, 'unknown action');
  }
});
