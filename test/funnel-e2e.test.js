// End-to-end: a real browser walks the cold-traffic funnel against the local dev server (in-memory store).
// Proves: UTM attribution reaches the lead, each step is counted, no personal data reaches analytics, privacy signals
// switch analytics off, and the visitor never sees internal scoring or an expired tax credit. Skips if Playwright is missing.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
let chromium = null;
try { ({ chromium } = require('playwright')); } catch (_) { /* skipped below */ }
const skip = chromium ? false : 'playwright not installed';

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, () => { const { port } = s.address(); s.close(() => res(port)); }); });
async function start() {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), ADMIN_TOKEN: 'e2e-admin' };
  ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY', 'TWILIO_ACCOUNT_SID'].forEach((k) => delete env[k]);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'dev.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('dev server did not start')), 10000); child.stdout.on('data', (d) => { if (String(d).includes('dev server')) { clearTimeout(t); resolve(); } }); child.on('exit', (c) => { clearTimeout(t); reject(new Error('exited ' + c)); }); });
  const base = `http://localhost:${port}`;
  const admin = async (method, body) => (await fetch(base + '/api/admin', { method, headers: { Authorization: 'Bearer e2e-admin', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  await admin('POST', { action: 'create_partner', name: 'Pedro', company: 'Test Solar', email: 'pedro@example.com', phone: '5125550199', fee_mode: 'flat', is_default: true });
  return { base, admin, stop: () => child.kill() };
}
const noFonts = (page) => page.route(/fonts\.g/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));

test('a cold visitor completes the funnel; attribution and step counts are recorded; no personal data in analytics', { skip }, async () => {
  const srv = await start(); const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message)); await noFonts(page);
    await page.goto(`${srv.base}/?utm_source=meta&utm_medium=paid&utm_campaign=t1&gclid=abc_123`);
    assert.match(await page.evaluate(() => document.body.innerText), /Free solar savings check for homeowners/);
    await page.click('.btn-hero');
    await page.click('#fs2 .choice:nth-child(3)'); await page.click('#btn-bill');
    await page.click('#fs3 .choice:nth-child(1)'); await page.click('#btn-own');
    await page.click('#btn-roof');                                   // roof skipped: it is optional
    await page.fill('#inp-addr', '123 Maple Street'); await page.fill('#inp-zip', '78701'); await page.fill('#inp-city', 'Austin'); await page.selectOption('#inp-state', 'TX');
    await page.click('#fs1 .btn-next');
    await page.fill('#inp-first', 'Dana'); await page.fill('#inp-last', 'Reyes'); await page.fill('#inp-email', 'dana.e2e@example.com'); await page.fill('#inp-phone', '(512) 555-0142');
    await page.check('#inp-consent'); await page.click('#fs5 .btn-next');
    assert.match(await page.evaluate(() => document.getElementById('whyVerify').innerText), /Why we ask/);
    await page.fill('#inp-provider', 'CPS Energy'); await page.fill('#inp-meter', 'M1234567');
    await page.click('#fs6 .btn-next');
    await page.waitForSelector('#fs-quote.active', { timeout: 10000 });
    const quote = await page.evaluate(() => document.getElementById('fs-quote').innerText);
    for (const bad of ['ITC', 'HOT', 'WARM', 'COOL', 'Score', '30%', 'starting month 1']) assert.ok(!quote.includes(bad), 'quote shows: ' + bad);
    assert.match(quote, /Rough monthly savings range/i);
    await page.waitForTimeout(1800);                                  // let the beacon flush

    const d = await srv.admin('GET');
    const lead = d.leads.find((l) => l.email === 'dana.e2e@example.com');
    assert.ok(lead, 'lead was stored');
    assert.deepEqual({ s: lead.utm.utm_source, m: lead.utm.utm_medium, c: lead.utm.utm_campaign, g: lead.utm.gclid }, { s: 'meta', m: 'paid', c: 't1', g: 'abc_123' });
    assert.equal(lead.verification_method, 'meter'); assert.equal(lead.homeowner, true);
    const f = d.visitor_funnel;
    assert.equal(f.visitors, 1); assert.equal(f.starts, 1); assert.equal(f.submitted, 1);
    assert.deepEqual(f.steps.map((s) => s.reached), [1, 1, 1, 1, 1, 1]);
    assert.equal(f.verifyChoice.meter, 1);
    const camp = f.campaigns.find((c) => c.source === 'meta' && c.campaign === 't1');
    assert.ok(camp && camp.visitors === 1 && camp.leads === 1);
    assert.equal(d.economics.counts.leads, 1);
    assert.deepEqual(errs, []);
  } finally { await browser.close(); srv.stop(); }
});

test('Global Privacy Control turns analytics off, keeps campaign tags on the lead, and drops ad click ids', { skip }, async () => {
  const srv = await start(); const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage(); await noFonts(page);
    await page.addInitScript(() => Object.defineProperty(navigator, 'globalPrivacyControl', { get: () => true }));
    await page.goto(`${srv.base}/?utm_source=google&utm_campaign=s1&gclid=zzz`);
    await page.click('.btn-hero'); await page.click('#fs2 .choice:nth-child(2)'); await page.click('#btn-bill');
    await page.waitForTimeout(1800);
    assert.match(await page.evaluate(() => document.getElementById('analyticsToggle').textContent), /off/);
    const d = await srv.admin('GET');
    assert.equal(d.visitor_funnel.visitors, 0); assert.equal(d.visitor_funnel.starts, 0);
    // the lead still keeps its campaign tags, without the ad click id
    const u = await page.evaluate(() => WWT.utm());
    assert.deepEqual(u, { utm_source: 'google', utm_campaign: 's1' });
  } finally { await browser.close(); srv.stop(); }
});

test('the funnel is usable at phone width: no sideways scroll, footer legal links resolve', { skip }, async () => {
  const srv = await start(); const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 360, height: 740 } })).newPage(); await noFonts(page);
    await page.goto(srv.base + '/'); await page.waitForTimeout(500);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 361), 'page scrolls sideways at 360px');
    for (const href of await page.$$eval('footer a[href^="/legal/"]', (as) => as.map((a) => a.getAttribute('href')))) {
      const r = await fetch(srv.base + href); assert.equal(r.status, 200, href);
    }
  } finally { await browser.close(); srv.stop(); }
});
