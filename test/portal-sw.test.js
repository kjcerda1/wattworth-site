// Regression: the customer portal must render even when the service worker never becomes ready.
// (Bug found in V2 QA: checkDevice() awaited navigator.serviceWorker.ready with no timeout, leaving a blank page.)
// Uses the local dev server (in-memory store) and headless Chromium. Skips cleanly if Playwright is not installed.
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (_) { /* skipped below */ }
const skip = chromium ? false : 'playwright not installed';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.on('error', reject);
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startServer() {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), ADMIN_TOKEN: 'sw-test' };
  delete env.SUPABASE_URL; delete env.SUPABASE_SERVICE_ROLE_KEY;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'dev.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('dev server did not start')), 10000);
    child.stdout.on('data', (d) => { if (String(d).includes('dev server')) { clearTimeout(t); resolve(); } });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error('dev server exited ' + c)); });
  });
  return { port, stop: () => child.kill() };
}

async function open(browser, port, neverReady) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/fonts\.g/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  if (neverReady) {
    await page.addInitScript(() => {
      const never = new Promise(() => {});
      Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => never });
    });
  }
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/portal/#t=demo`);
  await page.waitForSelector('[data-tab]', { timeout: 8000 });
  return { ctx, page, errors, ms: Date.now() - t0 };
}

test('portal renders when navigator.serviceWorker.ready never resolves', { skip }, async () => {
  const srv = await startServer(); const browser = await chromium.launch();
  try {
    const { ctx, page, errors, ms } = await open(browser, srv.port, true);
    // the stubbed promise really is pending forever
    const pending = await page.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(() => 'resolved'), new Promise((r) => setTimeout(() => r('pending'), 300))]));
    assert.strictEqual(pending, 'pending', 'test setup: ready must never resolve');
    const body = await page.evaluate(() => document.body.innerText);
    assert.match(body, /WattWorth/, 'portal header rendered');
    assert.match(body, /Demo mode/, 'demo banner rendered');
    assert.ok(body.trim().length > 100, 'page is not blank');
    assert.strictEqual(await page.locator('[data-tab]').count(), 4, 'all four tabs present');
    assert.ok(ms < 6000, `rendered within the timeout budget (${ms}ms)`);
    assert.deepStrictEqual(errors, [], 'no uncaught page errors');
    // still interactive after the timeout fallback
    await page.click('[data-tab=refer]');
    await page.waitForSelector('#qr svg', { timeout: 3000 });
    assert.match(await page.evaluate(() => document.body.innerText), /Share solar\. Earn \$1,000\./);
    await ctx.close();
  } finally { await browser.close(); srv.stop(); }
});

test('portal still renders normally when the service worker is available (timeout path intact)', { skip }, async () => {
  const srv = await startServer(); const browser = await chromium.launch();
  try {
    const { ctx, page, errors } = await open(browser, srv.port, false);
    assert.match(await page.evaluate(() => document.body.innerText), /Demo mode/);
    assert.deepStrictEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); srv.stop(); }
});

test('portal source keeps the bounded wait on serviceWorker.ready', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'portal', 'index.html'), 'utf8');
  assert.match(src, /Promise\.race\(\[navigator\.serviceWorker\.ready,/, 'ready is raced against a timeout');
  assert.doesNotMatch(src, /=\s*await navigator\.serviceWorker\.ready;/, 'no unbounded await on ready');
});
