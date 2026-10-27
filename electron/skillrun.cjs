// Run a skill without a chat (the Run button in the Skills panel). One headless engine run through the same
// gateway settings as the chat, with the same safety gate (policy.cjs) except that nobody is there to answer a
// yes/no card, so anything that would need one is refused and the run reports it.
// Each run is one line in runs.log (app data folder) and a 'run:<skill>' entry in jobs.json.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const vault = require('./vault.cjs');
const policy = require('./policy.cjs');
const jobs = require('./jobs.cjs');

const MAX_MS = 20 * 60 * 1000;
const MODELS = { haiku: 'haiku', sonnet: 'sonnet' }; // what the button offers; engine.engineModel maps them
const running = new Map(); // skill name -> { at, abort }
const SKILL = /^[a-z0-9][a-z0-9-]*$/;

const logFile = () => path.join(app.getPath('userData'), 'runs.log');
function log(line) { try { fs.appendFileSync(logFile(), line + '\n'); } catch { /* a missing log must not fail a run */ } }
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// Last runs, newest first, for the panel: [{ at, skill, model, ok, secs, note }]
function recent(limit = 30) {
  let raw = '';
  try { raw = fs.readFileSync(logFile(), 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const state = () => [...running.entries()].map(([skill, r]) => ({ skill, since: r.at }));

// engine: the claude.cjs exports (authEnv, engineSettings, engineModel, oneShot). emit(evt) tells the window.
async function run({ skill, model = 'sonnet', engine, emit }) {
  skill = String(skill || '');
  if (!SKILL.test(skill)) throw new Error('not a skill name');
  if (!fs.existsSync(path.join(vault.ROOT, 'skills', skill, 'SKILL.md'))) throw new Error(`no skill called ${skill}`);
  if (running.has(skill)) throw new Error(`${skill} is already running`);
  const want = MODELS[model] ? model : 'sonnet';
  const abort = new AbortController();
  running.set(skill, { at: Date.now(), abort });
  emit({ type: 'start', skill, model: want });
  const t0 = Date.now();
  const timer = setTimeout(() => abort.abort(), MAX_MS);
  let ok = false; let note = '';
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const refusals = [];
    const canUseTool = async (tool, input) => {
      const c = policy.check(tool, input);
      if (c.ask) { refusals.push(c.summary); return { behavior: 'deny', message: 'This run is unattended, so anything that needs the user\'s yes is refused. Skip it and say what you skipped.' }; }
      for (const b of c.backups || []) if (!policy.backupAny(b) && fs.existsSync(b)) return { behavior: 'deny', message: `Not run: the safety copy of ${b} could not be made first.` };
      if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) policy.backup(path.resolve(vault.ROOT, String(input.file_path || input.notebook_path || '')));
      return { behavior: 'allow', updatedInput: input };
    };
    const q = query({
      prompt: `Use the ${skill} skill (aos:${skill}) and carry it out now, start to finish. This is an unattended run: nobody can answer questions, so make the sensible choice the skill describes, and finish with two or three plain lines saying what was done, what changed, and anything that needs the user.`,
      options: {
        cwd: vault.ROOT,
        model: engine.engineModel(want === 'haiku' ? engine.HAIKU : engine.SONNET),
        abortController: abort,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        allowedTools: ['Read', 'Grep', 'Glob', 'Skill'],
        disallowedTools: ['Agent', 'Task', 'AskUserQuestion', 'WebSearch', 'WebFetch'],
        plugins: [{ type: 'local', path: vault.ROOT }],
        skills: 'all',
        permissionMode: 'default',
        canUseTool,
        maxTurns: 80,
        persistSession: false,
        settingSources: [],
        mcpServers: {},
        strictMcpConfig: true,
        settings: engine.engineSettings({ disableClaudeAiConnectors: true }),
        env: engine.authEnv(),
      },
    });
    let result = null;
    for await (const m of q) if (m.type === 'result') result = m;
    if (!result) throw new Error('no answer came back');
    if (result.is_error) throw new Error(`the run failed (${result.subtype || 'error'})`);
    ok = true;
    note = (typeof result.result === 'string' ? result.result : '').trim().replace(/\s+/g, ' ').slice(0, 400) || 'Finished.';
    if (refusals.length) note += ` [Refused ${refusals.length} action${refusals.length === 1 ? '' : 's'} that needed a yes: ${refusals[0].slice(0, 80)}]`;
  } catch (err) {
    note = abort.signal.aborted ? `stopped after ${Math.round((Date.now() - t0) / 60000)} min` : String((err && err.message) || err).slice(0, 300);
  } finally {
    clearTimeout(timer);
    running.delete(skill);
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  log(JSON.stringify({ at: stamp(), skill, model: want, ok, secs, note }));
  jobs.mark(`run:${skill}`, { ok, ms: Date.now() - t0, note });
  emit({ type: 'done', skill, ok, secs, note });
  return { ok, secs, note };
}

function stop(skill) {
  const r = running.get(String(skill));
  if (!r) return false;
  r.abort.abort();
  return true;
}

// The check to make before trusting the button: one plain question through the same gateway and settings, on the
// cheapest model. Says whether a background run can work at all, and what the gateway said if not.
async function test(engine) {
  const t0 = Date.now();
  try {
    const r = await engine.oneShot({ system: 'Answer in one word.', prompt: 'Reply with the single word OK.', model: 'haiku' });
    const r2 = { ok: true, secs: Math.round((Date.now() - t0) / 100) / 10, model: r.model, reply: String(r.text || '').slice(0, 40) };
    log(JSON.stringify({ at: stamp(), skill: '(test)', model: r.model, ok: true, secs: r2.secs, note: `reply: ${r2.reply}` }));
    return r2;
  } catch (err) {
    const error = String((err && err.message) || err).slice(0, 300);
    log(JSON.stringify({ at: stamp(), skill: '(test)', model: 'haiku', ok: false, secs: Math.round((Date.now() - t0) / 1000), note: error }));
    return { ok: false, error };
  }
}

module.exports = { run, stop, test, recent, state };
