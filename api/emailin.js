// POST /api/emailin — Resend "email.received" webhook. Lets the partner answer a customer by replying to the alert email.
// Setup: Resend -> Receiving (your inbound domain) -> Webhook to https://YOUR-SITE/api/emailin, set RESEND_WEBHOOK_SECRET
// and INBOUND_EMAIL_DOMAIN. Only replies sent from the partner's own email address are accepted.
const { route } = require('../lib/http');
const P = require('../lib/portal');

const f = (...a) => (globalThis.__wwfetch || fetch)(...a);

async function rawBody(req) {
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (req.readable && !req.body) { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks).toString('utf8'); }
  return JSON.stringify(req.body || {});
}

const handler = route(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const raw = await rawBody(req);
  if (!P.verifyWebhook(req.headers, raw, process.env.RESEND_WEBHOOK_SECRET)) return res.status(401).json({ error: 'bad_signature' });
  let evt; try { evt = JSON.parse(raw); } catch (_) { return res.status(400).json({ error: 'bad_json' }); }
  if (evt.type !== 'email.received' || !evt.data) return res.json({ ok: true, ignored: true });
  const d = evt.data;
  const r = await f(`https://api.resend.com/emails/receiving/${encodeURIComponent(d.email_id)}`, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
  if (!r.ok) return res.status(502).json({ error: 'fetch_failed' });   // non-2xx makes Resend retry
  const mail = await r.json();
  const out = await P.ingestReply({ to: d.to, from: d.from, text: mail.text || String(mail.html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '') });
  res.json(out);
});
handler.config = { api: { bodyParser: false } };   // signature needs the exact raw bytes
module.exports = handler;
