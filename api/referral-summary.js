function clean(value, max = 250) {
  return String(value ?? '').trim().slice(0, max);
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const code = clean(req.query && req.query.code, 40).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!code || code.length < 4) return res.status(400).json({ error: 'Enter a valid referral code.' });

  const webhook = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  const secret = process.env.WATTWORTH_WEBHOOK_SECRET;
  if (!webhook || !secret) return res.status(503).json({ error: 'Referral dashboard is not configured yet.' });

  try {
    const target = new URL(webhook);
    target.searchParams.set('secret', secret);
    target.searchParams.set('action', 'referral-summary');
    target.searchParams.set('code', code);
    const response = await fetch(target);
    const summary = await response.json().catch(() => ({}));
    if (!response.ok || !summary.ok) throw new Error(summary.error || 'Referral lookup failed');
    return res.status(200).json({
      ok: true,
      referralCode: summary.referralCode,
      counts: summary.counts || { total: 0, pending: 0, qualified: 0, completed: 0 }
    });
  } catch (error) {
    console.error('referral_lookup_failed', { message: error.message, code });
    return res.status(502).json({ error: 'We could not load that referral dashboard. Please try again.' });
  }
};
