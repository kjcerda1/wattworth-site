// Bills must only ever touch a PRIVATE bucket through authenticated, server-side calls.
const test = require('node:test');
const assert = require('node:assert');
process.env.SUPABASE_URL = 'https://proj.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
const seen = [];
globalThis.__wwfetch = async (url, opts = {}) => {
  seen.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
  if (url.includes('/object/sign/')) return { ok: true, status: 200, json: async () => ({ signedURL: '/object/sign/electric-bills/bills/x.pdf?token=abc' }) };
  if (url.includes('/object/authenticated/')) return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('%PDF-1.4 %%EOF'), headers: { get: () => 'application/pdf' } };
  return { ok: true, status: 200, json: async () => ({}) };
};
const storage = require('../lib/storage');

test('upload, read, sign and delete use the private bucket with the service role only', async () => {
  await storage.putBill('bills/2026/10/abc.pdf', Buffer.from('%PDF-1.4 %%EOF'), 'application/pdf');
  const f = await storage.getBill('bills/2026/10/abc.pdf');
  assert.equal(f.mime, 'application/pdf');
  const u = await storage.signedUrl('bills/x.pdf', 9999);
  await storage.removeBill('bills/2026/10/abc.pdf');
  assert.equal(storage.BUCKET, 'electric-bills');
  assert.match(u, /^https:\/\/proj\.supabase\.co\/storage\/v1\/object\/sign\/electric-bills\/.+token=/);
  assert.equal(JSON.parse(seen.find((s) => s.url.includes('/sign/')).body).expiresIn, 300, 'signed links are capped at 5 minutes');
  for (const s of seen) {
    assert.ok(!s.url.includes('/object/public/'), 'never a public URL');
    assert.equal(s.headers.Authorization, 'Bearer service-role-test');
  }
});
