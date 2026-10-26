/* Outbound delivery of a lead to a partner: email (Resend), SMS (Twilio), webhook (partner's own CRM).
   Each send returns { ok, providerId } or throws; the caller records the result in `deliveries`. */
const crypto = require('crypto');

const f = (...a) => (globalThis.__wwfetch || fetch)(...a);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const appUrl = () => (process.env.APP_URL || '').replace(/\/$/, '');
const fullName = (l) => [l.first_name, l.last_name].filter(Boolean).join(' ');
const where = (l) => [l.city, l.state].filter(Boolean).join(', ');

function missing(...names) {
  const m = names.filter((n) => !process.env[n]);
  if (m.length) { const e = new Error('Not configured: ' + m.join(', ')); e.skip = true; throw e; }
}

async function sendEmail(lead, partner) {
  missing('RESEND_API_KEY', 'MAIL_FROM');
  if (!partner.email) { const e = new Error('Partner has no email'); e.skip = true; throw e; }
  const link = appUrl() ? `${appUrl()}/partner/` : '';
  const rows = [
    ['Name', fullName(lead)], ['Phone', lead.phone], ['Email', lead.email], ['Address', [lead.address, where(lead), lead.zip].filter(Boolean).join(', ')],
    ['Monthly bill', lead.monthly_bill ? '$' + lead.monthly_bill : ''], ['Homeowner', lead.homeowner == null ? '' : lead.homeowner ? 'Yes' : 'No'],
    ['Notes', lead.notes], ['Lead ref', lead.ref],
  ].filter((r) => r[1]);
  const html = `<div style="font-family:DM Sans,Arial,sans-serif;max-width:520px;margin:auto;color:#1b2b24">
    <h2 style="font-family:Georgia,serif;color:#1F4D3A;margin:0 0 4px">New WattWorth lead</h2>
    <p style="margin:0 0 16px;color:#6b6b60">Reference <b>${esc(lead.ref)}</b>. Please update its status in your dashboard as it moves.</p>
    <table style="width:100%;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#6b6b60;width:120px">${esc(k)}</td><td style="padding:6px 0"><b>${esc(v)}</b></td></tr>`).join('')}</table>
    ${link ? `<p style="margin-top:20px"><a href="${esc(link)}" style="background:#1F4D3A;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none">Open dashboard</a></p>` : ''}
  </div>`;
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + (link ? `\n\nDashboard: ${link}` : '');
  const res = await f('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [partner.email], subject: `New solar lead ${lead.ref}: ${fullName(lead)}${where(lead) ? ' (' + where(lead) + ')' : ''}`, html, text }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${j.message || JSON.stringify(j).slice(0, 200)}`);
  return { providerId: j.id };
}

async function sendSms(lead, partner) {
  missing('TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM');
  if (!partner.phone) { const e = new Error('Partner has no phone'); e.skip = true; throw e; }
  const body = `New WattWorth lead ${lead.ref}: ${fullName(lead)}${where(lead) ? ', ' + where(lead) : ''}. ${lead.phone}${appUrl() ? ' ' + appUrl() + '/partner/' : ''}`;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const res = await f(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: partner.phone, From: process.env.TWILIO_FROM, Body: body }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${j.message || ''}`);
  return { providerId: j.sid };
}

async function sendWebhook(lead, partner) {
  if (!partner.webhook_url) { const e = new Error('Partner has no webhook URL'); e.skip = true; throw e; }
  const payload = JSON.stringify({
    event: 'lead.created', lead_id: lead.id, ref: lead.ref, created_at: lead.created_at,
    contact: { first_name: lead.first_name, last_name: lead.last_name, phone: lead.phone, email: lead.email },
    property: { address: lead.address, city: lead.city, state: lead.state, zip: lead.zip, homeowner: lead.homeowner, monthly_bill: lead.monthly_bill },
    notes: lead.notes, source: lead.source,
    update_url: appUrl() ? `${appUrl()}/api/inbound` : null,
  });
  const headers = { 'Content-Type': 'application/json' };
  if (partner.webhook_secret) headers['X-WattWorth-Signature'] = 'sha256=' + crypto.createHmac('sha256', partner.webhook_secret).update(payload).digest('hex');
  const res = await f(partner.webhook_url, { method: 'POST', headers, body: payload });
  if (!res.ok) throw new Error(`Webhook ${res.status}`);
  return { providerId: null };
}

const senders = { email: sendEmail, sms: sendSms, webhook: sendWebhook };
module.exports = { senders };
