// Dreams: once a night Agentic OS looks over the last week and hands the user four things worth doing.
//
// The PC does the counting, the model does the noticing: a local pass builds a short digest (questions,
// repeated asks, cost, skills, notes vs chats, sessions, project status) and one model call turns it into
// four JSON cards. Cards whose evidence quotes numbers that aren't in the digest are dropped.
// Runs at the chosen hour (2 am), or on the next launch if the PC was off then. Never blocks the chat:
// it is its own short call, with no tools (web search only if the user switches the web check on).
// Stored in dreams/YYYY-MM-DD.json in the app data folder; "done" and "not useful" are remembered in
// dreams/feedback.json so the same card doesn't come back.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const vault = require('./vault.cjs');
const history = require('./history.cjs');
const insights = require('./insights.cjs');
const ledger = require('./ledger.cjs');
const jobs = require('./jobs.cjs');
const engine = require('./engine.cjs');

const DAY = history.DAY;
const dir = () => path.join(app.getPath('userData'), 'dreams');
const settingsFile = () => path.join(dir(), 'settings.json');
const feedbackFile = () => path.join(dir(), 'feedback.json');
const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const { readJson, writeJson: save } = require('./store.cjs');
const writeJson = (f, v) => save(f, v, 1); // saved atomically, indented one space so it can be read by eye

const DIMENSIONS = ['chats', 'cost', 'skills', 'memory', 'sessions', 'workflow', 'outside', 'business'];

function settings() { return { hour: 2, web: false, ...readJson(settingsFile(), {}) }; }
function setSettings(patch) {
  const s = settings();
  if (patch && Number.isInteger(patch.hour) && patch.hour >= 0 && patch.hour <= 23) s.hour = patch.hour;
  if (patch && typeof patch.web === 'boolean') s.web = patch.web;
  writeJson(settingsFile(), s);
  return s;
}

function files() {
  try { return fs.readdirSync(dir()).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort(); } catch { return []; }
}
const load = (name) => readJson(path.join(dir(), name), null);

// What the Dreams panel shows: the latest dream, a few earlier ones, settings, and whether one is running.
function state() {
  const names = files();
  const latest = names.length ? load(names[names.length - 1]) : null;
  const earlier = names.slice(-8, -1).reverse().map((n) => {
    const d = load(n);
    const cards = (d && d.cards) || [];
    return { day: d ? d.day : n.slice(0, 10), total: cards.length, done: cards.filter((c) => c.status === 'done').length, skipped: cards.filter((c) => c.status === 'skip').length };
  });
  return { latest, earlier, settings: settings(), running: !!running, next: nextRun() };
}

// Open cards in the latest dream: the count on the moon pill and the menu.
function unread() {
  const names = files();
  const d = names.length ? load(names[names.length - 1]) : null;
  return d && d.cards ? d.cards.filter((c) => c.status === 'open').length : 0;
}

// Same card again = same gist. Fingerprint: the headline's longer words, sorted.
const fingerprint = (h) => [...new Set(String(h).toLowerCase().match(/[a-z0-9_]{4,}/g) || [])].sort().slice(0, 10).join(' ');

function mark(day, id, status) {
  if (!['open', 'done', 'skip'].includes(status)) return false;
  const f = path.join(dir(), `${day}.json`);
  const d = readJson(f, null);
  const card = d && d.cards && d.cards.find((c) => c.id === id);
  if (!card) return false;
  card.status = status;
  writeJson(f, d);
  const fb = readJson(feedbackFile(), []).filter((x) => x.fp !== fingerprint(card.headline));
  if (status !== 'open') fb.push({ fp: fingerprint(card.headline), headline: card.headline, status, t: Date.now() });
  writeJson(feedbackFile(), fb.slice(-200));
  notify({ phase: 'marked', unread: unread() });
  return true;
}

// ---------- the digest ----------

const STOP = new Set('that this with from have what your about there their they them then than when were will would could should into just like make more some only also been does each very want need know look sure okay right please thanks assistant'.split(' '));
const words = (t) => new Set((t.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) || []).filter((w) => !STOP.has(w)));
const jaccard = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / (a.size + b.size - n || 1); };
const when = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const ago = (t) => (t ? `${Math.max(0, Math.round((Date.now() - t) / DAY))} days ago` : 'never');
const usd = (v) => `$${(v || 0).toFixed(2)}`;

// Groups of 3+ similar questions: the "you did this by hand three times" signal.
function repeats(prompts) {
  const items = prompts.map((p) => ({ ...p, w: words(p.text) })).filter((p) => p.w.size >= 3);
  const groups = [];
  for (const p of items) {
    const g = groups.find((x) => jaccard(x.w, p.w) >= 0.4);
    if (g) { g.items.push(p); for (const w of p.w) g.w.add(w); } else groups.push({ w: new Set(p.w), items: [p] });
  }
  return groups.filter((g) => g.items.length >= 3 && new Set(g.items.map((i) => dayKey(i.t))).size >= 2).slice(0, 6);
}

async function digest() {
  const now = Date.now();
  const s = settings();
  const h = await history.load();
  const week = h.prompts.filter((p) => now - p.t < 7 * DAY);
  const [health, value] = await Promise.all([insights.health(0), insights.value(null)]);
  const out = [];
  const used = new Set();

  out.push(`Today: ${dayKey(now)}. Window: the last 7 days. History starts ${h.since ? dayKey(h.since) : 'today'}.`);

  // questions, newest kept when clipping
  const seen = new Set();
  const lines = [];
  for (const p of week.slice().reverse()) {
    const t = p.text.replace(/\s+/g, ' ').slice(0, 220);
    if (seen.has(t)) continue;
    seen.add(t);
    lines.push(`- [${when(p.t)}] ${t}`);
    if (lines.join('\n').length > 8000) break;
  }
  out.push(`## the user's questions (${week.length} in 7 days; up to the newest ${lines.length} shown, newest first)\n${lines.join('\n') || '- none'}`);
  if (week.length) used.add('chats');

  const reps = repeats(week);
  out.push(`## Repeated asks (3+ similar questions on 2+ days)\n${reps.map((g) => `- ${g.items.length} times: ${g.items.slice(0, 3).map((i) => `"${i.text.replace(/\s+/g, ' ').slice(0, 90)}" (${when(i.t)})`).join('; ')}`).join('\n') || '- none found'}`);
  if (reps.length) used.add('workflow');

  const sum = ledger.summary(null, 'plan');
  const f = value.fit;
  if (sum.month.questions) used.add('cost');
  out.push(`## Cost this month (API-price equivalent, not a bill; questions through the app only. Rows before 2026-10-04 can name Haiku for work a bigger model did, so don't judge model choice from those)
- ${sum.month.questions} questions, ${usd(sum.month.cost)} total
${sum.models.map((m) => `- ${m.model}: ${m.questions} questions, ${usd(m.cost)}`).join('\n')}
- short lookups that opened a chat on a model above Haiku: ${f.heavyLookups.n} (${usd(f.heavyLookups.cost)}${f.heavyLookups.saving != null ? `, about ${usd(f.heavyLookups.saving)} more than Haiku` : ''}); counted over ${f.sizedCount} questions. Short lookups in the middle of a chat stay on the chat's model on purpose (switching re-reads the whole chat), so they are not counted and are not a saving
- automatic Lessons pass runs: ${f.auto.n} (${usd(f.auto.cost)}). They run on Sonnet on purpose, so don't suggest moving them to Haiku
- share of tokens that were cache reads: ${f.cacheShare != null ? Math.round(f.cacheShare * 100) + '%' : 'unknown'}
- chats over 60 messages this month: ${f.longChats}`);

  if (health.skills.length) used.add('skills');
  const young = h.since && now - h.since < 30 * DAY ? `; the logs only start ${dayKey(h.since)}, so 0 uses means none since then, not none in 30 days` : '';
  out.push(`## Skills (uses in the last 30 days, from the session logs${young})\n${health.skills.map((k) => `- ${k.name}: ${k.uses} uses, last used ${ago(k.last)}`).join('\n')}`);

  if (health.memory.length) used.add('memory');
  out.push(`## Project notes vs chat (notes = newest edit in the project folder; chat = newest question naming it)\n${health.memory.slice(0, 14).map((m) => `- ${m.folder}: notes ${ago(m.notes)}, chat ${ago(m.chat)}${m.behind ? `, ${m.behind} days behind` : ''}${m.mentionsSince ? `, ${m.mentionsSince} questions since the last note edit` : ''}`).join('\n')}`);

  used.add('sessions');
  out.push(`## Sessions per day (runs of questions with no gap over 30 minutes)\n- ${health.sessions.days.map((d) => `${d.day}: ${d.n}`).join(', ')}`);

  let projects = [];
  try { projects = vault.projects(); } catch { /* ignore */ }
  if (projects.length) used.add('business');
  out.push(`## Projects (status lines from each README, newest edited first)\n${projects.slice(0, 14).map((p) => `- ${p.folder}: ${(p.status || p.description || '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')}`);

  const fb = readJson(feedbackFile(), []).slice(-40);
  out.push(`## Already handled (never suggest these again, or anything with the same gist)\n${fb.map((x) => `- ${x.headline} (${x.status === 'done' ? 'done' : 'not useful'})`).join('\n') || '- none'}`);

  if (s.web) used.add('outside');
  return { text: out.join('\n\n'), dims: DIMENSIONS.filter((d) => used.has(d)), read: { questions: week.length, days: 7 } };
}

// ---------- the dream ----------

const CARD_SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array', maxItems: 4,
      items: {
        type: 'object',
        properties: {
          dimension: { type: 'string', enum: DIMENSIONS },
          headline: { type: 'string', description: 'One plain sentence naming what was noticed, specific, with the count. Under 110 characters.' },
          why: { type: 'string', description: 'One or two plain sentences: why it matters and what doing it gets the user.' },
          evidence: { type: 'string', description: 'Short facts copied from the digest: counts, dates, costs. Every number here must appear in the digest.' },
          saves: { type: 'string', description: 'Rough saving, e.g. "~20 min/week" or "~$3 a month at API prices". A guess, keep it modest.' },
          savesKind: { type: 'string', enum: ['time', 'money'] },
          button: { type: 'string', description: 'Two to four words for the action button, e.g. "Update the notes".' },
          action: { type: 'string', description: 'The exact request Agentic OS will be sent if the user presses the button, written as the user asking Agentic OS to do it, self-contained (names the files, project or skill).' },
        },
        required: ['dimension', 'headline', 'why', 'evidence', 'saves', 'savesKind', 'button', 'action'],
      },
    },
  },
  required: ['cards'],
};

const SYSTEM = `You are the nightly "Dreams" pass of Agentic OS, the user's assistant. You read a digest of their last week (questions they asked, repeated asks, token costs, skill use, how far project notes lag behind their chats, sessions, project status) and pick the FOUR most useful, concrete things they could do to save time or money, or keep their notes in step with their work.
Rules:
- Only use facts in the digest. Every number in "evidence" must appear in the digest. Aim for four cards about four different things; if there isn't enough for four good ones, return fewer. Never pad, never invent.
- Look hard at their questions: themes they keep coming back to, tasks they walk Agentic OS through step by step each time, things they correct Agentic OS on, and projects they work on that the notes don't reflect.
- Don't suggest writing up work that the project notes already show as edited today.
- Prefer: work the user repeated by hand (could become a skill or a note), notes that have fallen behind what they talk about, money spent on a heavier model than the job needed, skills that are never used, chats that ran too long.
- Never repeat anything in "Already handled", or anything with the same gist.
- Plain words, no jargon, no file paths in the headline. Talk to the user as "you".
- The action must be something Agentic OS can do in the vault or the app when asked, and is sent to it as a normal request (edits still need the user's yes).`;

let running = null;
let notify = () => {};

async function run(reason = 'schedule') {
  if (running) return running;
  running = (async () => {
    const t0 = Date.now();
    const s = settings();
    notify({ phase: 'start', reason });
    let d;
    try {
      d = await digest();
      const r = await engine.oneShot({
        system: SYSTEM,
        prompt: `[Dreams digest, not from the user]\n\n${d.text}\n\nReturn four cards if the digest supports four distinct, useful ones; fewer only if it truly doesn't.${s.web ? ' You may use web search for at most ONE card about a fresh, relevant outside resource (dimension "outside"); put the source URL in its evidence.' : ''}`,
        schema: CARD_SCHEMA, web: s.web,
      });
      ledger.add({ model: r.model, input: r.usage.input, output: r.usage.output, cacheRead: r.usage.cacheRead, cacheWrite: r.usage.cacheWrite,
        cost: r.cost || 0, reads: 0, edits: 0, error: false, kind: 'dream', asked: r.model, ms: Date.now() - t0 });
      let out = r.out;
      if (!out && r.text) { const m = r.text.match(/\{[\s\S]*\}/); if (m) try { out = JSON.parse(m[0]); } catch { /* handled below */ } }
      const raw = (out && Array.isArray(out.cards) ? out.cards : []);
      // Evidence check: every number the card quotes must be in the digest (web cards may cite a URL instead).
      const digits = new Set(d.text.match(/\d+(?:\.\d+)?/g) || []);
      const handled = new Set(readJson(feedbackFile(), []).map((x) => x.fp));
      const cards = raw.filter((c) => c && c.headline && c.action)
        .filter((c) => c.dimension === 'outside' || (String(c.evidence).match(/\d+(?:\.\d+)?/g) || []).every((n) => digits.has(n)))
        .filter((c) => !handled.has(fingerprint(c.headline)))
        .slice(0, 4)
        .map((c, i) => ({ id: `c${i + 1}`, dimension: DIMENSIONS.includes(c.dimension) ? c.dimension : 'chats', headline: String(c.headline).slice(0, 160), why: String(c.why || '').slice(0, 400),
          evidence: String(c.evidence || '').slice(0, 300), saves: String(c.saves || '').slice(0, 40), savesKind: c.savesKind === 'money' ? 'money' : 'time',
          button: String(c.button || 'Do it').slice(0, 30), action: String(c.action).slice(0, 1200), status: 'open' }));
      const dims = DIMENSIONS.filter((k) => d.dims.includes(k) || cards.some((c) => c.dimension === k)); // lit: looked at, or a card came from it
      const dream = { day: dayKey(), at: Date.now(), ms: Date.now() - t0, reason, read: d.read, dims, dropped: raw.length - cards.length, web: s.web, cards };
      writeJson(path.join(dir(), `${dream.day}.json`), dream);
      jobs.mark('dreams', { ok: true, ms: dream.ms, note: `${cards.length} cards` });
      notify({ phase: 'done', count: cards.length, unread: unread() });
      return dream;
    } catch (err) {
      const message = String((err && err.message) || err);
      jobs.mark('dreams', { ok: false, ms: Date.now() - t0, note: message });
      notify({ phase: 'error', message });
      return null;
    } finally {
      running = null;
    }
  })();
  return running;
}

// ---------- schedule ----------

// The most recent time the dream was due (today or yesterday at the chosen hour).
function lastSlot(now = Date.now()) {
  const d = new Date(now); d.setHours(settings().hour, 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}
function nextRun() { return lastSlot() + DAY; }
function lastDreamAt() { const n = files(); const d = n.length ? load(n[n.length - 1]) : null; return d ? d.at : 0; }

// Checks every few minutes; if a due time passed with no dream since (asleep, or the app was closed), dream now.
// The first check waits two minutes after launch so start-up stays quick.
// A dream that fails (no network just after the PC wakes, plan limit reached) is tried again after 15 minutes,
// then 30, then an hour, up to 6 hours apart, instead of every 5 minutes with a "couldn't run" line each time.
let failures = 0, retryAt = 0;
function start(onEvent) {
  notify = onEvent || (() => {});
  const check = () => {
    if (!require('./settings.cjs').get('onboarded')) return; // nothing to dream about, and no brain chosen yet
    if (running || Date.now() < retryAt || lastDreamAt() >= lastSlot()) return;
    run('schedule').then((dream) => {
      if (dream) { failures = 0; retryAt = 0; return; }
      failures++;
      retryAt = Date.now() + Math.min(6 * 60, 15 * 2 ** (failures - 1)) * 60 * 1000;
    });
  };
  setTimeout(check, 2 * 60 * 1000);
  setInterval(check, 5 * 60 * 1000);
}

module.exports = { start, run, state, unread, mark, settings, setSettings, digest };
