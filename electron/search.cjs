// Search over the notes (and saved chats): one box, ranked files back.
//
// Every note gets an entry in search-index.json (app data folder, never inside the vault): path, title, project, type,
// date, headings and a first-lines extract, all made without any AI so search works the moment the index is built.
// Haiku then adds a 2-3 line summary, likely search questions and "atoms" (IDs, exact error text, decisions); only
// notes whose content changed since the last run are sent to it (md5 of the text), several small notes per call.
//
// Ranking is plain BM25 over those fields (no embeddings), then a recency boost: a newer file beats an older one of
// similar relevance. The date is as_of / created in the front matter, then the YYMMDD in the file name, and the
// modified time only as a last resort (index edits and OneDrive sync change it). stale_when is shown as a flag, it
// does not lower the rank.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store.cjs');
const vault = require('./vault.cjs');
const office = require('./office-text.cjs');

const VERSION = 3; // 3: Word, PowerPoint, Excel and CSV files are indexed too
// A note's entry is kept for as long as its file has the size and modified time it had when it was read (entry.sig, see
// noteEntry): the file is not opened again. SHAPE is the other half of that signature: raise it when the way an entry is made
// from a file changes, and every file is read once more but keeps its model-written summary (same text, same hash). Raising
// VERSION instead would throw all the summaries away.
const SHAPE = 1;
const MAX_READ = 400_000; // bytes of a note read at all; bigger ones are indexed from their start only
const BATCH_CHARS = 22_000; // text sent to Haiku per call
const PER_NOTE_CHARS = 3_500; // of each note (start, plus its headings)
const MAX_PER_BATCH = 8;
// Not indexed: other people's snapshots and one-time hand-off products live outside the vault now, but an older copy
// or an archive must never answer a question.
const EXCLUDE = [/(^|\/)_archive(\/|$)/i, /(^|\/)Handoffs?(\/|$)/i, /Handoff_Bundle/i, /(^|\/)dist(\/|$)/i];
const STOP = new Set('a an the of to in on for and or is are was were be been it this that these those what which who whom how when where why do does did can could should would will with from by at as about into out up down over any all some my me i we our you your there their they them its if not no yes find show tell give get look looking need want please note notes file files'.split(' '));

// What counts as an output: the finished things in Output/ and Client Facing/ folders. Inputs, raw notes, session
// working files, skills and saved chats are searched only when asked for ('all').
const OUTPUT = /(^|\/)(Output|Client Facing)(\/|$)/i;
const scopeOf = (rel) => (OUTPUT.test(rel) ? 'output' : 'other');
// An .html page as text: its title, and what a reader sees (scripts, styles and tags dropped).
function htmlText(raw) {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw) || [])[1] || '';
  const body = raw.replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  return { title: title.replace(/\s+/g, ' ').trim(), body };
}
const dir = () => store.dataDir();
const indexFile = () => path.join(dir(), 'search-index.json');
const chatsDir = () => path.join(dir(), 'chats');

let cache = null; // { version, built, entries: {id: entry} }, with the BM25 statistics beside it
let stats = null;

function load() {
  if (cache) return cache;
  const j = store.readJson(indexFile(), null);
  cache = j && j.version === VERSION && j.entries ? j : { version: VERSION, built: 0, entries: {} };
  stats = null;
  return cache;
}
function save() {
  cache.built = Date.now();
  store.tryWriteJson(indexFile(), cache);
}

// ---------- reading a note ----------
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fm = {};
  if (!m) return { fm, body: text };
  for (const line of m[1].split(/\r?\n/)) {
    const k = /^([A-Za-z_][\w -]*):\s*(.*)$/.exec(line);
    if (k) fm[k[1].trim().toLowerCase().replace(/ /g, '_')] = k[2].trim().replace(/^["']|["']$/g, '');
  }
  return { fm, body: text.slice(m[0].length) };
}
const ymd = (s) => {
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^\[?(\d{2})(\d{2})(\d{2})\]?$/.exec((s || '').trim());
  if (m) return `20${m[1]}-${m[2]}-${m[3]}`;
  return null;
};
function dateOf(rel, fm, mtime) {
  const fromFm = ymd(fm.as_of) || ymd(fm.created) || ymd(fm.date);
  if (fromFm) return { date: fromFm, from: 'front matter' };
  const f = /(^|\/)(\d{6})[_ -]/.exec(rel);
  if (f) { const d = ymd(f[2]); if (d && !Number.isNaN(Date.parse(d))) return { date: d, from: 'file name' }; }
  return { date: new Date(mtime).toISOString().slice(0, 10), from: 'modified' };
}
function typeOf(rel, fm) {
  if (/^skills\//i.test(rel)) return 'skill';
  if (/(^|\/)Client Facing(\/|$)/i.test(rel)) return /bundle/i.test(rel) || /bundle/i.test(fm.type || '') ? 'bundle' : 'client-facing';
  if (/(^|\/)Records(\/|$)/i.test(rel)) return 'record';
  if (/(^|\/)Sessions(\/|$)/i.test(rel)) return 'session';
  if (/(^|\/)Raw(\/|$)/i.test(rel)) return 'raw';
  if (/(^|\/)Tools(\/|$)/i.test(rel)) return 'tool';
  return 'note';
}
function titleOf(rel, fm, body) {
  if (fm.title) return fm.title;
  const h = /^#\s+(.+)$/m.exec(body);
  if (h) return h[1].trim().slice(0, 160);
  return path.basename(rel).replace(/\.(md|html?|docx|pptx|xlsx|csv|tsv)$/i, '').replace(/[_-]+/g, ' ');
}
const headingsOf = (body) => [...body.matchAll(/^#{2,4}\s+(.+)$/gm)].map((m) => m[1].trim()).slice(0, 25).join(' | ').slice(0, 800);
const leadOf = (body) => body.replace(/^#.*$/gm, '').replace(/[`*_>|\-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function readNote(rel) {
  const abs = vault.resolveInside(rel);
  if (!abs) return null;
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  if (office.isOffice(rel)) return { text: office.officeText(abs), mtime: st.mtimeMs, size: st.size };
  let text = '';
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(Math.min(st.size, MAX_READ));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return null; }
  return { text, mtime: st.mtimeMs, size: st.size };
}

const sigOf = (st) => `${SHAPE}:${st.mtimeMs}:${st.size}`;

// The entry for a note. `old` is the one already in the index. When its file has not changed it is returned as it is, and
// the file is not opened: opening, hashing and unzipping every note made each pass take 1-3 s on the app's one thread, and a
// pass runs after every mail check, on a search when the index is 5 minutes old, and hourly. `needBody`: the model will be
// sent this note when it has no summary yet, and then its text is needed, so an unchanged note without a summary is read.
function noteEntry(rel, layout, old, needBody) {
  const project = vault.projectOf(rel, layout) || rel.split('/')[0] || '';
  const abs = vault.resolveInside(rel);
  let st = null;
  try { st = abs && fs.statSync(abs); } catch { /* gone: readNote below says so */ }
  if (old && old.sig && st && old.sig === sigOf(st) && (old.enriched || !needBody)) return old.project === project ? old : { ...old, project };
  const r = readNote(rel);
  if (!r) return null;
  const hash = md5(r.text);
  const isHtml = /\.html?$/i.test(rel);
  const h = isHtml ? htmlText(r.text) : null;
  const { fm, body } = isHtml ? { fm: h.title ? { title: h.title } : {}, body: h.body } : frontMatter(r.text);
  const { date, from } = dateOf(rel, fm, r.mtime);
  const e = {
    id: rel, path: rel, kind: 'note', scope: scopeOf(rel), title: titleOf(rel, fm, body), project,
    type: typeOf(rel, fm), date, dateFrom: from, headings: headingsOf(body), lead: leadOf(body),
    staleWhen: fm.stale_when || '', hash, size: r.size, sig: `${SHAPE}:${r.mtime}:${r.size}`,
    summary: '', questions: [], atoms: [], enriched: false,
  };
  if (old && old.hash === hash) { // unchanged: keep what Haiku wrote
    e.summary = old.summary; e.questions = old.questions; e.atoms = old.atoms; e.enriched = old.enriched;
  }
  e.body = body.slice(0, PER_NOTE_CHARS); // for the Haiku batch only; dropped before saving
  return e;
}

// A saved chat is one entry: what was asked, and how the last answers ended. Path is chat:<id>; it has no file to open.
// Reading and parsing every saved chat (166 files, 8 MB) was most of what a pass cost once the notes were skipped, so a chat
// file whose size and modified time are as they were is not read: its entry is kept (entry.file and entry.sig say which file
// it came from and how that file looked), and a file that held no usable chat is remembered in `chatSkip` while it stays as it
// is. `needBody`: as for notes, an unchanged chat without a summary is read when the model is about to be asked for one.
const chatSkip = new Map(); // file name -> signature of a chat file that had nothing worth indexing
function chatEntries(oldEntries, needBody) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(chatsDir()).filter((n) => n.endsWith('.json')); } catch { return out; }
  const byFile = new Map();
  for (const e of Object.values(oldEntries)) if (e.kind === 'chat' && e.file) byFile.set(e.file, e);
  for (const n of names) {
    let st = null;
    try { st = fs.statSync(path.join(chatsDir(), n)); } catch { continue; }
    const sig = `${SHAPE}:${st.mtimeMs}:${st.size}`;
    if (chatSkip.get(n) === sig) continue;
    const kept = byFile.get(n);
    if (kept && kept.sig === sig && (kept.enriched || !needBody)) { out.push(kept); continue; }
    const c = store.readJson(path.join(chatsDir(), n), null);
    if (!c || !Array.isArray(c.items)) { chatSkip.set(n, sig); continue; }
    const you = c.items.filter((x) => x && x.role === 'you' && x.text).map((x) => String(x.text));
    if (!you.length) { chatSkip.set(n, sig); continue; }
    const bot = c.items.filter((x) => x && x.role === 'assistant' && x.text).map((x) => String(x.text));
    const text = `Questions:\n${you.join('\n')}\n\nAnswers (end of each):\n${bot.map((t) => t.slice(-400)).join('\n')}`.slice(0, 12_000);
    const id = `chat:${c.id}`;
    const hash = md5(text);
    const old = oldEntries[id];
    const e = {
      id, path: id, kind: 'chat', scope: 'chat', title: String(c.title || you[0]).slice(0, 120), project: 'Chats', type: 'chat',
      date: new Date(c.updated || Date.now()).toISOString().slice(0, 10), dateFrom: 'saved', headings: '', lead: you.join(' ').slice(0, 500),
      staleWhen: '', hash, size: text.length, file: n, sig, summary: '', questions: [], atoms: [], enriched: false,
    };
    if (old && old.hash === hash) { e.summary = old.summary; e.questions = old.questions; e.atoms = old.atoms; e.enriched = old.enriched; }
    e.body = text.slice(0, PER_NOTE_CHARS);
    out.push(e);
  }
  return out;
}

// ---------- Haiku: summaries and atoms ----------
const SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, summary: { type: 'string' }, questions: { type: 'array', items: { type: 'string' } }, atoms: { type: 'array', items: { type: 'string' } },
  }, required: ['id', 'summary', 'questions', 'atoms'] } } },
  required: ['items'],
};
const SYSTEM = `You index notes for a search box. For each note given, write:
- summary: 2-3 plain sentences saying what the note is and what it concludes or holds. Use the note's own words and names.
- questions: 3-5 questions a person might type when they need this note ("what did we decide about X", "where is the Y list").
- atoms: up to 10 short exact things worth finding by: ticket or record IDs, database or server names, people's names, dates, error text, decisions, numbers. Copy them exactly as written.
Return one item per note, with the id you were given. Never invent anything that is not in the note.`;

async function enrich(batch, oneShot) {
  const prompt = batch.map((e) => `=== id: ${e.id}\ntitle: ${e.title}\n${e.body}`).join('\n\n');
  const r = await oneShot({ system: SYSTEM, prompt, schema: SCHEMA, model: 'haiku' });
  const items = (r.out && r.out.items) || [];
  let n = 0;
  for (const it of items) {
    const e = batch.find((b) => b.id === it.id);
    if (!e) continue;
    e.summary = String(it.summary || '').slice(0, 600);
    e.questions = (it.questions || []).map(String).slice(0, 6);
    e.atoms = (it.atoms || []).map(String).slice(0, 12);
    e.enriched = !!e.summary;
    n++;
  }
  return { n, cost: r.cost || 0 };
}

// Notes (.md), pages (.html), Word/PowerPoint/Excel files and CSV/TSV tables in the vault. (PDFs and images have no text to read here.)
function listIndexable() {
  const acc = [];
  (function each(nodes) { for (const n of nodes) { if (n.dir) each(n.children); else if (n.kind === 'md' || n.kind === 'html' || n.kind === 'csv' || /\.(docx|pptx|xlsx|tsv)$/i.test(n.name)) acc.push(n.path); } })(vault.tree().children);
  return acc;
}

// ---------- building ----------
let running = null; // { total, done, startedAt } while a build is going
// opts: { only: 'folder/prefix', dry: true (heuristic only, no Haiku), oneShot, onProgress, limit }
const breathe = () => new Promise((r) => setImmediate(r)); // lets the window and the chats have the app's one thread for a moment
async function build(opts = {}) {
  if (running) return { already: true, ...running };
  const t0 = Date.now();
  running = { total: 0, done: 0, startedAt: t0 }; // set before the first pause below, so a second caller cannot start a parallel pass
  try {
    const idx = load();
    const layout = vault.projectLayout();
    const only = opts.only ? String(opts.only).replace(/\\/g, '/').replace(/\/+$/, '') + '/' : '';
    const files = listIndexable().filter((rel) => (!only || rel.startsWith(only)) && !EXCLUDE.some((x) => x.test(rel)) && !/(^|\/)index\.md$/i.test(rel));
    // A pass over unchanged notes only looks at each file's size and modified time (32 ms for 1,000 files). A note is opened
    // when it changed, is new, or the model is about to be asked for its summary and it has none yet.
    const needBody = !opts.dry && !!opts.oneShot;
    const fresh = {};
    let since = Date.now();
    for (const rel of files) {
      const e = noteEntry(rel, layout, idx.entries[rel], needBody);
      if (e) fresh[rel] = e;
      if (Date.now() - since > 40) { await breathe(); since = Date.now(); } // never hold the thread for much longer than that
    }
    if (!only) for (const e of chatEntries(idx.entries, needBody)) fresh[e.id] = e;
    if (!only) for (const e of require('./mail.cjs').searchEntries()) fresh[e.id] = e; // mail: summaries only, already enriched
    const todo = Object.values(fresh).filter((e) => !e.enriched);
    running.total = todo.length;
    let failed = 0, cost = 0, lastErr = '';
    const batches = [];
    for (let i = 0, cur = [], chars = 0; i <= todo.length; i++) {
      const e = todo[i];
      const len = e ? (e.body || '').length : 0;
      if (!e || cur.length >= MAX_PER_BATCH || (cur.length && chars + len > BATCH_CHARS)) { if (cur.length) batches.push(cur); cur = []; chars = 0; }
      if (e) { cur.push(e); chars += len; }
    }
    // The rest of the index (outside `only`) is kept as it was; entries for files that no longer exist are dropped. The 3 MB
    // index file is only written, and the ranking tables only rebuilt, when something is different (an entry is new,
    // changed or gone, or the "first pass done" flag was just set). Rewriting the file and re-tokenising 2,000 entries when
    // nothing had changed was much of what a pass cost. "built" still moves on in memory, so a search straight after a pass
    // does not start another; after a restart the index looks 5 minutes old again and one quiet pass brings it up to date.
    const seededBefore = !!idx.seeded;
    const merge = () => {
      const kept = {};
      for (const [id, e] of Object.entries(idx.entries)) if (only && !(id.startsWith(only)) && (e.kind === 'chat' || e.kind === 'mail' || fs.existsSync(vault.resolveInside(id) || '')) ) kept[id] = e;
      const next = { ...kept };
      for (const [id, e] of Object.entries(fresh)) { if (idx.entries[id] === e) { next[id] = e; continue; } const { body: _b, ...rest } = e; next[id] = rest; } // an entry returned as it was is not copied
      const ids = Object.keys(next);
      const changed = ids.length !== Object.keys(idx.entries).length || ids.some((id) => next[id] !== idx.entries[id] && JSON.stringify(next[id]) !== JSON.stringify(idx.entries[id]));
      idx.entries = next;
      if (changed) stats = null;
      if (changed || !!idx.seeded !== seededBefore || !idx.built) save(); else idx.built = Date.now();
      return changed;
    };
    if (!opts.dry && opts.oneShot) {
      const limit = opts.limit || Infinity;
      for (let b = 0; b < batches.length && b < limit; b++) {
        try { const r = await enrich(batches[b], opts.oneShot); cost += r.cost; }
        catch (err) { failed += batches[b].length; lastErr = String((err && err.message) || err); }
        running.done += batches[b].length;
        if (opts.onProgress) opts.onProgress({ ...running, cost });
        if (b % 5 === 4) merge(); // checkpoint, so a long run that is stopped keeps what it did
      }
    }
    if (!opts.dry && opts.oneShot && !only && !opts.limit && !failed) idx.seeded = true; // the one full pass is done; the routine may now keep up with changes
    merge();
    const all = Object.values(idx.entries);
    return { notes: all.length, enriched: all.filter((e) => e.enriched).length, sent: todo.length, failed, cost, ms: Date.now() - t0, error: lastErr, dry: !!opts.dry };
  } finally { running = null; }
}

// ---------- ranking ----------
const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_.\-/ ]+/g, ' ').split(/[\s/]+/).map((t) => t.replace(/^[.\-_]+|[.\-_]+$/g, '')).filter((t) => t.length > 1 && !STOP.has(t));
const fieldWeights = (e) => [
  [e.title, 3], [e.path.replace(/[_\-./]+/g, ' '), 1], [e.atoms.join(' '), 2], [e.questions.join(' '), 2],
  [e.summary, 1], [e.headings, 1], [e.enriched ? '' : e.lead, 1],
];
function prepare() {
  if (stats) return stats;
  const entries = Object.values(load().entries);
  const docs = new Map(); // id -> { tf: Map, len }
  const df = new Map();
  let total = 0;
  for (const e of entries) {
    const tf = new Map();
    let len = 0;
    for (const [text, w] of fieldWeights(e)) {
      for (const t of tokens(text)) { tf.set(t, (tf.get(t) || 0) + w); len += w; }
    }
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    docs.set(e.id, { tf, len, e });
    total += len;
  }
  stats = { docs, df, n: entries.length, avg: entries.length ? total / entries.length : 1 };
  return stats;
}
// "since" cutoff is not needed: recency is a gentle boost (a file a year old keeps about 1.1x of its score, today's 1.5x).
function recencyBoost(date) {
  const age = Math.max(0, (Date.now() - Date.parse(date)) / 86400000);
  return 1 + 0.5 * Math.exp(-age / 120);
}
// scope: 'output' = only the finished things (Output/ and Client Facing/ folders); 'all' = notes, inputs and past chats too.
function query(q, { limit = 10, scope = 'all' } = {}) {
  const s = prepare();
  const terms = [...new Set(tokens(q))];
  if (!terms.length || !s.n) return [];
  const k1 = 1.2, b = 0.75;
  const scored = [];
  for (const { tf, len, e } of s.docs.values()) {
    let score = 0, hit = 0;
    for (const t of terms) {
      // a term also matches the start of a longer word ("migrat" finds "migration"), at a lower weight
      let f = tf.get(t) || 0, weight = 1;
      if (!f && t.length >= 4) { for (const [k, v] of tf) if (k.startsWith(t)) { f += v; weight = 0.6; } }
      if (!f) continue;
      hit++;
      const dft = s.df.get(t) || 1;
      const idf = Math.log(1 + (s.n - dft + 0.5) / (dft + 0.5));
      score += weight * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / s.avg)));
    }
    if (!hit) continue;
    if (scope === 'output' && e.scope !== 'output') continue;
    score *= 1 + 0.35 * (hit / terms.length); // covering more of the words wins
    // A saved chat repeats every question ever asked, so it matches almost any word. It counts for less than a file, and
    // only a few chats may appear among the results, so the files are what the box mostly shows.
    scored.push({ e, score: score * recencyBoost(e.date) * (e.kind === 'chat' ? 0.6 : 1) });
  }
  scored.sort((a, b2) => b2.score - a.score);
  const chatCap = Math.min(3, Math.floor(limit / 4));
  let chatsSeen = 0;
  const kept = scored.filter(({ e }) => e.kind !== 'chat' || ++chatsSeen <= chatCap);
  scored.length = 0; scored.push(...kept);
  // a same-named file with a newer date elsewhere: flag the older one instead of hiding it
  const newest = new Map();
  for (const e of Object.values(load().entries)) { const n = path.basename(e.path) + '|' + e.title; if (e.kind === 'note' && (!newest.has(n) || e.date > newest.get(n).date)) newest.set(n, e); }
  return scored.slice(0, limit).map(({ e, score }) => {
    const twin = e.kind === 'note' ? newest.get(path.basename(e.path) + '|' + e.title) : null;
    return {
      path: e.path, kind: e.kind, title: e.title, project: e.project, type: e.type, date: e.date, score: Math.round(score * 100) / 100,
      summary: e.summary || e.lead.slice(0, 220), staleWhen: e.staleWhen || '', enriched: e.enriched,
      newerTwin: twin && twin.path !== e.path && twin.date > e.date ? twin.path : '',
    };
  });
}

// The no-AI part of the index is cheap (about a third of a second for the whole vault), so it is refreshed whenever it is
// older than a few minutes; notes whose text did not change keep their Haiku summaries.
const FRESH_MS = 5 * 60 * 1000;
async function ensureFresh() {
  const idx = load();
  if (running) return;
  if (!Object.keys(idx.entries).length || Date.now() - (idx.built || 0) > FRESH_MS) await build({ dry: true });
}

// The routine: every so often, bring the index up to date. The quick no-AI pass always runs. Haiku is only used once the
// full pass has been done and approved (idx.seeded), and then only for notes that changed, a few batches at a time.
const ROUTINE_BATCHES = 6;
async function routine(oneShot) {
  const idx = load();
  if (running) return null;
  if (!idx.seeded || !oneShot) return build({ dry: true });
  return build({ oneShot, limit: ROUTINE_BATCHES });
}
function startRoutine(oneShot, onDone) {
  const tick = async () => {
    const t0 = Date.now();
    try {
      const r = await routine(oneShot);
      if (r && !r.already) onDone({ ok: !r.error, ms: Date.now() - t0, note: r.error || (r.dry ? `${r.notes} notes searchable; summaries wait for the first full pass` : `${r.enriched} of ${r.notes} notes summarised`) });
    } catch (err) { onDone({ ok: false, ms: Date.now() - t0, note: String((err && err.message) || err) }); }
  };
  setTimeout(tick, 3 * 60 * 1000); // after start-up has settled
  setInterval(tick, 60 * 60 * 1000);
}

// Notes that say when they go out of date, oldest first: the list to look through now and then. Nothing is archived or changed.
function reviewList(limit = 40) {
  return Object.values(load().entries).filter((e) => e.kind === 'note' && e.staleWhen)
    .sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, limit)
    .map((e) => ({ path: e.path, title: e.title, project: e.project, date: e.date, staleWhen: e.staleWhen }));
}

function status() {
  const idx = load();
  const all = Object.values(idx.entries);
  return { seeded: !!idx.seeded, outputs: all.filter((e) => e.scope === 'output').length, notes: all.filter((e) => e.kind === 'note').length, chats: all.filter((e) => e.kind === 'chat').length, enriched: all.filter((e) => e.enriched).length, built: idx.built || null, running: running ? { ...running } : null };
}
const reset = () => { cache = null; stats = null; };

// The text a tool or the UI shows for a list of results.
function format(results) {
  if (!results.length) return 'No notes matched. Try other words, or fall back to the index pages.';
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.path}  [${r.project || '-'} · ${r.type} · ${r.date}]${r.staleWhen ? `\n   STALE WHEN: ${r.staleWhen}` : ''}${r.newerTwin ? `\n   NOTE: a newer file with the same name exists at ${r.newerTwin}` : ''}\n   ${r.summary}`).join('\n');
}

module.exports = { ensureFresh, build, routine, startRoutine, reviewList, query, status, format, reset, tokens, frontMatter, dateOf, EXCLUDE };
