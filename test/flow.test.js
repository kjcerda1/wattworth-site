const test = require('node:test');
const assert = require('node:assert');

process.env.ADMIN_TOKEN = 'admin-secret';
process.env.APP_URL = 'https://example.test';
process.env.RESEND_API_KEY = 're_test';
process.env.MAIL_FROM = 'WattWorth <leads@example.test>';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tok';
process.env.TWILIO_FROM = '+15550001111';
process.env.CRON_SECRET = 'cron-secret';
process.env.ALLOWED_ORIGINS = 'https://funnel.example.test';

const calls = [];
let failEmail = false;
globalThis.__wwfetch = async (url, opts) => {
  calls.push({ url, opts });
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (url.includes('resend')) return failEmail ? { ok: false, status: 500, json: async () => ({ message: 'boom' }) } : ok({ id: 'em_1' });
  if (url.includes('twilio')) return ok({ sid: 'SM1' });
  if (url.includes('hooks.partner.test')) return ok({});
  throw new Error('unexpected fetch ' + url);
};

let ipn = 0;
const mk = (method, { headers = {}, body, query = {} } = {}) => ({ method, headers: { 'x-forwarded-for': `1.2.3.${++ipn}`, ...headers }, body, query, socket: { remoteAddress: '1.2.3.4' } });
function mkRes() {
  const r = { code: 200, headers: {}, payload: undefined };
  r.setHeader = (k, v) => (r.headers[k] = v);
  r.status = (c) => { r.code = c; return r; };
  r.json = (o) => { r.payload = o; return r; };
  r.send = (s) => { r.payload = s; return r; };
  r.end = () => r;
  return r;
}
const call = async (mod, req) => { const res = mkRes(); await require(mod)(req, res); return res; };
const A = { authorization: 'Bearer admin-secret' };

const lead = (o = {}) => ({ first_name: 'Dana', last_name: 'Reyes', phone: '(512) 555-0142', email: 'dana@example.com', city: 'Austin', state: 'tx', zip: '78701', monthly_bill: 240, homeowner: true, consent: true, consent_text: 'I agree to be contacted by WattWorth and its partners (test wording).', source: 'wattworth-home', ...o });

let key, partnerId;

test('admin creates partner, key shown once and works', async () => {
  const r = await call('../api/admin', mk('POST', { headers: A, body: { action: 'create_partner', fee_mode: 'flat', name: 'Pedro', company: 'Test Solar', email: 'pedro@example.com', phone: '5125550199', webhook_url: 'https://hooks.partner.test/in' } }));
  assert.equal(r.code, 201);
  assert.match(r.payload.access_key, /^wp_[0-9a-f]{48}$/);
  key = r.payload.access_key; partnerId = r.payload.partner.id;
  assert.equal(r.payload.partner.is_default, true);
  assert.equal(r.payload.partner.key_hash, undefined);
});

test('admin and partner endpoints reject missing/wrong credentials', async () => {
  assert.equal((await call('../api/admin', mk('GET'))).code, 401);
  assert.equal((await call('../api/admin', mk('GET', { headers: { authorization: 'Bearer nope' } }))).code, 401);
  assert.equal((await call('../api/admin', mk('GET', { headers: { authorization: 'Bearer ' + key } }))).code, 401); // partner key is not admin
  assert.equal((await call('../api/partner', mk('GET'))).code, 401);
  assert.equal((await call('../api/partner', mk('GET', { headers: { authorization: 'Bearer wp_bad' } }))).code, 401);
});

test('intake validates consent, phone, and honeypot', async () => {
  assert.equal((await call('../api/leads', mk('POST', { body: lead({ consent: false }) }))).code, 400);
  assert.equal((await call('../api/leads', mk('POST', { body: lead({ consent_text: '' }) }))).code, 400);
  assert.equal((await call('../api/leads', mk('POST', { body: lead({ phone: '123' }) }))).code, 400);
  assert.equal((await call('../api/leads', mk('POST', { body: lead({ first_name: '' }) }))).code, 400);
  const bot = await call('../api/leads', mk('POST', { body: lead({ website: 'spam.biz' }) }));
  assert.equal(bot.code, 201);
  assert.equal(bot.payload.ref, null);
  assert.equal((await call('../api/leads', mk('GET'))).code, 405);
});

test('intake stores lead + consent, sends email/SMS/webhook, logs deliveries', async () => {
  calls.length = 0;
  const r = await call('../api/leads', mk('POST', { body: lead({ referrer_code: 'JANE50' }), headers: { 'user-agent': 'UA', origin: 'https://funnel.example.test' } }));
  assert.equal(r.code, 201);
  assert.match(r.payload.ref, /^WW-[A-Z0-9]{6}$/);
  assert.equal(r.headers['Access-Control-Allow-Origin'], 'https://funnel.example.test');
  assert.deepEqual(Object.keys(r.payload).sort(), ['ok', 'ref']); // nothing internal leaks to the browser
  assert.equal(calls.length, 3);
  const hook = calls.find((c) => c.url.includes('hooks.partner'));
  assert.ok(hook.opts.headers['X-WattWorth-Signature'].startsWith('sha256='));
  const admin = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  assert.equal(admin.leads.length, 1);
  assert.equal(admin.leads[0].phone, '+15125550142');
  assert.equal(admin.leads[0].state, 'TX');
  assert.equal(admin.leads[0].consent_ip, undefined);
  assert.deepEqual(admin.deliveries.map((d) => d.status).sort(), ['sent', 'sent', 'sent']);
  assert.equal(admin.payouts.length, 1); // $50 on form submission
  assert.equal(admin.payouts[0].amount_cents, 5000);
  assert.equal(admin.kpis.total, 1);
});

test('duplicate phone within 30 days is logged but not re-sent', async () => {
  calls.length = 0;
  const r = await call('../api/leads', mk('POST', { body: lead() }));
  assert.equal(r.code, 201);
  assert.equal(calls.length, 0);
  const admin = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  assert.equal(admin.kpis.total, 1); // duplicate excluded from counts
});

let leadId;
test('partner sees only own leads and can update stage; history + milestones recorded', async () => {
  const H = { authorization: 'Bearer ' + key };
  const g = (await call('../api/partner', mk('GET', { headers: H }))).payload;
  assert.equal(g.leads.length, 1);
  assert.equal(g.leads[0].consent_text, undefined);
  leadId = g.leads[0].id;

  let r = await call('../api/partner', mk('PATCH', { headers: H, body: { lead_id: leadId, stage: 'contacted', note: 'Left voicemail' } }));
  assert.equal(r.payload.lead.stage, 'contacted');
  r = await call('../api/partner', mk('PATCH', { headers: H, body: { lead_id: leadId, stage: 'proposal_sent', system_kw: 8.4 } }));
  assert.equal(r.code, 200);
  assert.equal((await call('../api/partner', mk('PATCH', { headers: H, body: { lead_id: leadId, stage: 'bogus' } }))).code, 400);
  assert.equal((await call('../api/partner', mk('PATCH', { headers: H, body: { lead_id: leadId, system_kw: 500 } }))).code, 400);
  assert.equal((await call('../api/partner', mk('PATCH', { headers: H, body: { lead_id: 'nope', stage: 'signed' } }))).code, 404);

  const g2 = (await call('../api/partner', mk('GET', { headers: H }))).payload;
  assert.ok(g2.leads[0].first_contacted_at);
  assert.ok(g2.leads[0].history.some((h) => h.type === 'stage' && h.to === 'contacted' && h.note === 'Left voicemail'));
  const admin = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  assert.deepEqual(admin.payouts.map((p) => p.milestone).sort(), ['estimate', 'submitted']); // $100 unlocked at proposal
});

test('another partner cannot touch this partner\'s lead', async () => {
  const c = await call('../api/admin', mk('POST', { headers: A, body: { action: 'create_partner', name: 'Other' } }));
  const H2 = { authorization: 'Bearer ' + c.payload.access_key };
  assert.equal((await call('../api/partner', mk('GET', { headers: H2 }))).payload.leads.length, 0);
  assert.equal((await call('../api/partner', mk('PATCH', { headers: H2, body: { lead_id: leadId, stage: 'lost' } }))).code, 404);
});

test('fees: placeholder tiers never invent money; owed only after rate set; paid toggles', async () => {
  const H = { authorization: 'Bearer ' + key };
  await call('../api/partner', mk('PATCH', { headers: H, body: { lead_id: leadId, stage: 'signed' } }));
  let admin = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  assert.equal(admin.leads.find((l) => l.id === leadId).fee.state, 'rate_unset');
  assert.equal(admin.kpis.feesOwedCents, 0);
  assert.equal(admin.kpis.feesNeedingSetup, 1);
  assert.equal(admin.kpis.inPlace, 1);

  const tiers = admin.tiers.map((t) => ({ ...t, fee_dollars: t.label === 'Mid system' ? 700 : '' }));
  assert.equal((await call('../api/admin', mk('POST', { headers: A, body: { action: 'set_tiers', tiers } }))).code, 200);
  admin = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  assert.equal(admin.leads.find((l) => l.id === leadId).fee.state, 'owed');
  assert.equal(admin.kpis.feesOwedCents, 70000);

  await call('../api/admin', mk('POST', { headers: A, body: { action: 'fee_paid', lead_id: leadId } }));
  admin = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  assert.equal(admin.leads.find((l) => l.id === leadId).fee.state, 'paid');
  assert.equal(admin.kpis.feesOwedCents, 0);
  assert.equal(admin.kpis.feesPaidCents, 70000);
});

test('install schedules the $1,000 referral milestone 30 days out; payout can be marked paid', async () => {
  const H = { authorization: 'Bearer ' + key };
  await call('../api/partner', mk('PATCH', { headers: H, body: { lead_id: leadId, stage: 'installed' } }));
  let admin = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  const inst = admin.payouts.find((p) => p.milestone === 'installed');
  assert.equal(inst.amount_cents, 100000);
  const days = (new Date(inst.due_at) - Date.now()) / 864e5;
  assert.ok(days > 29.9 && days < 30.1);
  assert.equal(admin.kpis.payoutsUpcomingCents, 100000);
  await call('../api/admin', mk('POST', { headers: A, body: { action: 'payout_paid', payout_id: inst.id } }));
  admin = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  assert.equal(admin.payouts.find((p) => p.milestone === 'installed').status, 'paid');
});

test('inbound API updates by ref (partner CRM path), batch with partial failure', async () => {
  const admin = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  const ref = admin.leads.find((l) => l.id === leadId).ref;
  const r = await call('../api/inbound', mk('POST', { headers: { 'x-api-key': key }, body: { updates: [{ ref: ref.toLowerCase(), note: 'Panels delivered' }, { ref: 'WW-NOPE00', stage: 'signed' }] } }));
  assert.equal(r.code, 200);
  assert.equal(r.payload.results[0].ok, true);
  assert.equal(r.payload.results[1].ok, false);
  assert.equal((await call('../api/inbound', mk('POST', { body: {} }))).code, 401);
});

test('failed delivery is retried by cron and by manual resend; skipped when unconfigured', async () => {
  failEmail = true;
  await call('../api/leads', mk('POST', { body: lead({ phone: '5125550177', first_name: 'Eli' }) }));
  let admin = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  const bad = admin.deliveries.find((d) => d.status === 'failed');
  assert.ok(bad && bad.channel === 'email' && /Resend 500/.test(bad.last_error));
  assert.ok(admin.kpis.deliveryFailures >= 1);

  assert.equal((await call('../api/cron', mk('GET'))).code, 401);
  failEmail = false;
  const cr = await call('../api/cron', mk('GET', { headers: { authorization: 'Bearer cron-secret' } }));
  assert.equal(cr.payload.retried, 1); assert.equal(cr.payload.sent, 1);
  admin = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  assert.equal(admin.deliveries.filter((d) => d.status === 'failed').length, 0);

  const saved = process.env.RESEND_API_KEY; delete process.env.RESEND_API_KEY;
  await call('../api/leads', mk('POST', { body: lead({ phone: '5125550166', first_name: 'Fay' }) }));
  process.env.RESEND_API_KEY = saved;
  admin = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  assert.ok(admin.deliveries.some((d) => d.status === 'skipped' && /RESEND_API_KEY/.test(d.last_error)));
  const sk = admin.deliveries.find((d) => d.status === 'skipped');
  const rs = await call('../api/admin', mk('POST', { headers: A, body: { action: 'resend', delivery_id: sk.id } }));
  assert.equal(rs.payload.delivery.status, 'sent');
});

test('CSV export: scoped per role, formula-injection safe', async () => {
  await call('../api/leads', mk('POST', { body: lead({ phone: '5125550155', first_name: '=HYPERLINK("x")' }) }));
  const a = await call('../api/export', mk('GET', { headers: A }));
  assert.match(a.payload.split('\n')[0], /your_share_dollars/);
  assert.ok(a.payload.includes("'=HYPERLINK"));
  const p = await call('../api/export', mk('GET', { headers: { authorization: 'Bearer ' + key } }));
  assert.ok(!/your_share_dollars/.test(p.payload.split('\n')[0]));
  assert.equal((await call('../api/export', mk('GET'))).code, 401);
});

test('shared rollups: tier boundaries are [min,max)', () => {
  const W = require('../lib/shared');
  const tiers = [{ label: 'a', min_kw: 0, max_kw: 7, fee_cents: 1 }, { label: 'b', min_kw: 7, max_kw: null, fee_cents: 2 }];
  assert.equal(W.tierFor(tiers, 6.99).label, 'a');
  assert.equal(W.tierFor(tiers, 7).label, 'b');
  assert.equal(W.tierFor(tiers, 99).label, 'b');
  assert.equal(W.tierFor(tiers, null), null);
  assert.equal(W.feeFor({ stage: 'lost', system_kw: 8 }, tiers).state, 'not_yet');
});
