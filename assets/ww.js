/* Shared client: API wrapper, helpers, and a localStorage mock so both dashboards run without a backend.
   Enter the access key "demo" on either sign-in screen to use mock data. */
window.App = (function () {
  const W = window.WW;
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
  };
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function ago(iso) {
    const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (m < 1) return 'just now'; if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60); if (h < 48) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }
  const date = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
  const when = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const name = (l) => [l.first_name, l.last_name].filter(Boolean).join(' ');
  const phone = (p) => (p || '').replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
  const usd = (n) => (n == null ? '' : '$' + Number(n).toLocaleString('en-US'));

  let toastTimer;
  function toast(msg, err) {
    let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.className = 'toast on' + (err ? ' err' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = 'toast'), 2600);
  }

  // ---------- mock backend (demo mode) ----------
  const MK = 'ww_mock_v5';
  function seed() {
    const h = 3600000, now = Date.now(), iso = (ago_h) => new Date(now - ago_h * h).toISOString();
    const L = (i, f, l, city, bill, stage, hrs, extra = {}) => ({ id: 'd' + i, ref: 'WW-DEMO' + i + 'A', partner_id: 'p1', first_name: f, last_name: l, phone: '+1512555010' + i, email: f.toLowerCase() + '@example.com', address: i + '12 Oak Lane', city, state: 'TX', zip: '787' + i + '1', monthly_bill: bill, homeowner: true, notes: i === 1 ? 'Prefers calls after 5pm' : null, stage, system_kw: null, contract_value: null, source: '/solar', utm: { utm_source: ['facebook', 'google', 'facebook'][i % 3] }, created_at: iso(hrs), first_contacted_at: stage === 'received' ? null : iso(hrs - 2), signed_at: null, installed_at: null, fee_paid_at: null, commission_cents: null, commission_collected_cents: 0, lost_reason: null, referrer_code: null, ...extra });
    const leads = [
      L(1, 'Dana', 'Reyes', 'Austin', 240, 'received', 31), L(2, 'Marcus', 'Bell', 'Round Rock', 310, 'contacted', 50, { messages: [{ from: 'customer', body: 'Hi Pedro, is Thursday after 5 okay for the consultation?', via: 'portal', at: iso(3), unread: true }], unread: 1 }),
      L(3, 'Priya', 'Shah', 'Cedar Park', 275, 'appointment_set', 80), L(4, 'Tom', 'Greer', 'Pflugerville', 190, 'proposal_sent', 120, { system_kw: 8.2 }),
      L(5, 'Lena', 'Ortiz', 'Austin', 350, 'signed', 240, { system_kw: 9.6, contract_value: 31200, signed_at: iso(60), commission_cents: 360000, referrer_code: 'JANE50', referrer_name: 'Jane M.' }),
      L(6, 'Cole', 'Nguyen', 'Georgetown', 220, 'installed', 500, { system_kw: 6.4, contract_value: 21800, signed_at: iso(300), installed_at: iso(40), commission_cents: 420000, commission_collected_cents: 50400 }),
      L(7, 'Amy', 'Park', 'Leander', 160, 'lost', 90, { lost_reason: 'Renting' }), L(8, 'Joe', 'Silva', 'Austin', 260, 'received', 3),
      L(9, 'Ray', 'Cole', 'Austin', 140, 'invalid', 60, { invalid_reason: 'Wrong number', dispute_status: 'pending' }),
    ];
    return {
      leads, deliveries: leads.flatMap((l) => ['email', 'sms'].map((c, j) => ({ id: l.id + c, lead_id: l.id, partner_id: 'p1', channel: c, status: l.id === 'd8' && c === 'sms' ? 'failed' : 'sent', attempts: 1, last_error: l.id === 'd8' && c === 'sms' ? 'Twilio 400: invalid number' : null, created_at: l.created_at, lead_ref: l.ref, lead_name: l.first_name, partner_name: 'Demo Partner' }))),
      rewards: [{ id: 'y1', lead_id: 'd5', lead_ref: 'WW-DEMO5A', referrer_code: 'JANE50', amount_cents: 100000, status: 'installation_confirmed', installation_confirmed_at: iso(24), reward_pending_at: null, paid_at: null, transaction_ref: null }],
      tiers: [{ id: 't1', label: 'Small system', min_kw: 0, max_kw: 7, fee_cents: null }, { id: 't2', label: 'Mid system', min_kw: 7, max_kw: 11, fee_cents: null }, { id: 't3', label: 'Large system', min_kw: 11, max_kw: null, fee_cents: null }],
      partners: [{ id: 'p1', name: 'Demo Partner', company: 'Demo Solar Co.', email: 'partner@example.com', phone: '+15125550199', webhook_url: null, is_default: true, active: true, fee_mode: 'split', split_percent: 30, ads_paid_by: 'partner' }],
      events: [], ad_spend: [{ id: 's1', month: new Date().toISOString().slice(0, 7), source: 'Meta', amount_cents: 45000 }],
    };
  }
  const mdb = () => { try { const v = JSON.parse(ls.get(MK)); if (v) return v; } catch (_) {} const s = seed(); ls.set(MK, JSON.stringify(s)); return s; };
  const msave = (d) => ls.set(MK, JSON.stringify(d));

  function mock(role, path, opts) {
    const d = mdb(); const body = opts && opts.body ? JSON.parse(opts.body) : {}; const m = (opts && opts.method) || 'GET';
    const hist = (id) => d.events.filter((e) => e.lead_id === id).map((e) => ({ type: e.type, actor: e.actor, from: e.from, to: e.to, note: e.note, at: e.at })).reverse();
    if (role === 'partner') {
      if (m === 'GET') return { partner: { name: 'Demo Partner', company: 'Demo Solar Co.' }, terms: { mode: 'split', owner_percent: (d.partners[0] || {}).split_percent == null ? null : d.partners[0].split_percent }, leads: d.leads.map((l) => ({ ...l, history: hist(l.id) })) };
      const l = d.leads.find((x) => x.id === body.lead_id); if (!l) throw { status: 404 };
      if (body.stage && body.stage !== l.stage) {
        d.events.push({ lead_id: l.id, type: 'stage', actor: 'partner:Demo', from: l.stage, to: body.stage, note: body.note || null, at: new Date().toISOString() });
        l.stage = body.stage; l.first_contacted_at = l.first_contacted_at || new Date().toISOString();
        if (body.stage === 'signed') l.signed_at = l.signed_at || new Date().toISOString();
        if (body.stage === 'installed') l.installed_at = new Date().toISOString();
      } else if (body.note) d.events.push({ lead_id: l.id, type: 'note', actor: 'partner:Demo', note: body.note, at: new Date().toISOString() });
      if ('system_kw' in body) l.system_kw = body.system_kw === '' ? null : Number(body.system_kw);
      if ('contract_value' in body) l.contract_value = body.contract_value === '' ? null : Number(body.contract_value);
      if ('commission_dollars' in body) { const c = body.commission_dollars === '' ? null : Math.round(Number(body.commission_dollars) * 100); if (c !== null && !(c >= 0)) throw { status: 400, message: 'Commission must be 0 or more.' }; if (c !== l.commission_cents) { d.events.push({ lead_id: l.id, type: 'commission', actor: 'partner:Demo', from: l.commission_cents == null ? null : String(l.commission_cents / 100), to: c == null ? null : String(c / 100), at: new Date().toISOString() }); l.commission_cents = c; } }
      if (body.read) { l.unread = 0; (l.messages || []).forEach((m) => (m.unread = false)); }
      if (body.message) { l.messages = l.messages || []; l.messages.push({ from: 'partner', body: body.message, via: 'dashboard', at: new Date().toISOString(), unread: false }); }
      if ('appointment_at' in body) l.appointment_at = body.appointment_at || null;
      if (body.lost_reason) l.lost_reason = body.lost_reason;
      if (body.stage === 'invalid') { if (!body.invalid_reason || body.invalid_reason.length < 3) throw { status: 400, message: 'Tell us why the lead is invalid.' }; l.invalid_reason = body.invalid_reason; l.dispute_status = 'pending'; }
      msave(d); return { ok: true, lead: l };
    }
    if (m === 'GET') {
      const s = W.buildSummary({ leads: d.leads, deliveries: d.deliveries, rewards: d.rewards, tiers: d.tiers, ad_spend: d.ad_spend || [], partners: d.partners });
      return { mode: 'demo', setup: {}, ad_spend: d.ad_spend || [], config: { feeTrigger: W.FEE_TRIGGER, stages: W.STAGES }, ...s, leads: d.leads.map((l) => ({ ...l, partner_name: 'Demo Partner', fee: l.fee || W.feeFor(l, d.tiers, undefined, d.partners.find((p) => p.id === l.partner_id)) })), deliveries: d.deliveries, rewards: d.rewards.map((p) => ({ ...p, stage: (d.leads.find((l) => l.id === p.lead_id) || {}).stage })), tiers: d.tiers, partners: d.partners, events: d.events.slice().reverse().slice(0, 30).map((e) => ({ ...e, created_at: e.at, lead_ref: (d.leads.find((l) => l.id === e.lead_id) || {}).ref })) };
    }
    if (body.action === 'resolve_dispute') { const l = d.leads.find((x) => x.id === body.lead_id); if (body.accept) { l.dispute_status = 'accepted'; } else { l.stage = 'contacted'; l.dispute_status = 'rejected'; } }
    if (body.action === 'add_spend') { d.ad_spend = d.ad_spend || []; d.ad_spend.unshift({ id: 's' + Date.now(), month: body.month, source: body.source || null, amount_cents: Math.round(Number(body.amount_dollars) * 100) }); }
    if (body.action === 'delete_spend') d.ad_spend = (d.ad_spend || []).filter((x) => x.id !== body.id);
    if (body.action === 'fee_paid') { const l = d.leads.find((x) => x.id === body.lead_id); const f = W.feeFor(l, d.tiers, undefined, d.partners.find((p) => p.id === l.partner_id)); l.fee_paid_at = body.paid === false ? null : new Date().toISOString(); l.commission_collected_cents = body.paid === false ? 0 : (f.share_cents != null ? f.share_cents : l.commission_collected_cents || 0); }
    if (body.action === 'record_payment') { const l = d.leads.find((x) => x.id === body.lead_id); const amt = Math.round(Number(body.amount_dollars) * 100); if (!(amt > 0)) throw { status: 400, message: 'Enter the dollar amount you received' }; l.commission_collected_cents = (l.commission_collected_cents || 0) + amt; if (W.feeFor(l, d.tiers, undefined, d.partners.find((p) => p.id === l.partner_id)).state === 'paid') l.fee_paid_at = new Date().toISOString(); }
    if (body.action === 'update_partner') { const p = d.partners.find((x) => x.id === body.partner_id); if ('split_percent' in body) { const n = body.split_percent === '' ? null : Number(body.split_percent); if (n !== null && !(n >= 0 && n <= 100)) throw { status: 400, message: 'Your share must be between 0 and 100 percent' }; p.split_percent = n; } if ('ads_paid_by' in body) p.ads_paid_by = body.ads_paid_by || null; if ('public_phone' in body) p.public_phone = String(body.public_phone || '').replace(/\D/g, '') ? '+1' + String(body.public_phone).replace(/\D/g, '').slice(-10) : null; if ('is_default' in body) p.is_default = !!body.is_default; if ('active' in body) p.active = !!body.active; }
    if (body.action === 'reward_verify') { const p = d.rewards.find((x) => x.id === body.reward_id); if (p.status !== 'installation_confirmed') throw { status: 409, message: 'The installation has not been reported yet' }; p.status = 'reward_pending'; p.reward_pending_at = new Date().toISOString(); }
    if (body.action === 'reward_paid') { const p = d.rewards.find((x) => x.id === body.reward_id); if (p.status !== 'reward_pending') throw { status: 409, message: 'Verify the installation before recording a payment' }; if (!String(body.transaction_ref || '').trim()) throw { status: 400, message: 'Enter a payment reference' }; p.status = 'paid'; p.paid_at = new Date().toISOString(); p.transaction_ref = String(body.transaction_ref).trim(); }
    if (body.action === 'reward_ineligible') { const p = d.rewards.find((x) => x.id === body.reward_id); if (p.status !== 'paid') p.status = 'ineligible'; }
    if (body.action === 'set_tiers') body.tiers.forEach((t) => { const x = d.tiers.find((y) => y.id === t.id); x.fee_cents = t.fee_dollars === '' || t.fee_dollars == null ? null : Math.round(Number(t.fee_dollars) * 100); });
    if (body.action === 'resend') { const x = d.deliveries.find((y) => y.id === body.delivery_id); x.status = 'sent'; x.last_error = null; x.attempts++; }
    if (body.action === 'erase_lead') { d.leads = d.leads.filter((l) => l.id !== body.lead_id); msave(d); return { ok: true }; }
    if (body.action === 'rotate_key' || body.action === 'create_partner') { msave(d); return { ok: true, access_key: 'wp_demo_' + Math.random().toString(16).slice(2, 14), webhook_secret: null }; }
    msave(d); return { ok: true };
  }

  async function api(role, path, opts = {}) {
    const token = ls.get('ww_' + role + '_token');
    if (!token) throw { status: 401 };
    if (token === 'demo') return mock(role, path, opts);
    let res;
    try {
      res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
    } catch (_) { throw { status: 0, message: 'You appear to be offline.' }; }
    if (res.status === 401) { ls.del('ww_' + role + '_token'); throw { status: 401 }; }
    const j = res.headers.get('content-type') && res.headers.get('content-type').includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw { status: res.status, message: (j && j.error) || 'Something went wrong' };
    return j;
  }
  async function download(role, path, filename) {
    const token = ls.get('ww_' + role + '_token');
    if (token === 'demo') return toast('Export is disabled in demo mode', true);
    const res = await fetch(path, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return toast('Export failed', true);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // Opens a customer's electric bill. Fetched with the dashboard's own credentials; there is no public link to it.
  async function viewBill(role, leadId) {
    const token = ls.get('ww_' + role + '_token');
    if (token === 'demo') return toast('Bills are not available in demo mode', true);
    const w = window.open('', '_blank');
    try {
      const res = await fetch('/api/bill?lead_id=' + encodeURIComponent(leadId), { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) { if (w) w.close(); const j = await res.json().catch(() => ({})); return toast(j.error || 'Could not open the bill', true); }
      const url = URL.createObjectURL(await res.blob());
      if (w) w.location = url; else window.location = url;
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (_) { if (w) w.close(); toast('Could not open the bill', true); }
  }

  return { ls, $, esc, ago, date, when, name, phone, usd, toast, api, download, viewBill, W };
})();
