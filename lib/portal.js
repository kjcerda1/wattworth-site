/* Customer portal service: private-link auth, what the customer may see, messaging with the
   solar specialist (portal, email reply, partner dashboard), and notifications (web push with
   email fallback). Nothing here exposes commission, internal notes, fees or other customers. */
const crypto = require('crypto');
const db = require('./db');
const W = require('./shared');
const { sendMail, emailReady, esc, shell } = require('./mail');
const { safeEqual } = require('./auth');

const appUrl = () => (process.env.APP_URL || '').replace(/\/$/, '');
const TZ = () => process.env.DISPLAY_TZ || 'America/Chicago';
const MSG_LIMIT = 20;           // customer messages per hour
const MSG_MAX = 2000;

const newToken = () => 'wc_' + crypto.randomBytes(24).toString('hex');
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

async function newOwnCode(first) {
  const base = String(first || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5) || 'WW';
  for (let i = 0; i < 8; i++) {
    const code = base + Array.from(crypto.randomBytes(3), (b) => ALPHA[b % ALPHA.length]).join('');
    if (!(await db.get('leads', { own_code: code }))) return code;
  }
  return 'WW' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

const portalUrl = (lead) => `${appUrl()}/portal/#t=${lead.portal_token}`;
const fmtWhen = (iso) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ() });

/* ---------- auth ---------- */
async function customerFrom(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(wc_[a-f0-9]{48})$/i.exec(h.trim());
  if (!m) return null;
  const lead = await db.get('leads', { portal_token: m[1] });
  return lead && !lead.deletion_requested_at ? lead : null;
}

/* ---------- what the customer sees ---------- */
const STEPS = [
  { key: 'received', label: 'Request received', hint: 'We have your details and passed them to your solar specialist.' },
  { key: 'contacted', label: 'Specialist reached out', hint: 'Your specialist introduces themselves and answers your first questions.' },
  { key: 'appointment_set', label: 'Consultation scheduled', hint: 'A time to go over your home, your bills and your options.' },
  { key: 'proposal_sent', label: 'Proposal ready', hint: 'Your custom system design and pricing.' },
  { key: 'signed', label: 'Agreement signed', hint: 'Paperwork, permits and scheduling begin.' },
  { key: 'installed', label: 'System installed', hint: 'Your system is on the roof and ready to go.' },
];

/** What a referrer may see about the people they referred. Built field by field from approved values only:
 *  never a lead row, so no name, contact detail, address, ZIP, utility data, bill, storage path, proposal or contract
 *  amount, sales note or partner commission can reach this response. Referrals are anonymous ("Referral #1"). */
async function referrerView(lead, rewards) {
  const R = require('./referral');
  const rows = [];
  for (const r of rewards.slice().sort((a, b) => (a.created_at < b.created_at ? -1 : 1))) {
    const l = await db.get('leads', { id: r.lead_id });
    if (!l || l.duplicate_of || l.id === lead.id) continue;
    const m = R.milestoneOf(r, l);
    rows.push({ status: r.status, amount: r.amount_cents, milestone: m, updated: String(r.updated_at || r.created_at || '').slice(0, 10), verified: !!l.verification_method });
  }
  const live = rows.filter((x) => x.status !== 'ineligible');
  const sum = (st) => rows.filter((x) => x.status === st).reduce((t, x) => t + x.amount, 0);
  return {
    code: lead.own_code || null,
    path: lead.own_code ? '/r/' + lead.own_code : null,
    reward_cents: R.AMOUNT,
    stats: {
      total: rows.length,
      verified: live.filter((x) => x.verified).length,
      in_progress: live.filter((x) => ['tracking', 'installation_confirmed'].includes(x.status)).length,
      installed: live.filter((x) => ['reward_pending', 'paid'].includes(x.status)).length,
      reward_pending: rows.filter((x) => x.status === 'reward_pending').length,
      paid: rows.filter((x) => x.status === 'paid').length,
    },
    paid_cents: sum('paid'),
    pending_cents: sum('reward_pending'),
    list: rows.map((x, i) => ({ n: i + 1, milestone: x.milestone, label: R.MILESTONES[x.milestone], updated: x.updated })),
  };
}

async function customerView(lead) {
  const [partner, events, messages, rewards] = await Promise.all([
    lead.partner_id ? db.get('partners', { id: lead.partner_id }) : null,
    db.select('lead_events', { where: { lead_id: lead.id }, order: ['created_at', 'asc'], limit: 200 }),
    db.select('messages', { where: { lead_id: lead.id }, order: ['created_at', 'asc'], limit: 500 }),
    lead.own_code ? db.select('referral_rewards', { where: { referrer_code: lead.own_code } }) : [],
  ]);
  const closed = ['lost', 'invalid'].includes(lead.stage);
  const at = {};
  events.filter((e) => e.type === 'stage').forEach((e) => { if (!at[e.to_value]) at[e.to_value] = e.created_at; });
  at.received = lead.created_at;
  if (lead.first_contacted_at && !at.contacted) at.contacted = lead.first_contacted_at;
  const steps = STEPS.map((s) => ({ ...s, done: !closed && W.reached(lead.stage, s.key), current: !closed && lead.stage === s.key, at: !closed && W.reached(lead.stage, s.key) ? at[s.key] || null : null }));
  // the "next up" step gets highlighted when the current one is done
  const referral = await referrerView(lead, rewards);
  const unverified = !!lead.first_contacted_at && !lead.contact_confirmed;
  return {
    lead: { ref: lead.ref, first_name: lead.first_name, city: lead.city, state: lead.state, stage: closed ? 'closed' : lead.stage, closed, created_at: lead.created_at },
    steps,
    appointment_at: lead.appointment_at || null,
    appointment_text: lead.appointment_at ? fmtWhen(lead.appointment_at) : null,
    specialist: partner ? { name: partner.name, company: partner.company, phone: partner.public_phone || null } : null,
    messages: messages.map((m) => ({ id: m.id, from: m.sender, body: m.body, at: m.created_at, read: m.sender === 'partner' ? !!m.read_by_customer_at : true })),
    unread: messages.filter((m) => m.sender === 'partner' && !m.read_by_customer_at).length,
    confirm: { state: lead.contact_confirmed || null, ask: unverified && !closed },
    referral,
    push: { available: pushReady(), public_key: process.env.VAPID_PUBLIC_KEY || null, devices: (await db.select('push_subscriptions', { where: { lead_id: lead.id } })).length },
    tz: TZ(),
  };
}

/* ---------- push + email notifications ---------- */
const pushReady = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

async function sendPush(sub, payload) {
  if (globalThis.__wwpush) return globalThis.__wwpush(sub, payload);
  const wp = require('web-push');
  wp.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:' + (process.env.OWNER_EMAIL || 'admin@example.com'), process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  return wp.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 86400 });
}

/** Tell the customer something. Push first; email only when no device could be reached. Deduped by key. Never throws. */
async function notifyCustomer(lead, { key, title, body, tag }) {
  try {
    if (key) { if ((await db.select('alerts', { where: { key }, limit: 1 })).length) return { sent: false, deduped: true }; }
    let pushed = 0;
    if (pushReady() || globalThis.__wwpush) {
      for (const s of await db.select('push_subscriptions', { where: { lead_id: lead.id } })) {
        try {
          await sendPush(s, { title, body, tag: tag || 'ww', url: '/portal/' });
          pushed++;
          if (s.failures) await db.update('push_subscriptions', { id: s.id }, { failures: 0 });
        } catch (e) {
          if (e && (e.statusCode === 404 || e.statusCode === 410)) await db.remove('push_subscriptions', { id: s.id });
          else await db.update('push_subscriptions', { id: s.id }, { failures: (s.failures || 0) + 1 });
        }
      }
    }
    let emailed = false;
    if (!pushed && lead.email && lead.portal_token && emailReady()) {
      try {
        emailed = await sendMail({ to: lead.email, subject: title, html: shell(title, `<p style="margin:6px 0">${esc(body)}</p>`, portalUrl(lead), 'Open my tracker'), text: `${body}\n\n${portalUrl(lead)}` });
      } catch (e) { console.error('[wattworth] customer email failed', e.message); }
    }
    if ((pushed || emailed) && key) await db.insert('alerts', { key });
    return { sent: pushed > 0 || emailed, pushed, emailed };
  } catch (e) {
    console.error('[wattworth] notifyCustomer failed', e.message);
    return { sent: false };
  }
}

const STAGE_COPY = (who) => ({
  contacted: ['Your solar specialist reached out', `${who} has introduced themselves. Open your tracker to see next steps or send a question.`],
  appointment_set: ['Your consultation is scheduled', 'Open your tracker for the date and time.'],
  proposal_sent: ['Your solar proposal is ready', `${who} has your proposal ready. Questions? Message them in your tracker.`],
  signed: ['Your agreement is signed', 'Congratulations! Next up are permits and installation scheduling.'],
  installed: ['Your solar system is installed', 'Welcome to solar. Your tracker has everything in one place.'],
});

/** Called after a partner/admin moves a lead forward. */
async function onStageChange(lead, from) {
  if (!lead || lead.stage === from) return;
  const partner = lead.partner_id ? await db.get('partners', { id: lead.partner_id }) : null;
  const who = partner ? partner.name : 'Your solar specialist';
  const copy = STAGE_COPY(who)[lead.stage];
  if (!copy || ['lost', 'invalid'].includes(from)) return;
  if (W.KEYS.indexOf(lead.stage) < W.KEYS.indexOf(from)) return;          // moving backwards: stay quiet
  await notifyCustomer(lead, { key: `cust:${lead.id}:${lead.stage}`, title: copy[0], body: copy[1], tag: 'stage' });
}

async function onAppointment(lead) {
  if (!lead.appointment_at) return;
  await notifyCustomer(lead, { key: `cust:${lead.id}:appt:${lead.appointment_at}`, title: 'Consultation scheduled', body: `Your consultation is set for ${fmtWhen(lead.appointment_at)}.`, tag: 'appt' });
}

/** Cron: 24-hour and 1-hour reminders. Safe to run every 15 minutes (each is sent once). */
async function reminders(now = Date.now()) {
  let n = 0;
  const leads = (await db.select('leads', {})).filter((l) => l.appointment_at && !l.duplicate_of && !['lost', 'invalid'].includes(l.stage));
  for (const l of leads) {
    const until = (new Date(l.appointment_at).getTime() - now) / 3600e3;
    let kind = null;
    if (until > 0 && until <= 1) kind = '1h'; else if (until > 23 && until <= 24) kind = '24h';
    if (!kind) continue;
    const r = await notifyCustomer(l, { key: `cust:${l.id}:rem${kind}:${l.appointment_at}`, title: kind === '1h' ? 'Your consultation is in about an hour' : 'Your consultation is tomorrow', body: `Scheduled for ${fmtWhen(l.appointment_at)}.`, tag: 'appt' });
    if (r.sent) n++;
  }
  return n;
}

/* ---------- messaging ---------- */
const cleanMsg = (t) => String(t == null ? '' : t).replace(/\r/g, '').trim().slice(0, MSG_MAX);

async function customerSend(lead, text) {
  const { HttpError } = require('./leads');
  const body = cleanMsg(text);
  if (!body) throw new HttpError(400, 'Write a message first.');
  const hourAgo = Date.now() - 3600e3;
  const recent = (await db.select('messages', { where: { lead_id: lead.id, sender: 'customer' } })).filter((m) => new Date(m.created_at).getTime() > hourAgo);
  if (recent.length >= MSG_LIMIT) throw new HttpError(429, 'You have sent a lot of messages. Please wait a bit before sending more.');
  const msg = await db.insert('messages', { lead_id: lead.id, sender: 'customer', body, via: 'portal', read_by_customer_at: new Date().toISOString(), read_by_partner_at: null });
  await emailPartnerMessage(lead, body);
  return msg;
}

const replyTo = (lead) => (process.env.INBOUND_EMAIL_DOMAIN ? `reply+${String(lead.ref).toLowerCase()}@${process.env.INBOUND_EMAIL_DOMAIN}` : null);

async function emailPartnerMessage(lead, body) {
  try {
    const partner = lead.partner_id ? await db.get('partners', { id: lead.partner_id }) : null;
    if (!partner || !partner.email || !emailReady()) return false;
    const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ');
    const rt = replyTo(lead);
    const inner = `<p style="margin:6px 0;color:#6b6b60">${esc(name)} (${esc(lead.ref)}) wrote:</p><blockquote style="margin:10px 0;padding:10px 14px;border-left:3px solid #C9A86A;background:#F6F1E7">${esc(body).replace(/\n/g, '<br>')}</blockquote>
      <p style="margin:6px 0;color:#6b6b60">${rt ? 'Reply to this email to answer them. Your reply appears in their app.' : 'Answer them from your dashboard.'}</p>`;
    return await sendMail({ to: partner.email, subject: `Message from ${name} (${lead.ref})`, html: shell(`Message from ${name}`, inner, appUrl() ? appUrl() + '/partner/' : '', 'Open dashboard'), text: `${name} (${lead.ref}) wrote:\n\n${body}\n\n${rt ? 'Reply to this email to answer them.' : ''}`, reply_to: rt });
  } catch (e) { console.error('[wattworth] partner message email failed', e.message); return false; }
}

async function partnerSend(lead, text, via = 'dashboard') {
  const { HttpError } = require('./leads');
  const body = cleanMsg(text);
  if (!body) throw new HttpError(400, 'Write a message first.');
  const msg = await db.insert('messages', { lead_id: lead.id, sender: 'partner', body, via, read_by_customer_at: null, read_by_partner_at: new Date().toISOString() });
  if (!lead.first_contacted_at) await db.update('leads', { id: lead.id }, { first_contacted_at: new Date().toISOString() });
  const partner = lead.partner_id ? await db.get('partners', { id: lead.partner_id }) : null;
  await notifyCustomer(lead, { key: `cust:msg:${msg.id}`, title: `New message from ${partner ? partner.name : 'your solar specialist'}`, body: body.length > 140 ? body.slice(0, 137) + '...' : body, tag: 'msg' });
  return msg;
}

/* ---------- inbound email (Resend) ---------- */
function stripQuoted(text) {
  let t = String(text || '').replace(/\r/g, '');
  const cut = [/\nOn [^\n]{0,200}(\n[^\n]{0,200})?\bwrote:/i, /\n-{2,}\s*Original Message/i, /\nFrom:\s[^\n]+\nSent:/i, /\n>/, /\nSent from my /i];
  for (const re of cut) { const m = re.exec('\n' + t); if (m) t = ('\n' + t).slice(0, m.index).replace(/^\n/, ''); }
  return t.trim();
}
const addr = (s) => { const m = /<([^>]+)>/.exec(String(s || '')); return String(m ? m[1] : s || '').trim().toLowerCase(); };

async function ingestReply({ to, from, text }) {
  const list = Array.isArray(to) ? to : [to];
  let ref = null;
  for (const t of list) { const m = /reply\+([a-z0-9-]+)@/i.exec(String(t || '')); if (m) { ref = m[1].toUpperCase(); break; } }
  if (!ref) return { ok: false, reason: 'no_ref' };
  const lead = await db.get('leads', { ref });
  if (!lead) return { ok: false, reason: 'unknown_lead' };
  const partner = lead.partner_id ? await db.get('partners', { id: lead.partner_id }) : null;
  // Only the partner's own email address may answer a customer.
  if (!partner || !partner.email || addr(from) !== addr(partner.email)) return { ok: false, reason: 'sender_not_partner' };
  const body = stripQuoted(text);
  if (!body) return { ok: false, reason: 'empty' };
  await partnerSend(lead, body, 'email');
  return { ok: true, lead_id: lead.id };
}

function verifyWebhook(headers, raw, secret) {
  const id = headers['svix-id'], ts = headers['svix-timestamp'], sigs = headers['svix-signature'];
  if (!id || !ts || !sigs || !secret) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  return String(sigs).split(' ').some((s) => { const [v, sig] = s.split(','); return v === 'v1' && sig && safeEqual(sig, expected); });
}

/* ---------- link emails ---------- */
async function sendPortalLink(lead) {
  if (!lead || !lead.email || !lead.portal_token || !emailReady()) return false;
  try {
    const ok = await sendMail({ to: lead.email, subject: 'Your WattWorth solar tracker', html: shell('Your solar tracker', `<p style="margin:6px 0">Hi ${esc(lead.first_name)}, this is your private link. Follow your project, message your solar specialist and turn on notifications. Add it to your home screen to use it like an app.</p><p style="margin:6px 0;color:#6b6b60">Keep this link private. Anyone with it can see your tracker.</p>`, portalUrl(lead), 'Open my tracker'), text: `Your private WattWorth tracker: ${portalUrl(lead)}` });
    if (ok) await db.update('leads', { id: lead.id }, { portal_link_sent_at: new Date().toISOString() });
    return ok;
  } catch (e) { console.error('[wattworth] portal link email failed', e.message); return false; }
}

module.exports = { sendPush, newToken, newOwnCode, portalUrl, customerFrom, customerView, notifyCustomer, onStageChange, onAppointment, reminders, customerSend, partnerSend, emailPartnerMessage, ingestReply, stripQuoted, verifyWebhook, sendPortalLink, pushReady, fmtWhen, STEPS };
