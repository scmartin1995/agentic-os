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
// Plain Bedrock settings (no secrets) that are taken over from Claude Code's settings and passed to the engine as they were.
// Names only from this list; nothing else is ever copied across.
const EXTRA_ENV = [
  'ANTHROPIC_BEDROCK_REGION_PREFIX', 'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION', 'ANTHROPIC_BEDROCK_SERVICE_TIER',
  'DISABLE_PROMPT_CACHING', 'ENABLE_PROMPT_CACHING_1H', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_DEFAULT',
];
for (const v of EXTRA_ENV) ROUTING_VARS.push(v);

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
function readClaudeSettings() {
  const file = claudeSettingsPath();
  let json;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, error: 'No Claude Code settings file was found on this PC (looked for ~/.claude/settings.json). Paste the address and key instead.' };
    return { ok: false, error: 'The Claude Code settings file could not be read as settings. Paste the address and key instead.' };
  }
  const env = json && typeof json.env === 'object' && json.env ? json.env : {};
  const bedrock = on(env.CLAUDE_CODE_USE_BEDROCK) && str(env.ANTHROPIC_BEDROCK_BASE_URL);
  const baseUrl = (bedrock ? str(env.ANTHROPIC_BEDROCK_BASE_URL) : str(env.ANTHROPIC_BASE_URL)).replace(/\/+$/, '');
  const token = str(env.ANTHROPIC_AUTH_TOKEN);
  const apiKey = str(env.ANTHROPIC_API_KEY);
  const awsBearer = str(env.AWS_BEARER_TOKEN_BEDROCK); // a Bedrock API key: Claude Code sends it as the Authorization header
  // Which variable holds the key. On a Bedrock-style gateway the Bedrock API key comes first, as it does in Claude Code.
  const keyVar = bedrock && awsBearer ? 'AWS_BEARER_TOKEN_BEDROCK' : token ? 'ANTHROPIC_AUTH_TOKEN' : apiKey ? 'ANTHROPIC_API_KEY' : awsBearer && bedrock ? 'AWS_BEARER_TOKEN_BEDROCK' : '';
  const key = keyVar ? str(env[keyVar]) : '';
  const hdr = str(env.ANTHROPIC_CUSTOM_HEADERS) ? parseHeadersLoose(str(env.ANTHROPIC_CUSTOM_HEADERS)) : { text: '', names: [] };
  const extraEnv = {};
  for (const name of EXTRA_ENV) { const v = str(env[name]); if (v && /^[\w.:\/@-]{1,200}$/.test(v)) extraEnv[name] = v; }
  const overrides = {};
  if (json.modelOverrides && typeof json.modelOverrides === 'object') for (const [k, v] of Object.entries(json.modelOverrides)) if (typeof v === 'string' && /^[\w.:\/@-]{1,300}$/.test(k) && /^[\w.:\/@-]{1,300}$/.test(v)) overrides[k] = v;
  const found = {
    style: bedrock ? 'bedrock' : 'anthropic',
    baseUrl, key, keyVar,
    keyHeader: bedrock || keyVar === 'ANTHROPIC_AUTH_TOKEN' ? 'bearer' : apiKey ? 'x-api-key' : '',
    headers: hdr.text, headerNames: hdr.names,
    models: { light: str(env.ANTHROPIC_DEFAULT_HAIKU_MODEL), standard: str(env.ANTHROPIC_DEFAULT_SONNET_MODEL), strong: str(env.ANTHROPIC_DEFAULT_OPUS_MODEL) },
    disableBetas: on(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS),
    certFile: str(env.NODE_EXTRA_CA_CERTS),
    skipBedrockAuth: on(env.CLAUDE_CODE_SKIP_BEDROCK_AUTH),
    // Agentic OS never signs requests with AWS credentials, so signing is always skipped. (Tried against the real engine: without
    // this it sends about a dozen "can I use this model?" requests at the gateway on every start; with it, a Bedrock API key
    // still arrives as a bearer token and only the real request is made.)
    skipAuth: true,
    region: str(env.AWS_REGION) || str(env.AWS_DEFAULT_REGION),
    extraEnv, modelOverrides: overrides,
    keyHelper: !!str(json.apiKeyHelper),
    // signing in as an AWS identity (a profile, access keys, a refresh command) is not something Agentic OS does
    awsIdentity: [str(env.AWS_PROFILE) && 'AWS_PROFILE', str(env.AWS_ACCESS_KEY_ID) && 'AWS_ACCESS_KEY_ID', str(json.awsAuthRefresh) && 'awsAuthRefresh', str(json.awsCredentialExport) && 'awsCredentialExport'].filter(Boolean),
    useBedrockNoGateway: on(env.CLAUDE_CODE_USE_BEDROCK) && !str(env.ANTHROPIC_BEDROCK_BASE_URL),
  };
  if (!found.baseUrl && !found.key && (found.awsIdentity.length || found.useBedrockNoGateway)) return { ok: false, error: `Those Claude Code settings connect to Amazon Bedrock with your own AWS sign-in${found.awsIdentity.length ? ` (${found.awsIdentity.join(', ')})` : ''}, not through a gateway address. Agentic OS does not sign in to AWS itself yet. If you were given a gateway address and key, paste them instead.` };
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
  if (!found.key && found.style !== 'bedrock') notes.push(found.keyHelper ? 'Your settings fetch the key with a command (apiKeyHelper). Agentic OS does not run commands from settings files, so paste the key yourself.' : 'No key was found there. Paste the key yourself.');
  if (found.style === 'bedrock' && found.keyHelper && !found.key) notes.push('Your settings fetch a key with a command (apiKeyHelper), which Agentic OS does not run. If the gateway needs a key, paste it.');
  if (found.awsIdentity.length) notes.push(`Your settings also sign in as an AWS identity (${found.awsIdentity.join(', ')}). Agentic OS does not do that: it sends the gateway's key and leaves the AWS sign-in to the gateway. If the gateway needs your AWS sign-in too, it will refuse the check.`);
  return {
    style: found.style, baseUrl: found.baseUrl,
    keyFrom: found.keyVar || '', headerNames: found.headerNames, models: found.models,
    switches: [found.disableBetas ? 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS' : '', found.skipBedrockAuth ? 'CLAUDE_CODE_SKIP_BEDROCK_AUTH' : '', found.certFile ? 'NODE_EXTRA_CA_CERTS' : ''].filter(Boolean),
    certFile: found.certFile, region: found.region, extras: [...Object.keys(found.extraEnv), ...(Object.keys(found.modelOverrides).length ? ['modelOverrides'] : [])], notes,
  };
}

// ---------- the engine's settings ----------
// cfg: { baseUrl, key, keyHeader ('bearer' | 'x-api-key'), style ('anthropic' | 'bedrock'), headers (text), disableBetas, certFile, models,
//        and for the Bedrock style: keyVar, skipAuth, region, extraEnv }
function applyToEnv(env, cfg) {
  for (const v of ROUTING_VARS) delete env[v];
  if (cfg.style === 'bedrock') {
    // A gateway that speaks Amazon Bedrock's format. The gateway holds the cloud credentials, so Agentic OS signs nothing.
    env.CLAUDE_CODE_USE_BEDROCK = '1';
    env.ANTHROPIC_BEDROCK_BASE_URL = cfg.baseUrl;
    if (cfg.skipAuth !== false) env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1';
    // A Bedrock API key goes in its own variable (Claude Code sends it as the Authorization header); any other key is a bearer token.
    if (cfg.key) env[cfg.keyVar === 'AWS_BEARER_TOKEN_BEDROCK' ? 'AWS_BEARER_TOKEN_BEDROCK' : 'ANTHROPIC_AUTH_TOKEN'] = cfg.key;
    if (cfg.region) env.AWS_REGION = cfg.region;
    for (const [k, v] of Object.entries(cfg.extraEnv || {})) if (EXTRA_ENV.includes(k)) env[k] = String(v);
  } else {
    env.ANTHROPIC_BASE_URL = cfg.baseUrl;
    if (cfg.keyHeader === 'x-api-key') env.ANTHROPIC_API_KEY = cfg.key; else env.ANTHROPIC_AUTH_TOKEN = cfg.key;
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1';
  }
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
  shape: 'The gateway rejected the shape of the request. Turn on "My gateway rejects some requests" in the advanced settings and try again. If it still fails, ask the gateway\'s owner which Claude API format it accepts (Anthropic or Amazon Bedrock).',
  notGateway: 'That address answered, but not like a model gateway. Check the address with the gateway\'s owner.',
  stream: 'The gateway changed the format of the reply stream. Ask the gateway\'s owner to pass Amazon Bedrock\'s streaming replies through unchanged. If it also accepts Anthropic-style requests, use the Anthropic format in the advanced settings instead.',
  profile: 'Amazon Bedrock wants an inference-profile model name here, for example us.anthropic.claude-sonnet-4-6 (the us. or global. at the front must be one your account has switched on). Pick Auto, or type one of the names the gateway\'s owner gave you in the model picker under the chat box.',
  noModel: 'Amazon Bedrock refused that model. Ask the gateway\'s owner which Claude models and which prefix (us., eu., global.) your account can use, and type one of those names in the model picker under the chat box.',
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
  if (/Bedrock streaming response has content-type/i.test(t)) return TEXT.stream;
  if (/on-demand throughput isn.t supported/i.test(t)) return TEXT.profile;
  if (/model identifier is invalid|don.t have access to the model|not authorized to (invoke|access) .*model|access.*denied.*model/i.test(t)) return TEXT.noModel;
  if (/Extra inputs are not permitted|context_management|Input tag '|adaptive/i.test(t)) return TEXT.shape;
  if (/\b(401|403)\b|invalid (x-api-)?key|unauthori[sz]ed|authentication_error|authentication_failed|invalid.*token/i.test(t)) return TEXT.refused;
  return '';
}
const SHAPE = /extra inputs|not permitted|unrecognized|unknown (field|parameter)|context_management/i;

module.exports = { ROUTING_VARS, EXTRA_ENV, parseHeaders, claudeSettingsPath, readClaudeSettings, describeImport, applyToEnv, TEXT, netErrorKind, friendlyError, SHAPE };
