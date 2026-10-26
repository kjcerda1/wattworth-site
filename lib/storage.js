/* Private file storage for electric bills.
   Supabase Storage (PRIVATE bucket `electric-bills`, service role, server-side only) when SUPABASE_* is set,
   otherwise an in-memory store so everything runs locally and in tests.
   Bills are never public: there is no public bucket and no permanent URL. They are read only through the
   server (/api/bill, partner or admin auth) or a short-lived signed URL. */
const BUCKET = process.env.BILL_BUCKET || 'electric-bills';
const URL_ = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY_ = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const live = () => !!(URL_() && KEY_());
const f = (...a) => (globalThis.__wwfetch || fetch)(...a);
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const hdr = (extra) => ({ apikey: KEY_(), Authorization: `Bearer ${KEY_()}`, ...extra });
const mem = () => (globalThis.__wwbills = globalThis.__wwbills || new Map());

async function putBill(path, buf, mime) {
  if (!live()) { mem().set(path, { buf: Buffer.from(buf), mime }); return true; }
  const res = await f(`${URL_()}/storage/v1/object/${BUCKET}/${enc(path)}`, { method: 'POST', headers: hdr({ 'Content-Type': mime, 'x-upsert': 'false', 'Cache-Control': 'private, max-age=0' }), body: buf });
  if (!res.ok) throw new Error('storage upload failed: ' + res.status);
  return true;
}
async function getBill(path) {
  if (!live()) { const o = mem().get(path); return o ? { buf: o.buf, mime: o.mime } : null; }
  const res = await f(`${URL_()}/storage/v1/object/authenticated/${BUCKET}/${enc(path)}`, { headers: hdr() });
  if (!res.ok) return null;
  return { buf: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') || 'application/octet-stream' };
}
/** Short-lived signed URL (default 60 s, max 5 min). Returns null in memory mode. */
async function signedUrl(path, seconds = 60) {
  if (!live()) return null;
  const res = await f(`${URL_()}/storage/v1/object/sign/${BUCKET}/${enc(path)}`, { method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn: Math.min(Math.max(1, seconds | 0), 300) }) });
  if (!res.ok) return null;
  const j = await res.json();
  return j.signedURL ? `${URL_()}/storage/v1${j.signedURL}` : null;
}
async function removeBill(path) {
  if (!path) return;
  if (!live()) { mem().delete(path); return; }
  try { await f(`${URL_()}/storage/v1/object/${BUCKET}/${enc(path)}`, { method: 'DELETE', headers: hdr() }); } catch (_) {}
}
module.exports = { BUCKET, putBill, getBill, signedUrl, removeBill };
