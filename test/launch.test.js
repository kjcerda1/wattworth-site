// Cold-market launch readiness: privacy-conscious analytics, unit economics, UTM hygiene, and the honest funnel.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
process.env.ADMIN_TOKEN = 'admin-secret';
process.env.APP_URL = 'https://example.test';
globalThis.__wwfetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'x' }), text: async () => '{}' });

let n = 0;
const mk = (method, { headers = {}, body, query = {} } = {}) => ({ method, headers: { 'x-forwarded-for': `7.7.7.${++n}`, ...headers }, body, query, socket: { remoteAddress: '1.1.1.1' } });
function mkRes() { const r = { code: 200, headers: {}, payload: undefined }; r.setHeader = (k, v) => (r.headers[k] = v); r.status = (c) => { r.code = c; return r; }; r.json = (o) => { r.payload = o; return r; }; r.send = (s) => { r.payload = s; return r; }; r.end = () => r; return r; }
const call = async (mod, req) => { const res = mkRes(); await require(mod)(req, res); return res; };
const A = { authorization: 'Bearer admin-secret' };
const db = () => require('../lib/db');
const EV = () => require('../lib/events');
const W = () => require('../lib/shared');
const ev = (o = {}) => ({ event: 'step_view', vid: 'abcdef123456', step: 1, utm: { utm_source: 'meta', utm_campaign: 'angle-a' }, device: 'mobile', ...o });
const post = (events, headers) => call('../api/event', mk('POST', { body: { events }, headers }));

const FUNNEL = fs.readFileSync(path.join(__dirname, '..', 'wattworthsolar_platform.html'), 'utf8');
const visible = FUNNEL.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');

// ---------- analytics API ----------
test('analytics: only allowlisted events are stored, with no personal data fields', async () => {
  const r = await post([ev({ event: 'landing_view', step: null }), ev(), ev({ event: 'verify_method', method: 'meter' }), ev({ event: 'not_an_event' }), ev({ vid: 'x' }), ev({ step: 99 })]);
  assert.equal(r.code, 202); assert.equal(r.payload.stored, 3);
  const rows = await db().select('funnel_events', {});
  assert.equal(rows.length, 3);
  const allowed = new Set(['id', 'created_at', 'updated_at', 'visitor_id', 'event', 'step', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'ref_host', 'device', 'props']);
  rows.forEach((x) => Object.keys(x).forEach((k) => assert.ok(allowed.has(k), 'unexpected column ' + k)));
  assert.ok(!rows.some((x) => 'ip' in x || 'ua' in x || 'user_agent' in x));
});

test('analytics: personal details smuggled into an event are dropped, never stored', async () => {
  db().reset();
  const r = await post([ev({ email: 'dana@example.com', phone: '5125550142', address: '1 Main St', meter_number: 'M123456', provider: 'CPS', ref_code: 'DANA7K2', method: 'dana@example.com', error: 'free text with name', cta: '<script>', utm: { utm_source: 'a@b.com', utm_campaign: 'ok-camp', utm_content: 'x'.repeat(500) } })]);
  assert.equal(r.payload.stored, 1);
  const row = (await db().select('funnel_events', {}))[0];
  const json = JSON.stringify(row);
  for (const bad of ['dana@example.com', '5125550142', 'Main St', 'M123456', 'CPS', 'DANA7K2', 'free text', '<script>']) assert.ok(!json.includes(bad), 'leaked ' + bad);
  assert.equal(row.utm_source, null);              // an email-looking campaign tag is refused
  assert.equal(row.utm_campaign, 'ok-camp');
  assert.ok(!row.utm_content || row.utm_content.length <= 80);   // overlong tags are cut, never stored whole
  assert.equal(row.props, null);
});

test('analytics: Global Privacy Control and Do Not Track are honored server-side', async () => {
  db().reset();
  assert.equal((await post([ev()], { 'sec-gpc': '1' })).payload.stored, 0);
  assert.equal((await post([ev()], { dnt: '1' })).payload.stored, 0);
  assert.equal((await db().select('funnel_events', {})).length, 0);
  assert.equal((await call('../api/event', mk('GET'))).code, 405);
});

test('analytics: batch size is capped and a single address cannot flood the table', async () => {
  db().reset();
  const big = Array.from({ length: 60 }, () => ev());
  assert.equal((await post(big)).payload.stored, 25);
  let flooded = false; const ipHeader = { 'x-forwarded-for': '8.8.8.8' };
  for (let i = 0; i < 8; i++) { const r = await call('../api/event', mk('POST', { body: { events: Array.from({ length: 25 }, () => ev()) }, headers: ipHeader })); if (r.payload.stored === 0) flooded = true; }
  assert.ok(flooded, 'rate limit never engaged');
});

test('analytics: events older than 180 days are purged by the daily job', async () => {
  db().reset();
  await db().insert('funnel_events', { visitor_id: 'oldvisitor1', event: 'landing_view', created_at: new Date(Date.now() - 200 * 864e5).toISOString() });
  await db().insert('funnel_events', { visitor_id: 'newvisitor1', event: 'landing_view' });
  await EV().purge();
  const left = await db().select('funnel_events', {});
  assert.deepEqual(left.map((x) => x.visitor_id), ['newvisitor1']);
});

// ---------- reporting ----------
test('visitor funnel report: steps, drop-off, and campaign join to real lead outcomes', async () => {
  db().reset();
  const V = (id, steps, extra = []) => [ev({ event: 'landing_view', vid: id, step: null }), ev({ event: 'funnel_start', vid: id, step: null }), ...steps.map((s) => ev({ vid: id, step: s })), ...extra];
  await post([...V('visitor0001', [1, 2, 3, 4, 5, 6], [ev({ event: 'submit_success', vid: 'visitor0001', step: null })]), ...V('visitor0002', [1, 2]), ...V('visitor0003', [1]), ev({ event: 'landing_view', vid: 'visitor0004', step: null })]);
  await db().insert('leads', { ref: 'WW-A', first_name: 'A', phone: '+15125550001', stage: 'appointment_set', homeowner: true, utm: { utm_source: 'meta', utm_campaign: 'angle-a' }, first_contacted_at: new Date().toISOString(), consent: true, consent_text: 't' });
  const r = EV().report(await db().selectAll('funnel_events', {}), await db().select('leads', {}));
  assert.equal(r.visitors, 4); assert.equal(r.starts, 3); assert.equal(r.submitted, 1);
  assert.equal(r.startRate, 75); assert.equal(r.completionRate, 33);
  assert.deepEqual(r.steps.map((s) => s.reached), [3, 2, 1, 1, 1, 1]);
  assert.equal(r.steps[1].droppedBefore, 1);
  const c = r.campaigns.find((x) => x.source === 'meta' && x.campaign === 'angle-a');
  assert.equal(c.visitors, 4); assert.equal(c.leads, 1); assert.equal(c.contacted, 1); assert.equal(c.appointments, 1); assert.equal(c.signed, 0);
});

test('reading more than 1000 rows pages through PostgREST limits', async () => {
  db().reset();
  for (let i = 0; i < 1203; i++) await db().insert('funnel_events', { visitor_id: 'v' + String(i).padStart(10, '0'), event: 'landing_view' });
  assert.equal((await db().selectAll('funnel_events', {})).length, 1203);
});

// ---------- UTM hygiene on leads ----------
test('lead intake stores only clean campaign tags', () => {
  const u = EV().cleanUtm({ utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'a b', utm_content: '<img src=x>', utm_term: 'solar', gclid: 'Cj0KCQ_abc-1', evil: 'x', nested: { a: 1 } });
  assert.deepEqual(u, { utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'a b', utm_term: 'solar', gclid: 'Cj0KCQ_abc-1' });
  assert.equal(EV().cleanUtm('nope'), null); assert.equal(EV().cleanUtm({}), null);
});

// ---------- economics ----------
test('economics: nothing is invented; ratios stay n/a until there is something to divide by', () => {
  const e = W().buildSummary({ leads: [], rewards: [], ad_spend: [], partners: [], tiers: [], expenses: [] }).economics;
  assert.equal(e.costPer.leadCents, null); assert.equal(e.costPer.installationCents, null);
  assert.equal(e.netRealisedCents, 0); assert.equal(e.termsSet, false);
  const e2 = W().buildSummary({ leads: [], rewards: [], ad_spend: [{ amount_cents: 50000 }], partners: [], tiers: [], expenses: [] }).economics;
  assert.equal(e2.costPer.leadCents, null);                 // spend but no leads: no cost-per-lead
  assert.equal(e2.netRealisedCents, -50000);
});

test('economics: spend, qualified leads, installs, commission received and referral rewards stay separate', () => {
  const L = (o) => ({ id: Math.random() + '', stage: 'received', homeowner: true, created_at: new Date().toISOString(), ...o });
  const leads = [L({}), L({ stage: 'contacted', first_contacted_at: 'x' }), L({ stage: 'contacted', homeowner: false, first_contacted_at: 'x' }), L({ stage: 'appointment_set', first_contacted_at: 'x' }), L({ stage: 'installed', first_contacted_at: 'x', commission_cents: 800000, commission_collected_cents: 200000, system_kw: 8 }), L({ stage: 'invalid' }), L({ duplicate_of: 'z' })];
  const partners = [{ id: 'p', split_percent: 25 }];
  leads.forEach((l) => (l.partner_id = 'p'));
  const s = W().buildSummary({ leads, rewards: [{ status: 'reward_pending', amount_cents: 100000 }, { status: 'paid', amount_cents: 100000 }, { status: 'tracking', amount_cents: 0 }], ad_spend: [{ amount_cents: 60000 }, { amount_cents: 15000 }], partners, tiers: [], expenses: [{ amount_cents: 5000 }] });
  const e = s.economics;
  assert.equal(e.counts.leads, 5);                // duplicate and invalid excluded
  assert.equal(e.counts.qualified, 3);            // contacted, appointment, installed; the renter is not qualified
  assert.equal(e.counts.installed, 1);
  assert.equal(e.adSpendCents, 75000); assert.equal(e.opexCents, 5000);
  assert.equal(e.costPer.leadCents, 15000); assert.equal(e.costPer.qualifiedLeadCents, 25000); assert.equal(e.costPer.installationCents, 75000);
  assert.equal(e.referralRewardsPaidCents, 100000); assert.equal(e.referralRewardsOwedCents, 100000);
  assert.equal(e.commissionReceivedCents, 200000);
  assert.equal(e.netRealisedCents, 200000 - 75000 - 5000 - 100000);          // paid reward is a cost; the pending one is not yet
  assert.equal(e.netIfSettledCents, e.netRealisedCents + e.commissionOwedCents - 100000);
  assert.equal(e.termsSet, true);
});

// ---------- admin endpoints ----------
test('owner dashboard exposes funnel and economics; expenses are owner-only', async () => {
  db().reset();
  assert.equal((await call('../api/admin', mk('POST', { body: { action: 'add_expense', month: '2026-11', amount_dollars: 25 } }))).code, 401);
  assert.equal((await call('../api/admin', mk('POST', { headers: { authorization: 'Bearer wp_notadmin' }, body: { action: 'add_expense', month: '2026-11', amount_dollars: 25 } }))).code, 401);
  assert.equal((await call('../api/admin', mk('POST', { headers: A, body: { action: 'add_expense', month: 'bad', amount_dollars: 25 } }))).code, 400);
  const add = await call('../api/admin', mk('POST', { headers: A, body: { action: 'add_expense', month: '2026-11', amount_dollars: 25, category: 'Supabase' } }));
  assert.equal(add.code, 201);
  const g = await call('../api/admin', mk('GET', { headers: A }));
  assert.equal(g.payload.economics.opexCents, 2500);
  assert.ok(g.payload.visitor_funnel && Array.isArray(g.payload.visitor_funnel.steps));
  assert.equal((await call('../api/admin', mk('POST', { headers: A, body: { action: 'delete_expense', id: add.payload.id } }))).code, 200);
  assert.equal((await call('../api/admin', mk('GET', { headers: A }))).payload.economics.opexCents, 0);
});

// ---------- the funnel page itself ----------
test('funnel copy: no invented statistics, testimonials or ratings', () => {
  for (const bad of ['14,200', '$2.1M', '4.9 ★', '4.9★', 'Customer satisfaction', '$1,840', 'saving up to $2,200', 'Maria Johnson', 'Tom Reynolds', 'Sara Kim', 'Referral rewards paid', "I saved $"]) assert.ok(!FUNNEL.includes(bad), 'found: ' + bad);
});

test('funnel copy: no claim that the 30% federal homeowner credit applies', () => {
  assert.ok(!/30%\s*(federal|fed\.|ITC)/i.test(visible), 'visible 30% credit claim');
  assert.ok(!/Full 30% ITC|Claim the ITC|ITC Est|After 30% federal/i.test(FUNNEL));
  assert.match(visible, /ended for systems purchased after December 31, 2025/);
  assert.ok(/const credit = 0;/.test(FUNNEL), 'estimate must not apply a credit');
});

test('funnel copy: internal lead scoring is never shown to the visitor', () => {
  assert.ok(!/HOT 🔴|WARM 🟡|COOL 🔵/.test(FUNNEL));
  assert.ok(!/Score: \$\{lead\.qualScore\}/.test(FUNNEL));
});

test('funnel copy: no contradiction about calls, and the referral reward is described once, accurately', () => {
  assert.ok(!/No calls, no reps/i.test(FUNNEL) && !/never requires a cold call/i.test(FUNNEL) && !/Zero calls/i.test(FUNNEL));
  assert.ok(!/(friend submits, estimates, or installs|Earn \$1,000 per referral|\+\$1,000<)/i.test(FUNNEL));
  assert.match(visible, /verified qualifying solar installation/);
  assert.match(FUNNEL, /Disclosure: I may receive a reward/);
});

test('funnel: required verification and consent are intact, and the reason for asking is explained', () => {
  for (const id of ['inp-bill', 'inp-provider', 'inp-meter', 'inp-consent', 'consentText']) assert.ok(FUNNEL.includes(`id="${id}"`), id + ' missing');
  assert.match(FUNNEL, /Please upload a recent bill, or enter your electric provider and meter number\./);
  assert.match(FUNNEL, /Enter your meter number along with your electric provider\./);
  assert.match(visible, /Why we ask:/); assert.match(visible, /not sent to advertisers or ad platforms/);
  assert.ok(FUNNEL.indexOf('id="fs5"') < FUNNEL.indexOf('id="fs6"'));          // contact + consent first, then verification
  assert.ok(FUNNEL.indexOf('id="fs1"') < FUNNEL.indexOf('id="fs2"') && /STEP_POS = \{ 2:1, 3:2, 4:3, 1:4, 5:5, 6:6 \}/.test(FUNNEL));   // address is step 4, never first
});

test('funnel: the roof question really is optional', () => {
  assert.ok(!/id="btn-roof" disabled/.test(FUNNEL));
});

test('funnel: footer legal links point at real pages, each marked as a draft pending attorney review', () => {
  assert.ok(!/<a href="#">(Privacy|Terms|Referral|TCPA)/.test(FUNNEL));
  for (const f of ['privacy', 'terms', 'referral-terms', 'contact-consent']) {
    assert.ok(FUNNEL.includes(`/legal/${f}.html`), f + ' not linked');
    const t = fs.readFileSync(path.join(__dirname, '..', 'legal', f + '.html'), 'utf8');
    assert.match(t, /DRAFT: not yet reviewed by an attorney/); assert.match(t, /noindex/);
  }
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'legal', 'referral-terms.html'), 'utf8'), /one \$1,000 reward/);
});

test('funnel analytics: first-party only, no ad pixels, privacy signals respected', () => {
  assert.ok(!/connect\.facebook\.net|fbq\(|googletagmanager|google-analytics|gtag\(|ads\/ga-audiences|snap\.licdn|tiktok/i.test(FUNNEL), 'ad or third-party tracker found');
  assert.match(FUNNEL, /globalPrivacyControl/); assert.match(FUNNEL, /doNotTrack/);
  assert.match(FUNNEL, /fetch\('\/api\/event'/);
  // nothing the visitor types is passed to the tracker
  const trackCalls = FUNNEL.match(/WWT\.track\([^)]*\)/g) || [];
  assert.ok(trackCalls.length >= 10);
  assert.ok(!trackCalls.some((c) => /lead\.(email|phone|address|meter|provider|firstName|lastName|zip)/.test(c)));
});
