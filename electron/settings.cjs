// App settings and secrets for Agentic OS.
//  - settings.json (app data folder): who you are, where the vault is, which LLM is the brain.
//  - secrets.json: API keys and tokens, encrypted with Windows' own per-user encryption (Electron safeStorage, DPAPI).
//    Keys never go to the window; it only sees "saved, ends in 1a2b".
// v1 kept these in .env files and environment variables; those still work as overrides (see envOr).
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const file = (n) => path.join(app.getPath('userData'), n);
const store = require('./store.cjs');
const readJson = store.readJson;
const writeJson = (f, v) => store.writeJson(f, v, 1); // atomic: never a half-written settings file

const DEFAULTS = {
  onboarded: false,
  userName: '',
  vaultPath: '',
  // The brain. id: a key of providers.CATALOG; method: 'subscription' | 'key' | 'local'.
  provider: { id: 'claude', method: 'subscription', baseUrl: '', models: { light: '', standard: '', strong: '' } },
  budgets: { daily: 5, monthly: 50 }, // USD, for the charge meter on an API key
  wakeWord: true,
};

let cache = null;
function all() {
  if (!cache) {
    const s = readJson(file('settings.json'), {});
    cache = { ...DEFAULTS, ...s, provider: { ...DEFAULTS.provider, ...(s.provider || {}), models: { ...DEFAULTS.provider.models, ...((s.provider && s.provider.models) || {}) } }, budgets: { ...DEFAULTS.budgets, ...(s.budgets || {}) } };
  }
  return cache;
}
function get(key) { return all()[key]; }
function set(patch) {
  const next = { ...all(), ...patch };
  cache = next;
  writeJson(file('settings.json'), next);
  return next;
}

// ---------- secrets ----------
// name: 'key:<provider id>'
const canEncrypt = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
function secrets() { return readJson(file('secrets.json'), {}); }
function getSecret(name) {
  const v = secrets()[name];
  if (!v) return '';
  try {
    if (v.enc) return safeStorage.decryptString(Buffer.from(v.enc, 'base64'));
    if (v.plain) return String(v.plain); // only when Windows encryption was not available at save time
  } catch { /* unreadable (another Windows user, a moved profile): treat as not set */ }
  return '';
}
function setSecret(name, value) {
  const s = secrets();
  if (!value) delete s[name];
  else s[name] = canEncrypt() ? { enc: safeStorage.encryptString(String(value)).toString('base64') } : { plain: String(value) };
  writeJson(file('secrets.json'), s);
  return true;
}
// What the window may know about a secret: that it exists, and its last four characters.
function hint(name) {
  const v = getSecret(name);
  return v ? { saved: true, tail: v.length > 8 ? v.slice(-4) : '' } : { saved: false, tail: '' };
}

// ---------- v1 style overrides ----------
// A value from the environment or a .env file next to the app / in the data folder wins over the saved one,
// so the v1 way of setting things up keeps working.
function envFile(name) {
  for (const dir of [path.join(__dirname, '..'), app.getPath('userData')]) {
    try {
      const m = fs.readFileSync(path.join(dir, '.env'), 'utf8').match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, 'm'));
      if (m && m[1]) return m[1].replace(/^["']|["']$/g, '');
    } catch { /* no .env there */ }
  }
  return '';
}
const envOr = (name, fallback = '') => (process.env[name] || envFile(name) || fallback || '').trim();

module.exports = { all, get, set, getSecret, setSecret, hint, envOr, canEncrypt, DEFAULTS };
