/* Local dev server: serves the static pages and mounts /api/* handlers exactly like Vercel does.
   Runs with the in-memory store unless SUPABASE_* env vars are set.  Usage: ADMIN_TOKEN=dev node dev.js */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function shim(req, res, body) {
  const u = new URL(req.url, 'http://x');
  req.query = Object.fromEntries(u.searchParams);
  req.rawBody = body || '';
  try { req.body = body ? JSON.parse(body) : {}; } catch (_) { req.body = {}; }
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  res.send = (s) => res.end(s);
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    const name = u.pathname.slice(5).replace(/[^a-z]/g, '');
    const file = path.join(__dirname, 'api', name + '.js');
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('{}'); }
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { shim(req, res, data); require(file)(req, res); });
    return;
  }
  let p = u.pathname.replace(/\/$/, '') || '/wattworthsolar_platform.html';
  if (p === '/partner' || p === '/admin' || p === '/portal') p += '/index.html';
  if (/^\/r\/[A-Za-z0-9]+$/.test(p)) p = '/wattworthsolar_platform.html';
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(__dirname, p);
  if (!f.startsWith(__dirname) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('Content-Type', types[path.extname(f)] || 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log(`WattWorth leads dev server: http://localhost:${PORT}/partner/  and /admin/  (store: ${process.env.SUPABASE_URL ? 'supabase' : 'memory'})`));
