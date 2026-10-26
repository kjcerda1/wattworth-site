// Fee statements (admin only)
//   GET  /api/statement?month=YYYY-MM&partner_id=...   -> statement JSON
//   POST /api/statement { month, partner_id }          -> emails the statement to the partner
const { route, body, deny } = require('../lib/http');
const { isAdmin } = require('../lib/auth');
const { build } = require('../lib/statement');
const { sendMail, emailReady, esc, shell } = require('../lib/mail');
const { HttpError } = require('../lib/leads');
const W = require('../lib/shared');

module.exports = route(async (req, res) => {
  if (!isAdmin(req)) return deny(res);
  if (req.method === 'GET') return res.json(await build(req.query.month, req.query.partner_id));
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const b = body(req);
  const st = await build(b.month, b.partner_id);
  if (!st.partner.email) throw new HttpError(400, 'This partner has no email address');
  if (!emailReady()) throw new HttpError(400, 'Email is not configured (RESEND_API_KEY, MAIL_FROM)');
  const m = W.money;
  const rows = st.lines.map((l) => `<tr><td style="padding:6px 4px">${esc(l.ref)}</td><td>${esc(l.name)}</td><td>${l.system_kw ? esc(l.system_kw) + ' kW' : ''}</td><td style="text-align:right">${m(l.billed_cents / 1)}</td></tr>${l.note ? `<tr><td colspan="4" style="color:#6b6b60;font-size:12px;padding:0 4px 6px">${esc(l.note)}</td></tr>` : ''}`).join('');
  const html = shell(`Statement ${st.number}: ${st.month_label}`,
    `<p style="margin:0 0 12px">Lead fees for deals that reached <b>${esc(st.trigger_label)}</b> in ${esc(st.month_label)}.</p>
     <table style="width:100%;border-collapse:collapse;font-size:14px"><tr style="text-align:left;color:#6b6b60"><th>Ref</th><th>Lead</th><th>Size</th><th style="text-align:right">Fee</th></tr>${rows || '<tr><td colspan="4">No billable deals this month.</td></tr>'}</table>
     <p style="margin:16px 0 4px"><b>Total billed:</b> ${m(st.totals.billed_cents)}<br><b>Already paid:</b> ${m(st.totals.paid_cents)}<br><b>Balance due:</b> ${m(st.totals.balance_cents)}</p>
     ${st.payment_note ? `<p style="color:#6b6b60">${esc(st.payment_note)}</p>` : ''}`, '');
  await sendMail({ to: st.partner.email, subject: `${st.issuer} statement ${st.number} (${st.month_label})`, html, text: `Statement ${st.number}\nBilled ${m(st.totals.billed_cents)}, paid ${m(st.totals.paid_cents)}, balance ${m(st.totals.balance_cents)}` });
  res.json({ ok: true, sent_to: st.partner.email });
});
