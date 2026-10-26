/* Plain email + SMS senders used by alerts, nudges and statements. Return false when the channel isn't configured. */
const f = (...a) => (globalThis.__wwfetch || fetch)(...a);

const emailReady = () => !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
const smsReady = () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);

async function sendMail({ to, subject, html, text }) {
  if (!emailReady() || !to) return false;
  const res = await f('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, html, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}`);
  return true;
}

async function sendText({ to, body }) {
  if (!smsReady() || !to) return false;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const res = await f(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: body }).toString(),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}`);
  return true;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const shell = (title, inner, link) => `<div style="font-family:DM Sans,Arial,sans-serif;max-width:520px;margin:auto;color:#1b2b24">
  <h2 style="font-family:Georgia,serif;color:#1F4D3A;margin:0 0 12px">${esc(title)}</h2>${inner}
  ${link ? `<p style="margin-top:20px"><a href="${esc(link)}" style="background:#1F4D3A;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none">Open dashboard</a></p>` : ''}</div>`;

module.exports = { sendMail, sendText, emailReady, smsReady, esc, shell };
