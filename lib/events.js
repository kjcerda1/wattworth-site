/* First-party, consent-aware funnel analytics.
   What is stored: an anonymous per-tab-session id, an allowlisted event name, the funnel step number, campaign (UTM) tags,
   the referring HOST, a device class and a few allowlisted values. What is never stored or accepted: names, phones, emails,
   addresses, ZIPs, meter numbers, provider names, bill data, referral codes, IP addresses, or free text.
   Nothing here is sent to an advertising platform. */
const db = require('./db');

const EVENTS = new Set(['landing_view', 'cta_click', 'funnel_start', 'step_view', 'verify_method', 'submit_attempt', 'submit_success', 'submit_error', 'referral_view', 'tracker_open', 'abandon']);
const STEPS = { 2: 1, 3: 2, 4: 3, 1: 4, 5: 5, 6: 6 };   // funnel DOM step -> position (bill, ownership, roof, address, details, verify)
const STEP_LABELS = ['Monthly bill', 'Ownership', 'Roof', 'Address', 'Contact + consent', 'Verify account'];
const METHODS = new Set(['bill', 'meter', 'both']);
const ERRORS = new Set(['contact', 'verify', 'network', 'rate_limit', 'server', 'other']);
const CTAS = new Set(['hero', 'nav', 'estimate', 'plans', 'referral', 'footer']);
const DEVICES = new Set(['mobile', 'tablet', 'desktop']);
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const CLICK_IDS = ['gclid', 'fbclid', 'msclkid'];
const RATE_PER_MIN = 120, MAX_BATCH = 25;
const hits = new Map();

const tag = (v, n = 80) => { const s = String(v == null ? '' : v).trim().slice(0, n); return /^[A-Za-z0-9 _.\-+:/%]*$/.test(s) ? s : ''; };

/** Campaign tags only, from an untrusted object. Used for analytics AND for the lead's stored attribution. */
function cleanUtm(u) {
  if (!u || typeof u !== 'object') return null;
  const out = {};
  for (const k of UTM_KEYS) { const v = tag(u[k]); if (v) out[k] = v; }
  for (const k of CLICK_IDS) { const v = String(u[k] || '').slice(0, 120); if (v && /^[A-Za-z0-9_\-.]+$/.test(v)) out[k] = v; }
  return Object.keys(out).length ? out : null;
}

function normalize(e) {
  if (!e || typeof e !== 'object' || !EVENTS.has(e.event)) return null;
  const vid = String(e.vid || '');
  if (!/^[a-z0-9]{8,32}$/.test(vid)) return null;
  const step = e.step == null ? null : Number(e.step);
  if (step != null && !(Number.isInteger(step) && step >= 1 && step <= 6)) return null;
  const u = cleanUtm(e.utm) || {};
  const props = {};
  if (METHODS.has(e.method)) props.method = e.method;
  if (ERRORS.has(e.error)) props.error = e.error;
  if (CTAS.has(e.cta)) props.cta = e.cta;
  if (e.has_ref === true) props.has_ref = true;
  const host = String(e.ref_host || '').toLowerCase().slice(0, 80);
  return {
    visitor_id: vid, event: e.event, step,
    utm_source: u.utm_source || null, utm_medium: u.utm_medium || null, utm_campaign: u.utm_campaign || null, utm_content: u.utm_content || null,
    ref_host: /^[a-z0-9.\-]+$/.test(host) ? host : null,
    device: DEVICES.has(e.device) ? e.device : null,
    props: Object.keys(props).length ? props : null,
  };
}

/** Accepts a batch. Returns how many were stored. Honors Global Privacy Control / Do Not Track even if the browser sent them. */
async function record(batch, ctx = {}) {
  if (ctx.optOut) return { stored: 0, skipped: 'opt_out' };
  const list = (Array.isArray(batch) ? batch : []).slice(0, MAX_BATCH);
  if (ctx.ip) {
    const now = Date.now(), h = (hits.get(ctx.ip) || []).filter((t) => now - t < 60000);
    if (h.length + list.length > RATE_PER_MIN) { hits.set(ctx.ip, h); return { stored: 0, skipped: 'rate_limit' }; }
    h.push(...list.map(() => now)); hits.set(ctx.ip, h);
    if (hits.size > 5000) hits.clear();
  }
  const rows = list.map(normalize).filter(Boolean);
  for (const r of rows) await db.insert('funnel_events', r);
  return { stored: rows.length };
}

const RETENTION_DAYS = 180;
const purge = (now = Date.now()) => db.purgeBefore('funnel_events', 'created_at', new Date(now - RETENTION_DAYS * 864e5).toISOString());

/** Visitor funnel + campaign table. `leads` are real (non-duplicate) leads; campaign tags come from the lead's stored utm. */
function report(events, leads, since) {
  const ev = events.filter((e) => !since || e.created_at >= since);
  const by = (k) => { const m = new Map(); ev.forEach((e) => { if (e.event === k) m.set(e.visitor_id, e); }); return m; };
  const visitors = new Set(ev.filter((e) => e.event === 'landing_view').map((e) => e.visitor_id));
  const started = new Set(ev.filter((e) => e.event === 'funnel_start').map((e) => e.visitor_id));
  const stepSets = [1, 2, 3, 4, 5, 6].map((n) => new Set(ev.filter((e) => e.event === 'step_view' && e.step === n).map((e) => e.visitor_id)));
  const submitted = new Set(ev.filter((e) => e.event === 'submit_success').map((e) => e.visitor_id));
  const steps = stepSets.map((s, i) => ({
    step: i + 1, label: STEP_LABELS[i], reached: s.size,
    pctOfStarts: started.size ? Math.round(s.size / started.size * 100) : null,
    droppedBefore: i === 0 ? Math.max(0, started.size - s.size) : Math.max(0, stepSets[i - 1].size - s.size),
  }));
  const verifyChoice = { bill: 0, meter: 0, both: 0 };
  const seen = new Set();
  ev.filter((e) => e.event === 'verify_method' && e.props && e.props.method).forEach((e) => { if (!seen.has(e.visitor_id + e.props.method)) { seen.add(e.visitor_id + e.props.method); verifyChoice[e.props.method]++; } });
  const errors = {};
  ev.filter((e) => e.event === 'submit_error').forEach((e) => { const k = (e.props && e.props.error) || 'other'; errors[k] = (errors[k] || 0) + 1; });

  // Per campaign: visitors/starts/submits from events; lead outcomes from leads (the source of truth for what happened next).
  const key = (src, cmp) => `${src || 'direct'}||${cmp || ''}`;
  const rows = new Map();
  const row = (src, cmp) => { const k = key(src, cmp); if (!rows.has(k)) rows.set(k, { source: src || 'direct', campaign: cmp || '', visitors: 0, starts: 0, submits: 0, leads: 0, contacted: 0, appointments: 0, signed: 0, installed: 0 }); return rows.get(k); };
  const firstEv = new Map();
  ev.forEach((e) => { if (!firstEv.has(e.visitor_id)) firstEv.set(e.visitor_id, e); });
  firstEv.forEach((e, vid) => {
    const r = row(e.utm_source, e.utm_campaign);
    if (visitors.has(vid)) r.visitors++;
    if (started.has(vid)) r.starts++;
    if (submitted.has(vid)) r.submits++;
  });
  leads.filter((l) => !l.duplicate_of && l.stage !== 'invalid' && (!since || l.created_at >= since)).forEach((l) => {
    const u = l.utm || {}; const r = row(u.utm_source || (l.source ? null : null), u.utm_campaign); r.leads++;
    if (l.first_contacted_at || ['contacted', 'appointment_set', 'proposal_sent', 'signed', 'installed'].includes(l.stage)) r.contacted++;
    if (['appointment_set', 'proposal_sent', 'signed', 'installed'].includes(l.stage)) r.appointments++;
    if (['signed', 'installed'].includes(l.stage)) r.signed++;
    if (l.stage === 'installed') r.installed++;
  });
  return {
    visitors: visitors.size, starts: started.size, submitted: submitted.size,
    startRate: visitors.size ? Math.round(started.size / visitors.size * 100) : null,
    completionRate: started.size ? Math.round(submitted.size / started.size * 100) : null,
    steps, verifyChoice, errors,
    campaigns: [...rows.values()].sort((a, b) => b.visitors - a.visitors || b.leads - a.leads).slice(0, 30),
  };
}

module.exports = { record, report, purge, cleanUtm, normalize, EVENTS, STEPS, STEP_LABELS, RETENTION_DAYS };
