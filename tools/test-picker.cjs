// The model picker against a stand-in gateway on localhost. The stand-in lists several Claude models and some others,
// and refuses one of the Claude models the way a company gateway can ("not available"). Checks that the picker offers
// the Claude models the gateway has, greys out the refused one, never offers the others, and that a pinned model is
// sent to the engine under its exact name. Throwaway data folder; no real service; no tokens.
// Run:  node_modules\.bin\electron tools\test-picker.cjs
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-picker-'));
app.setPath('userData', tmp);
process.env.AOS_USERDATA = tmp;
process.env.ANTHROPIC_API_KEY = 'stand-in-key';

app.whenReady().then(async () => {
  let passed = 0, failed = 0;
  const check = (name, ok, extra = '') => { console.log(ok ? 'ok   ' : 'FAIL ', name, ok ? '' : extra); ok ? passed++ : failed++; };
  const J = { 'Content-Type': 'application/json' };
  const asked = [];
  const gw = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, J);
        return res.end(JSON.stringify({ data: ['gpt-5.1', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'gemini-3.5-flash', 'claude-advantage-assist'].map((id) => ({ id })) }));
      }
      let model = '';
      try { model = JSON.parse(body).model; } catch { /* not json */ }
      asked.push(model);
      if (model === 'claude-opus-5-5') { res.writeHead(400, J); return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'E003: Model not available for Coding Agents.' } })); }
      res.writeHead(200, J);
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((r) => gw.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + gw.address().port;

  try {
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify({
      onboarded: true,
      provider: { id: 'claude', method: 'key', baseUrl: base, models: { light: 'claude-sonnet-5-5', standard: 'claude-sonnet-5-5', strong: 'claude-advantage-assist' }, keyHeader: 'bearer', gateway: { style: 'anthropic', disableBetas: false, certFile: '', keyVar: 'ANTHROPIC_AUTH_TOKEN', skipAuth: true, region: '', extraEnv: {}, modelOverrides: {} } },
    }));
    const claude = require('../electron/claude.cjs');
    await claude.refreshGatewayModels(true);
    await claude.probeGatewayModels();
    const choices = claude.status().choices;
    const ids = choices.map((c) => c.id);

    check('Auto comes first', ids[0] === null);
    check('every Claude model the gateway lists is offered', ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-advantage-assist', 'claude-opus-5-5'].every((m) => ids.includes(m)), JSON.stringify(ids));
    check('models that are not Claude are not offered', !ids.some((i) => /gpt|gemini/i.test(String(i))), JSON.stringify(ids));
    check('a model the gateway refuses is offered greyed out, not selectable', choices.find((c) => c.id === 'claude-opus-5-5')?.unavailable === true && choices.filter((c) => c.unavailable).length === 1, JSON.stringify(choices));
    check('names read plainly', choices.find((c) => c.id === 'claude-haiku-5-5')?.name === 'Haiku 5.5' && choices.find((c) => c.id === 'claude-advantage-assist')?.name === 'Advantage Assist', JSON.stringify(choices.map((c) => c.name)));

    for (const m of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-advantage-assist']) {
      const r = claude.setPick('t', m, null);
      const sent = r.model ? claude.engineModel(claude.pickModel({ pick: r.model }, 'hello', false)) : null;
      check(`pinning ${m} sends exactly ${m} to the engine`, r.model === m && sent === m, JSON.stringify({ r, sent }));
    }
    check('a refused model cannot be pinned', claude.setPick('t', 'claude-opus-5-5', null).model === null);
    check('a family word such as fable cannot be pinned through this gateway', claude.setPick('t', 'fable', null).model === null);
    // The user can type any model name in the picker: it is pinned as typed and sent as typed (the gateway says if it does not know it).
    const typed = claude.setPick('t', 'gpt-5.1', null);
    check('a name the user types is pinned and sent exactly as typed', typed.model === 'gpt-5.1' && claude.engineModel(claude.pickModel({ pick: typed.model }, 'hello', false)) === 'gpt-5.1', JSON.stringify(typed));
    check('a name that is not a valid model id is not pinned', claude.setPick('t', 'two words; rm', null).model === null);
    check('Auto clears the pin', claude.setPick('t', null, null).model === null);

    const before = asked.length;
    await claude.probeGatewayModels();
    check('the models are probed once, not on every look', asked.length === before, `${asked.length - before} more requests`);
  } catch (err) {
    check('the picker test ran', false, String((err && err.stack) || err));
  } finally {
    console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
    gw.close();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows may still hold a file; it is in the temp folder */ }
    app.exit(failed ? 1 : 0);
  }
});
