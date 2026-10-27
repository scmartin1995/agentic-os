// How Agentic OS connects to Claude, and how the user signs in. Claude is the only brain.
//
// Three ways in, whichever the user picks in setup or Settings > Brain:
//   - "key" with an address: an organisation's gateway (an address and a key), checked and saved here (testGateway,
//     save, and importSettings to take over what Claude Code on this PC already has; see gateway.cjs).
//   - "key" without an address: an Anthropic API key, checked with a free "list models" call, then saved encrypted
//     (settings.cjs). It is only ever sent to Anthropic.
//   - "subscription": the user's own Claude plan, signed in through Claude Code's OWN sign-in flow. This app opens
//     that flow in a terminal window and afterwards only asks "are you signed in?". It never sees, reads or stores
//     the login.
// The engine that does the work is claude.cjs (the Claude Agent SDK).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const settings = require('./settings.cjs');
const gw = require('./gateway.cjs');

const CATALOG = [
  {
    id: 'claude', name: 'Claude', by: 'Anthropic', color: '#be95ff',
    methods: ['key', 'subscription'],
    keyUrl: 'https://console.anthropic.com/settings/keys', keyLooks: 'the key you were given',
    blurb: 'Claude, through your organisation\'s gateway (an address and a key), an Anthropic API key, or a Claude plan.',
    subscription: 'Your own Claude plan, through Claude Code.',
  },
];
const byId = () => CATALOG[0];
// The last gateway check: which header the gateway took the key in, remembered so save() can store it.
let lastProbe = { base: '', keyHeader: '' };

// What the window is allowed to see: the catalog, the saved choice, and whether a key is saved (never the key).
function state() {
  const p = settings.get('provider');
  const def = byId();
  return {
    catalog: CATALOG,
    current: { id: def.id, method: def.methods.includes(p.method) ? p.method : def.methods[0], baseUrl: p.baseUrl || '', models: p.models, key: settings.hint('key:claude'), price: p.price || null, gateway: gatewayState(p) },
    encrypted: settings.canEncrypt(),
  };
}

// What the window may know about the gateway settings: the switches, and the names (not values) of extra headers.
function gatewayState(p) {
  const g = p.gateway || {};
  const h = gw.parseHeaders(settings.getSecret('headers:claude'));
  return { disableBetas: !!g.disableBetas, certFile: g.certFile || '', headerNames: h.ok ? h.names : [] };
}

// The resolved connection, for the engine (main process only: includes the key).
function active() {
  const p = settings.get('provider');
  const def = byId();
  const method = def.methods.includes(p.method) ? p.method : def.methods[0];
  return {
    id: def.id, name: def.name, method,
    baseUrl: String(p.baseUrl || '').replace(/\/+$/, ''),
    key: method === 'key' ? settings.getSecret('key:claude') : '',
    models: p.models || {}, price: p.price || null,
  };
}

// ---------- keys and gateways ----------
const NOT_CHAT = /embed|moderation|transcri|rerank|guard/i;
const LIGHT = /mini|flash|haiku|nano|small|lite|instant|8b|:1b|:3b/i;
const STRONG = /opus|ultra|-pro\b|pro$|max|large|heavy|fable|reason/i;

// Pick sensible starting models from a provider's own list: a quick cheap one, an everyday one, a strong one.
// Newest first when the list carries dates. The user can change all three in Settings.
function suggest(models) {
  const chat = models.filter((m) => !NOT_CHAT.test(m.id));
  const sorted = [...chat].sort((a, b) => (b.created || 0) - (a.created || 0));
  const light = sorted.find((m) => LIGHT.test(m.id));
  const standard = sorted.find((m) => !LIGHT.test(m.id) && !STRONG.test(m.id)) || sorted.find((m) => !LIGHT.test(m.id)) || sorted[0];
  const strong = sorted.find((m) => STRONG.test(m.id) && !LIGHT.test(m.id) && m !== standard);
  return { light: (light || standard || {}).id || '', standard: (standard || {}).id || '', strong: (strong || {}).id || '' };
}

// Network calls for checks go through Chromium's network stack when it is running (it trusts the certificates and proxy
// this PC is set up with, which a company network usually needs), and plain fetch otherwise.
function netFetch(url, opts) {
  try { const { net, app } = require('electron'); if (net && app && app.isReady()) return net.fetch(url, opts); } catch { /* not running inside Electron */ }
  return fetch(url, opts);
}

// Free check that a key works: ask for the model list. With an address it is the gateway check (testGateway).
// Returns { ok, models, suggested, error }.
async function test({ key, baseUrl, headers, disableBetas, model }) {
  key = String(key || '').trim() || settings.getSecret('key:claude');
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  try {
    if (base) {
      const h = headers == null ? { ok: true, text: settings.getSecret('headers:claude') } : gw.parseHeaders(headers);
      if (!h.ok) return { ok: false, error: h.error };
      return await testGateway(base, key, { headers: h.text, disableBetas, model });
    }
    if (!key) return { ok: false, error: 'Paste your key first.' };
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15000) });
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'That key was not accepted. Check it was copied whole and is still active.' };
    if (!res.ok) return { ok: false, error: `The service answered with an error (${res.status}).` };
    const body = await res.json();
    const list = (body.data || []).map((m) => ({ id: String(m.id || ''), created: Date.parse(m.created_at || '') / 1000 || 0 })).filter((m) => m.id);
    return { ok: true, models: list.filter((m) => !NOT_CHAT.test(m.id)).map((m) => m.id).sort(), suggested: suggest(list) };
  } catch (err) {
    return { ok: false, error: `Could not reach the service: ${String((err && err.message) || err)}` };
  }
}

// An organisation's gateway in front of Claude: an address and a key. Works out which header the gateway reads the key
// from (a bearer token first, then x-api-key), using the gateway's free model list where it has one and a one-token
// request where it does not.
// Nothing is sent anywhere but that address. Every failure is one of: not reachable, certificate not trusted, key
// refused, request shape rejected, or "not a gateway", each with what to ask the gateway's owner for.
async function testGateway(base, key, { headers = '' } = {}) {
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'That address should start with https:// (or http://).', kind: 'address' };
  const extra = {};
  for (const l of String(headers || '').split('\n').filter(Boolean)) extra[l.slice(0, l.indexOf(':')).trim()] = l.slice(l.indexOf(':') + 1).trim();
  const fail = (kind, error) => ({ ok: false, kind, error: error || gw.TEXT[kind] });
  const netFail = (err) => fail(gw.netErrorKind(err));
  const nothing = { light: '', standard: '', strong: '' };
  const send = (url, opts) => netFetch(url, { redirect: 'error', ...opts, signal: AbortSignal.timeout(opts.method === 'POST' ? 20000 : 15000) });
  // an answer that proves the address and key are taken even though the request itself was refused
  const accepted = async (res) => {
    const text = await res.text().catch(() => '');
    if (!/^\s*\{/.test(text)) return { bad: fail('notGateway') };
    if ((res.status === 400 || res.status === 422) && gw.SHAPE.test(text)) return { bad: fail('shape') };
    return { good: true };
  };

  if (!key && !Object.keys(extra).length) return fail('refused', 'Paste your key first.');
  const styles = key ? [['bearer', { Authorization: `Bearer ${key}` }], ['x-api-key', { 'x-api-key': key }]] : [['bearer', {}]];
  const common = { 'anthropic-version': '2023-06-01', ...extra };
  let refused = false;
  for (const [keyHeader, h] of styles) {
    let res;
    try { res = await send(`${base}/v1/models?limit=1000`, { headers: { ...common, ...h } }); }
    catch (err) { return netFail(err); }
    if (res.status === 401 || res.status === 403) { refused = true; continue; }
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (!body || typeof body !== 'object') return fail('notGateway'); // a sign-in page or similar, not the gateway
      const list = (Array.isArray(body) ? body : body.data || body.models || []).map((m) => ({ id: String(m.id || m.name || ''), created: Number(m.created) || Date.parse(m.created_at || '') / 1000 || 0 })).filter((m) => m.id && /claude|anthropic/i.test(m.id));
      lastProbe = { base, keyHeader };
      return { ok: true, models: list.map((m) => m.id).sort(), suggested: suggest(list), keyHeader };
    }
    // no model list on this gateway: a one-token request shows whether the address and key are taken
    let r2;
    try { r2 = await send(`${base}/v1/messages`, { method: 'POST', headers: { ...common, ...h, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-check', max_tokens: 1, messages: [{ role: 'user', content: '.' }] }) }); }
    catch (err) { return netFail(err); }
    if (r2.status === 401 || r2.status === 403) { refused = true; continue; }
    if (r2.status >= 500) return fail('other', `The gateway answered with an error (${r2.status}). Ask its owner whether it is running.`);
    const a = await accepted(r2);
    if (a.bad) return a.bad;
    lastProbe = { base, keyHeader };
    return { ok: true, models: [], suggested: nothing, keyHeader }; // an error naming the model still proves the address and key
  }
  return refused ? fail('refused') : fail('unreachable');
}

// Save the choice made in onboarding or Settings. A key is stored encrypted and never handed back.
// `gateway`: { headers, disableBetas, certFile }; headers is text (replaces what was saved; '' clears it) or left out (keeps it).
function save({ id, method, key, baseUrl, models, price, gateway }) {
  const def = byId(id);
  if (!def.methods.includes(method)) return { ok: false, error: 'That way of signing in is not offered for this provider.' };
  const g = gateway || {};
  if (g.headers != null) {
    const h = gw.parseHeaders(g.headers);
    if (!h.ok) return { ok: false, error: h.error };
    settings.setSecret('headers:claude', h.text);
  }
  if (method === 'key' && key) settings.setSecret(`key:${def.id}`, String(key).trim());
  if (method === 'key' && !settings.getSecret(`key:${def.id}`) && !(def.id === 'claude' && settings.envOr('ANTHROPIC_API_KEY'))) return { ok: false, error: 'No key saved yet.' };
  const prev = settings.get('provider');
  const same = prev.id === def.id;
  const pg = (same && prev.gateway) || {};
  settings.set({ provider: {
    id: def.id, method,
    baseUrl: String(baseUrl != null ? baseUrl : same ? prev.baseUrl : '').trim(),
    models: { light: '', standard: '', strong: '', ...(same ? prev.models : {}), ...(models || {}) },
    price: price !== undefined ? price : same ? prev.price || null : null,
    keyHeader: lastProbe.keyHeader && lastProbe.base === String(baseUrl || '').trim().replace(/\/+$/, '') ? lastProbe.keyHeader : same ? prev.keyHeader || '' : '',
    gateway: {
      disableBetas: g.disableBetas != null ? !!g.disableBetas : !!pg.disableBetas,
      certFile: g.certFile != null ? String(g.certFile).trim() : pg.certFile || '',
    },
  } });
  return { ok: true };
}

// ---------- taking over what Claude Code already has ----------
// Reads ~/.claude/settings.json (read only), keeps what it found in memory, and tells the window what was found without
// the key or header values. applyImport() then saves it once the user has confirmed.
let pendingImport = null;
function importSettings() {
  const r = gw.readClaudeSettings();
  if (!r.ok) { pendingImport = null; return { ok: false, error: r.error }; }
  pendingImport = r.found;
  return { ok: true, found: gw.describeImport(r.found) };
}
// The pins found in Claude Code's settings win; the gateway's own suggestions fill the gaps.
const mergePins = (found, suggested) => ({ light: found.light || (suggested || {}).light || '', standard: found.standard || (suggested || {}).standard || '', strong: found.strong || (suggested || {}).strong || '' });
async function applyImport() {
  const f = pendingImport;
  if (!f) return { ok: false, error: 'Nothing to take over. Press the button again.' };
  if (f.key) settings.setSecret('key:claude', f.key);
  // check the connection first, so the saved choice carries the key header that worked and any models the gateway lists
  const checked = f.baseUrl ? await testGateway(f.baseUrl, f.key, { headers: f.headers }) : null;
  const ok = !!(checked && checked.ok);
  const r = save({ id: 'claude', method: 'key', baseUrl: f.baseUrl, models: ok ? mergePins(f.models, checked.suggested) : f.models, gateway: { headers: f.headers || '', disableBetas: f.disableBetas, certFile: f.certFile } });
  if (!r.ok) return r;
  if (f.keyHeader && !ok) { const p = settings.get('provider'); settings.set({ provider: { ...p, keyHeader: f.keyHeader } }); } // Claude Code already knew which header the key goes in
  pendingImport = null;
  return { ok: true, check: checked ? { ok, error: checked.error || '', kind: checked.kind || '', models: checked.models || [] } : null };
}

function forgetKey() { settings.setSecret('key:claude', ''); return true; }

// ---------- the user's own Claude plan, through Claude Code ----------
function claudeExe() {
  const dir = path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64');
  try { const exe = fs.readdirSync(dir).find((f) => /^claude(\.exe)?$/i.test(f)); return exe ? path.join(dir, exe) : ''; } catch { return ''; }
}

// Is Claude Code signed in, and (as far as can be told without touching the login) as what?
async function cliStatus() {
  const a = await require('./claude.cjs').account();
  return { installed: !!claudeExe(), signedIn: a.signedIn, plan: a.plan, who: a.email, error: a.ok ? '' : a.error };
}

// Opens Claude Code's own sign-in in a normal terminal window, so the login happens entirely in Anthropic's app.
function openLogin() {
  const exe = claudeExe();
  if (!exe) return { ok: false, error: 'The bundled Claude Code was not found. Run npm install in the app folder.' };
  const env = { ...process.env };
  for (const v of gw.ROUTING_VARS) delete env[v]; // sign in with the claude.ai account, not a key or a gateway
  env.DISABLE_AUTOUPDATER = '1'; // it must never replace itself while Agentic OS uses it
  try {
    spawn('cmd.exe', ['/d', '/s', '/c', `start "Sign in for Agentic OS" cmd /k "${exe}" /login`], { detached: true, stdio: 'ignore', env, windowsVerbatimArguments: true }).unref();
    return { ok: true };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
}

module.exports = { CATALOG, byId, state, active, test, testGateway, save, importSettings, applyImport, forgetKey, suggest, cliStatus, openLogin, claudeExe };
