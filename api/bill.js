// GET /api/bill?lead_id=ID[&signed=1]  — protected access to a customer's uploaded electric bill.
// Auth: owner ADMIN_TOKEN, or the partner the lead was sent to. Customers never get this.
// Default: the server streams the file. With signed=1 (Supabase only) it returns a 60-second signed URL instead.
const db = require('../lib/db');
const storage = require('../lib/storage');
const { route, deny } = require('../lib/http');
const { isAdmin, partnerFrom } = require('../lib/auth');
const { HttpError, event } = require('../lib/leads');

module.exports = route(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const admin = isAdmin(req);
  const partner = admin ? null : await partnerFrom(req);
  if (!admin && !partner) return deny(res);
  const lead = await db.get('leads', { id: String((req.query || {}).lead_id || '') });
  if (!lead || (!admin && lead.partner_id !== partner.id) || !lead.bill_storage_path) throw new HttpError(404, 'No bill on file for this lead');
  await event(lead.id, 'bill_view', admin ? 'admin' : 'partner:' + partner.name, null, null, null);
  if ((req.query || {}).signed === '1') {
    const url = await storage.signedUrl(lead.bill_storage_path, 60);
    if (!url) throw new HttpError(409, 'Signed links need Supabase Storage; use the direct download');
    return res.json({ url, expires_in: 60, filename: lead.bill_filename });
  }
  const f = await storage.getBill(lead.bill_storage_path);
  if (!f) throw new HttpError(404, 'The bill file is missing from storage');
  res.setHeader('Content-Type', lead.bill_mime_type || f.mime);   // our validated type, not whatever storage reports
  res.setHeader('Content-Disposition', `inline; filename="${String(lead.bill_filename || 'bill').replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.status(200).end(f.buf);
});
