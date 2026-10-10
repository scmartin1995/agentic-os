// The phone link: a small web server inside the app, so a paired phone can open the same the assistant in its browser
// (and add it to the home screen). The brain, voice, vault and permissions all stay on this PC; the phone is a
// second screen. Plan and reasoning: the design notes
//
// Safety:
//   - Off until switched on in Settings > Phone.
//   - Every request needs the pairing token (a long random secret). The phone gets it once, from the QR code or
//     link shown in Settings, and keeps it as a cookie. "Unpair all phones" makes a new token.
//   - Only handlers marked `remote: true` in main.cjs can be called. Keys, sign-ins, folders and window controls
//     are desktop-only.
//   - It listens on this PC's network addresses (home Wi-Fi and Tailscale). It is plain http, so use it on a
//     network you trust; for use away from home, Tailscale gives a private, encrypted path (and `tailscale serve`
//     gives https, which phones require before they allow the microphone).
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const api = require('./api.cjs');
const vault = require('./vault.cjs');
const settings = require('./settings.cjs');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.gif': 'image/gif', '.webp': 'image/webp', '.csv': 'text/csv; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const MAX_BODY = 40 * 1024 * 1024; // an attached photo, base64-encoded

let server = null;
let distDir = () => path.join(__dirname, '..', 'dist');
const clients = new Map(); // client id -> Set of open event streams
let badTries = 0, lockedUntil = 0;

function token() {
  let t = settings.getSecret('remote:token');
  if (!t) { t = crypto.randomBytes(24).toString('hex'); settings.setSecret('remote:token', t); }
  return t;
}
function newToken() { settings.setSecret('remote:token', crypto.randomBytes(24).toString('hex')); for (const set of clients.values()) for (const res of set) res.end(); clients.clear(); return true; }
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const cookieOf = (req) => { const m = String(req.headers.cookie || '').match(/(?:^|;\s*)aos=([a-f0-9]+)/); return m ? m[1] : ''; };
const authed = (req) => same(cookieOf(req), token());

// This PC's addresses a phone could use. Tailscale's are 100.64.0.0/10.
function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      const tailscale = x === 100 && y >= 64 && y <= 127;
      if (a.address.startsWith('169.254.')) continue;
      out.push({ address: a.address, name, kind: tailscale ? 'tailscale' : 'wifi' });
    }
  }
  return out.sort((a, b) => (a.kind === 'tailscale' ? -1 : 1) - (b.kind === 'tailscale' ? -1 : 1));
}

function send(res, code, body, headers = {}) { res.writeHead(code, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }); res.end(body); }
const page = (title, msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agentic OS</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#060608;color:#cfe9ee;font:16px/1.5 system-ui,sans-serif"><div style="max-width:420px;margin:24px;padding:26px 28px;border:1px solid rgba(34,211,238,.3);border-radius:16px;background:rgba(20,24,30,.7)"><h1 style="margin:0 0 8px;font-size:19px;color:#22d3ee">${title}</h1><p style="margin:0;color:#9db4ba">${msg}</p></div>`;

function serveFile(res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache ? 'public, max-age=31536000, immutable' : 'no-store', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  });
}

// ArrayBuffers (attachments, recorded speech) travel as { __b64 } inside JSON.
const revive = (v) => (v && typeof v === 'object' && typeof v.__b64 === 'string' ? Uint8Array.from(Buffer.from(v.__b64, 'base64')).buffer : Array.isArray(v) ? v.map(revive) : v);

function onRequest(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, 'Bad request'); }
  // A bad percent-escape ("/%E0%A4%A") makes decodeURIComponent throw, and nothing up the stack would catch it:
  // it has to be answered here, before the pairing check, since anyone on the network can send it.
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request'); }

  // Pairing: the link from the QR code carries the token once; after that the cookie does.
  if (p === '/pair') {
    if (Date.now() < lockedUntil) return send(res, 429, page('Too many tries', 'Wait a few minutes, then scan the code again.'), { 'Content-Type': 'text/html; charset=utf-8' });
    if (!same(url.searchParams.get('k') || '', token())) {
      if (++badTries >= 10) { badTries = 0; lockedUntil = Date.now() + 5 * 60 * 1000; }
      return send(res, 401, page('That code is out of date', 'On the PC, open Agentic OS, then Settings, then Phone, and scan the code shown there.'), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    badTries = 0;
    return send(res, 302, '', { Location: '/', 'Set-Cookie': `aos=${token()}; HttpOnly; SameSite=Lax; Max-Age=31536000; Path=/` });
  }
  // The home-screen icon and manifest are fetched without the cookie on some phones; they hold nothing private.
  if (req.method === 'GET' && (p === '/manifest.webmanifest' || /^\/app-icon-\d+\.png$/.test(p))) return serveFile(res, path.join(distDir(), p), false);
  if (!authed(req)) return send(res, 401, page('Pair this phone first', 'On the PC, open Agentic OS, then Settings, then Phone, and scan the code shown there.'), { 'Content-Type': 'text/html; charset=utf-8' });

  if (req.method === 'GET' && p === '/api/events') {
    const id = String(url.searchParams.get('c') || '').slice(0, 64) || crypto.randomBytes(6).toString('hex');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': hello\n\n');
    if (!clients.has(id)) clients.set(id, new Set());
    clients.get(id).add(res);
    const beat = setInterval(() => res.write(': beat\n\n'), 25000);
    req.on('close', () => { clearInterval(beat); const set = clients.get(id); if (set) { set.delete(res); if (!set.size) clients.delete(id); } });
    return;
  }

  if (req.method === 'POST' && p === '/api/invoke') {
    // A page on another site must not be able to drive the assistant with the phone's cookie.
    const origin = req.headers.origin;
    if (origin) { try { if (new URL(origin).host !== req.headers.host) return send(res, 403, 'Wrong origin'); } catch { return send(res, 403, 'Wrong origin'); } }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { send(res, 413, 'Too large'); req.destroy(); } else chunks.push(c); });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, 'Bad JSON'); }
      const id = String(req.headers['x-client'] || '').slice(0, 64);
      const ctx = { kind: 'remote', sender: null, send: (ch, payload) => toClient(id, ch, payload) };
      try {
        const result = await api.invokeRemote(String(body.channel || ''), ctx, revive(body.args || []));
        send(res, 200, JSON.stringify({ ok: true, result: result === undefined ? null : result }), { 'Content-Type': 'application/json' });
      } catch (err) {
        send(res, 200, JSON.stringify({ ok: false, error: String((err && err.message) || err) }), { 'Content-Type': 'application/json' });
      }
    });
    return;
  }

  if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
  if (p.startsWith('/vault/')) {
    const abs = vault.resolveInside(p.slice(7));
    return abs ? serveFile(res, abs, false) : send(res, 404, 'Not found');
  }
  // The app itself: the same build the desktop window shows.
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const file = path.resolve(distDir(), rel);
  if (!file.startsWith(path.resolve(distDir()) + path.sep)) return send(res, 404, 'Not found');
  serveFile(res, file, rel.startsWith('assets/'));
}

const frame = (channel, payload) => `data: ${JSON.stringify({ channel, payload })}\n\n`;
function toClient(id, channel, payload) { const set = clients.get(id); if (set) for (const res of set) res.write(frame(channel, payload)); }
function toAll(channel, payload) { const f = frame(channel, payload); for (const set of clients.values()) for (const res of set) res.write(f); }

let offSink = null;
function start({ dist } = {}) {
  if (dist) distDir = dist;
  if (server) return status();
  const port = Number(settings.get('remote').port) || 8765;
  server = http.createServer(onRequest);
  server.on('error', (e) => { lastError = e.code === 'EADDRINUSE' ? `Port ${port} is already in use on this PC. Pick another in Settings.` : String(e.message || e); server = null; });
  // every network address of this PC, so a phone on the Wi-Fi or on Tailscale can reach it (tests bind to this PC only)
  server.listen(port, process.env.AOS_REMOTE_HOST || '0.0.0.0', () => { lastError = ''; });
  offSink = api.addSink(toAll);
  return status();
}
function stop() {
  if (offSink) { offSink(); offSink = null; }
  for (const set of clients.values()) for (const res of set) res.end();
  clients.clear();
  if (server) { server.close(); server = null; }
  return status();
}
let lastError = '';
function status() {
  const r = settings.get('remote');
  return { enabled: !!r.enabled, running: !!server, port: Number(r.port) || 8765, phones: clients.size, error: lastError, addresses: addresses() };
}
const pairPath = () => `/pair?k=${token()}`;

module.exports = { start, stop, status, newToken, pairPath, addresses, phones: () => clients.size };
