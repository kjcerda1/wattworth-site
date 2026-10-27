// Referral Experience V2: one $1,000 reward after a verified qualifying installation, nothing before it,
// anonymous referrer view, first valid referral wins, owner-only money actions, audited overrides.
const test = require('node:test');
const assert = require('node:assert');
process.env.ADMIN_TOKEN = 'admin-secret';
process.env.APP_URL = 'https://example.test';
const pushes = [];
globalThis.__wwfetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'x' }), text: async () => '{}' });
globalThis.__wwpush = async (sub, payload) => { pushes.push({ to: sub.lead_id, payload }); };

let n = 0;
const mk = (method, { headers = {}, body, query = {} } = {}) => ({ method, headers: { 'x-forwarded-for': `8.8.8.${++n}`, ...headers }, body, query, socket: { remoteAddress: '1.1.1.1' } });
function mkRes() { const r = { code: 200, headers: {}, payload: undefined, raw: undefined }; r.setHeader = (k, v) => (r.headers[k] = v); r.status = (c) => { r.code = c; return r; }; r.json = (o) => { r.payload = o; return r; }; r.end = (b) => { r.raw = b; return r; }; r.send = r.end; return r; }
const call = async (mod, req) => { const res = mkRes(); await require(mod)(req, res); return res; };
const A = { authorization: 'Bearer admin-secret' };
const C = (t) => ({ authorization: 'Bearer ' + t });
const db = () => require('../lib/db');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const BILL = { filename: 'zelda-private-bill.pdf', mime: 'application/pdf', data: PDF.toString('base64') };
let pn = 1000;
const person = (o = {}) => { const k = ++pn; return { first_name: 'Pat' + k, last_name: 'Person', phone: '512555' + k, email: `pat${k}@example.com`, city: 'Austin', state: 'TX', zip: '78701', monthly_bill: 200, homeowner: true, consent: true, consent_text: 'I agree.', electric_provider: 'CPS Energy', meter_number: 'M' + (1000000 + k), ...o }; };
const submit = (o) => call('../api/leads', mk('POST', { body: person(o) }));
const lead = async (ref) => (await db().select('leads', {})).find((l) => l.ref === ref);
const rewards = () => db().select('referral_rewards', {});
const rewardOf = async (leadId) => (await rewards()).find((r) => r.lead_id === leadId);
const stage = (pk, id, body) => call('../api/partner', mk('PATCH', { headers: C(pk), body: { lead_id: id, ...body } }));
const adm = (body) => call('../api/admin', mk('POST', { headers: A, body }));
const view = async (tok) => (await call('../api/portal', mk('GET', { headers: C(tok) }))).payload;

let pk, ref1, ref2, r1, r2, F1, F1lead;   // partner key, two referrers, a referred friend
const pushTitles = (leadId) => pushes.filter((p) => p.to === leadId).map((p) => p.payload.title);

test('setup: partner and two customers who can refer', async () => {
  const p = await adm({ action: 'create_partner', name: 'Pedro', company: 'Test Solar', email: 'pedro@example.com', fee_mode: 'flat' });
  pk = p.payload.access_key;
  const a = await submit({ first_name: 'Alice' }), b = await submit({ first_name: 'Bob' });
  r1 = await lead(a.payload.ref); r2 = await lead(b.payload.ref); ref1 = r1.own_code; ref2 = r2.own_code;
  assert.ok(ref1 && ref2 && ref1 !== ref2);
  for (const l of [r1, r2]) await db().insert('push_subscriptions', { lead_id: l.id, endpoint: 'https://push.example/' + l.id, p256dh: 'k', auth: 'a', failures: 0 });
});

test('1. valid referral attribution: the referrer is set server-side and recorded once', async () => {
  const r = await submit({ first_name: 'Zelda', last_name: 'Quimby', address: '742 Evergreen Terrace', city: 'Gotham', zip: '73301', referrer_code: ref1.toLowerCase(), meter_number: 'METER9X77Z', electric_provider: 'Gotham Power', bill: BILL, notes: 'secret sales note' });
  assert.equal(r.code, 201);
  F1lead = await lead(r.payload.ref);
  assert.equal(F1lead.referrer_code, ref1);
  F1 = await rewardOf(F1lead.id);
  assert.ok(F1 && F1.referrer_code === ref1 && F1.created_at, 'attribution record with its date');
  assert.equal((await rewards()).filter((x) => x.lead_id === F1lead.id).length, 1);
});

test('2. an invalid referral code is ignored and the lead is still accepted', async () => {
  const r = await submit({ referrer_code: 'NOSUCHCODE' });
  assert.equal(r.code, 201);
  const l = await lead(r.payload.ref);
  assert.equal(l.referrer_code, null); assert.equal(await rewardOf(l.id), undefined);
  assert.equal((await submit({ referrer_code: "'; drop table leads;--" })).code, 201);
});

test('3. self referral is rejected (same phone, or same email in any case)', async () => {
  const samePhone = await submit({ phone: r1.phone.replace('+1', ''), email: 'other@example.com', referrer_code: ref1 });
  const sameEmail = await submit({ email: r1.email.toUpperCase(), referrer_code: ref1 });
  for (const r of [samePhone, sameEmail]) {
    assert.equal(r.code, 201);
    const l = await lead(r.payload.ref);
    assert.equal(l.referrer_code, null); assert.equal(await rewardOf(l.id), undefined);
  }
});

test('4. first valid referral wins: a later submission with another code changes nothing and adds no reward', async () => {
  const again = await submit({ phone: F1lead.phone.replace('+1', ''), email: F1lead.email, referrer_code: ref2 });
  assert.equal(again.code, 201);
  const dupe = await lead(again.payload.ref);
  assert.ok(dupe.duplicate_of); assert.equal(dupe.referrer_code, null);
  assert.equal(await rewardOf(dupe.id), undefined, 'a duplicate homeowner never creates a reward');
  assert.equal((await lead(F1lead.ref)).referrer_code, ref1, 'attribution did not move');
  assert.equal((await rewards()).filter((x) => x.referrer_code === ref2).length, 0);
  // and the customer cannot change it themselves
  const hack = await call('../api/portal', mk('POST', { headers: C(F1lead.portal_token), body: { action: 'set_referrer', referrer_code: ref2, own_code: 'HACKED' } }));
  assert.equal(hack.code, 400);
  const after = await lead(F1lead.ref);
  assert.equal(after.referrer_code, ref1); assert.notEqual(after.own_code, 'HACKED');
});

test('5. the referrer API is an anonymized, hand-built object', async () => {
  const v = (await view(r1.portal_token)).referral;
  assert.deepEqual(Object.keys(v).sort(), ['code', 'list', 'paid_cents', 'path', 'pending_cents', 'reward_cents', 'stats'].sort());
  assert.deepEqual(Object.keys(v.stats).sort(), ['in_progress', 'installed', 'paid', 'reward_pending', 'total', 'verified']);
  assert.equal(v.stats.total, 1); assert.equal(v.stats.verified, 1); assert.equal(v.stats.in_progress, 1);
  assert.deepEqual(Object.keys(v.list[0]).sort(), ['label', 'milestone', 'n', 'updated']);
  assert.equal(v.list[0].n, 1); assert.equal(v.list[0].label, 'Verification complete');
  assert.equal(v.reward_cents, 100000); assert.equal(v.path, '/r/' + ref1);
});

test('6. no homeowner details reach the referrer, even after the deal progresses', async () => {
  await stage(pk, F1lead.id, { stage: 'contacted', note: 'secret sales note too' });
  await stage(pk, F1lead.id, { stage: 'proposal_sent', system_kw: 8.4, contract_value: 31234 });
  await stage(pk, F1lead.id, { stage: 'signed', commission_dollars: 4321 });
  const s = JSON.stringify(await view(r1.portal_token));
  for (const secret of ['Zelda', 'Quimby', 'Gotham', '73301', '742 Evergreen', F1lead.phone, F1lead.phone.slice(2), F1lead.email, 'METER9X77Z', 'Gotham Power', 'zelda-private-bill', 'bills/', 'secret sales note', '31234', '4321', '432100', 'commission', 'contract', 'system_kw', 'meter', 'provider', 'bill_', F1lead.ref, F1lead.id, F1lead.own_code]) assert.ok(!s.includes(secret), 'referrer response leaks: ' + secret);
});

test('7-10. submitting, verification, consultation and signing each create a $0 reward', async () => {
  // snapshots at each stage were taken as the deal moved; re-check the end state of the same lead
  const r = await rewardOf(F1lead.id);
  assert.equal(r.status, 'tracking'); assert.equal(r.amount_cents, 0);
  const a = (await adm({}).catch(() => null)); // keep linter quiet
  const admin = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  assert.equal(admin.kpis.rewardsDueCents, 0); assert.equal(admin.kpis.rewardsToVerify, 0);
  const v = (await view(r1.portal_token)).referral;
  assert.equal(v.pending_cents, 0); assert.equal(v.paid_cents, 0);
  // step by step on a fresh referral
  const f = await lead((await submit({ referrer_code: ref2 })).payload.ref);
  assert.equal((await rewardOf(f.id)).amount_cents, 0);                                      // submitted + verification complete
  await stage(pk, f.id, { stage: 'contacted' });
  await stage(pk, f.id, { stage: 'appointment_set' });
  assert.equal((await rewardOf(f.id)).amount_cents, 0);                                      // consultation
  await stage(pk, f.id, { stage: 'proposal_sent' });
  await stage(pk, f.id, { stage: 'signed' });
  const rr = await rewardOf(f.id);
  assert.equal(rr.amount_cents, 0); assert.equal(rr.status, 'tracking');                     // signed
  assert.equal((await rewards()).filter((x) => x.lead_id === f.id).length, 1);
});

test('11. installation verification produces exactly one $1,000 pending reward and notifies the referrer', async () => {
  await stage(pk, F1lead.id, { stage: 'installed' });
  let r = await rewardOf(F1lead.id);
  assert.equal(r.status, 'installation_confirmed'); assert.equal(r.amount_cents, 0, 'a reported install is not yet money');
  assert.equal((await view(r1.portal_token)).referral.list[0].label, 'Installation being verified');
  assert.equal((await adm({ action: 'reward_verify', reward_id: r.id })).code, 200);
  r = await rewardOf(F1lead.id);
  assert.equal(r.status, 'reward_pending'); assert.equal(r.amount_cents, 100000);
  assert.ok(r.installation_verified_at && r.reward_pending_at); assert.equal(r.verified_by, 'admin');
  assert.equal((await rewards()).filter((x) => x.lead_id === F1lead.id).length, 1);
  const v = (await view(r1.portal_token)).referral;
  assert.equal(v.stats.installed, 1); assert.equal(v.stats.reward_pending, 1); assert.equal(v.pending_cents, 100000);
  assert.equal(v.list[0].label, 'Installation verified: $1,000 reward pending');
});

test('12. repeated status updates cannot duplicate or advance the reward', async () => {
  for (let i = 0; i < 3; i++) {
    await stage(pk, F1lead.id, { stage: 'installed', note: 'again ' + i });
    await call('../api/inbound', mk('POST', { headers: { 'x-api-key': pk }, body: { updates: [{ ref: F1lead.ref, stage: 'installed' }] } }));
    await adm({ action: 'admin_update', lead_id: F1lead.id, stage: 'installed' });
  }
  const rows = (await rewards()).filter((x) => x.lead_id === F1lead.id);
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'reward_pending'); assert.equal(rows[0].amount_cents, 100000);
  assert.equal((await adm({ action: 'reward_verify', reward_id: rows[0].id })).code, 409, 'cannot verify twice');
  await require('../lib/referral').onProgress(await lead(F1lead.ref));
  assert.equal((await rewards()).filter((x) => x.lead_id === F1lead.id).length, 1);
});

test('13. only the owner/admin can mark paid or change money and attribution; Pedro cannot', async () => {
  const r = await rewardOf(F1lead.id);
  const H = { authorization: 'Bearer ' + pk };
  for (const body of [{ action: 'reward_paid', reward_id: r.id, transaction_ref: 'X' }, { action: 'reward_verify', reward_id: r.id }, { action: 'override_referrer', lead_id: F1lead.id, referrer_code: ref2, reason: 'x' }]) {
    assert.equal((await call('../api/admin', mk('POST', { headers: H, body }))).code, 401, body.action + ' as partner');
    assert.equal((await call('../api/admin', mk('POST', { headers: C(F1lead.portal_token), body }))).code, 401, body.action + ' as customer');
    assert.equal((await call('../api/admin', mk('POST', { headers: C(r1.portal_token), body }))).code, 401, body.action + ' as referrer');
  }
  // fields a partner might try to slip into a lead update are ignored
  await call('../api/partner', mk('PATCH', { headers: H, body: { lead_id: F1lead.id, referrer_code: ref2, amount_cents: 999, status: 'paid', transaction_ref: 'HACK' } }));
  const after = await rewardOf(F1lead.id);
  assert.equal(after.status, 'reward_pending'); assert.equal(after.amount_cents, 100000); assert.equal(after.referrer_code, ref1); assert.equal(after.transaction_ref, null);
  assert.equal((await lead(F1lead.ref)).referrer_code, ref1);
  assert.equal(after.status === 'paid', false, 'nothing paid automatically');
});

test('14. paid needs a reference and records timestamp, reference, admin actor and an audit event', async () => {
  const r = await rewardOf(F1lead.id);
  assert.equal((await adm({ action: 'reward_paid', reward_id: r.id })).code, 400);
  assert.equal((await adm({ action: 'reward_paid', reward_id: r.id, transaction_ref: '   ' })).code, 400);
  assert.equal((await adm({ action: 'reward_paid', reward_id: r.id, transaction_ref: 'ACH-2026-0007' })).code, 200);
  const p = await rewardOf(F1lead.id);
  assert.equal(p.status, 'paid'); assert.equal(p.transaction_ref, 'ACH-2026-0007'); assert.equal(p.paid_by, 'admin'); assert.ok(p.paid_at);
  const admin = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  const row = admin.rewards.find((x) => x.id === p.id);
  assert.ok(row.audit.some((e) => e.to === 'paid' && e.actor === 'admin' && /ACH-2026-0007/.test(e.note)));
  assert.equal(row.referrer_name, 'Alice Person'); assert.equal(row.milestone, 'paid'); assert.ok(row.attributed_at);
  assert.equal((await adm({ action: 'reward_ineligible', reward_id: p.id })).code, 409, 'paid is final');
  assert.equal((await view(r1.portal_token)).referral.paid_cents, 100000);
});

test('15. referrer notifications: meaningful milestones only, once each, no homeowner details', async () => {
  const bodies = pushes.filter((p) => p.to === r1.id).map((p) => p.payload.body);
  assert.deepEqual(bodies, ['Your referral completed WattWorth verification.', 'Your referral is moving forward.', 'Great news \u2014 a qualifying solar installation was verified. Your $1,000 reward is pending.', 'Your $1,000 WattWorth referral reward has been marked paid.'], 'exactly the four milestones, in order, once each');
  const text = JSON.stringify(pushes.filter((p) => p.to === r1.id));
  for (const secret of ['Zelda', 'Quimby', 'Gotham', F1lead.email, 'METER', 'contract', 'proposal', 'signed', 'commission']) assert.ok(!text.includes(secret), 'notification leaks ' + secret);
  assert.equal(pushes.filter((p) => p.to === F1lead.id && /\$1,000/.test(p.payload.body)).length, 0, 'the homeowner is never told about the reward');
});

test('16. bill / provider+meter verification still works for referred homeowners', async () => {
  assert.equal((await submit({ referrer_code: ref2, electric_provider: undefined, meter_number: undefined, bill: BILL })).code, 201);
  assert.equal((await submit({ referrer_code: ref2 })).code, 201);
  assert.equal((await submit({ referrer_code: ref2, electric_provider: undefined, meter_number: undefined })).code, 400, 'neither');
  assert.equal((await submit({ referrer_code: ref2, meter_number: undefined })).code, 400, 'provider only');
  assert.equal((await submit({ referrer_code: ref2, electric_provider: undefined })).code, 400, 'meter only');
});

test('17. the bill and verification data stay private from the referrer and the customer', async () => {
  const bill = (await db().select('leads', {})).find((l) => l.id === F1lead.id).bill_storage_path;
  assert.ok(bill);
  for (const tok of [r1.portal_token, F1lead.portal_token]) {
    assert.equal((await call('../api/bill', mk('GET', { headers: C(tok), query: { lead_id: F1lead.id } }))).code, 401);
    const s = JSON.stringify(await view(tok));
    for (const secret of [bill, 'bills/', 'METER9X77Z', 'Gotham Power', 'zelda-private-bill']) assert.ok(!s.includes(secret), 'portal leaks ' + secret);
  }
  assert.equal((await call('../api/bill', mk('GET', { headers: C(pk), query: { lead_id: F1lead.id } }))).code, 200, 'the assigned partner can open it');
});

test('admin override: reason required, audited, owner-only, locked after payment', async () => {
  const f = await lead((await submit({ referrer_code: ref1 })).payload.ref);
  assert.equal((await adm({ action: 'override_referrer', lead_id: f.id, referrer_code: ref2 })).code, 400, 'reason required');
  assert.equal((await adm({ action: 'override_referrer', lead_id: f.id, referrer_code: 'NOPE', reason: 'typo' })).code, 400, 'must be a real referrer');
  assert.equal((await adm({ action: 'override_referrer', lead_id: f.id, referrer_code: ref2, reason: 'Referred at the event by Bob' })).code, 200);
  assert.equal((await lead(f.ref)).referrer_code, ref2);
  assert.equal((await rewardOf(f.id)).referrer_code, ref2);
  assert.equal((await rewards()).filter((x) => x.lead_id === f.id).length, 1);
  const ev = (await db().select('lead_events', { where: { lead_id: f.id } })).find((e) => e.type === 'referral_override');
  assert.ok(ev && ev.actor === 'admin' && ev.from_value === ref1 && ev.to_value === ref2 && /event/.test(ev.note));
  const audit = (await call('../api/admin', mk('GET', { headers: A }))).payload.rewards.find((x) => x.lead_id === f.id).audit;
  assert.ok(audit.some((e) => e.type === 'referral_override'));
  // the new referrer is credited, the old one no longer sees it
  assert.equal((await view(r1.portal_token)).referral.stats.total, 1);
  assert.ok((await view(r2.portal_token)).referral.stats.total >= 1);
  // a self-referral cannot be forced either, and removing the referrer makes the record not eligible
  assert.equal((await adm({ action: 'override_referrer', lead_id: r2.id, referrer_code: ref2, reason: 'self' })).code, 400);
  assert.equal((await adm({ action: 'override_referrer', lead_id: f.id, referrer_code: '', reason: 'Wrong person' })).code, 200);
  assert.equal((await rewardOf(f.id)).status, 'ineligible');
  // paid attribution is locked
  const paid = await rewardOf(F1lead.id);
  assert.equal((await adm({ action: 'override_referrer', lead_id: F1lead.id, referrer_code: ref2, reason: 'try' })).code, 409);
  assert.equal((await rewardOf(F1lead.id)).referrer_code, paid.referrer_code);
});

test('a lost referral is ineligible and cannot become a reward; reinstating re-checks the lead', async () => {
  const f = await lead((await submit({ referrer_code: ref2 })).payload.ref);
  await stage(pk, f.id, { stage: 'lost', lost_reason: 'Not interested' });
  const r = await rewardOf(f.id);
  assert.equal(r.status, 'ineligible'); assert.equal(r.amount_cents, 0);
  assert.equal((await adm({ action: 'reward_verify', reward_id: r.id })).code, 409);
  assert.equal((await view(r2.portal_token)).referral.list.some((x) => x.milestone === 'ineligible'), true);
});
