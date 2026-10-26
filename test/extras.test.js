const test = require('node:test');
const assert = require('node:assert');

Object.assign(process.env, {
  ADMIN_TOKEN: 'admin-secret', APP_URL: 'https://example.test', RESEND_API_KEY: 're_test', MAIL_FROM: 'WW <a@example.test>',
  TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15550001111',
  NUDGE_PARTNERS: 'true', OWNER_EMAIL: 'kacy@example.test', OWNER_PHONE: '+15125550000', CRON_SECRET: 'cron-secret', STATEMENT_PAYMENT_NOTE: 'Pay by ACH.',
});
const sent = [];
let failEmail = false;
globalThis.__wwfetch = async (url, opts) => {
  const j = opts && opts.body && opts.body[0] === '{' ? JSON.parse(opts.body) : opts && opts.body;
  sent.push({ url, body: j });
  if (url.includes('resend')) return failEmail ? { ok: false, status: 500, json: async () => ({ message: 'boom' }) } : { ok: true, status: 200, json: async () => ({ id: 'e1' }) };
  return { ok: true, status: 200, json: async () => ({ sid: 'SM1' }) };
};
const emailsTo = (to) => sent.filter((s) => s.url.includes('resend') && s.body.to.includes(to));
const smsTo = (to) => sent.filter((s) => s.url.includes('twilio') && String(s.body).includes(encodeURIComponent(to).replace(/%2B/g, '%2B')));

let n = 0;
const mk = (method, { headers = {}, body, query = {} } = {}) => ({ method, headers: { 'x-forwarded-for': headers['x-forwarded-for'] || `9.9.9.${++n}`, ...headers }, body, query, socket: {} });
function mkRes() { const r = { code: 200 }; r.setHeader = () => {}; r.status = (c) => ((r.code = c), r); r.json = (o) => ((r.payload = o), r); r.send = (s) => ((r.payload = s), r); r.end = () => r; return r; }
const call = async (mod, req) => { const res = mkRes(); await require(mod)(req, res); return res; };
const A = { authorization: 'Bearer admin-secret' };
const lead = (o = {}) => ({ first_name: 'Dana', last_name: 'Reyes', phone: '5125550' + String(100 + ++n), city: 'Austin', state: 'TX', consent: true, electric_provider: 'CPS Energy', meter_number: 'M1234567', consent_text: 'consent wording', ...o });
const db = require('../lib/db');
const adminGet = async () => (await call('../api/admin', mk('GET', { headers: A }))).payload;

let key, H;
const intake = async (o) => { const r = await call('../api/leads', mk('POST', { body: lead(o) })); assert.equal(r.code, 201); return r.payload.ref; };
const byRef = async (ref) => (await db.select('leads', { where: { ref } }))[0];
const patch = (id, b) => call('../api/partner', mk('PATCH', { headers: H, body: { lead_id: id, ...b } }));
const tiers = async (mid) => { const t = (await adminGet()).tiers.map((x) => ({ ...x, fee_dollars: x.label === 'Mid system' ? mid : '' })); await call('../api/admin', mk('POST', { headers: A, body: { action: 'set_tiers', tiers: t } })); };

test('setup: partner + fee rate', async () => {
  const r = await call('../api/admin', mk('POST', { headers: A, body: { action: 'create_partner', fee_mode: 'flat', name: 'Pedro', email: 'pedro@example.test', phone: '5125550199' } }));
  key = r.payload.access_key; H = { authorization: 'Bearer ' + key };
  await tiers(700);
});

test('rate limit: 6th submission from one IP in an hour is refused', async () => {
  const ip = { 'x-forwarded-for': '7.7.7.7' };
  for (let i = 0; i < 5; i++) assert.equal((await call('../api/leads', mk('POST', { headers: ip, body: lead() }))).code, 201);
  const r = await call('../api/leads', mk('POST', { headers: ip, body: lead() }));
  assert.equal(r.code, 429);
  assert.equal((await call('../api/leads', mk('POST', { headers: { 'x-forwarded-for': '7.7.7.8' }, body: lead() }))).code, 201); // other IPs unaffected
});

test('dispute: reason required, owner alerted, fee on hold, accept waives, decline restores stage', async () => {
  const ref = await intake();
  let l = await byRef(ref);
  await patch(l.id, { stage: 'contacted' });
  assert.equal((await patch(l.id, { stage: 'invalid' })).code, 400);          // reason required
  sent.length = 0;
  const r = await patch(l.id, { stage: 'invalid', invalid_reason: 'Wrong number' });
  assert.equal(r.payload.lead.dispute_status, 'pending');
  assert.equal(emailsTo('kacy@example.test').length, 0);   // disputes are not the owner's job: no alert
  let a = await adminGet();
  assert.equal(a.kpis.disputesPending, 1);
  assert.equal(a.leads.find((x) => x.id === l.id).fee.state, 'on_hold');

  // decline -> back to contacted
  await call('../api/admin', mk('POST', { headers: A, body: { action: 'resolve_dispute', lead_id: l.id, accept: false } }));
  l = await byRef(ref);
  assert.equal(l.stage, 'contacted'); assert.equal(l.dispute_status, 'rejected');
  // flag again, accept -> stays invalid, waived
  await patch(l.id, { stage: 'invalid', invalid_reason: 'Renter' });
  await call('../api/admin', mk('POST', { headers: A, body: { action: 'resolve_dispute', lead_id: l.id, accept: true } }));
  a = await adminGet();
  assert.equal(a.leads.find((x) => x.id === l.id).fee.state, 'waived');
  assert.equal(a.kpis.disputesPending, 0);
  assert.equal((await call('../api/admin', mk('POST', { headers: A, body: { action: 'resolve_dispute', lead_id: l.id, accept: true } }))).code, 400); // nothing pending
  // partner sees outcome
  const pv = (await call('../api/partner', mk('GET', { headers: H }))).payload.leads.find((x) => x.id === l.id);
  assert.equal(pv.dispute_status, 'accepted'); assert.equal(pv.invalid_reason, 'Renter');
});

test('credit: invalid accepted after fee was paid shows credit due; invalid leads do not hurt close rate', async () => {
  const ref = await intake(); const l = await byRef(ref);
  await patch(l.id, { stage: 'signed', system_kw: 8 });
  await call('../api/admin', mk('POST', { headers: A, body: { action: 'fee_paid', lead_id: l.id } }));
  await patch(l.id, { stage: 'invalid', invalid_reason: 'Not the homeowner' });
  await call('../api/admin', mk('POST', { headers: A, body: { action: 'resolve_dispute', lead_id: l.id, accept: true } }));
  const a = await adminGet();
  const f = a.leads.find((x) => x.id === l.id).fee;
  assert.deepEqual([f.state, f.cents], ['credit_due', 70000]);
  assert.equal(a.kpis.creditsDueCents, 70000);
});

test('alerts: signed-deal alert sent once; exhausted delivery alerts once', async () => {
  const ref = await intake(); const l = await byRef(ref);
  sent.length = 0;
  await patch(l.id, { stage: 'signed', system_kw: 9 });
  await patch(l.id, { stage: 'installed' });
  await patch(l.id, { stage: 'signed' });
  assert.equal(emailsTo('kacy@example.test').filter((e) => /Deal signed/.test(e.body.subject)).length, 1);

  failEmail = true;
  await intake({ first_name: 'Eli' });
  sent.length = 0;
  for (let i = 0; i < 6; i++) await require('../lib/jobs').run();   // retries up to 5 attempts, then alerts
  failEmail = false;
  const twilio = sent.filter((s) => s.url.includes('twilio') && /could%20not%20be%20sent|could\+not\+be\+sent/.test(String(s.body)));
  assert.equal(twilio.length, 1); // ...but the SMS alert goes out exactly once
});

test('daily job: nudges partner about stale leads and sends one owner digest per day', async () => {
  failEmail = false;
  const ref = await intake({ first_name: 'Stale' }); const l = await byRef(ref);
  await db.update('leads', { id: l.id }, { created_at: new Date(Date.now() - 30 * 3600e3).toISOString() });
  sent.length = 0;
  const jobs = require('../lib/jobs');
  const r1 = await jobs.daily();
  assert.ok(r1.nudged >= 1 && r1.digest === true);
  assert.equal(emailsTo('pedro@example.test').length, 1);
  assert.ok(/waiting for first contact/.test(emailsTo('pedro@example.test')[0].body.subject));
  assert.equal(emailsTo('kacy@example.test').filter((e) => /Daily summary/.test(e.body.subject)).length, 1);
  sent.length = 0;
  const r2 = await jobs.daily();
  assert.equal(r2.nudged, 0); assert.equal(r2.digest, false); assert.equal(sent.length, 0); // no repeats
  assert.equal((await call('../api/cron', mk('GET', { query: { job: 'daily' }, headers: { authorization: 'Bearer cron-secret' } }))).code, 200);
});

test('statement: billed/paid/balance, waived + credit lines, unpriced listed, email sent', async () => {
  const month = new Date().toISOString().slice(0, 7);
  const a = await adminGet(); const pid = a.partners[0].id;
  const wv = await byRef(await intake({ first_name: 'Waive' }));       // signed, unpaid, then accepted invalid -> waived
  await patch(wv.id, { stage: 'signed', system_kw: 8 }); await patch(wv.id, { stage: 'invalid', invalid_reason: 'Duplicate household' });
  await call('../api/admin', mk('POST', { headers: A, body: { action: 'resolve_dispute', lead_id: wv.id, accept: true } }));
  const un = await intake({ first_name: 'NoSize' }); await patch((await byRef(un)).id, { stage: 'signed' });   // signed, size missing -> unpriced
  const st = (await call('../api/statement', mk('GET', { headers: A, query: { month, partner_id: pid } }))).payload;
  assert.match(st.number, /^WW-\d{6}-[0-9A-F]{4}$/);
  assert.ok(st.lines.some((x) => x.fee_state === 'credit_due' && x.billed_cents === 0 && x.paid_cents === 70000));
  assert.ok(st.lines.some((x) => x.fee_state === 'waived'));
  assert.ok(st.lines.some((x) => x.fee_state === 'owed' && x.billed_cents === 70000));
  assert.ok(st.unpriced.some((x) => x.reason === 'needs_size'));
  const t = st.totals;
  assert.equal(t.balance_cents, t.billed_cents - t.paid_cents);
  assert.ok(t.balance_cents < t.billed_cents); // credit reduces what's owed
  sent.length = 0;
  const r = await call('../api/statement', mk('POST', { headers: A, body: { month, partner_id: pid } }));
  assert.equal(r.payload.sent_to, 'pedro@example.test');
  assert.ok(emailsTo('pedro@example.test')[0].body.html.includes('Pay by ACH.'));
  assert.equal((await call('../api/statement', mk('GET', { headers: A, query: { month: 'bad', partner_id: pid } }))).code, 400);
  assert.equal((await call('../api/statement', mk('GET', { query: { month, partner_id: pid } }))).code, 401);
});

test('ad spend: add, cost per lead / per signed deal, delete', async () => {
  const month = new Date().toISOString().slice(0, 7);
  assert.equal((await call('../api/admin', mk('POST', { headers: A, body: { action: 'add_spend', month: 'nope', amount_dollars: 5 } }))).code, 400);
  const r = await call('../api/admin', mk('POST', { headers: A, body: { action: 'add_spend', month, source: 'Meta', amount_dollars: 500 } }));
  assert.equal(r.code, 201);
  let a = await adminGet();
  const row = a.marketing.months.find((x) => x.month === month);
  assert.equal(row.spendCents, 50000);
  assert.ok(row.leads > 0 && row.cplCents === Math.round(50000 / row.leads));
  assert.ok(row.signed > 0 && row.cpsCents === Math.round(50000 / row.signed));
  await call('../api/admin', mk('POST', { headers: A, body: { action: 'delete_spend', id: r.payload.id } }));
  a = await adminGet();
  assert.equal(a.marketing.totalSpendCents, 0);
  assert.equal(a.setup.ownerAlerts, true);
});

test('disputes nobody reviews are auto-accepted after 5 days; nudges stay off unless enabled', async () => {
  const ref = await intake({ first_name: 'Auto' }); const l = await byRef(ref);
  await patch(l.id, { stage: 'invalid', invalid_reason: 'Disconnected number' });
  const jobs = require('../lib/jobs');
  const r = await jobs.daily(Date.now() + 6 * 864e5);   // six days later
  assert.ok(r.autoAccepted >= 1);
  const after = await byRef(ref);
  assert.equal(after.dispute_status, 'accepted');
  assert.ok((await db.select('lead_events', { where: { lead_id: l.id, type: 'dispute' } })).some((e) => e.actor === 'system'));
  process.env.NUDGE_PARTNERS = 'false';
  const l2 = await byRef(await intake({ first_name: 'Quiet' }));
  await db.update('leads', { id: l2.id }, { created_at: new Date(Date.now() - 40 * 3600e3).toISOString() });
  sent.length = 0; process.env.NUDGE_PARTNERS = 'false';
  const r2 = await jobs.daily(Date.now() + 864e5 * 400);   // fresh day key so nothing is de-duplicated
  assert.equal(r2.nudged, 0);
  assert.equal(emailsTo('pedro@example.test').length, 0);
});

test('follow-along analytics: weekly counts, sources from utm, cities, delivery + contact rates, per-partner stats', async () => {
  const a = await adminGet();
  assert.equal(a.acquisition.weeks.length, 8);
  assert.equal(a.acquisition.weeks.reduce((x, w) => x + w.count, 0) <= a.kpis.total, true);
  assert.ok(a.acquisition.weeks[7].count >= 1);
  assert.ok(a.acquisition.cities.some((c) => c.name === 'Austin'));
  const ref = await intake({ utm: { utm_source: 'facebook' } });
  const a2 = await adminGet();
  assert.ok(a2.acquisition.sources.some((s) => s.name === 'facebook' && s.count >= 1));
  assert.ok(a2.kpis.deliveryRate > 0 && a2.kpis.deliveryRate <= 100);
  const ps = a2.partnerStats.find((p) => p.name === 'Pedro');
  assert.ok(ps && ps.leads > 0 && ps.leads <= a2.kpis.total);
});
