/* Alerts to the owner (OWNER_EMAIL / OWNER_PHONE). Each alert has a key and is sent at most once. */
const db = require('./db');
const { sendMail, sendText, emailReady, esc, shell } = require('./mail');

const appUrl = () => (process.env.APP_URL || '').replace(/\/$/, '');

/** Send an owner alert once per key. Never throws; returns true only when something was actually sent. */
async function alertOwner({ key, subject, lines, sms }) {
  try {
    const to = process.env.OWNER_EMAIL, phone = process.env.OWNER_PHONE;
    if (!to && !phone) return false;
    if ((await db.select('alerts', { where: { key }, limit: 1 })).length) return false;
    let sent = false;
    // Each channel is independent: if email is down, the text still goes out (and vice versa).
    if (to && emailReady()) {
      try {
        const html = shell(subject, lines.map((l) => `<p style="margin:6px 0">${esc(l)}</p>`).join(''), appUrl() ? appUrl() + '/admin/' : '');
        sent = (await sendMail({ to, subject: 'WattWorth: ' + subject, html, text: lines.join('\n') })) || sent;
      } catch (e) { console.error('[wattworth] owner email failed', e.message); }
    }
    if (phone && sms) {
      try { sent = (await sendText({ to: phone, body: `WattWorth: ${subject}` })) || sent; }
      catch (e) { console.error('[wattworth] owner sms failed', e.message); }
    }
    if (sent) await db.insert('alerts', { key });
    return sent;
  } catch (e) {
    console.error('[wattworth] alert failed', e.message);
    return false;
  }
}

module.exports = { alertOwner };
