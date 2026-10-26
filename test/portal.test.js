const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
process.env.ADMIN_TOKEN = 'admin-secret';
process.env.APP_URL = 'https://example.test';
process.env.RESEND_API_KEY = 're_test';
process.env.MAIL_FROM = 'WattWorth <hi@example.test>';
process.env.INBOUND_EMAIL_DOMAIN = 'in.example.test';
process.env.RESEND_WEBHOOK_SECRET = 'whsec_' + Buffer.from('s3cret-key-for-tests').toString('base64');
process.env.OWNER_EMAIL = 'owner@example.test';
process.env.DISPLAY_TZ = 'America/Chicago';

const mails = []; const pushes = []; let received = null;
globalThis.__wwfetch = async (url, opts) => {
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (url === 'https://api.resend.com/emails') { mails.push(JSON.parse(opts.body)); return ok({ id: 'em' }); }
  if (url.startsWith('https://api.resend.com/emails/receiving/')) return ok(received);
  throw new Error('unexpected fetch ' + url);
};
globalThis.__wwpush = async (sub, payload) => { if (sub.endpoint.includes('gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; } pushes.push({ sub, payload }); };

let n = 0;
const mk = (method, { headers = {}, body, query = {}, raw } = {}) => ({ method, headers: { 'x-forwarded-for': `7.7.7.${++n}`, ...headers }, body, query, rawBody: raw, socket: { remoteAddress: '1.1.1.1' } });
function mkRes() { const r = { code: 200, headers: {}, payload: undefined }; r.setHeader = (k, v) => (r.headers[k] = v); r.status = (c) => { r.code = c; return r; }; r.json = (o) => { r.payload = o; return r; }; r.send = (s) => { r.payload = s; return r; }; r.end = () => r; return r; }
const call = async (mod, req) => { const res = mkRes(); await require(mod)(req, res); return res; };
const A = { authorization: 'Bearer admin-secret' };
const C = (t) => ({ authorization: 'Bearer ' + t });
const intake = (o = {}) => ({ first_name: 'Dana', last_name: 'Reyes', phone: '5125550142', email: 'dana@example.com', city: 'Austin', state: 'TX', zip: '78701', monthly_bill: 220, homeowner: true, consent: true, consent_text: 'I agree to be contacted (portal test wording).', source: '/', ...o });

let pkey, partner, tok, lead, code;
const pview = async () => (await call('../api/partner', mk('GET', { headers: C(pkey) }))).payload;
const pget = async () => (await pview()).leads.find((l) => l.id === lead.id);
const cview = async () => (await call('../api/portal', mk('GET', { headers: C(tok) }))).payload;
const cpost = (b, t = tok) => call('../api/portal', mk('POST', { headers: C(t), body: b }));
const ppatch = (b) => call('../api/partner', mk('PATCH', { headers: C(pkey), body: { lead_id: lead.id, ...b } }));

test('setup: partner (email only) and a customer who gets a private tracker link', async () => {
  const r = await call('../api/admin', mk('POST', { headers: A, body: { action: 'create_partner', name: 'Pedro', company: 'Test Solar', email: 'pedro@example.com', public_phone: '(512) 555-0111', fee_mode: 'flat' } }));
  pkey = r.payload.access_key; partner = r.payload.partner;
  assert.equal(partner.public_phone, '+15125550111');
  mails.length = 0;
  const l = await call('../api/leads', mk('POST', { body: intake() }));
  tok = l.payload.portal_token; code = l.payload.own_code;
  assert.match(tok, /^wc_[a-f0-9]{48}$/); assert.match(code, /^DANA[A-Z2-9]{3}$/);
  assert.ok(mails.some((m) => m.to[0] === 'dana@example.com' && /tracker/i.test(m.subject) && m.text.includes('/portal/#t=' + tok)), 'customer gets tracker link by email');
  lead = (await pview()).leads[0];
});

test('auth: only the customer\'s own token works; admin/partner keys do not', async () => {
  assert.equal((await call('../api/portal', mk('GET'))).code, 401);
  assert.equal((await call('../api/portal', mk('GET', { headers: C('wc_' + '0'.repeat(48)) }))).code, 401);
  assert.equal((await call('../api/portal', mk('GET', { headers: A }))).code, 401);
  assert.equal((await call('../api/portal', mk('GET', { headers: C(pkey) }))).code, 401);
});

test('view: tracker, specialist, and nothing internal', async () => {
  await ppatch({ note: 'internal: tough customer', contract_value: 20000 });
  const v = await cview();
  assert.equal(v.lead.first_name, 'Dana'); assert.equal(v.steps[0].done, true); assert.equal(v.steps[1].done, false);
  assert.deepEqual(v.specialist, { name: 'Pedro', company: 'Test Solar', phone: '+15125550111' });
  const text = JSON.stringify(v);
  for (const secret of ['internal: tough', 'commission', 'contract', 'fee', 'consent', 'portal_token', 'pedro@example.com', 'wp_']) assert.ok(!text.includes(secret), 'leaked: ' + secret);
});

test('push: stage changes notify installed devices; gone devices are cleaned up; email only when no device', async () => {
  assert.equal((await cpost({ action: 'subscribe', subscription: { endpoint: 'http://insecure', keys: { p256dh: 'a', auth: 'b' } } })).code, 400);
  assert.equal((await cpost({ action: 'subscribe', subscription: { endpoint: 'https://push.example/dev1', keys: { p256dh: 'a', auth: 'b' } } })).code, 201);
  assert.equal((await cpost({ action: 'subscribe', subscription: { endpoint: 'https://push.example/gone1', keys: { p256dh: 'a', auth: 'b' } } })).code, 201);
  assert.equal((await cview()).push.devices, 2);
  mails.length = 0; pushes.length = 0;
  await ppatch({ stage: 'contacted' });
  assert.equal(pushes.length, 1); assert.match(pushes[0].payload.title, /reached out/i);
  assert.equal(mails.filter((m) => m.to[0] === 'dana@example.com').length, 0, 'no email when push worked');
  assert.equal((await cview()).push.devices, 1, 'expired device removed');
  await ppatch({ stage: 'contacted', note: 'again' });            // same stage again: deduped
  assert.equal(pushes.length, 1);
  await cpost({ action: 'unsubscribe', endpoint: 'https://push.example/dev1' });
  await ppatch({ stage: 'proposal_sent' });
  assert.equal(pushes.length, 1);
  assert.ok(mails.some((m) => m.to[0] === 'dana@example.com' && /proposal/i.test(m.subject)), 'email fallback with no device');
  await ppatch({ stage: 'contacted' });                            // moving backwards stays quiet
  assert.equal(mails.filter((m) => /reached out/i.test(m.subject)).length, 0);
});

test('messages: customer to partner by email with reply address; partner reply reaches customer', async () => {
  mails.length = 0;
  assert.equal((await cpost({ action: 'message', body: '   ' })).code, 400);
  const r = await cpost({ action: 'message', body: 'Can we do Thursday?' });
  assert.equal(r.code, 201); assert.equal(r.payload.messages.at(-1).body, 'Can we do Thursday?');
  const m = mails.find((x) => x.to[0] === 'pedro@example.com');
  assert.ok(m && m.reply_to === `reply+${lead.ref.toLowerCase()}@in.example.test`);
  const p = await pget(); assert.equal(p.unread, 1); assert.equal(p.messages.at(-1).from, 'customer');
  await ppatch({ read: true }); assert.equal((await pget()).unread, 0);
  await subscribe('https://push.example/dev2'); pushes.length = 0;
  await ppatch({ message: 'Thursday works. I will call from 512-555-0111.' });
  assert.equal(pushes.length, 1); assert.match(pushes[0].payload.title, /Pedro/);
  const v = await cview(); assert.equal(v.unread, 1);
  await cpost({ action: 'read' }); assert.equal((await cview()).unread, 0);
});
const subscribe = (endpoint) => cpost({ action: 'subscribe', subscription: { endpoint, keys: { p256dh: 'a', auth: 'b' } } });

test('messages: hourly limit', async () => {
  let last;
  for (let i = 0; i < 25; i++) last = await cpost({ action: 'message', body: 'ping ' + i });
  assert.equal(last.code, 429);
});

const sign = (body) => { const id = 'msg_1', ts = String(Math.floor(Date.now() / 1000)); const key = Buffer.from(process.env.RESEND_WEBHOOK_SECRET.replace('whsec_', ''), 'base64'); return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': 'v1,' + crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64') }; };
const inbound = (from, text, to) => { received = { text }; const raw = JSON.stringify({ type: 'email.received', data: { email_id: 'e1', from, to: [to || `reply+${lead.ref.toLowerCase()}@in.example.test`] } }); return call('../api/emailin', mk('POST', { headers: sign(raw), raw })); };

test('email reply bridge: signed, from the partner only, quotes stripped', async () => {
  const bad = JSON.stringify({ type: 'email.received', data: {} });
  assert.equal((await call('../api/emailin', mk('POST', { headers: { ...sign(bad), 'svix-signature': 'v1,AAAA' }, raw: bad }))).code, 401);
  const before = (await cview()).messages.length;
  assert.equal((await inbound('Intruder <evil@example.org>', 'Send me your bank info')).payload.reason, 'sender_not_partner');
  assert.equal((await cview()).messages.length, before);
  const r = await inbound('Pedro <PEDRO@example.com>', 'See you Thursday at 10!\n\nOn Mon, Oct 26, 2026 at 3:01 PM WattWorth <hi@example.test>\nwrote:\n> Can we do Thursday?\n> thanks');
  assert.equal(r.payload.ok, true);
  const v = await cview(); assert.equal(v.messages.at(-1).body, 'See you Thursday at 10!'); assert.equal(v.messages.at(-1).from, 'partner');
  assert.equal((await inbound('pedro@example.com', 'hi', 'someone@in.example.test')).payload.reason, 'no_ref');
});

test('appointment: notifies, and reminders fire once at 24h and 1h', async () => {
  pushes.length = 0;
  const when = new Date(Date.now() + 24 * 3600e3 - 600e3);          // 23h50m away
  await ppatch({ appointment_at: when.toISOString() });
  assert.match(pushes.at(-1).payload.body, /consultation is set for/i);
  assert.equal((await ppatch({ appointment_at: 'nonsense' })).code, 400);
  const { reminders } = require('../lib/portal');
  pushes.length = 0;
  assert.equal(await reminders(Date.now()), 1);
  assert.match(pushes[0].payload.title, /tomorrow/i);
  assert.equal(await reminders(Date.now()), 0);                      // never twice
  assert.equal(await reminders(when.getTime() - 30 * 60e3), 1);      // 1 hour window
  assert.equal((await cview()).appointment_text.length > 5, true);
});

test('confirm contact: a "no" alerts the owner and shows in the dashboard stats', async () => {
  assert.equal((await cview()).confirm.ask, true);
  mails.length = 0;
  await cpost({ action: 'confirm_contact', answer: 'no' });
  assert.ok(mails.some((m) => m.to[0] === 'owner@example.test' && /not reached/i.test(m.subject)));
  const a = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  assert.equal(a.kpis.contactConfirmedNo, 1); assert.ok(a.kpis.messagesUnanswered >= 0);
  assert.ok(!(await pget()).history.some((h) => h.type === 'confirm'), 'partner does not see the answer');
  assert.equal((await cpost({ action: 'confirm_contact', answer: 'maybe' })).code, 400);
});

test('referrals: real codes only; friend progress and rewards appear in the referrer\'s tracker', async () => {
  const self = await call('../api/leads', mk('POST', { body: intake({ phone: '5125550999', referrer_code: code }) }));   // different person, valid code
  assert.equal(self.code, 201);
  const bogus = await call('../api/leads', mk('POST', { body: intake({ phone: '5125550888', first_name: 'Eve', referrer_code: 'NOPE123' }) }));
  const adm = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  assert.equal(adm.leads.find((l) => l.phone === '+15125550888').referrer_code, null, 'unknown code ignored');
  assert.equal(adm.payouts.length, 1);
  const v = await cview();
  assert.equal(v.referral.friends.length, 1); assert.equal(v.referral.friends[0].status, 'Submitted');
  assert.equal(v.referral.pending_cents, 5000); assert.equal(v.referral.rewards[0].friend.startsWith('Dana'), true);
  assert.ok(!JSON.stringify(v.referral).includes('555'), 'no friend contact details');
  assert.ok(bogus.payload.own_code);
});

test('duplicates never hand out a token; the existing tracker link is emailed to the original email', async () => {
  mails.length = 0;
  const d = await call('../api/leads', mk('POST', { body: intake({ email: 'someone-else@example.com' }) }));
  assert.equal(d.payload.portal_token, null); assert.equal(d.payload.existing_tracker, true);
  assert.ok(mails.every((m) => m.to[0] !== 'someone-else@example.com'));
});

test('magic link: same answer for everyone, one email per 10 minutes', async () => {
  const known = await call('../api/magiclink', mk('POST', { body: { email: 'eve@example.com' } }));
  const unknown = await call('../api/magiclink', mk('POST', { body: { email: 'nobody@example.com' } }));
  assert.deepEqual(known.payload, unknown.payload);
  // first lead for dana@: cooldown already running from intake
  mails.length = 0;
  await call('../api/magiclink', mk('POST', { body: { email: 'dana@example.com' } }));
  assert.equal(mails.length, 0);
});

test('privacy: deletion request revokes the link and alerts the owner; admin can erase', async () => {
  mails.length = 0;
  await cpost({ action: 'delete_request' });
  assert.ok(mails.some((m) => /deletion/i.test(m.subject)));
  assert.equal((await call('../api/portal', mk('GET', { headers: C(tok) }))).code, 401);
  assert.equal((await call('../api/admin', mk('POST', { headers: A, body: { action: 'erase_lead', lead_id: lead.id } }))).code, 200);
  const a = (await call('../api/admin', mk('GET', { headers: A }))).payload;
  assert.ok(!a.leads.some((l) => l.id === lead.id));
});

test('shared: customer-facing stage mapping and quoted-text stripper', () => {
  const P = require('../lib/portal');
  assert.equal(P.stripQuoted('Yes!\n\n-----Original Message-----\nFrom: x'), 'Yes!');
  assert.equal(P.stripQuoted('Line one\nLine two\n> quoted'), 'Line one\nLine two');
  assert.equal(P.STEPS.length, 6);
});
