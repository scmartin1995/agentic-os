// The Notes and Action items pages. Everything lives in plain markdown in the workspace, so any editor and any agent
// can read and edit it, and the pages never hold the only copy. The rule is by file name, one pair per project folder:
//
//   projects/<P>/notes.md          dated notes: "## Mon 2026-10-12" day headings, "### 14:05" time headings
//   projects/<P>/action-items.md   checkbox lines anywhere in the file: "- [ ] open", "- [x] done"
//   inbox/notes.md, inbox/action-items.md   the Inbox: "not sure where this goes yet"
//
// Lines the Notes page writes look like this (hand-typed lines without the " | added ..." part work too):
//   - [ ] call the dealer | added 2026-10-08 10:42 · [note](notes.md)
// A note that starts with "action item" is also copied to that project's action items (prefix removed).
// Ticking an item on the page and changing [ ] to [x] in the file are the same thing: the page only reads the file.
// If the file has "## Open" and "## Closed" headings, a ticked item moves under Closed; otherwise it is ticked in place.
// No AI is involved anywhere here, so none of it costs tokens.
const fs = require('fs');
const path = require('path');
const vault = require('./vault.cjs');
const { markWritten } = require('./shared.cjs');
const { writeText } = require('./store.cjs');

const PREFIX = /^\s*action item\b\s*[:\-–—]?\s*/i;
const INBOX = 'Inbox';
const NOTES = 'notes.md';
const ACTIONS = 'action-items.md';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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

// "action item: call the dealer" -> "call the dealer"; anything else -> null.
function actionText(note) {
  const m = String(note).match(PREFIX);
  if (!m) return null;
  return String(note).slice(m[0].length).replace(/\s+/g, ' ').trim();
}

const nice = (p) => (p === INBOX ? INBOX : p.replace(/[_-]/g, ' '));
// Every folder directly under projects/ (not starting with . or _), plus the Inbox. Anything else is refused, so a name
// can't reach outside the workspace.
function projects() {
  let names = [];
  try { names = fs.readdirSync(path.join(vault.ROOT, 'projects'), { withFileTypes: true }).filter((e) => e.isDirectory() && !/^[._]/.test(e.name)).map((e) => e.name); } catch { /* no projects folder yet */ }
  return [...names.sort((a, b) => a.localeCompare(b)), INBOX];
}
function check(project) {
  const p = String(project || '');
  if (!projects().includes(p)) throw new Error(`There is no project called "${p}".`);
  return p;
}
const base = (p) => (p === INBOX ? 'inbox' : `projects/${p}`);
const notesRel = (p) => `${base(p)}/${NOTES}`;
const actionsRel = (p) => `${base(p)}/${ACTIONS}`;

const abs = (rel) => { const a = vault.resolveInside(rel); if (!a) throw new Error('That path is outside the workspace.'); return a; };
const readRel = (rel) => { try { return fs.readFileSync(abs(rel), 'utf8'); } catch { return ''; } };
function save(rel, text) { writeText(abs(rel), text); markWritten(rel); } // marked as ours, so it isn't reported as "edited elsewhere"
const eol = (text) => (/\r\n/.test(text) ? '\r\n' : '\n'); // keep whatever line endings the file already has
// When a line moves between sections, runs of blank lines are squeezed to one.
function saveList(rel, lines, nl) { save(rel, lines.join(nl).replace(/(\r?\n){3,}/g, nl + nl)); }

// ---- action-items.md ----

// One list line: "- [ ] text | added 2026-10-08 10:42, closed ... · [note](link)".
const ITEM = /^(\s*[-*+]\s+)\[( |x|X)\]\s+(.*?)\s*$/;
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
// Open/Closed sections are optional. A file that has neither keeps everything in one list.
const sectioned = (lines) => heading(lines, 'Open') >= 0 && heading(lines, 'Closed') >= 0;
function insertUnder(lines, name, line, atTop) {
  const h = heading(lines, name);
  if (h < 0) { // no such section: add the line at the end of the file
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push(line, '');
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
const newActionsFile = (p) => `# Action items: ${nice(p)}\n\n## Open\n\n## Closed\n`;

function addAction(p, text, at, noteRel) {
  const rel = actionsRel(p);
  const old = readRel(rel);
  const nl = old ? eol(old) : '\n';
  const lines = (old || newActionsFile(p)).split(/\r?\n/);
  const link = path.posix.relative(base(p), noteRel);
  const line = `- [ ] ${text} | added ${ymd(at)} ${hhmm(at)} · [note](${link})`;
  insertUnder(lines, 'Open', line, false);
  saveList(rel, lines, nl);
  return { project: p, file: rel, raw: line, ...parseItem(line) };
}

// Every action item in every project, open and closed, read fresh from the files.
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
  return { items, open: items.filter((i) => !i.done).length };
}

// Find one exact line again (the file may have been edited by hand since the page read it).
function findLine(lines, raw) { return lines.findIndex((l) => l.trim() === String(raw).trim()); }
function locate(project, raw, wantDone) {
  const p = check(project);
  const rel = actionsRel(p);
  const old = readRel(rel);
  const lines = old.split(/\r?\n/);
  const i = findLine(lines, raw);
  if (i < 0) throw new Error('That item has changed in the file since the page read it. Look again.');
  const m = lines[i].match(ITEM);
  const it = parseItem(lines[i]);
  if (!m || !it) throw new Error('That line is not an action item.');
  if (it.done !== wantDone) throw new Error(wantDone ? 'That item is already open.' : 'That item is already closed.');
  return { rel, old, lines, i, m, it };
}

function close(project, raw, at = new Date()) {
  const { rel, old, lines, i, m, it } = locate(project, raw, false);
  const stamp = `closed ${ymd(at)} ${hhmm(at)}`;
  const meta = (it.added ? `added ${it.added}, ${stamp}` : stamp) + (it.note ? ` · [note](${it.note})` : '');
  let line;
  if (sectioned(lines)) {
    lines.splice(i, 1);
    line = `- [x] ${it.text} | ${meta}`;
    insertUnder(lines, 'Closed', line, true);
    saveList(rel, lines, eol(old));
  } else {
    line = `${m[1]}[x] ${it.text} | ${meta}`;
    lines[i] = line;
    save(rel, lines.join(eol(old)));
  }
  return { raw: line.trim() };
}

// Undo a close: back to open, without the closed stamp.
function reopen(project, raw) {
  const { rel, old, lines, i, m, it } = locate(project, raw, true);
  const meta = [it.added ? `added ${it.added}` : '', it.note ? `[note](${it.note})` : ''].filter(Boolean).join(' · ');
  let line;
  if (sectioned(lines)) {
    lines.splice(i, 1);
    line = `- [ ] ${it.text}${meta ? ` | ${meta}` : ''}`;
    insertUnder(lines, 'Open', line, false);
    saveList(rel, lines, eol(old));
  } else {
    line = `${m[1]}[ ] ${it.text}${meta ? ` | ${meta}` : ''}`;
    lines[i] = line;
    save(rel, lines.join(eol(old)));
  }
  return { raw: line.trim() };
}

// Reword an item (the page's Update button). Only the text changes: the dates and the note link stay.
function update(project, raw, newText) {
  const p = check(project);
  const text = String(newText || '').replace(/\s+/g, ' ').replace(/ \| /g, ' / ').trim().slice(0, 500);
  if (!text) throw new Error('An action item needs some words.');
  const rel = actionsRel(p);
  const old = readRel(rel);
  const lines = old.split(/\r?\n/);
  const i = findLine(lines, raw);
  if (i < 0) throw new Error('That item has changed in the file since the page read it. Look again.');
  const m = lines[i].match(ITEM);
  const it = parseItem(lines[i]);
  if (!m || !it) throw new Error('That line is not an action item.');
  const cut = lines[i].lastIndexOf(' | ');
  const meta = it.added || it.closed || it.note ? lines[i].trimEnd().slice(cut) : '';
  const line = `${m[1]}[${m[2]}] ${text}${meta}`;
  lines[i] = line;
  save(rel, lines.join(eol(old)));
  return { raw: line.trim() };
}

// ---- notes.md ----

const newNotesFile = (p) => `# Notes: ${nice(p)}\n`;

// Save a note, stamped with the date and time. Returns where it went and, for an "action item" note, the new item.
function addNote(project, text, at = new Date()) {
  const p = check(project);
  const body = String(text || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_NOTE);
  if (!body) throw new Error('The note is empty.');
  const item = actionText(body);
  if (item === '') throw new Error('Add what needs doing after "action item".');
  const rel = notesRel(p);
  const old = readRel(rel);
  const nl = old ? eol(old) : '\n';
  let out = (old || newNotesFile(p)).replace(/\s+$/, '') + nl;
  const day = `## ${DAYS[at.getDay()]} ${ymd(at)}`;
  // A new day heading unless today's is already the last one in the file.
  const days = out.split(/\r?\n/).filter((l) => /^##\s/.test(l) && !/^###/.test(l));
  if (days[days.length - 1]?.trim() !== day) out += nl + day + nl;
  out += nl + `### ${hhmm(at)}${item ? ' · action item' : ''}` + nl + body.split('\n').join(nl) + nl;
  save(rel, out);
  const action = item ? addAction(p, item, at, rel) : null;
  return { project: p, file: rel, date: ymd(at), time: hhmm(at), action };
}

// Dated notes from this week and last (newest first), for one project or all of them. Text under a day heading with
// no time heading is one entry at 00:00; anything before the first day heading isn't dated, so it isn't listed.
function notes(project, now = new Date()) {
  const want = project ? [check(project)] : projects();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  from.setDate(from.getDate() - ((from.getDay() + 6) % 7) - 7); // Monday of last week
  const out = [];
  for (const p of want) {
    const rel = notesRel(p);
    const text = readRel(rel);
    if (!text) continue;
    let date = null, cur = null;
    const flush = () => { if (cur) { cur.text = cur.text.join('\n').trim(); if (cur.text) out.push(cur); cur = null; } };
    const start = (time, action) => { cur = { project: p, name: nice(p), file: rel, date, time, action, text: [] }; };
    for (const line of text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').split(/\r?\n/)) {
      const th = line.match(/^###\s+(\d{1,2}:\d{2})(.*)$/);
      const dh = !th && line.match(/^##\s+.*?(\d{4}-\d{2}-\d{2})/);
      if (dh) { flush(); date = dh[1]; continue; }
      if (th && date) { flush(); start(th[1].padStart(5, '0'), /action item/i.test(th[2])); continue; }
      if (/^#{1,2}\s/.test(line)) { flush(); date = null; continue; }
      if (!date) continue;
      if (!cur && line.trim()) start('00:00', false);
      if (cur) cur.text.push(line);
    }
    flush();
  }
  const first = ymd(from), last = ymd(now);
  for (const n of out) if (!n.action && actionText(n.text)) n.action = true;
  return out.filter((n) => n.date >= first && n.date <= last).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
}

// What the Notes page shows under the box before saving: where the note would go.
function where(project, now = new Date()) {
  const p = check(project);
  return { file: notesRel(p), actions: actionsRel(p), week: isoWeek(now) };
}

module.exports = { list, close, reopen, update, addNote, notes, where, projects, actionText, isoWeek, parseItem, PREFIX, INBOX, NOTES, ACTIONS };
