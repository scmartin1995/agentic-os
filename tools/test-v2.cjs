// Tests with nothing real touched: a throwaway data folder, a throwaway notes folder and stand-in gateway servers on
// localhost.
// No window opens, no real service is called, no tokens are spent.
// Run:  node_modules\.bin\electron tools\test-v2.cjs
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-v2-test-'));
const VAULT = path.join(tmp, 'vault');
app.setPath('userData', path.join(tmp, 'userData'));
process.env.AOS_VAULT = VAULT;
process.env.AOS_BACKUP_DIR = path.join(tmp, 'backups');
delete process.env.ANTHROPIC_API_KEY;

const put = (rel, text, root = VAULT) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
put('index.md', '# Notes\n\n- [Alpha](notes/alpha.md)\n');
put('notes/alpha.md', '# Alpha\n\nThe launch date is 12 March.\n');
put('skills/tidy/SKILL.md', '---\nname: tidy\ndescription: How to tidy notes\n---\nTidy them.\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const check = (name, ok, extra = '') => { console.log(ok ? 'ok   ' : 'FAIL ', name, ok ? '' : extra); ok ? passed++ : failed++; };

app.whenReady().then(async () => {
  try {

    // ---------- settings and secrets ----------
    const settings = require('../electron/settings.cjs');
    settings.set({ userName: 'Robin' });
    check('settings: saved and read back', settings.get('userName') === 'Robin' && JSON.parse(fs.readFileSync(path.join(tmp, 'userData', 'settings.json'), 'utf8')).userName === 'Robin');
    settings.setSecret('key:test', 'sk-super-secret-1234');
    const rawSecrets = fs.readFileSync(path.join(tmp, 'userData', 'secrets.json'), 'utf8');
    check('secrets: read back whole', settings.getSecret('key:test') === 'sk-super-secret-1234');
    check('secrets: not stored as readable text when Windows encryption is available', !settings.canEncrypt() || !rawSecrets.includes('sk-super-secret-1234'), rawSecrets.slice(0, 80));
    check('secrets: the window only gets a hint', JSON.stringify(settings.hint('key:test')) === '{"saved":true,"tail":"1234"}');
    settings.setSecret('key:test', '');
    check('secrets: can be removed', settings.getSecret('key:test') === '' && !settings.hint('key:test').saved);

    // ---------- providers: key check, model suggestions, saving ----------
    const providers = require('../electron/providers.cjs');
    check('provider: Claude on a plan login never falls back to a stray key', (() => { const before = settings.get('provider'); settings.set({ provider: { ...before, id: 'claude', method: 'subscription' } }); process.env.ANTHROPIC_API_KEY = 'sk-ant-stray'; const m = require('../electron/claude.cjs').mode(); delete process.env.ANTHROPIC_API_KEY; settings.set({ provider: before }); return m === 'plan'; })());

    // ---------- an organisation's gateway in front of Claude ----------
    const gw = http.createServer((req, res) => {
      if (req.headers['x-api-key'] !== 'gw-key') { res.writeHead(401); return res.end('{}'); }
      if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-x' }, { id: 'claude-haiku-x' }, { id: 'other-model' }] })); }
      res.writeHead(404); res.end('{}');
    });
    await new Promise((r) => gw.listen(0, '127.0.0.1', r));
    const gwBase = 'http://127.0.0.1:' + gw.address().port;
    const gwProviders = require('../electron/providers.cjs');
    const probe = await gwProviders.test({ id: 'claude', key: 'gw-key', baseUrl: gwBase });
    check('gateway: finds the header the gateway reads the key from, and lists only Claude models', probe.ok && probe.keyHeader === 'x-api-key' && probe.models.length === 2, JSON.stringify(probe));
    check('gateway: a wrong key is refused', (await gwProviders.test({ id: 'claude', key: 'nope', baseUrl: gwBase })).ok === false);
    const before = require('../electron/settings.cjs').get('provider');
    gwProviders.save({ id: 'claude', method: 'key', key: 'gw-key', baseUrl: gwBase, models: { light: 'claude-haiku-x', standard: 'claude-sonnet-x', strong: '' } });
    const gwEnv = require('../electron/claude.cjs').authEnv();
    check('gateway: the engine is pointed at the gateway, key in the right header, reporting switched off, models pinned', gwEnv.ANTHROPIC_BASE_URL === gwBase && gwEnv.ANTHROPIC_API_KEY === 'gw-key' && !gwEnv.ANTHROPIC_AUTH_TOKEN && gwEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === '1' && gwEnv.DISABLE_TELEMETRY === '1' && gwEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'claude-haiku-x' && gwEnv.ANTHROPIC_DEFAULT_SONNET_MODEL === 'claude-sonnet-x', JSON.stringify({ b: gwEnv.ANTHROPIC_BASE_URL, k: !!gwEnv.ANTHROPIC_API_KEY, h: gwEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL }));
    check('brains: only Claude is offered', gwProviders.state().catalog.length === 1 && gwProviders.state().catalog[0].id === 'claude');
    require('../electron/settings.cjs').set({ provider: before });
    gw.close();

    // ---------- the gateway set-up screen: both styles, taking over Claude Code's settings, plain errors ----------
    {
      const claudeCjs = require('../electron/claude.cjs');
      const gwlib = require('../electron/gateway.cjs');
      const S = require('../electron/settings.cjs');
      const prev = S.get('provider');
      const sha = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', r));
      const J = { 'Content-Type': 'application/json' };

      // a gateway that reads "Authorization: Bearer" and needs a tenant header, with the usual model list
      const seenHeaders = [];
      const bearer = http.createServer((req, res) => {
        seenHeaders.push(req.headers);
        if (req.headers.authorization !== 'Bearer tok-1' || req.headers['x-org'] !== 'blue') { res.writeHead(401); return res.end('{}'); }
        if (req.url.startsWith('/v1/models')) { res.writeHead(200, J); return res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-g' }, { id: 'claude-haiku-g' }, { id: 'claude-opus-g' }] })); }
        res.writeHead(404); res.end('{}');
      });
      await listen(bearer);
      const bBase = 'http://127.0.0.1:' + bearer.address().port;
      const P = require('../electron/providers.cjs');
      let r = await P.test({ id: 'claude', key: 'tok-1', baseUrl: bBase, headers: 'X-Org: blue' });
      check('gateway (Anthropic style): a bearer-token gateway that also wants an extra header is found, with its model list', r.ok && r.keyHeader === 'bearer' && r.models.length === 3, JSON.stringify(r));
      check('gateway (Anthropic style): the extra header was sent on the check', seenHeaders.some((h) => h['x-org'] === 'blue'));
      r = await P.test({ id: 'claude', key: 'tok-1', baseUrl: bBase, headers: 'Authorization: Bearer x' });
      check('gateway: the key is refused as a header (it belongs in the key box)', !r.ok && /key box/.test(r.error), JSON.stringify(r));
      P.save({ id: 'claude', method: 'key', key: 'tok-1', baseUrl: bBase, models: { light: 'claude-haiku-g', standard: 'claude-sonnet-g', strong: 'claude-opus-g' }, gateway: { style: 'anthropic', headers: 'X-Org: blue\nX-Team: red', disableBetas: true, certFile: 'C:\\certs\\root.pem' } });
      let env = claudeCjs.authEnv();
      check('gateway (Anthropic style): the engine gets the address, the token, headers, the rejects-requests switch, the certificate file and the model pins', env.ANTHROPIC_BASE_URL === bBase && env.ANTHROPIC_AUTH_TOKEN === 'tok-1' && !env.ANTHROPIC_API_KEY && env.ANTHROPIC_CUSTOM_HEADERS === 'X-Org: blue\nX-Team: red' && env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS === '1' && env.NODE_EXTRA_CA_CERTS === 'C:\\certs\\root.pem' && env.ANTHROPIC_DEFAULT_OPUS_MODEL === 'claude-opus-g' && !env.CLAUDE_CODE_USE_BEDROCK, JSON.stringify(Object.keys(env).filter((k) => /ANTHROPIC|CLAUDE_CODE_(USE|SKIP|DISABLE_EXP)/.test(k))));
      check('gateway: header values stay in the main process (the window sees only their names)', JSON.stringify(P.state()).includes('X-Team') && !JSON.stringify(P.state()).includes('blue') && !JSON.stringify(P.state()).includes('tok-1') && P.state().current.gateway.headerNames.join() === 'X-Org,X-Team');
      check('gateway: an engine started later on this PC does not inherit stray routing variables', (() => { process.env.ANTHROPIC_BEDROCK_BASE_URL = 'http://elsewhere'; process.env.CLAUDE_CODE_USE_BEDROCK = '1'; const e = claudeCjs.authEnv(); delete process.env.ANTHROPIC_BEDROCK_BASE_URL; delete process.env.CLAUDE_CODE_USE_BEDROCK; return !e.ANTHROPIC_BEDROCK_BASE_URL && !e.CLAUDE_CODE_USE_BEDROCK; })());
      check('gateway: a web fetch skips the call to Anthropic first', claudeCjs.engineSettings().skipWebFetchPreflight === true && claudeCjs.engineSettings({ a: 1 }).a === 1);
      check('gateway: Claude Code mode is "api" (not the plan meter) while a gateway is set', claudeCjs.mode() === 'api');

      // a gateway in Amazon Bedrock's format
      const bedrockSeen = [];
      const bedrock = http.createServer((req, res) => {
        let body = ''; req.on('data', (d) => { body += d; });
        req.on('end', () => {
          bedrockSeen.push({ url: req.url, auth: req.headers.authorization, body });
          if (req.headers.authorization !== 'Bearer bk-1') { res.writeHead(403); return res.end('{"message":"nope"}'); }
          res.writeHead(400, J); res.end('{"message":"The provided model identifier is invalid."}'); // names the model: the address and key still count as accepted
        });
      });
      await listen(bedrock);
      const kBase = 'http://127.0.0.1:' + bedrock.address().port + '/bedrock';
      r = await P.test({ id: 'claude', key: 'bk-1', baseUrl: kBase, style: 'bedrock' });
      check('gateway (Bedrock style): checked with a Bedrock-format request, key as a bearer token', r.ok && r.style === 'bedrock' && bedrockSeen.some((x) => /^\/bedrock\/model\/.+\/invoke$/.test(x.url) && x.auth === 'Bearer bk-1' && /bedrock-2023-05-31/.test(x.body)), JSON.stringify({ r, bedrockSeen }));
      r = await P.test({ id: 'claude', key: 'wrong', baseUrl: kBase, style: 'bedrock' });
      check('gateway (Bedrock style): a wrong key is refused, with what to ask for', !r.ok && r.kind === 'refused' && /gateway's owner/.test(r.error), JSON.stringify(r));
      P.save({ id: 'claude', method: 'key', key: 'bk-1', baseUrl: kBase, models: { light: '', standard: 'anthropic.claude-sonnet-x', strong: '' }, gateway: { style: 'bedrock', headers: '', disableBetas: false, certFile: '' } });
      env = claudeCjs.authEnv();
      check('gateway (Bedrock style): the engine gets the Bedrock address, skips Bedrock signing, and uses no Anthropic address', env.CLAUDE_CODE_USE_BEDROCK === '1' && env.ANTHROPIC_BEDROCK_BASE_URL === kBase && env.CLAUDE_CODE_SKIP_BEDROCK_AUTH === '1' && env.ANTHROPIC_AUTH_TOKEN === 'bk-1' && !env.ANTHROPIC_BASE_URL && !env.AWS_BEARER_TOKEN_BEDROCK && env.ANTHROPIC_DEFAULT_SONNET_MODEL === 'anthropic.claude-sonnet-x' && env.DISABLE_TELEMETRY === '1', JSON.stringify(Object.keys(env).filter((k) => /ANTHROPIC|BEDROCK/.test(k))));

      // taking over Claude Code's own settings (a fixture file; the real one is read in its own check below)
      const fixture = path.join(tmp, 'claude-settings.json');
      process.env.AOS_CLAUDE_SETTINGS = fixture;
      const writeFix = (obj) => fs.writeFileSync(fixture, JSON.stringify(obj, null, 2));
      writeFix({ theme: 'dark', env: { ANTHROPIC_BASE_URL: bBase + '/', ANTHROPIC_AUTH_TOKEN: 'tok-1', ANTHROPIC_CUSTOM_HEADERS: 'X-Org: blue\nAuthorization: leak', ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-g', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-g', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1', NODE_EXTRA_CA_CERTS: 'C:\\certs\\root.pem' } });
      const fixSha = sha(fixture);
      let imp = P.importSettings();
      const shown = JSON.stringify(imp);
      check('import: finds the address, which variable holds the key, header names, model pins and switches', imp.ok && imp.found.baseUrl === bBase && imp.found.keyFrom === 'ANTHROPIC_AUTH_TOKEN' && imp.found.headerNames.join() === 'X-Org' && imp.found.models.standard === 'claude-sonnet-g' && imp.found.switches.includes('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS') && imp.found.switches.includes('NODE_EXTRA_CA_CERTS'), shown);
      check('import: what the window is shown never holds the key or a header value', !shown.includes('tok-1') && !shown.includes('blue') && !shown.includes('leak'));
      P.save({ id: 'claude', method: 'subscription' }); // start from "nothing saved"
      S.setSecret('key:claude', '');
      const applied = await P.applyImport();
      const after = P.state().current;
      env = claudeCjs.authEnv();
      check('import: confirmed, it is saved and checked against the gateway (bearer, models found, pins kept)', applied.ok && applied.check && applied.check.ok && applied.check.models.length === 3 && after.method === 'key' && after.baseUrl === bBase && after.key.saved && after.models.standard === 'claude-sonnet-g' && after.models.strong === 'claude-opus-g' && after.gateway.disableBetas && after.gateway.certFile === 'C:\\certs\\root.pem', JSON.stringify({ applied, after }));
      check('import: the engine then runs with what was taken over, and the stray Authorization header was dropped', env.ANTHROPIC_BASE_URL === bBase && env.ANTHROPIC_AUTH_TOKEN === 'tok-1' && env.ANTHROPIC_CUSTOM_HEADERS === 'X-Org: blue' && env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS === '1');
      check('import: the settings file it read is byte-identical afterwards', sha(fixture) === fixSha);
      writeFix({ env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BEDROCK_BASE_URL: kBase, CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1', ANTHROPIC_AUTH_TOKEN: 'bk-1' } });
      imp = P.importSettings();
      check('import: a Bedrock-style setup is recognised', imp.ok && imp.found.style === 'bedrock' && imp.found.baseUrl === kBase && imp.found.keyFrom === 'ANTHROPIC_AUTH_TOKEN' && imp.found.switches.includes('CLAUDE_CODE_SKIP_BEDROCK_AUTH'), JSON.stringify(imp));
      const applied2 = await P.applyImport();
      env = claudeCjs.authEnv();
      check('import: a Bedrock-style setup is saved and the engine gets the Bedrock variables', applied2.ok && applied2.check.ok && env.CLAUDE_CODE_USE_BEDROCK === '1' && env.ANTHROPIC_BEDROCK_BASE_URL === kBase && env.CLAUDE_CODE_SKIP_BEDROCK_AUTH === '1' && !env.ANTHROPIC_BASE_URL, JSON.stringify({ applied2 }));
      writeFix({ apiKeyHelper: 'get-key.sh', env: { ANTHROPIC_BASE_URL: bBase } });
      imp = P.importSettings();
      check('import: a key fetched by a command is not run; Agentic OS says to paste it', imp.ok && !imp.found.keyFrom && imp.found.notes.some((n) => /apiKeyHelper/.test(n) && /paste/i.test(n)), JSON.stringify(imp));
      writeFix({ theme: 'dark' });
      imp = P.importSettings();
      check('import: settings with no gateway in them say so plainly', !imp.ok && /no gateway address or key/.test(imp.error), JSON.stringify(imp));
      fs.rmSync(fixture);
      imp = P.importSettings();
      check('import: no settings file says so plainly', !imp.ok && /No Claude Code settings file/.test(imp.error), JSON.stringify(imp));
      delete process.env.AOS_CLAUDE_SETTINGS;
      const realFile = gwlib.claudeSettingsPath();
      const realBefore = fs.existsSync(realFile) ? sha(realFile) : '';
      const realRun = P.importSettings(); // the real file, read only; the answer is not looked at, only that the file is untouched
      check('import: the real Claude Code settings file is byte-identical before and after a read', (fs.existsSync(realFile) ? sha(realFile) : '') === realBefore && typeof realRun.ok === 'boolean');

      // plain errors
      const closed = http.createServer(); await listen(closed); const deadBase = 'http://127.0.0.1:' + closed.address().port; await new Promise((res) => closed.close(res));
      r = await P.test({ id: 'claude', key: 'k', baseUrl: deadBase });
      check('error: address not reachable says to check the VPN and ask for the address', !r.ok && r.kind === 'unreachable' && /VPN/.test(r.error) && /gateway's owner/.test(r.error), JSON.stringify(r));
      r = await P.test({ id: 'claude', key: 'nope', baseUrl: bBase, headers: 'X-Org: blue' });
      check('error: key refused says what to ask the gateway owner for', !r.ok && r.kind === 'refused' && /gateway's owner/.test(r.error), JSON.stringify(r));
      const picky = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(400, J); res.end('{"error":{"message":"context_management: Extra inputs are not permitted"}}'); }); });
      await listen(picky);
      r = await P.test({ id: 'claude', key: 'k', baseUrl: 'http://127.0.0.1:' + picky.address().port });
      check('error: a gateway that rejects the request shape points to the "rejects some requests" switch', !r.ok && r.kind === 'shape' && /rejects some requests/.test(r.error), JSON.stringify(r));
      const html = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>sign in</html>'); });
      await listen(html);
      r = await P.test({ id: 'claude', key: 'k', baseUrl: 'http://127.0.0.1:' + html.address().port });
      check('error: a sign-in page instead of a gateway is called what it is', !r.ok && r.kind === 'notGateway', JSON.stringify(r));
      // a company certificate this PC does not trust: a self-signed https server
      const crt = path.join(tmp, 'x.crt'), keyf = path.join(tmp, 'x.key');
      const ossl = require('child_process').spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyf, '-out', crt, '-days', '2', '-subj', '/CN=localhost'], { encoding: 'utf8' });
      if (ossl.status === 0) {
        const tls = require('https').createServer({ key: fs.readFileSync(keyf), cert: fs.readFileSync(crt) }, (req, res) => { res.writeHead(200, J); res.end('{"data":[]}'); });
        await listen(tls);
        r = await P.test({ id: 'claude', key: 'k', baseUrl: 'https://localhost:' + tls.address().port });
        check('error: a certificate this PC does not trust says to ask for the company root certificate', !r.ok && r.kind === 'cert' && /root certificate/.test(r.error) && /Certificate file/.test(r.error), JSON.stringify(r));
        tls.close();
      } else check('error: a certificate this PC does not trust (no openssl here, so the wording check only)', gwlib.netErrorKind(new Error('net::ERR_CERT_AUTHORITY_INVALID')) === 'cert' && gwlib.netErrorKind({ message: 'fetch failed', cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } }) === 'cert');
      check('error: what the engine reports mid-chat becomes plain words (unreachable, certificate, key, request shape)', /VPN/.test(gwlib.friendlyError('API Error: Unable to connect (ECONNREFUSED)')) && /root certificate/.test(gwlib.friendlyError('unable to verify the first certificate')) && /gateway's owner/.test(gwlib.friendlyError('API Error: 401 invalid x-api-key')) && /rejects some requests/.test(gwlib.friendlyError('400 context_management Extra inputs are not permitted')) && gwlib.friendlyError('something else') === '');
      for (const sv of [bearer, bedrock, picky, html]) sv.close();
      S.set({ provider: prev });
      S.setSecret('key:claude', ''); S.setSecret('headers:claude', '');
    }

    // ---------- Amazon Bedrock through a gateway: the way Claude Code itself is set up for it ----------
    {
      const claudeCjs = require('../electron/claude.cjs');
      const gwlib = require('../electron/gateway.cjs');
      const S = require('../electron/settings.cjs');
      const P = require('../electron/providers.cjs');
      const prev = S.get('provider');
      const seen = [];
      const bedrock2 = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          seen.push({ url: req.url, auth: req.headers.authorization });
          if (req.headers.authorization !== 'Bearer bk-2') { res.writeHead(403); return res.end('{"message":"nope"}'); }
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"message":"The provided model identifier is invalid."}');
        });
      });
      await new Promise((r) => bedrock2.listen(0, '127.0.0.1', r));
      const base2 = 'http://127.0.0.1:' + bedrock2.address().port + '/bedrock';
      const fixture = path.join(tmp, 'claude-settings-bedrock.json');
      process.env.AOS_CLAUDE_SETTINGS = fixture;
      const arn = 'arn:aws:bedrock:us-east-2:123456789012:application-inference-profile/opus-prod';
      const writeFix = (obj) => fs.writeFileSync(fixture, JSON.stringify(obj, null, 2));
      writeFix({
        modelOverrides: { 'claude-opus-4-7': arn },
        env: {
          CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BEDROCK_BASE_URL: base2, AWS_BEARER_TOKEN_BEDROCK: 'bk-2', AWS_REGION: 'us-east-1',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'us.anthropic.claude-sonnet-4-6', ANTHROPIC_BEDROCK_REGION_PREFIX: 'us', DISABLE_PROMPT_CACHING: '1',
          AWS_PROFILE: 'ibm-sso', SOMETHING_ELSE: 'not copied',
        },
      });
      let imp = P.importSettings();
      const shown = JSON.stringify(imp);
      check('bedrock import: a Bedrock API key in AWS_BEARER_TOKEN_BEDROCK is found, with the region and the settings that go with it', imp.ok && imp.found.style === 'bedrock' && imp.found.keyFrom === 'AWS_BEARER_TOKEN_BEDROCK' && imp.found.region === 'us-east-1' && imp.found.extras.includes('ANTHROPIC_BEDROCK_REGION_PREFIX') && imp.found.extras.includes('DISABLE_PROMPT_CACHING') && imp.found.extras.includes('modelOverrides') && imp.found.models.standard === 'us.anthropic.claude-sonnet-4-6', shown);
      check('bedrock import: nothing else is copied, and the key is never shown', !imp.found.extras.includes('SOMETHING_ELSE') && !shown.includes('bk-2') && !shown.includes('not copied'));
      check('bedrock import: an AWS sign-in in the settings is said plainly to be something Agentic OS does not do', imp.found.notes.some((n) => /AWS_PROFILE/.test(n) && /does not do that/.test(n)), shown);
      P.save({ id: 'claude', method: 'subscription' }); S.setSecret('key:claude', '');
      const applied = await P.applyImport();
      check('bedrock import: saved, and the check used the model name from the settings and the Bedrock key as a bearer token', applied.ok && applied.check.ok && seen.some((x) => x.url === '/bedrock/model/' + encodeURIComponent('us.anthropic.claude-sonnet-4-6') + '/invoke' && x.auth === 'Bearer bk-2'), JSON.stringify({ applied, seen }));
      let env = claudeCjs.authEnv();
      check('bedrock engine: Bedrock on, the gateway address, the Bedrock key in its own variable, the region and the plain settings', env.CLAUDE_CODE_USE_BEDROCK === '1' && env.ANTHROPIC_BEDROCK_BASE_URL === base2 && env.AWS_BEARER_TOKEN_BEDROCK === 'bk-2' && !env.ANTHROPIC_AUTH_TOKEN && env.AWS_REGION === 'us-east-1' && env.ANTHROPIC_BEDROCK_REGION_PREFIX === 'us' && env.DISABLE_PROMPT_CACHING === '1' && env.ANTHROPIC_DEFAULT_SONNET_MODEL === 'us.anthropic.claude-sonnet-4-6' && !env.SOMETHING_ELSE, JSON.stringify(Object.keys(env).filter((k) => /ANTHROPIC|BEDROCK|AWS/.test(k))));
      check('bedrock engine: AWS signing is always skipped (Agentic OS signs nothing), so the engine makes no startup model probes', env.CLAUDE_CODE_SKIP_BEDROCK_AUTH === '1');
      check('bedrock engine: the company\'s own profile map is handed to Claude Code', JSON.stringify(claudeCjs.engineSettings().modelOverrides) === JSON.stringify({ 'claude-opus-4-7': arn }) && claudeCjs.engineSettings().skipWebFetchPreflight === true);
      // model names: through a gateway only the pinned tiers are asked for, by their plain names, so the pins apply
      const m = claudeCjs;
      check('gateway models: sonnet is asked for by name; a tier with nothing pinned falls back to sonnet instead of a model the account may lack', m.engineModel(m.SONNET) === 'sonnet' && m.engineModel(m.HAIKU) === 'sonnet' && m.engineModel(m.OPUS) === 'sonnet' && m.engineModel('claude-fable-5-1') === 'sonnet' && m.helperDefs().scout.model === 'sonnet');
      P.save({ id: 'claude', method: 'key', models: { light: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', standard: 'us.anthropic.claude-sonnet-4-6', strong: 'us.anthropic.claude-opus-4-8' } });
      check('gateway models: with all three pinned, haiku, sonnet and opus are asked for by name', m.engineModel(m.HAIKU) === 'haiku' && m.engineModel(m.OPUS) === 'opus' && m.engineModel('claude-fable-5-1') === 'opus' && m.helperDefs().scout.model === 'haiku');
      S.set({ provider: { ...S.get('provider'), id: 'claude', method: 'subscription', baseUrl: '' } });
      check('gateway models: on a Claude plan or an Anthropic key the exact version is asked for, as before', m.engineModel(m.HAIKU) === m.HAIKU && m.engineModel(m.SONNET) === m.SONNET);
      // the same, but this time the settings do skip AWS signing and use a plain token
      writeFix({ env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BEDROCK_BASE_URL: base2, CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1', AWS_BEARER_TOKEN_BEDROCK: 'bk-2' } });
      imp = P.importSettings(); await P.applyImport(); env = claudeCjs.authEnv();
      check('bedrock engine: the same with a settings file that already skips AWS signing', env.CLAUDE_CODE_SKIP_BEDROCK_AUTH === '1' && env.AWS_BEARER_TOKEN_BEDROCK === 'bk-2');
      // a stray region on this PC does not leak in
      process.env.AWS_REGION = 'eu-west-1'; process.env.AWS_PROFILE = 'x';
      P.save({ id: 'claude', method: 'key', baseUrl: base2, gateway: { style: 'bedrock', region: '' } });
      env = claudeCjs.authEnv();
      delete process.env.AWS_REGION; delete process.env.AWS_PROFILE;
      check('bedrock engine: a stray AWS_REGION on this PC does not reach the engine', env.AWS_REGION === undefined);
      // settings that only sign in as an AWS identity
      writeFix({ awsAuthRefresh: 'aws sso login --profile ibm', env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'ibm', AWS_REGION: 'us-east-1' } });
      imp = P.importSettings();
      check('bedrock import: settings that only sign in as an AWS identity (no gateway address) say so, and what to do', !imp.ok && /AWS sign-in/.test(imp.error) && /gateway address and key/.test(imp.error), JSON.stringify(imp));
      check('bedrock errors: the stream, inference-profile and model-access messages are put in plain words', /pass Amazon Bedrock's streaming replies/.test(gwlib.friendlyError('Bedrock streaming response has content-type text/event-stream')) && /inference-profile model name/.test(gwlib.friendlyError("400 on-demand throughput isn't supported")) && /refused that model/.test(gwlib.friendlyError('The provided model identifier is invalid')));
      fs.rmSync(fixture, { force: true });
      delete process.env.AOS_CLAUDE_SETTINGS;
      bedrock2.close();
      S.set({ provider: prev });
      S.setSecret('key:claude', ''); S.setSecret('headers:claude', '');
    }

    // ---------- nothing is copied from any other app ----------
    const importV1 = require('../electron/import-v1.cjs');
    check('no import: the stand-in finds nothing and copies nothing', importV1.look().found === false && Object.keys(importV1.run({ chats: true })).length === 0);
    check('no chat-app link: nothing is read or started', Object.keys(require('../electron/discord.cjs').readConfig([tmp])).length === 0);

    // ---------- Projects: deliverables as tiles ----------
    const dv = path.join(tmp, 'vault3');
    put('projects/Alpha/README.md', '---\ntitle: Alpha\ndescription: A test project.\n---\n# Alpha\n', dv);
    put('projects/Alpha/output/plan.md', '---\ntitle: The plan\ndescription: One line about the plan.\n---\n# Plan\n', dv);
    put('projects/Alpha/output/index.md', '# Index\n', dv);
    put('projects/Alpha/output/designs/mock.png', 'png', dv);
    put('projects/Alpha/input/call.md', '# Call\n', dv);
    const vlt = require('../electron/vault.cjs');
    const keep = vlt.ROOT;
    vlt.setRoot(dv);
    const alpha = vlt.projects().find((p) => p.folder === 'Alpha');
    check('projects: deliverables are the output folder files, with the header title and description, index pages left out', !!alpha && alpha.deliverables.length === 2 && alpha.deliverables.some((x) => x.title === 'The plan' && x.description === 'One line about the plan.') && !alpha.deliverables.some((x) => /index\.md$/.test(x.path)));
    check("projects: a file in a subfolder of output keeps its folder name, and the project's own notes are listed apart", !!alpha && alpha.deliverables.some((x) => x.sub.endsWith('output/designs') && x.kind === 'image') && alpha.working.some((x) => x.path.endsWith('input/call.md')) && alpha.deliverables.every((x) => typeof x.modified === 'number' && x.modified > 0));
    vlt.setRoot(keep);

    // ---------- the vault can move without a restart ----------
    const vault = require('../electron/vault.cjs');
    const other = path.join(tmp, 'vault2');
    put('index.md', '# Other\n', other);
    vault.setRoot(other);
    check('vault: switching folders takes effect at once', vault.info().notes === 1 && vault.ROOT === other && vault.resolveInside('../vault/index.md') === null);
  } catch (err) {
    failed++;
    console.log('FAIL  the test run itself broke:', err && err.stack ? err.stack : err);
  } finally {
    console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows may still hold a file; it is in the temp folder */ }
    app.exit(failed ? 1 : 0);
  }
});
