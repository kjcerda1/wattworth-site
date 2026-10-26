/* Scheduled jobs. retry: every 15 min. daily: morning digest to owner + nudge to partners with untouched leads. */
const db = require('./db');
const W = require('./shared');
const { retryFailed, resolveDispute } = require('./leads');
const { alertOwner } = require('./alerts');
const { sendMail, sendText, emailReady, smsReady, esc, shell } = require('./mail');

const appUrl = () => (process.env.APP_URL || '').replace(/\/$/, '');
const STALE_HOURS = 24;
const DISPUTE_AUTO_DAYS = 5;

async function daily(now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const [leads, deliveries, payouts, tiers, partners] = await Promise.all([
    db.select('leads', {}), db.select('deliveries', {}), db.select('referral_payouts', {}), db.select('fee_tiers', {}), db.select('partners', { where: { active: true } }),
  ]);
  const real = leads.filter((l) => !l.duplicate_of);
  const stale = real.filter((l) => l.stage === 'received' && now - new Date(l.created_at).getTime() > STALE_HOURS * 3600e3);
  const out = { nudged: 0, digest: false, autoAccepted: 0 };

  // Invalid-lead flags nobody reviewed are accepted automatically, so nothing waits on the owner
  for (const l of real.filter((x) => x.stage === 'invalid' && x.dispute_status === 'pending' && now - new Date(x.updated_at).getTime() > DISPUTE_AUTO_DAYS * 864e5)) {
    await resolveDispute(l.id, true, 'system'); out.autoAccepted++;
  }


  // Nudge each partner about leads nobody has contacted yet
  // Nudges are opt-in (NUDGE_PARTNERS=true): the partner runs his own pipeline by default
  for (const p of process.env.NUDGE_PARTNERS === 'true' ? partners : []) {
    const mine = stale.filter((l) => l.partner_id === p.id);
    if (!mine.length) continue;
    const key = `nudge:${day}:${p.id}`;
    if ((await db.select('alerts', { where: { key }, limit: 1 })).length) continue;
    const names = mine.slice(0, 5).map((l) => `${l.first_name} ${l.last_name || ''}`.trim() + ` (${l.ref})`);
    const subject = `${mine.length} WattWorth lead${mine.length > 1 ? 's' : ''} still waiting for first contact`;
    let sent = false;
    try {
      if (p.email && emailReady()) sent = (await sendMail({ to: p.email, subject, html: shell(subject, `<p>These haven't been contacted yet:</p><ul>${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul><p>Leads convert far better when called within a day. Update the status in your dashboard once you've reached them.</p>`, appUrl() ? appUrl() + '/partner/' : ''), text: subject + '\n' + names.join('\n') })) || sent;
      if (p.phone && smsReady()) sent = (await sendText({ to: p.phone, body: `${subject}. ${appUrl() ? appUrl() + '/partner/' : ''}` })) || sent;
    } catch (e) { console.error('[wattworth] nudge failed', e.message); }
    if (sent) { await db.insert('alerts', { key }); out.nudged++; }
  }

  // Owner digest (only when there is something to say)
  const s = W.buildSummary({ leads, deliveries, payouts, tiers, partners }, now);
  const k = s.kpis;
  const newLast24 = real.filter((l) => now - new Date(l.created_at).getTime() < 24 * 3600e3).length;
  const lines = [];
  if (newLast24) lines.push(`${newLast24} new lead${newLast24 > 1 ? 's' : ''} in the last 24 hours.`);
  if (k.deliveryFailures) lines.push(`${k.deliveryFailures} send${k.deliveryFailures > 1 ? 's' : ''} to your partner failed or were skipped.`);
  const signedToday = real.filter((l) => l.signed_at && now - new Date(l.signed_at).getTime() < 24 * 3600e3).length;
  if (signedToday) lines.push(`${signedToday} deal${signedToday > 1 ? 's' : ''} signed in the last 24 hours.`);
  if (k.feesOwedCents) lines.push(`Commission owed to you: ${W.money(k.feesOwedCents)}.`);
  if (k.feesNeedingSetup) lines.push(`${k.feesNeedingSetup} signed deal${k.feesNeedingSetup > 1 ? 's' : ''} waiting on details from your partner (size or commission) before your share can be worked out.`);
  if (k.payoutsDueCents) lines.push(`Referral payouts due: ${W.money(k.payoutsDueCents)}.`);
  if (lines.length) out.digest = await alertOwner({ key: `digest:${day}`, subject: 'Daily summary', lines });
  return out;
}

async function run(job) {
  if (job === 'daily') return daily();
  return retryFailed();
}

module.exports = { run, daily };
