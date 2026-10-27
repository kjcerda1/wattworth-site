// Production contract: required utility verification (real bill upload) and the single $1,000 referral reward.
const test = require('node:test');
const assert = require('node:assert');
process.env.ADMIN_TOKEN = 'admin-secret';
process.env.APP_URL = 'https://example.test';
globalThis.__wwfetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'x' }), text: async () => '{}' }); // mail etc. are not under test here

let n = 0;
const mk = (method, { headers = {}, body, query = {} } = {}) => ({ method, headers: { 'x-forwarded-for': `9.9.9.${++n}`, ...headers }, body, query, socket: { remoteAddress: '1.1.1.1' } });
function mkRes() { const r = { code: 200, headers: {}, payload: undefined, raw: undefined }; r.setHeader = (k, v) => (r.headers[k] = v); r.status = (c) => { r.code = c; return r; }; r.json = (o) => { r.payload = o; return r; }; r.end = (b) => { r.raw = b; return r; }; r.send = r.end; return r; }
const call = async (mod, req) => { const res = mkRes(); await require(mod)(req, res); return res; };
const A = { authorization: 'Bearer admin-secret' };
const C = (t) => ({ authorization: 'Bearer ' + t });

// ---- real-looking files ----
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(40, 7), Buffer.from([0xff, 0xd9])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(17, 1), Buffer.from([0, 0, 0, 0]), Buffer.from('IEND'), Buffer.alloc(4)]);
const up = (buf, mime, filename = 'bill') => ({ filename, mime, data: buf.toString('base64') });
const BILL = up(PDF, 'application/pdf', 'may-bill.pdf');
const METER = { electric_provider: 'CPS Energy', meter_number: 'M-1234567' };

let phoneN = 100;
const base = (o = {}) => ({ first_name: 'Dana', last_name: 'Reyes', phone: '51255501' + String(++phoneN).slice(-2), email: 'p' + String(phoneN + 1) + '@example.com', city: 'Austin', state: 'TX', zip: '78701', monthly_bill: 220, homeowner: true, consent: true, consent_text: 'I agree to be contacted.', ...o });
const post = (o) => call('../api/leads', mk('POST', { body: base(o) }));
const db = () => require('../lib/db');

let pkey, partner;
test('setup: a partner who receives leads', async () => {
  const r = await call('../api/admin', mk('POST', { headers: A, body: { action: 'create_partner', name: 'Pedro', company: 'Test Solar', email: 'pedro@example.com', fee_mode: 'flat' } }));
  assert.equal(r.code, 201); pkey = r.payload.access_key;
  partner = (await db().select('partners', {}))[0];
});

test('1. bill-only lead is accepted; the file goes to private storage, never into the leads table', async () => {
  const r = await post({ bill: BILL });
  assert.equal(r.code, 201);
  const row = (await db().select('leads', {})).find((l) => l.ref === r.payload.ref);
  assert.equal(row.verification_method, 'bill');
  assert.equal(row.electric_provider, null); assert.equal(row.meter_number, null);
  assert.match(row.bill_storage_path, /^bills\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.pdf$/);
  assert.equal(row.bill_filename, 'may-bill.pdf'); assert.equal(row.bill_mime_type, 'application/pdf');
  assert.match(row.bill_sha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(row).includes(BILL.data), 'no bill bytes in the row');
  assert.ok(globalThis.__wwbills.get(row.bill_storage_path).buf.equals(PDF), 'stored in the private store');
});

test('2. provider + meter only is accepted', async () => {
  const r = await post(METER);
  assert.equal(r.code, 201);
  const row = (await db().select('leads', {})).find((l) => l.ref === r.payload.ref);
  assert.equal(row.verification_method, 'meter'); assert.equal(row.meter_number, 'M1234567'); assert.equal(row.bill_storage_path, null);
});

test('3. both are accepted', async () => {
  const r = await post({ ...METER, bill: BILL });
  assert.equal(r.code, 201);
  assert.equal((await db().select('leads', {})).find((l) => l.ref === r.payload.ref).verification_method, 'both');
});

test('4. neither is rejected', async () => {
  const before = (await db().select('leads', {})).length;
  const r = await post({});
  assert.equal(r.code, 400); assert.match(r.payload.error, /verify your electric account/i);
  assert.equal((await db().select('leads', {})).length, before, 'nothing stored');
});

test('5. provider without meter is rejected (even with a bill attached)', async () => {
  assert.equal((await post({ electric_provider: 'CPS Energy' })).code, 400);
  assert.equal((await post({ electric_provider: 'CPS Energy', bill: BILL })).code, 400);
});

test('6. meter without provider is rejected (even with a bill attached)', async () => {
  assert.equal((await post({ meter_number: 'M1234567' })).code, 400);
  assert.equal((await post({ meter_number: 'M1234567', bill: BILL })).code, 400);
  assert.equal((await post({ electric_provider: 'CPS', meter_number: '12' })).code, 400, 'implausible meter number');
});

test('7. valid PDF, JPG and PNG are accepted', async () => {
  for (const [buf, mime, name] of [[PDF, 'application/pdf', 'a.pdf'], [JPG, 'image/jpeg', 'a.jpg'], [JPG, 'image/jpg', 'a.jpeg'], [PNG, 'image/png', 'a.png']]) {
    const r = await post({ bill: up(buf, mime, name) });
    assert.equal(r.code, 201, name);
  }
});

test('8. spoofed, mislabeled, empty or broken files are rejected', async () => {
  const before = (await db().select('leads', {})).length;
  const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100, 1)]);
  const cases = [
    ['exe labeled pdf', up(exe, 'application/pdf', 'bill.pdf')],
    ['html labeled png', up(Buffer.from('<html><script>alert(1)</script></html>'), 'image/png', 'x.png')],
    ['png content labeled pdf', up(PNG, 'application/pdf', 'x.pdf')],
    ['pdf content labeled jpeg', up(PDF, 'image/jpeg', 'x.jpg')],
    ['svg', up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', 'x.svg')],
    ['truncated pdf', up(Buffer.from('%PDF-1.4\n1 0 obj'), 'application/pdf', 'x.pdf')],
    ['truncated png', up(PNG.subarray(0, 20), 'image/png', 'x.png')],
    ['truncated jpeg', up(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'image/jpeg', 'x.jpg')],
    ['empty', { filename: 'x.pdf', mime: 'application/pdf', data: '' }],
    ['not base64', { filename: 'x.pdf', mime: 'application/pdf', data: '%%%not base64%%%' }],
    ['no mime', up(PDF, '', 'x.pdf')],
  ];
  for (const [label, bill] of cases) assert.equal((await post({ bill })).code, 400, label);
  assert.equal((await db().select('leads', {})).length, before, 'nothing stored for any of them');
});

test('9. a bill over 3 MB is rejected; a bill just under it is fine', async () => {
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3 * 1024 * 1024, 65), Buffer.from('\n%%EOF')]);
  const r = await post({ bill: up(big, 'application/pdf', 'huge.pdf') });
  assert.equal(r.code, 400); assert.match(r.payload.error, /3 MB/);
  const ok = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3 * 1024 * 1024 - 100, 65), Buffer.from('\n%%EOF')]);
  assert.equal((await post({ bill: up(ok, 'application/pdf', 'ok.pdf') })).code, 201);
});

let custTok, custLead;
test('10. the bill is never exposed to the customer portal, and only partner/admin can open it', async () => {
  const r = await post({ ...METER, bill: BILL });
  custTok = r.payload.portal_token; custLead = (await db().select('leads', {})).find((l) => l.ref === r.payload.ref);
  const v = (await call('../api/portal', mk('GET', { headers: C(custTok) }))).payload;
  const s = JSON.stringify(v);
  for (const secret of ['M1234567', 'CPS Energy', 'may-bill', 'bills/', custLead.bill_storage_path, custLead.bill_sha256, 'meter', 'bill_']) assert.ok(!s.includes(secret), 'portal leaks ' + secret);
  // admin list hides the storage path and hash
  const admin = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  const al = admin.leads.find((l) => l.id === custLead.id);
  assert.equal(al.bill_storage_path, undefined); assert.equal(al.bill_sha256, undefined); assert.equal(al.has_bill, true);
  // bill endpoint: no auth, customer token, wrong partner -> refused
  assert.equal((await call('../api/bill', mk('GET', { query: { lead_id: custLead.id } }))).code, 401);
  assert.equal((await call('../api/bill', mk('GET', { headers: C(custTok), query: { lead_id: custLead.id } }))).code, 401);
  const other = (await call('../api/admin', mk('POST', { headers: A, body: { action: 'create_partner', name: 'Other', fee_mode: 'flat' } }))).payload.access_key;
  assert.equal((await call('../api/bill', mk('GET', { headers: C(other), query: { lead_id: custLead.id } }))).code, 404);
  // the lead's own partner and the owner can
  for (const h of [C(pkey), A]) {
    const b = await call('../api/bill', mk('GET', { headers: h, query: { lead_id: custLead.id } }));
    assert.equal(b.code, 200); assert.ok(b.raw.equals(PDF));
    assert.equal(b.headers['Content-Type'], 'application/pdf'); assert.equal(b.headers['X-Content-Type-Options'], 'nosniff'); assert.equal(b.headers['Cache-Control'], 'no-store');
  }
  // partner sees provider + meter in the lead; the access is logged
  const pv = (await call('../api/partner', mk('GET', { headers: C(pkey) }))).payload.leads.find((l) => l.id === custLead.id);
  assert.equal(pv.meter_number, 'M1234567'); assert.equal(pv.has_bill, true); assert.equal(pv.bill_storage_path, undefined);
  assert.ok((await db().select('lead_events', { where: { lead_id: custLead.id } })).some((e) => e.type === 'bill_view'));
});

// ---- referral reward ----
let owner, refd;
const rewards = async () => db().select('referral_rewards', {});
test('11. unknown and self referral codes are rejected', async () => {
  const o = await post({ ...METER, first_name: 'Owner', phone: '5125552000' });
  owner = (await db().select('leads', {})).find((l) => l.ref === o.payload.ref);
  assert.ok(owner.own_code);
  const unknown = await post({ ...METER, referrer_code: 'NOPE123' });
  assert.equal((await db().select('leads', {})).find((l) => l.ref === unknown.payload.ref).referrer_code, null);
  const self = await post({ ...METER, phone: '5125552000', referrer_code: owner.own_code });
  const selfRow = (await db().select('leads', {})).find((l) => l.ref === self.payload.ref);
  assert.equal(selfRow.referrer_code, null);
  assert.equal((await rewards()).length, 0, 'no reward rows for rejected codes');
});

test('12. a referred lead creates no $50 reward (only a $0 tracking record)', async () => {
  const r = await post({ ...METER, first_name: 'Friend', phone: '5125552001', referrer_code: owner.own_code });
  refd = (await db().select('leads', {})).find((l) => l.ref === r.payload.ref);
  assert.equal(refd.referrer_code, owner.own_code);
  const rw = await rewards();
  assert.equal(rw.length, 1);
  assert.equal(rw[0].amount_cents, 0); assert.equal(rw[0].status, 'tracking');
  assert.ok(!rw.some((x) => x.amount_cents === 5000));
  assert.equal(rw[0].milestone, undefined);
});

test('13. an estimate / proposal creates no $100 reward and earns nothing', async () => {
  const H = C(pkey);
  for (const stage of ['contacted', 'appointment_set', 'proposal_sent', 'signed']) await call('../api/partner', mk('PATCH', { headers: H, body: { lead_id: refd.id, stage } }));
  const rw = await rewards();
  assert.equal(rw.length, 1); assert.ok(!rw.some((x) => x.amount_cents === 10000));
  assert.equal(rw[0].status, 'tracking');
  const adm = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  assert.equal(adm.kpis.rewardsDueCents, 0); assert.equal(adm.kpis.rewardsToVerify, 0);
});

test('14. a verified installation produces exactly one $1,000 reward', async () => {
  await call('../api/partner', mk('PATCH', { headers: C(pkey), body: { lead_id: refd.id, stage: 'installed' } }));
  let rw = await rewards();
  assert.equal(rw.length, 1); assert.equal(rw[0].status, 'installation_confirmed'); assert.equal(rw[0].amount_cents, 0, 'a reported install is still worth $0 until verified');
  assert.equal((await call('../api/admin', mk('POST', { headers: A, body: { action: 'reward_verify', reward_id: rw[0].id } }))).code, 200);
  rw = await rewards();
  assert.equal(rw[0].status, 'reward_pending'); assert.equal(rw[0].amount_cents, 100000); assert.ok(rw[0].reward_pending_at); assert.ok(rw[0].installation_verified_at);
  const v = (await call('../api/portal', mk('GET', { headers: C(owner.portal_token) }))).payload;
  assert.equal(v.referral.stats.reward_pending, 1); assert.equal(v.referral.pending_cents, 100000);
});

test('15. repeat installation / status updates never duplicate the reward', async () => {
  for (let i = 0; i < 3; i++) {
    await call('../api/partner', mk('PATCH', { headers: C(pkey), body: { lead_id: refd.id, stage: 'installed', note: 'update ' + i } }));
    await call('../api/inbound', mk('POST', { headers: { 'x-api-key': pkey }, body: { updates: [{ ref: refd.ref, stage: 'installed' }] } }));
    await call('../api/admin', mk('POST', { headers: A, body: { action: 'admin_update', lead_id: refd.id, stage: 'installed' } }));
  }
  const rw = await rewards();
  assert.equal(rw.length, 1);
  assert.equal(rw[0].status, 'reward_pending', 'repeat updates do not move it');
  // a second insert for the same lead is impossible by design: ensureReward is idempotent
  await require('../lib/leads').ensureReward(refd); await require('../lib/leads').syncReward(refd);
  assert.equal((await rewards()).length, 1);
});

test('16. the reward is never automatically marked paid; payment needs the owner and a reference', async () => {
  let rw = (await rewards())[0];
  assert.notEqual(rw.status, 'paid'); assert.equal(rw.paid_at, null); assert.equal(rw.transaction_ref, null);
  assert.equal((await call('../api/admin', mk('POST', { headers: { authorization: 'Bearer ' + pkey }, body: { action: 'reward_paid', reward_id: rw.id, transaction_ref: 'X' } }))).code, 401, 'partners cannot pay');
  assert.equal((await call('../api/admin', mk('POST', { headers: A, body: { action: 'reward_paid', reward_id: rw.id } }))).code, 400);
  assert.equal((await call('../api/admin', mk('POST', { headers: A, body: { action: 'reward_paid', reward_id: rw.id, transaction_ref: 'ACH-77' } }))).code, 200);
  rw = (await rewards())[0];
  assert.equal(rw.status, 'paid'); assert.equal(rw.transaction_ref, 'ACH-77'); assert.ok(rw.paid_at);
  assert.equal((await rewards()).length, 1);
});

test('lost referred leads become ineligible and cannot be paid', async () => {
  const r = await post({ ...METER, first_name: 'Gone', phone: '5125552002', referrer_code: owner.own_code });
  const lost = (await db().select('leads', {})).find((l) => l.ref === r.payload.ref);
  await call('../api/partner', mk('PATCH', { headers: C(pkey), body: { lead_id: lost.id, stage: 'lost', lost_reason: 'Not interested' } }));
  const rw = (await rewards()).find((x) => x.lead_id === lost.id);
  assert.equal(rw.status, 'ineligible');
  assert.equal((await call('../api/admin', mk('POST', { headers: A, body: { action: 'reward_verify', reward_id: rw.id } }))).code, 409);
});

test('admin erase also removes the stored bill', async () => {
  assert.ok(globalThis.__wwbills.has(custLead.bill_storage_path));
  await call('../api/admin', mk('POST', { headers: A, body: { action: 'erase_lead', lead_id: custLead.id } }));
  assert.ok(!globalThis.__wwbills.has(custLead.bill_storage_path));
});
