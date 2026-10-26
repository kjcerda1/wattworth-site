/* Lead service: intake, dispatch to partner, partner updates, referral milestones. */
const crypto = require('crypto');
const db = require('./db');
const { senders } = require('./notify');
const W = require('./shared');
const { alertOwner } = require('./alerts');
const portal = require('./portal');

const MAX_ATTEMPTS = 5;
const DUP_WINDOW_DAYS = 30;
const IP_LIMIT = 5, IP_WINDOW_MS = 3600e3; // max real submissions per IP per hour
const clean = (v, n = 200) => (v == null ? null : String(v).trim().slice(0, n) || null);

function normPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return null;
}
function newRef() {
  const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return 'WW-' + Array.from(crypto.randomBytes(6), (b) => a[b % a.length]).join('');
}
async function event(lead_id, type, actor, from_value, to_value, note) {
  return db.insert('lead_events', { lead_id, type, actor, from_value: from_value ?? null, to_value: to_value ?? null, note: note ?? null });
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function defaultPartner() {
  const all = await db.select('partners', { where: { active: true } });
  return all.find((p) => p.is_default) || all[0] || null;
}

/* ---------- intake ---------- */
async function createLead(input, ctx = {}) {
  if (input.website) return { ok: true, dropped: true }; // honeypot: bots fill hidden "website"
  const first = clean(input.first_name || (input.name || '').split(' ')[0], 80);
  const last = clean(input.last_name || (input.name || '').split(' ').slice(1).join(' '), 80);
  const phone = normPhone(input.phone);
  if (!first) throw new HttpError(400, 'first_name required');
  if (!phone) throw new HttpError(400, 'valid US phone required');
  if (input.consent !== true && input.consent !== 'true') throw new HttpError(400, 'consent required');
  const consent_text = clean(input.consent_text, 2000);
  if (!consent_text) throw new HttpError(400, 'consent_text required (store the exact wording shown to the consumer)');
  const email = clean(input.email, 200);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'invalid email');

  if (ctx.ip) {
    const recent = (await db.select('leads', { where: { consent_ip: ctx.ip } })).filter((l) => Date.now() - new Date(l.created_at).getTime() < IP_WINDOW_MS);
    if (recent.length >= IP_LIMIT) throw new HttpError(429, 'Too many submissions. Please try again later.');
  }

  const partner = await defaultPartner();
  // Referral codes must belong to a real earlier customer (and not be the same person). Unknown codes are ignored.
  let refCode = clean(input.referrer_code, 60), refName = null;
  if (refCode) {
    const owner = await db.get('leads', { own_code: refCode.toUpperCase() });
    if (!owner || owner.phone === phone) refCode = null;
    else { refCode = owner.own_code; refName = clean(owner.first_name + (owner.last_name ? ' ' + owner.last_name[0] + '.' : ''), 120); }
  }
  const bill = input.monthly_bill === '' || input.monthly_bill == null ? null : Number(input.monthly_bill);

  // Duplicate check: same phone with same partner inside the window
  const cutoff = Date.now() - DUP_WINDOW_DAYS * 864e5;
  const prior = (await db.select('leads', { where: { phone } })).find(
    (l) => !l.duplicate_of && new Date(l.created_at).getTime() > cutoff);

  const lead = await db.insert('leads', {
    ref: newRef(), partner_id: partner ? partner.id : null,
    first_name: first, last_name: last, phone, email,
    address: clean(input.address), city: clean(input.city, 80), state: clean(input.state, 2)?.toUpperCase() || null, zip: clean(input.zip, 10),
    monthly_bill: Number.isFinite(bill) ? bill : null,
    homeowner: input.homeowner == null || input.homeowner === '' ? null : input.homeowner === true || input.homeowner === 'true' || input.homeowner === 'yes',
    notes: clean(input.notes, 1000), source: clean(input.source, 120), utm: input.utm && typeof input.utm === 'object' ? input.utm : null,
    referrer_code: refCode, referrer_name: refName,
    portal_token: prior ? null : portal.newToken(), own_code: prior ? null : await portal.newOwnCode(first), appointment_at: null, contact_confirmed: null, contact_confirmed_at: null, deletion_requested_at: null, portal_link_sent_at: null,
    consent: true, consent_text, consent_at: new Date().toISOString(), consent_ip: clean(ctx.ip, 64), consent_user_agent: clean(ctx.ua, 300),
    stage: 'received', system_kw: null, contract_value: null, first_contacted_at: null, signed_at: null, installed_at: null,
    lost_reason: null, invalid_reason: null, dispute_status: null, dispute_resolved_at: null, fee_paid_at: null, commission_cents: null, commission_collected_cents: 0, duplicate_of: prior ? prior.id : null,
  });
  await event(lead.id, 'created', 'system', null, 'received', lead.source ? 'source: ' + lead.source : null);

  if (lead.referrer_code) await addPayout(lead, 'submitted');

  if (prior) {
    await event(lead.id, 'duplicate', 'system', null, null, `Same phone as ${prior.ref}; not sent to partner`);
    // They already have a tracker: email them the link (never hand a token to someone who only knows a phone number).
    if (!prior.portal_link_sent_at || Date.now() - new Date(prior.portal_link_sent_at).getTime() > 600e3) await portal.sendPortalLink(prior);
    return { ok: true, ref: lead.ref, duplicate_of: prior.ref, delivered: false, existing_tracker: true };
  }
  if (!partner) {
    await event(lead.id, 'delivery', 'system', null, 'no_partner', 'No active partner to route to');
    await portal.sendPortalLink(lead);
    return { ok: true, ref: lead.ref, delivered: false, portal_token: lead.portal_token, own_code: lead.own_code };
  }
  const results = await dispatchLead(lead, partner);
  await portal.sendPortalLink(lead);
  return { ok: true, ref: lead.ref, portal_token: lead.portal_token, own_code: lead.own_code, delivered: results.some((r) => r.status === 'sent'), deliveries: results.map((r) => ({ channel: r.channel, status: r.status })) };
}

/* ---------- dispatch ---------- */
function channelsFor(p) {
  const c = [];
  if (p.email) c.push('email');
  if (p.phone) c.push('sms');
  if (p.webhook_url) c.push('webhook');
  return c.length ? c : ['email']; // always log at least one attempt so a missing contact shows up in the dashboard
}

async function attempt(delivery, lead, partner) {
  const attempts = delivery.attempts + 1;
  try {
    const r = await senders[delivery.channel](lead, partner);
    const [row] = await db.update('deliveries', { id: delivery.id }, { status: 'sent', attempts, last_error: null, provider_id: r.providerId || null, sent_at: new Date().toISOString() });
    await event(lead.id, 'delivery', 'system', null, 'sent', delivery.channel);
    return row;
  } catch (err) {
    const status = err.skip ? 'skipped' : 'failed';
    const [row] = await db.update('deliveries', { id: delivery.id }, { status, attempts, last_error: String(err.message).slice(0, 300) });
    await event(lead.id, 'delivery', 'system', null, status, `${delivery.channel}: ${err.message}`.slice(0, 300));
    return row;
  }
}

async function dispatchLead(lead, partner) {
  const out = [];
  for (const channel of channelsFor(partner)) {
    const d = await db.insert('deliveries', { lead_id: lead.id, partner_id: partner.id, channel, status: 'queued', attempts: 0, last_error: null, provider_id: null, sent_at: null });
    out.push(await attempt(d, lead, partner));
  }
  return out;
}

async function retryDelivery(id) {
  const d = await db.get('deliveries', { id });
  if (!d) throw new HttpError(404, 'delivery not found');
  const [lead, partner] = [await db.get('leads', { id: d.lead_id }), await db.get('partners', { id: d.partner_id })];
  return attempt(d, lead, partner);
}

/** Cron: retry failed (not skipped) deliveries under the attempt cap, oldest first. */
async function retryFailed() {
  const failed = (await db.select('deliveries', { where: { status: 'failed' }, order: ['created_at', 'asc'], limit: 50 })).filter((d) => d.attempts < MAX_ATTEMPTS);
  let retried = 0, sent = 0;
  for (const d of failed) {
    const r = await retryDelivery(d.id); retried++;
    if (r.status === 'sent') sent++;
    else if (r.attempts >= MAX_ATTEMPTS) {
      const lead = await db.get('leads', { id: r.lead_id });
      await alertOwner({ key: `deliv:${r.id}`, sms: true, subject: `Lead ${lead ? lead.ref : ''} could not be sent to your partner (${r.channel})`, lines: [`${r.channel} delivery failed ${r.attempts} times.`, r.last_error || '', 'Open the dashboard and use Resend, or contact the lead directly.'] });
    }
  }
  return { retried, sent };
}

/* ---------- referral milestones ---------- */
async function addPayout(lead, milestone) {
  if (!lead.referrer_code) return null;
  const existing = await db.select('referral_payouts', { where: { lead_id: lead.id, milestone } });
  if (existing.length) return existing[0];
  const m = W.REFERRAL[milestone];
  const due_at = m.delayDays ? new Date(Date.now() + m.delayDays * 864e5).toISOString() : null;
  return db.insert('referral_payouts', { lead_id: lead.id, referrer_code: lead.referrer_code, milestone, amount_cents: m.cents, status: 'pending', due_at, paid_at: null });
}

/* ---------- partner / admin updates ---------- */
async function applyUpdate(lead, patch, actor) {
  const set = {}; const log = [];
  if (patch.stage !== undefined && patch.stage !== lead.stage) {
    if (!W.KEYS.includes(patch.stage)) throw new HttpError(400, 'invalid stage');
    set.stage = patch.stage;
    const now = new Date().toISOString();
    if (patch.stage !== 'received' && !lead.first_contacted_at) set.first_contacted_at = now;
    if (patch.stage === 'signed' && !lead.signed_at) set.signed_at = now;
    if (patch.stage === 'installed') { if (!lead.signed_at) set.signed_at = now; if (!lead.installed_at) set.installed_at = now; }
    if (patch.stage === 'lost') set.lost_reason = clean(patch.lost_reason, 300) || lead.lost_reason;
    if (patch.stage === 'invalid') {
      const why = clean(patch.invalid_reason, 300);
      if (!why || why.length < 3) throw new HttpError(400, 'Tell us why the lead is invalid (for example: wrong number, renter, outside service area).');
      set.invalid_reason = why; set.dispute_status = 'pending'; set.dispute_resolved_at = null;
    } else if (lead.stage === 'invalid') { set.dispute_status = null; set.invalid_reason = null; } // partner withdrew the flag
    log.push(['stage', lead.stage, patch.stage, patch.stage === 'invalid' ? clean(patch.invalid_reason, 300) : clean(patch.note, 1000)]);
  }
  if (patch.system_kw !== undefined) {
    const kw = patch.system_kw === '' || patch.system_kw === null ? null : Number(patch.system_kw);
    if (kw !== null && !(kw >= 0.5 && kw <= 100)) throw new HttpError(400, 'system_kw must be between 0.5 and 100');
    if (kw !== (lead.system_kw == null ? null : Number(lead.system_kw))) { set.system_kw = kw; log.push(['size', lead.system_kw, kw, null]); }
  }
  if (patch.contract_value !== undefined) {
    const v = patch.contract_value === '' || patch.contract_value === null ? null : Number(patch.contract_value);
    if (v !== null && !(v >= 0 && v < 10000000)) throw new HttpError(400, 'invalid contract_value');
    if (v !== (lead.contract_value == null ? null : Number(lead.contract_value))) { set.contract_value = v; log.push(['value', lead.contract_value, v, null]); }
  }
  if (patch.commission_dollars !== undefined) {
    const c = patch.commission_dollars === '' || patch.commission_dollars === null ? null : Math.round(Number(patch.commission_dollars) * 100);
    if (c !== null && !(c >= 0 && c <= 1e9)) throw new HttpError(400, 'commission must be a dollar amount of 0 or more');
    if (c !== (lead.commission_cents == null ? null : Number(lead.commission_cents))) {
      set.commission_cents = c;
      log.push(['commission', lead.commission_cents == null ? null : (lead.commission_cents / 100).toFixed(2), c == null ? null : (c / 100).toFixed(2), null]);
    }
  }
  if (patch.appointment_at !== undefined) {
    const t = patch.appointment_at === '' || patch.appointment_at === null ? null : new Date(patch.appointment_at);
    if (t && isNaN(t.getTime())) throw new HttpError(400, 'invalid appointment time');
    const iso = t ? t.toISOString() : null;
    if (iso !== (lead.appointment_at ? new Date(lead.appointment_at).toISOString() : null)) {
      set.appointment_at = iso;
      log.push(['appointment', lead.appointment_at || null, iso, null]);
    }
  }
  const note = clean(patch.note, 1000);
  if (note && !log.some((l) => l[0] === 'stage')) log.push(['note', null, null, note]);

  let updated = lead;
  if (Object.keys(set).length) updated = (await db.update('leads', { id: lead.id }, set))[0];
  for (const [t, a, b, n] of log) await event(lead.id, t, actor, a, b, n);

  // Customer-facing: tracker notifications, and an optional message to the customer
  if (actor !== 'system') {
    if (set.stage) await portal.onStageChange(updated, lead.stage);
    if (set.appointment_at) await portal.onAppointment(updated);
    if (patch.message && String(patch.message).trim()) await portal.partnerSend(updated, patch.message, 'dashboard');
  }

  // Tell the owner about the moments that matter
  if (set.stage && W.reached(set.stage, W.FEE_TRIGGER) && !W.reached(lead.stage, W.FEE_TRIGGER)) await alertOwner({ key: `signed:${lead.id}`, sms: true, subject: `Deal ${W.LABEL[set.stage].toLowerCase()}: ${lead.ref}`, lines: [`${lead.first_name} ${lead.last_name || ''} (${lead.ref}) moved to ${W.LABEL[set.stage]}.`, updated.system_kw ? `System size: ${updated.system_kw} kW.` : 'System size not entered yet.'] });

  // Referral milestones unlock as the deal moves
  if (updated.referrer_code && set.stage) {
    for (const [m, def] of Object.entries(W.REFERRAL)) if (def.stage && W.reached(updated.stage, def.stage)) await addPayout(updated, m);
  }
  return updated;
}

/** Owner decision on a flagged lead. accept: stays invalid (no fee; credit if already paid). decline: goes back to where it was. */
async function resolveDispute(lead_id, accept, actor = 'admin') {
  const lead = await db.get('leads', { id: lead_id });
  if (!lead) throw new HttpError(404, 'lead not found');
  if (lead.stage !== 'invalid' || lead.dispute_status !== 'pending') throw new HttpError(400, 'No pending dispute on this lead');
  const now = new Date().toISOString();
  if (accept) {
    await db.update('leads', { id: lead.id }, { dispute_status: 'accepted', dispute_resolved_at: now });
    await event(lead.id, 'dispute', actor, null, 'accepted', (actor === 'system' ? 'Auto-accepted after 5 days: no fee' : 'Invalid lead accepted: no fee') + (lead.fee_paid_at ? ' (credit due for fee already paid)' : ''));
  } else {
    const hist = (await db.select('lead_events', { where: { lead_id: lead.id, type: 'stage' }, order: ['created_at', 'desc'] })).find((e) => e.to_value === 'invalid');
    const back = hist && hist.from_value && hist.from_value !== 'invalid' ? hist.from_value : 'contacted';
    await db.update('leads', { id: lead.id }, { stage: back, dispute_status: 'rejected', dispute_resolved_at: now });
    await event(lead.id, 'dispute', actor, 'invalid', 'declined', 'Invalid flag declined; lead stays active');
  }
  return db.get('leads', { id: lead.id });
}

module.exports = { resolveDispute, createLead, dispatchLead, retryDelivery, retryFailed, applyUpdate, event, addPayout, HttpError, normPhone, clean };
