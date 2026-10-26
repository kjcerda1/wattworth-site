/* Data layer. Supabase (PostgREST over fetch, no dependencies) when env is set,
   otherwise an in-memory store (optionally persisted to WW_DB_FILE) so everything runs locally. */
const crypto = require('crypto');
const fs = require('fs');

const URL_ = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY_ = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const live = () => !!(URL_() && KEY_());
const mode = () => (live() ? 'supabase' : 'memory');

// ---------- memory adapter ----------
function mem() {
  if (!globalThis.__wwmem) {
    globalThis.__wwmem = { partners: [], leads: [], deliveries: [], lead_events: [], fee_tiers: [], referral_payouts: [], ad_spend: [], alerts: [] };
    const f = process.env.WW_DB_FILE;
    if (f && fs.existsSync(f)) {
      try { Object.assign(globalThis.__wwmem, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (_) {}
    }
    for (const t of ['ad_spend', 'alerts']) if (!globalThis.__wwmem[t]) globalThis.__wwmem[t] = [];
    if (!globalThis.__wwmem.fee_tiers.length) {
      const now = new Date().toISOString();
      [['Small system', 0, 7], ['Mid system', 7, 11], ['Large system', 11, null]].forEach(([label, a, b]) =>
        globalThis.__wwmem.fee_tiers.push({ id: crypto.randomUUID(), label, min_kw: a, max_kw: b, fee_cents: null, created_at: now, updated_at: now }));
    }
  }
  return globalThis.__wwmem;
}
const persist = () => { const f = process.env.WW_DB_FILE; if (f) fs.writeFileSync(f, JSON.stringify(mem())); };
const matches = (row, where) => Object.entries(where || {}).every(([k, v]) => (v === null ? row[k] == null : row[k] === v));

// ---------- supabase adapter ----------
async function rest(method, table, { where, order, limit, body } = {}) {
  const qs = new URLSearchParams();
  Object.entries(where || {}).forEach(([k, v]) => qs.append(k, v === null ? 'is.null' : 'eq.' + v));
  if (order) qs.append('order', `${order[0]}.${order[1] || 'desc'}`);
  if (limit) qs.append('limit', String(limit));
  const res = await (globalThis.__wwfetch || fetch)(`${URL_()}/rest/v1/${table}?${qs}`, {
    method,
    headers: {
      apikey: KEY_(), Authorization: `Bearer ${KEY_()}`, 'Content-Type': 'application/json',
      Prefer: method === 'GET' ? 'count=none' : 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`db ${method} ${table} ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

// ---------- public API ----------
async function select(table, opts = {}) {
  if (live()) return rest('GET', table, opts);
  let rows = mem()[table].filter((r) => matches(r, opts.where));
  if (opts.order) {
    const [k, dir] = opts.order;
    rows = rows.slice().sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (dir === 'asc' ? 1 : -1));
  }
  if (opts.limit) rows = rows.slice(0, opts.limit);
  return rows.map((r) => ({ ...r }));
}
async function insert(table, row) {
  if (live()) return (await rest('POST', table, { body: row }))[0];
  const now = new Date().toISOString();
  const r = { id: crypto.randomUUID(), created_at: now, updated_at: now, ...row };
  mem()[table].push(r); persist();
  return { ...r };
}
async function update(table, where, patch) {
  const p = { ...patch, updated_at: new Date().toISOString() };
  if (live()) return rest('PATCH', table, { where, body: p });
  const out = [];
  mem()[table].forEach((r) => { if (matches(r, where)) { Object.assign(r, p); out.push({ ...r }); } });
  persist();
  return out;
}
async function remove(table, where) {
  if (!where || !Object.keys(where).length) throw new Error('remove requires a where clause');
  if (live()) return rest('DELETE', table, { where });
  const m = mem(); const before = m[table].length;
  m[table] = m[table].filter((r) => !matches(r, where)); persist();
  return before - m[table].length;
}
const get = async (table, where) => (await select(table, { where, limit: 1 }))[0] || null;
const reset = () => { globalThis.__wwmem = undefined; };

module.exports = { select, insert, update, remove, get, mode, reset };
