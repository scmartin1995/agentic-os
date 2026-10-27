// An organisation's gateway in front of Claude: reading the setup Claude Code already has, turning the assistant's saved choice
// into the settings the Claude Code engine is started with, and saying plainly what went wrong when it does not work.
// Variable names are the ones in Claude Code's gateway guide (https://code.claude.com/docs/en/llm-gateway-connect).
const fs = require('fs');
const os = require('os');
const path = require('path');

// Everything that decides where Claude Code sends its requests. These are cleared from the engine's environment first,
// so a stray variable on this PC can never send the assistant's questions somewhere the user did not choose.
const ROUTING_VARS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BEDROCK_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_VERTEX_BASE_URL', 'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_MODEL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY', 'NODE_EXTRA_CA_CERTS',
  'AWS_REGION', 'AWS_DEFAULT_REGION',
];

// ---------- headers ----------
const HEADER_LINE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+:[ \t]*\S[^\r\n]*$/;
// "Name: Value" per line, as Claude Code's ANTHROPIC_CUSTOM_HEADERS wants it. Returns { ok, text, names } or { ok: false, error }.
function parseHeaders(raw) {
  const lines = String(raw || '').split(/\r?\n|\\n/).map((l) => l.trim()).filter(Boolean);
  for (const l of lines) if (!HEADER_LINE.test(l)) return { ok: false, error: `"${l.slice(0, 40)}" is not a header. Write each one as Name: Value, one per line.` };
  const names = lines.map((l) => l.split(':')[0].trim());
  if (names.some((n) => /^(authorization|x-api-key)$/i.test(n))) return { ok: false, error: 'The key goes in the key box, not in a header. Remove Authorization or x-api-key from the extra headers.' };
  return { ok: true, text: lines.join('\n'), names };
}

// ---------- reading Claude Code's own settings ----------
const claudeSettingsPath = () => process.env.AOS_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const on = (v) => /^(1|true|yes|on)$/i.test(str(v));

// Reads (never writes) the env block of ~/.claude/settings.json. Returns { ok, found } with `found` holding every
// connection value (key included: it stays in the main process) or { ok: false, error }.
// Only a plain gateway address (ANTHROPIC_BASE_URL) with a key is understood; other routing set-ups are left alone.
function readClaudeSettings() {
  const file = claudeSettingsPath();
  let json;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, error: 'No Claude Code settings file was found on this PC (looked for ~/.claude/settings.json). Paste the address and key instead.' };
    return { ok: false, error: 'The Claude Code settings file could not be read as settings. Paste the address and key instead.' };
  }
  const env = json && typeof json.env === 'object' && json.env ? json.env : {};
  const baseUrl = str(env.ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  const token = str(env.ANTHROPIC_AUTH_TOKEN);
  const apiKey = str(env.ANTHROPIC_API_KEY);
  const keyVar = token ? 'ANTHROPIC_AUTH_TOKEN' : apiKey ? 'ANTHROPIC_API_KEY' : '';
  const key = keyVar ? str(env[keyVar]) : '';
  const hdr = str(env.ANTHROPIC_CUSTOM_HEADERS) ? parseHeadersLoose(str(env.ANTHROPIC_CUSTOM_HEADERS)) : { text: '', names: [] };
  const found = {
    baseUrl, key, keyVar,
    keyHeader: keyVar === 'ANTHROPIC_AUTH_TOKEN' ? 'bearer' : apiKey ? 'x-api-key' : '',
    headers: hdr.text, headerNames: hdr.names,
    models: { light: str(env.ANTHROPIC_DEFAULT_HAIKU_MODEL), standard: str(env.ANTHROPIC_DEFAULT_SONNET_MODEL), strong: str(env.ANTHROPIC_DEFAULT_OPUS_MODEL) },
    disableBetas: on(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS),
    certFile: str(env.NODE_EXTRA_CA_CERTS),
    keyHelper: !!str(json.apiKeyHelper),
  };
  if (!found.baseUrl && !found.key && !found.keyHelper) return { ok: false, error: 'Those Claude Code settings hold no gateway address or key. Agentic OS looked in the env block of ~/.claude/settings.json. Paste the address and key instead.' };
  return { ok: true, found };
}
// Headers from a settings file are the user's own: keep what is readable and drop only a credential header.
function parseHeadersLoose(raw) {
  const lines = String(raw).split(/\r?\n|\\n/).map((l) => l.trim()).filter((l) => HEADER_LINE.test(l) && !/^(authorization|x-api-key):/i.test(l));
  return { text: lines.join('\n'), names: lines.map((l) => l.split(':')[0].trim()) };
}

// What the window may be shown about an import: everything except the key and header values.
function describeImport(found) {
  const notes = [];
  if (!found.baseUrl) notes.push('No gateway address was set there, so Agentic OS would talk to Anthropic directly.');
  if (!found.key) notes.push(found.keyHelper ? 'Your settings fetch the key with a command (apiKeyHelper). Agentic OS does not run commands from settings files, so paste the key yourself.' : 'No key was found there. Paste the key yourself.');
  return {
    baseUrl: found.baseUrl,
    keyFrom: found.keyVar || '', headerNames: found.headerNames, models: found.models,
    switches: [found.disableBetas ? 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS' : '', found.certFile ? 'NODE_EXTRA_CA_CERTS' : ''].filter(Boolean),
    certFile: found.certFile, notes,
  };
}

// ---------- the engine's settings ----------
// cfg: { baseUrl, key, keyHeader ('bearer' | 'x-api-key'), headers (text), disableBetas, certFile, models }
function applyToEnv(env, cfg) {
  for (const v of ROUTING_VARS) delete env[v];
  env.ANTHROPIC_BASE_URL = cfg.baseUrl;
  if (cfg.keyHeader === 'x-api-key') env.ANTHROPIC_API_KEY = cfg.key; else env.ANTHROPIC_AUTH_TOKEN = cfg.key;
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1';
  const m = cfg.models || {};
  if (m.light) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = m.light;
  if (m.standard) env.ANTHROPIC_DEFAULT_SONNET_MODEL = m.standard;
  if (m.strong) env.ANTHROPIC_DEFAULT_OPUS_MODEL = m.strong;
  if (cfg.headers) env.ANTHROPIC_CUSTOM_HEADERS = cfg.headers;
  if (cfg.disableBetas) env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
  if (cfg.certFile) env.NODE_EXTRA_CA_CERTS = cfg.certFile;
  return env;
}

// ---------- plain errors ----------
const TEXT = {
  unreachable: 'Nothing answered at that address. Check you are on the company VPN or network, and that the address is typed exactly. If it still fails, ask the gateway\'s owner for the correct address.',
  cert: 'The address answered, but this PC does not trust its security certificate (common on company networks). Ask the gateway\'s owner for the company root certificate file (.pem), and put its path under "Certificate file" in the advanced settings.',
  refused: 'The gateway did not accept that key. Check it was copied whole and is still active. If it is, ask the gateway\'s owner whether the key goes in an Authorization header or an x-api-key header, and which models it is allowed to use.',
  shape: 'The gateway rejected the shape of the request. Turn on "My gateway rejects some requests" in the advanced settings and try again. If it still fails, ask the gateway\'s owner which Claude API format it accepts.',
  notGateway: 'That address answered, but not like a model gateway. Check the address with the gateway\'s owner.',
};
// Looks at an error from a network call (Node or Chromium wording) and says whether it is a certificate problem.
function netErrorKind(err) {
  const text = [err && err.message, err && err.code, err && err.cause && err.cause.code, err && err.cause && err.cause.message].filter(Boolean).join(' ');
  return /cert|ssl|tls|self.signed|unable to verify|issuer/i.test(text) ? 'cert' : 'unreachable';
}
// Turns an error that came back from the engine into plain words, or '' when it is not a gateway problem we know.
function friendlyError(raw) {
  const t = String(raw || '');
  if (/certificate|self.signed|UNABLE_TO_VERIFY|CERT_|SSL/i.test(t)) return TEXT.cert;
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|Unable to connect|Can't reach the API|Connection refused|fetch failed/i.test(t)) return TEXT.unreachable;
  if (/Extra inputs are not permitted|context_management|Input tag '|adaptive/i.test(t)) return TEXT.shape;
  if (/\b(401|403)\b|invalid (x-api-)?key|unauthori[sz]ed|authentication_error|authentication_failed|invalid.*token/i.test(t)) return TEXT.refused;
  return '';
}
const SHAPE = /extra inputs|not permitted|unrecognized|unknown (field|parameter)|context_management/i;

module.exports = { ROUTING_VARS, parseHeaders, claudeSettingsPath, readClaudeSettings, describeImport, applyToEnv, TEXT, netErrorKind, friendlyError, SHAPE };
