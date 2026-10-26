// Customer portal API (auth: Bearer wc_<private token>, sent only to the customer).
//   GET  /api/portal                  -> everything the customer app renders
//   POST /api/portal {action, ...}    -> message | read | confirm_contact | subscribe | unsubscribe | delete_request
const db = require('../lib/db');
const { route, body, deny } = require('../lib/http');
const { HttpError, event } = require('../lib/leads');
const { alertOwner } = require('../lib/alerts');
const P = require('../lib/portal');

module.exports = route(async (req, res) => {
  const lead = await P.customerFrom(req);
  if (!lead) return deny(res);

  if (req.method === 'GET') return res.json(await P.customerView(lead));
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const b = body(req);

  switch (b.action) {
    case 'message': {
      await P.customerSend(lead, b.body);
      return res.status(201).json(await P.customerView(lead));
    }
    case 'read': {
      const now = new Date().toISOString();
      for (const m of await db.select('messages', { where: { lead_id: lead.id, sender: 'partner', read_by_customer_at: null } })) await db.update('messages', { id: m.id }, { read_by_customer_at: now });
      return res.json({ ok: true });
    }
    case 'confirm_contact': {
      if (!['yes', 'no'].includes(b.answer)) throw new HttpError(400, 'answer must be yes or no');
      await db.update('leads', { id: lead.id }, { contact_confirmed: b.answer, contact_confirmed_at: new Date().toISOString() });
      await event(lead.id, 'confirm', 'customer', null, b.answer, null);
      if (b.answer === 'no') await alertOwner({ key: `noconfirm:${lead.id}`, subject: `Customer says they were not reached: ${lead.ref}`, lines: [`${lead.first_name} ${lead.last_name || ''} (${lead.ref}) answered No to "Has your specialist reached you?".`, 'Your partner marked this lead as contacted. It may be worth a check-in.'] });
      return res.json({ ok: true });
    }
    case 'subscribe': {
      const s = b.subscription || {};
      if (!s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth || String(s.endpoint).length > 1000 || !/^https:\/\//.test(s.endpoint)) throw new HttpError(400, 'invalid subscription');
      const existing = await db.get('push_subscriptions', { endpoint: s.endpoint });
      if (existing) await db.update('push_subscriptions', { id: existing.id }, { lead_id: lead.id, p256dh: s.keys.p256dh, auth: s.keys.auth, failures: 0 });
      else await db.insert('push_subscriptions', { lead_id: lead.id, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, failures: 0 });
      // Confirm it works: a welcome notification straight to this device
      try { const who = lead.partner_id ? (await db.get('partners', { id: lead.partner_id })) : null; await P.sendPush({ endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth }, { title: 'Notifications are on', body: `We will let you know when ${who ? who.name : 'your solar specialist'} updates your project.`, tag: 'welcome', url: '/portal/' }); } catch (_) {}
      return res.status(201).json({ ok: true });
    }
    case 'unsubscribe': {
      if (b.endpoint) await db.remove('push_subscriptions', { endpoint: String(b.endpoint) });
      return res.json({ ok: true });
    }
    case 'delete_request': {
      await db.update('leads', { id: lead.id }, { deletion_requested_at: new Date().toISOString() });
      await event(lead.id, 'privacy', 'customer', null, 'deletion_requested', null);
      await alertOwner({ key: `erase:${lead.id}`, subject: `Data deletion requested: ${lead.ref}`, lines: [`${lead.first_name} ${lead.last_name || ''} (${lead.ref}) asked to delete their data.`, 'Open the Partners tab in your dashboard to review and erase it.'] });
      return res.json({ ok: true });
    }
    default:
      throw new HttpError(400, 'unknown action');
  }
});
