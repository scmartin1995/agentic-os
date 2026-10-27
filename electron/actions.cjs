// The Notes and Action items panels.
//
// Everything lives in plain markdown in the vault, so Obsidian and every agent can read and edit it, and the panels
// never hold the only copy:
//  - Notes: one file per project per ISO week, a heading per day and per time:
//      projects/<P>/input/notes/2026-W41.md   (work/notes/ when input/ is a client's received, read-only folder;
//                                             <P>/input/notes/... when the folder has no projects/)
//      agent-os/inbox/notes-2026-W41.md       (Inbox: "not sure where this goes yet")
//  - Action items: one file per project, an Open and a Closed section:
//      projects/<P>/action-items.md, agent-os/inbox/action-items.md
//      - [ ] call the dealer | added 2026-10-08 10:42 · [note](input/notes/2026-W41.md)
//      - [x] send Sam the email | added 2026-10-05 14:10, closed 2026-10-05 15:30 · [note](input/notes/2026-W41.md)
// A note that starts with "action item" is also copied to that project's action items (prefix removed).
// Ticking an item in the panel and changing [ ] to [x] in the file are the same thing: the panel only reads the file.
// A project laid out the OKF way (see okf() below) keeps its own files instead, and the panels use those:
//      <P>/Raw/Notes/261005_Week_Notes.md     ("## Thursday — Oct 8" a day, "- **10:38am** — text" a note;
//                                             named for the week's Monday)
//      <P>/Records/actionitem-register.md     (any note with concept_class: action-item; see registers.cjs)
// No AI is involved anywhere here, so none of it costs tokens.
const fs = require('fs');
const path = require('path');
const vault = require('./vault.cjs');
const registers = require('./registers.cjs');
const { markWritten } = require('./shared.cjs');
const { writeText } = require('./store.cjs');

const PREFIX = /^\s*action item\b\s*[:\-–—]?\s*/i;
const INBOX = 'Inbox';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MAX_NOTE = 20000;

const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const hhmm = (d) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
// ISO 8601 week ("2026-W41"): weeks start on Monday, and week 1 holds the year's first Thursday.
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  return `${y}-W${p2(Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7))}`;
}
const mondayOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

// "action item: call the dealer" -> "call the dealer"; anything else -> null.
function actionText(note) {
  const m = String(note).match(PREFIX);
  if (!m) return null;
  return String(note).slice(m[0].length).replace(/\s+/g, ' ').trim();
}

const nice = (p) => (p === INBOX ? INBOX : p.replace(/_/g, ' '));
// Every project folder (projects/<P>, or each top-level folder when there is no projects/; see vault.projectLayout),
// plus the Inbox. Anything else is refused, so a name can't reach outside the vault.
function projects() {
  return [...vault.projectLayout().names.sort((a, b) => a.localeCompare(b)), INBOX];
}
function check(project) {
  const p = String(project || '');
  if (!projects().includes(p)) throw new Error(`There is no project called "${p}".`);
  return p;
}
const base = (p) => (p === INBOX ? 'agent-os/inbox' : vault.projectPath(p));
// A client's received folder is kept exactly as received, so our notes go beside it in work/ instead.
function notesDir(p, received = vault.receivedRoots()) {
  if (p === INBOX) return 'agent-os/inbox';
  const b = base(p);
  return received.some((r) => `${b}/input/`.startsWith(r.dir)) ? `${b}/work/notes` : `${b}/input/notes`;
}
// An OKF project: two or more of Client Facing/Raw/Records/Sessions/Tools in its folder (the same test
// vault.projectLayout uses). It already has a place for weekly notes and an action-item register, so Agentic OS writes there.
function okf(p) {
  if (p === INBOX) return false;
  const a = vault.resolveInside(base(p));
  return !!a && vault.okfMarkerCount(a) >= 2;
}
const yymmdd = (d) => `${p2(d.getFullYear() % 100)}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
const weekNotesRel = (p, d) => `${base(p)}/Raw/Notes/${yymmdd(mondayOf(d))}_Week_Notes.md`;
const notesRel = (p, d, received) => (p === INBOX ? `agent-os/inbox/notes-${isoWeek(d)}.md`
  : okf(p) ? weekNotesRel(p, d) : `${notesDir(p, received)}/${isoWeek(d)}.md`);
const actionsRel = (p) => `${base(p)}/action-items.md`;
// Where an OKF project's new action items go: its register, or the one registers.cjs would make.
const registerRel = (p) => registers.inFolder(base(p))[0] || `${base(p)}/Records/actionitem-register.md`;

const abs = (rel) => { const a = vault.resolveInside(rel); if (!a) throw new Error('That path is outside the notes folder.'); return a; };
const readRel = (rel) => { try { return fs.readFileSync(abs(rel), 'utf8'); } catch { return ''; } };
function save(rel, text) { writeText(abs(rel), text); markWritten(rel); } // marked as ours, so it isn't reported as "edited elsewhere"
const eol = (text) => (/\r\n/.test(text) ? '\r\n' : '\n'); // keep whatever line endings the file already has
// An action-items file is only headings and list lines, so runs of blank lines (left when a line moves) are squeezed to one.
function saveList(rel, lines, nl) { save(rel, lines.join(nl).replace(/(\r?\n){3,}/g, nl + nl)); }

function frontmatter({ type, title, description, tags, at }) {
  return `---\ntype: ${type}\ntitle: ${title}\ndescription: ${description}\ntags: [${tags.join(', ')}]\ntimestamp: ${at.toISOString().replace(/\.\d+Z$/, 'Z')}\n---\n`;
}

// ---- action-items.md ----

// One list line: "- [ ] text | added 2026-10-08 10:42, closed ... · [note](link)". Lines typed by hand without the
// " | added" part work too; they just have no date.
const ITEM = /^(\s*[-*]\s+)\[( |x|X)\]\s+(.*?)\s*$/;
function parseItem(line) {
  const m = line.match(ITEM);
  if (!m) return null;
  let text = m[3], meta = '';
  const cut = text.lastIndexOf(' | ');
  if (cut >= 0 && /added|closed|\[note\]/.test(text.slice(cut))) { meta = text.slice(cut + 3); text = text.slice(0, cut); }
  const added = meta.match(/added\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?/);
  const closed = meta.match(/closed\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?/);
  const note = meta.match(/\[note\]\(([^)\s]+)\)/);
  return {
    done: m[2] !== ' ', text: text.trim(),
    added: added ? `${added[1]}${added[2] ? ' ' + added[2] : ''}` : null,
    closed: closed ? `${closed[1]}${closed[2] ? ' ' + closed[2] : ''}` : null,
    note: note ? note[1] : null,
  };
}

// Where a section's list ends: just before the next heading (or the end), after its last non-blank line.
function sectionEnd(lines, start) {
  let i = start + 1;
  while (i < lines.length && !/^#{1,2}\s/.test(lines[i])) i++;
  let end = i;
  while (end > start + 1 && !lines[end - 1].trim()) end--;
  return end;
}
const heading = (lines, name) => lines.findIndex((l) => new RegExp(`^##\\s+${name}\\s*$`, 'i').test(l));
function insertUnder(lines, name, line, atTop) {
  let h = heading(lines, name);
  if (h < 0) {
    // no such section yet: Open goes before Closed, Closed goes at the end
    const closed = heading(lines, 'Closed');
    const block = [`## ${name}`, '', line, ''];
    if (name === 'Open' && closed >= 0) lines.splice(closed, 0, ...block);
    else { while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); lines.push('', ...block); }
    return;
  }
  if (atTop) { // newest first
    let i = h + 1;
    while (i < lines.length && !lines[i].trim()) i++;
    if (i < lines.length && !/^#{1,2}\s/.test(lines[i])) lines.splice(i, 0, line);
    else lines.splice(h + 1, 0, '', line);
    return;
  }
  const end = sectionEnd(lines, h);
  if (end === h + 1) lines.splice(h + 1, 0, '', line);
  else lines.splice(end, 0, line);
}
function newActionsFile(p, at) {
  return frontmatter({
    type: 'Task', title: `Action items - ${nice(p)}`, at, tags: ['plan', 'planning'],
    description: `Open and closed action items for ${nice(p)}. Written by the Notes and Action items panels in Agentic OS; the panel shows the open ones.`,
  }) + `\n# Action items: ${nice(p)}\n\n## Open\n\n## Closed\n`;
}

function addAction(p, text, at, noteRel) {
  const rel = actionsRel(p);
  const old = readRel(rel);
  const nl = old ? eol(old) : '\n';
  const lines = (old || newActionsFile(p, at)).split(/\r?\n/);
  const link = path.posix.relative(base(p), noteRel);
  const line = `- [ ] ${text} | added ${ymd(at)} ${hhmm(at)} · [note](${link})`;
  insertUnder(lines, 'Open', line, false);
  saveList(rel, lines, nl);
  return { project: p, file: rel, raw: line, ...parseItem(line) };
}

// ---- action-item registers (registers.cjs) ----

// A register item in the panel's shape. raw is "register:<file>#<number>", which stays the same when the item's
// status or updates change, so the panel's Undo still finds it.
const REG_RAW = /^register:(.+)#(\d+)$/;
function registerItems(p, reg) {
  return reg.items.map((it) => ({
    // project owns the register (it gates close/update); origin is the project whose note made the item, for the label
    project: p, name: nice(p), origin: it.project || nice(p), file: reg.file, raw: `register:${reg.file}#${it.num}`, done: !it.open,
    text: it.title + (it.open && it.waiting ? ` (waiting on ${it.waiting})` : ''),
    added: it.added, closed: it.closed, note: null,
    register: reg.title, num: it.num, summary: it.summary,
    // the item's own dated Updates log (registers.cjs), newest first, so the panel can show it without opening the file
    updates: it.updates.slice().reverse(),
  }));
}
// The register and item number a raw names, checked to be inside that project's folder. null for a checklist line.
function registerTarget(p, raw) {
  const m = String(raw).match(REG_RAW);
  if (!m) return null;
  if (p === INBOX || !m[1].startsWith(`${base(p)}/`)) throw new Error('That item is not in this project.');
  return { rel: m[1], num: Number(m[2]) };
}

// Every action item in every project, open and closed, read fresh from the files: action-items.md checklists, and
// every register inside a project's folder (each register counted once, for the deepest project holding it).
function list() {
  const items = [];
  for (const p of projects()) {
    const rel = actionsRel(p);
    const text = readRel(rel);
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      const it = parseItem(line);
      if (it && it.text) items.push({ project: p, name: nice(p), file: rel, raw: line.trim(), ...it, note: it.note ? path.posix.normalize(path.posix.join(base(p), it.note)) : null });
    }
  }
  const owners = projects().filter((p) => p !== INBOX).sort((a, b) => base(b).length - base(a).length);
  for (const rel of registers.inFolder('')) {
    const p = owners.find((o) => rel.startsWith(`${base(o)}/`));
    if (!p) continue;
    try { items.push(...registerItems(p, registers.parse(rel))); } catch { /* unreadable just now; the next refresh tries again */ }
  }
  return { items, open: items.filter((i) => !i.done).length };
}

// Find one exact line again (the file may have been edited by hand since the panel read it).
function findLine(lines, raw) { return lines.findIndex((l) => l.trim() === String(raw).trim()); }

function close(project, raw, at = new Date()) {
  const p = check(project);
  const reg = registerTarget(p, raw);
  if (reg) { registers.update(reg.rel, reg.num, { open: false }); return { raw: String(raw) }; }
  const rel = actionsRel(p);
  const old = readRel(rel);
  const lines = old.split(/\r?\n/);
  const i = findLine(lines, raw);
  if (i < 0) throw new Error('That item has changed in the file since the panel read it. Look again.');
  const it = parseItem(lines[i]);
  if (!it || it.done) throw new Error('That item is already closed.');
  lines.splice(i, 1);
  const stamp = `closed ${ymd(at)} ${hhmm(at)}`;
  const meta = (it.added ? `added ${it.added}, ${stamp}` : stamp) + (it.note ? ` · [note](${it.note})` : '');
  const line = `- [x] ${it.text} | ${meta}`;
  insertUnder(lines, 'Closed', line, true);
  saveList(rel, lines, eol(old));
  return { raw: line };
}

// Undo a close: back to the end of Open, without the closed stamp.
function reopen(project, raw) {
  const p = check(project);
  const reg = registerTarget(p, raw);
  if (reg) { registers.update(reg.rel, reg.num, { open: true }); return { raw: String(raw) }; }
  const rel = actionsRel(p);
  const old = readRel(rel);
  const lines = old.split(/\r?\n/);
  const i = findLine(lines, raw);
  if (i < 0) throw new Error('That item has changed in the file since the panel read it. Look again.');
  const it = parseItem(lines[i]);
  if (!it || !it.done) throw new Error('That item is already open.');
  lines.splice(i, 1);
  const meta = [it.added ? `added ${it.added}` : '', it.note ? `[note](${it.note})` : ''].filter(Boolean).join(' · ');
  const line = `- [ ] ${it.text}${meta ? ` | ${meta}` : ''}`;
  insertUnder(lines, 'Open', line, false);
  saveList(rel, lines, eol(old));
  return { raw: line };
}

// Reword an item (the panel's Update button). Only the text changes: the added date, closed stamp and note link stay,
// and the note it came from is left alone, because notes and items are not one to one.
// A register item is never reworded (its own rules): the text becomes a dated line in its Updates instead.
function update(project, raw, newText) {
  const p = check(project);
  const reg = registerTarget(p, raw);
  if (reg) {
    const note = String(newText || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
    if (!note) throw new Error('An update needs some words.');
    registers.update(reg.rel, reg.num, { text: note });
    return { raw: String(raw) };
  }
  const text = String(newText || '').replace(/\s+/g, ' ').replace(/ \| /g, ' / ').trim().slice(0, 500);
  if (!text) throw new Error('An action item needs some words.');
  const rel = actionsRel(p);
  const old = readRel(rel);
  const lines = old.split(/\r?\n/);
  const i = findLine(lines, raw);
  if (i < 0) throw new Error('That item has changed in the file since the panel read it. Look again.');
  const m = lines[i].match(ITEM);
  const it = parseItem(lines[i]);
  if (!m || !it) throw new Error('That line is not an action item.');
  const cut = lines[i].lastIndexOf(' | ');
  const meta = it.added || it.closed || it.note ? lines[i].trimEnd().slice(cut) : '';
  const line = `${m[1]}[${m[2]}] ${text}${meta}`;
  lines[i] = line;
  saveList(rel, lines, eol(old));
  return { raw: line.trim() };
}

// ---- weekly notes files ----

function newNotesFile(p, at) {
  const mon = mondayOf(at);
  return frontmatter({
    type: 'Notes', title: `Notes - ${nice(p)}, week ${isoWeek(at)}`, at, tags: ['source', 'planning'],
    description: `Dated notes for ${nice(p)}, week of Mon ${mon.getDate()} ${MONTHS[mon.getMonth()]} ${mon.getFullYear()}, written from the Notes panel in Agentic OS.`,
  }) + `\n# Notes: ${nice(p)}, week ${isoWeek(at)}\n`;
}

// ---- OKF week notes (<P>/Raw/Notes/<Monday>_Week_Notes.md) ----

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayHeading = (d) => `## ${DAY_NAMES[d.getDay()]} — ${MONTHS[d.getMonth()]} ${d.getDate()}`;
const ampm = (d) => `${d.getHours() % 12 || 12}:${p2(d.getMinutes())}${d.getHours() >= 12 ? 'pm' : 'am'}`;
const DAY_LINE = /^##\s+(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+—\s+\w{3}\s+\d{1,2}\b/;
const NOTE_LINE = /^-\s+\*\*(\d{1,2}):(\d{2})\s*(am|pm)\*\*\s+—\s+(.*)$/i;

// One entry at the end of today's day (a "(processed)" mark on the heading is kept), or a new day heading at the end
// of the file. Every other line stays exactly as it was. Lines after the first are indented, so they stay one entry.
function appendWeekNote(rel, body, at) {
  const old = readRel(rel);
  const nl = old ? eol(old) : '\n';
  if (old) { try { require('./policy.cjs').backup(abs(rel)); } catch { /* best effort; writing still proceeds */ } }
  const lines = old ? old.replace(/\s+$/, '').split(/\r?\n/) : [];
  const head = dayHeading(at);
  const entry = `- **${ampm(at)}** — ${body.split('\n').map((l, i) => (i ? `  ${l}` : l)).join(nl)}`;
  const h = lines.findIndex((l) => l === head || l.startsWith(`${head} (`));
  if (h < 0) { if (lines.length) lines.push(''); lines.push(head, entry); } else {
    let e = h + 1;
    while (e < lines.length && !/^##\s/.test(lines[e])) e++;
    while (e > h + 1 && !lines[e - 1].trim()) e--;
    lines.splice(e, 0, entry);
  }
  save(rel, lines.join(nl) + nl);
}

// The entries of one week file, dated from the week's Monday and each day heading's weekday.
function readWeekNotes(p, rel, monday) {
  const out = [];
  let date = null, cur = null;
  const flush = () => { if (cur) { cur.text = cur.text.join('\n').trim(); if (cur.text) out.push(cur); cur = null; } };
  for (const line of readRel(rel).split(/\r?\n/)) {
    const dh = line.match(DAY_LINE);
    if (dh) { flush(); const d = new Date(monday); d.setDate(d.getDate() + ((DAY_NAMES.indexOf(dh[1]) + 6) % 7)); date = ymd(d); continue; }
    if (/^#/.test(line)) { flush(); date = null; continue; }
    const nm = line.match(NOTE_LINE);
    if (nm && date) {
      flush();
      const h = (Number(nm[1]) % 12) + (nm[3].toLowerCase() === 'pm' ? 12 : 0);
      cur = { project: p, name: nice(p), file: rel, date, time: `${p2(h)}:${nm[2]}`, action: !!actionText(nm[4]), text: [nm[4]] };
      continue;
    }
    if (cur && line.trim()) cur.text.push(line.trim());
  }
  flush();
  return out;
}

// Save a note, stamped with the date and time. Returns where it went and, for an "action item" note, the new item.
function addNote(project, text, at = new Date()) {
  const p = check(project);
  const body = String(text || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_NOTE);
  if (!body) throw new Error('The note is empty.');
  const item = actionText(body);
  if (item === '') throw new Error('Add what needs doing after "action item".');
  // One register for everything: once the vault has one, every project's "action item" notes (the Inbox's too) go into
  // it, tagged with the project they came from. With none, the old per-project files are used.
  const shared = item ? registers.sharedRegister() : null;
  const intoRegister = (rel) => {
    const r = registers.addFromNote(base(p), item, rel, nice(p));
    const owner = projects().filter((o) => o !== INBOX).sort((a, b) => base(b).length - base(a).length).find((o) => r.file.startsWith(`${base(o)}/`)) || p;
    return registerItems(owner, r.register).find((x) => x.num === r.num) || null;
  };
  if (okf(p)) {
    const rel = weekNotesRel(p, at);
    appendWeekNote(rel, body, at);
    const action = item ? intoRegister(rel) : null;
    return { project: p, file: rel, date: ymd(at), time: hhmm(at), action };
  }
  const rel = notesRel(p, at);
  const old = readRel(rel);
  const nl = old ? eol(old) : '\n';
  let out = (old || newNotesFile(p, at)).replace(/\s+$/, '') + nl;
  const day = `## ${DAYS[at.getDay()]} ${ymd(at)}`;
  // A new day heading unless today's is already the last one in the file.
  const days = out.split(/\r?\n/).filter((l) => /^##\s/.test(l) && !/^###/.test(l));
  if (days[days.length - 1]?.trim() !== day) out += nl + day + nl;
  out += nl + `### ${hhmm(at)}${item ? ' · action item' : ''}` + nl + body.split('\n').join(nl) + nl;
  save(rel, out);
  const action = item ? (shared ? intoRegister(rel) : addAction(p, item, at, rel)) : null;
  return { project: p, file: rel, date: ymd(at), time: hhmm(at), action };
}

// The entries of one non-OKF week file ("## Thu 2026-10-08" a day, "### 10:42" a note).
function readIsoNotes(p, rel, out) {
  const text = readRel(rel);
  if (!text) return;
  let date = null, cur = null;
  const flush = () => { if (cur) { cur.text = cur.text.join('\n').trim(); if (cur.text) out.push(cur); cur = null; } };
  for (const line of text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').split(/\r?\n/)) {
    const dh = line.match(/^##\s+\w*\s*(\d{4}-\d{2}-\d{2})\s*$/);
    const th = line.match(/^###\s+(\d{1,2}:\d{2})(.*)$/);
    if (dh) { flush(); date = dh[1]; continue; }
    if (th && date) { flush(); cur = { project: p, name: nice(p), file: rel, date, time: th[1].padStart(5, '0'), action: /action item/i.test(th[2]), text: [] }; continue; }
    if (/^#\s/.test(line)) { flush(); continue; }
    if (cur) cur.text.push(line);
  }
  flush();
}
const finish = (out) => {
  for (const n of out) if (!n.action && actionText(n.text)) n.action = true;
  return out.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
};

// Notes from this week and last (newest first), for one project or all of them.
function notes(project, now = new Date()) {
  const want = project ? [check(project)] : projects();
  const last = new Date(now); last.setDate(last.getDate() - 7);
  const received = vault.receivedRoots();
  const out = [];
  for (const p of want) {
    const isOkf = okf(p);
    for (const d of [now, last]) {
      const rel = notesRel(p, d, received);
      if (isOkf) out.push(...readWeekNotes(p, rel, mondayOf(d)));
      else readIsoNotes(p, rel, out);
    }
  }
  return finish(out);
}

// Every week file a project has, as { rel, monday }. OKF: 261005_Week_Notes.md (named for the Monday); otherwise
// 2026-W41.md / notes-2026-W41.md, whose Monday is worked out from the ISO week.
function weekFiles(p, received) {
  const rel = notesRel(p, new Date(), received);
  const dir = rel.slice(0, rel.lastIndexOf('/'));
  const a = vault.resolveInside(dir);
  if (!a) return [];
  let names = [];
  try { names = fs.readdirSync(a); } catch { return []; }
  const out = [];
  for (const f of names) {
    let m = okf(p) && f.match(/^(\d{2})(\d{2})(\d{2})_Week_Notes\.md$/);
    if (m) { out.push({ rel: `${dir}/${f}`, monday: new Date(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3])) }); continue; }
    m = !okf(p) && f.match(/^(?:notes-)?(\d{4})-W(\d{2})\.md$/);
    if (m) {
      const wk1 = mondayOf(new Date(Number(m[1]), 0, 4)); // week 1 is the one holding 4 January
      wk1.setDate(wk1.getDate() + (Number(m[2]) - 1) * 7);
      out.push({ rel: `${dir}/${f}`, monday: wk1 });
    }
  }
  return out;
}

// Notes from before last week, for the "Earlier" part of the panel. Grouped by week, newest week first; each group
// carries its Monday, its file and its entries (newest first). Read-only, so nothing is cached or written.
function olderNotes(project, now = new Date()) {
  const want = project ? [check(project)] : projects();
  const cutoff = mondayOf(now); cutoff.setDate(cutoff.getDate() - 7); // last week's Monday: that week and later are in notes()
  const received = vault.receivedRoots();
  const weeks = new Map();
  for (const p of want) {
    for (const { rel, monday } of weekFiles(p, received)) {
      if (monday >= cutoff) continue;
      const out = [];
      if (okf(p)) out.push(...readWeekNotes(p, rel, monday)); else readIsoNotes(p, rel, out);
      if (!out.length) continue;
      const key = ymd(monday);
      if (!weeks.has(key)) weeks.set(key, { monday: key, entries: [] });
      weeks.get(key).entries.push(...out);
    }
  }
  return [...weeks.values()]
    .sort((a, b) => b.monday.localeCompare(a.monday))
    .map((w) => ({ monday: w.monday, entries: finish(w.entries) }));
}

// What the Notes panel shows under the box before saving: where the note would go.
function where(project, now = new Date()) {
  const p = check(project);
  return { file: notesRel(p, now), actions: registers.sharedRegister() || (okf(p) ? registerRel(p) : actionsRel(p)), week: isoWeek(now) };
}

module.exports = { list, close, reopen, update, addNote, notes, olderNotes, where, projects, actionText, isoWeek, parseItem, PREFIX, INBOX };
