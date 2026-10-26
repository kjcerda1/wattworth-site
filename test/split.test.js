const test = require('node:test');
const assert = require('node:assert');
process.env.ADMIN_TOKEN = 'admin-secret';
process.env.APP_URL = 'https://example.test';
const A = { authorization: 'Bearer admin-secret' };
let ipn = 100;
const mk = (method, { headers = {}, body, query = {} } = {}) => ({ method, headers: { 'x-forwarded-for': `9.9.9.${++ipn}`, ...headers }, body, query, socket: { remoteAddress: '1.2.3.4' } });
function mkRes() { const r = { code: 200, headers: {}, payload: undefined }; r.setHeader = (k, v) => (r.headers[k] = v); r.status = (c) => { r.code = c; return r; }; r.json = (o) => { r.payload = o; return r; }; r.send = (s) => { r.payload = s; return r; }; r.end = () => r; return r; }
const call = async (mod, req) => { const res = mkRes(); await require(mod)(req, res); return res; };
const W = require('../lib/shared');

let key, pid, lid;
const admin = async () => (await call('../api/admin', mk('GET', { headers: A }))).payload;
const post = (body) => call('../api/admin', mk('POST', { headers: A, body }));
const pbody = (b) => call('../api/partner', mk('PATCH', { headers: { authorization: 'Bearer ' + key }, body: b }));

test('split: percent starts blank, nothing is invented', async () => {
  const r = await post({ action: 'create_partner', name: 'Pedro', ads_paid_by: 'partner' });
  key = r.payload.access_key; pid = r.payload.partner.id;
  assert.equal(r.payload.partner.fee_mode, 'split');
  assert.equal(r.payload.partner.split_percent, null);
  const l = await call('../api/leads', mk('POST', { body: { first_name: 'Sam', last_name: 'Lee', phone: '5125550177', email: 's@example.com', city: 'Austin', state: 'TX', zip: '78701', monthly_bill: 250, homeowner: true, consent: true, electric_provider: 'CPS Energy', meter_number: 'M1234567', consent_text: 'I agree to be contacted (test wording for the split).', source: 'x' } }));
  lid = l.payload.id || (await admin()).leads[0].id;
  await pbody({ lead_id: lid, stage: 'signed' });
  let a = await admin(); let lead = a.leads.find((x) => x.id === lid);
  assert.equal(lead.fee.state, 'split_unset');
  assert.equal(a.kpis.feesOwedCents, 0);
});

test('split: percent + commission give the share; staged payments reduce the balance', async () => {
  assert.equal((await post({ action: 'update_partner', partner_id: pid, split_percent: 150 })).code, 400);
  assert.equal((await post({ action: 'update_partner', partner_id: pid, split_percent: 30 })).code, 200);
  let lead = (await admin()).leads.find((x) => x.id === lid);
  assert.equal(lead.fee.state, 'needs_commission');
  assert.equal((await pbody({ lead_id: lid, commission_dollars: -5 })).code, 400);
  assert.equal((await pbody({ lead_id: lid, commission_dollars: 3000 })).code, 200);
  let a = await admin(); lead = a.leads.find((x) => x.id === lid);
  assert.equal(lead.fee.state, 'owed'); assert.equal(lead.fee.cents, 90000); assert.equal(lead.fee.share_cents, 90000);
  assert.equal(a.kpis.feesOwedCents, 90000);
  assert.ok(a.events.some((e) => e.type === 'commission' && e.to_value === '3000.00'));
  await post({ action: 'record_payment', lead_id: lid, amount_dollars: 500 });
  a = await admin(); lead = a.leads.find((x) => x.id === lid);
  assert.equal(lead.fee.state, 'owed'); assert.equal(lead.fee.cents, 40000);
  assert.equal(a.kpis.feesPaidCents, 50000);
  await post({ action: 'record_payment', lead_id: lid, amount_dollars: 400 });
  lead = (await admin()).leads.find((x) => x.id === lid);
  assert.equal(lead.fee.state, 'paid'); assert.ok(lead.fee_paid_at);
});

test('split: commission rising later re-opens a balance; partner sees terms and own commission only', async () => {
  await pbody({ lead_id: lid, commission_dollars: 4000 });
  const lead = (await admin()).leads.find((x) => x.id === lid);
  assert.equal(lead.fee.state, 'owed'); assert.equal(lead.fee.cents, 30000);
  const p = (await call('../api/partner', mk('GET', { headers: { authorization: 'Bearer ' + key } }))).payload;
  assert.equal(p.terms.owner_percent, 30);
  assert.equal(p.leads.find((x) => x.id === lid).commission_cents, 400000);
  assert.ok(!('fee' in p.leads[0]));
});

test('split: settle toggle, and invalid-accepted after payment becomes a credit', async () => {
  await post({ action: 'fee_paid', lead_id: lid, paid: true });
  let lead = (await admin()).leads.find((x) => x.id === lid);
  assert.equal(lead.fee.state, 'paid'); assert.equal(lead.fee.collected_cents, 120000);
  await pbody({ lead_id: lid, stage: 'invalid', invalid_reason: 'Customer never requested a quote' });
  await post({ action: 'resolve_dispute', lead_id: lid, accept: true });
  lead = (await admin()).leads.find((x) => x.id === lid);
  assert.equal(lead.fee.state, 'credit_due'); assert.equal(lead.fee.cents, 120000);
});

test('split: statement lines carry commission, percent and share; CSV has the columns', async () => {
  const st = require('../lib/statement');
  const month = new Date().toISOString().slice(0, 7);
  const s = await st.build(month, pid);
  assert.equal(s.mode, 'split'); assert.equal(s.split_percent, 30);
  const csv = (await call('../api/export', mk('GET', { headers: A }))).payload;
  assert.match(csv.split('\n')[0], /partner_commission,your_share_dollars,received_dollars,balance_dollars/);
});

test('split: shared math rounds to cents and handles missing data', () => {
  assert.equal(W.shareFor({ commission_cents: 33333 }, { split_percent: 30 }).share, 10000);
  assert.equal(W.shareFor({ commission_cents: null }, { split_percent: 30 }).share, null);
  assert.equal(W.shareFor({ commission_cents: 1000 }, {}).pct, null);
  assert.equal(W.modeOf({ fee_mode: 'flat' }), 'flat'); assert.equal(W.modeOf({}), 'split');
});
