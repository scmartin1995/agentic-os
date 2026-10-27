// Action-item registers: any vault note whose frontmatter says `concept_class: action-item` (for example
// Lumen/Database Team/Records/actionitem-register.md). Reads the numbered sections (`## N — Title `[OPEN]``) and the
// "Where the items stand" table, and writes back only the changes the register's own rules allow: a dated line
// appended to an item's Updates, the status tag flipped in the heading and the table, the open/closed sentence
// recounted, and as_of bumped. Carried over from the Oct 6 build; actions.cjs is the only caller.
const fs = require('fs');
const path = require('path');
const vault = require('./vault.cjs');
const { markWritten } = require('./shared.cjs');
const { writeText } = require('./store.cjs');

const HEAD = /^## (\d+) — (.+?)\s+`\[(OPEN|CLOSED(?: (\d{6}))?)\]`\s*$/;
const ROW = /^\|\s*(\d+)\s*\|(.*)\|\s*`\[([^\]]+)\]`\s*\|\s*(.*?)\s*\|\s*$/;
// Spaces are \s+ because the sentence can wrap across lines; each gap's original whitespace is kept.
const COUNTS = /\b(?:[A-Z][a-z]+|\d+)(?:-[a-z]+)?(\s+)(?:are|is)(\s+)open(\s+)and(\s+)(?:[a-z]+|\d+)(?:-[a-z]+)?(\s+)(?:are|is)(\s+)closed\b/;
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const words = (n) => (n < 20 ? ONES[n] : n < 100 ? TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '') : String(n));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const pad2 = (n) => String(n).padStart(2, '0');
const yymmdd = (d = new Date()) => `${pad2(d.getFullYear() % 100)}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
const iso = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
// "261008" -> "2026-10-08"
const fromYymmdd = (s) => (/^\d{6}$/.test(s || '') ? `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}` : null);

// Markdown to plain text for the cards: links keep their text, emphasis and code ticks go.
const plain = (s) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '').replace(/~~[^~]*~~/g, '').replace(/\s+/g, ' ').trim();

// The frontmatter check reads only the first 4 KB, and is remembered per file until the file changes, because
// list() asks it of every note in the vault each time the panel refreshes.
const seen = new Map(); // rel -> { mtime, yes }
function isRegister(rel) {
  const abs = vault.resolveInside(rel);
  if (!abs) return false;
  let mtime;
  try { mtime = fs.statSync(abs).mtimeMs; } catch { return false; }
  const hit = seen.get(rel);
  if (hit && hit.mtime === mtime) return hit.yes;
  let head = '';
  try { const fd = fs.openSync(abs, 'r'); const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, 4096, 0); fs.closeSync(fd); head = buf.slice(0, n).toString('utf8'); } catch { return false; }
  let yes = false;
  if (head.startsWith('---')) {
    const end = head.indexOf('\n---', 3);
    yes = /^concept_class:\s*["']?action-item["']?\s*$/m.test(end === -1 ? head : head.slice(0, end));
  }
  seen.set(rel, { mtime, yes });
  return yes;
}

// Every register at or under a folder of the vault ('' for the whole vault).
function inFolder(dirRel, files = vault.listMarkdown()) {
  const pre = dirRel ? `${dirRel}/` : '';
  return files.filter((f) => f.startsWith(pre) && isRegister(f));
}

// Paragraph that starts with `**Label.**`, joined across its wrapped lines.
function para(lines, from, to, label) {
  const i = lines.slice(from, to).findIndex((l) => l.startsWith(`**${label}.**`));
  if (i === -1) return '';
  const out = [];
  for (let j = from + i; j < to && lines[j].trim() !== ''; j++) out.push(lines[j]);
  return plain(out.join(' ').replace(`**${label}.**`, ''));
}

function updatesOf(lines, from, to) {
  const i = lines.slice(from, to).findIndex((l) => l.trim() === '**Updates**');
  if (i === -1) return [];
  const out = [];
  for (let j = from + i + 1; j < to; j++) {
    const l = lines[j];
    if (l.startsWith('- ')) out.push(l.slice(2));
    else if (/^\s+\S/.test(l) && out.length) out[out.length - 1] += ' ' + l.trim();
    else break;
  }
  return out.map((u) => { const m = u.match(/^\[(\d{6})\]\s*(.*)$/); return m ? { date: m[1], text: plain(m[2]) } : { date: '', text: plain(u) }; });
}

function itemRanges(lines) {
  const starts = [];
  lines.forEach((l, i) => { if (HEAD.test(l)) starts.push(i); });
  return starts.map((s) => {
    let e = lines.length;
    for (let j = s + 1; j < lines.length; j++) if (lines[j].startsWith('## ')) { e = j; break; }
    return { start: s, end: e };
  });
}

function recount(lines, eol) {
  let open = 0, closed = 0;
  for (const l of lines) { const m = l.match(HEAD); if (m) { if (m[3] === 'OPEN') open++; else closed++; } }
  const be = (n) => (n === 1 ? 'is' : 'are');
  let out = lines.join(eol);
  out = out.replace(COUNTS, (_m, a, b, c, d, e, f) => `${cap(words(open))}${a}${be(open)}${b}open${c}and${d}${words(closed)}${e}${be(closed)}${f}closed`);
  return out.replace(/^(---\r?\n[\s\S]*?^as_of:\s*)\S+/m, `$1${iso()}`);
}

// One backup, one safe write, marked as ours so it isn't reported as "edited elsewhere".
function save(rel, abs, text) {
  try { require('./policy.cjs').backup(abs); } catch { /* best effort; writing still proceeds */ }
  writeText(abs, text);
  markWritten(rel);
}

function parse(rel) {
  const abs = vault.resolveInside(rel);
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split(/\r?\n/);
  const fm = text.match(/^---\r?\n[\s\S]*?\ntitle:\s*(.+)\r?\n/);
  const waiting = {};
  for (const l of lines) { const m = l.match(ROW); if (m) waiting[m[1]] = m[4] === '—' || m[4] === '-' ? '' : plain(m[4]); }
  const items = itemRanges(lines).map(({ start, end }) => {
    const m = lines[start].match(HEAD);
    const updates = updatesOf(lines, start + 1, end);
    return {
      num: Number(m[1]), title: plain(m[2]), open: m[3] === 'OPEN', closed: fromYymmdd(m[4]),
      waiting: waiting[m[1]] || '',
      summary: para(lines, start + 1, end, 'Summary'),
      // the project whose note made the item (the shared register holds every project's items); older items have none
      project: para(lines, start + 1, end, 'Project') || null,
      // only an "Auto-added" first update says when the item was added; older items don't record it
      added: updates[0] && /^auto-added\b/i.test(updates[0].text) ? fromYymmdd(updates[0].date) : null,
      updates,
    };
  });
  return { file: rel, title: fm ? fm[1].trim().replace(/^["']|["']$/g, '') : path.basename(rel, '.md'), items };
}

// change: { text?: string, open?: boolean }. One read, one backup, one write.
function update(rel, num, change = {}) {
  if (!isRegister(rel)) throw new Error('That file is not an action-item register.');
  const abs = vault.resolveInside(rel);
  const text = fs.readFileSync(abs, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const range = itemRanges(lines).find(({ start }) => Number(lines[start].match(HEAD)[1]) === Number(num));
  if (!range) throw new Error(`Item ${num} is no longer in the register. Look again.`);
  const head = lines[range.start].match(HEAD);
  const wasOpen = head[3] === 'OPEN';
  const flip = typeof change.open === 'boolean' && change.open !== wasOpen;
  if (typeof change.open === 'boolean' && !flip) throw new Error(wasOpen ? 'That item is already open.' : 'That item is already closed.');
  let note = String(change.text || '').replace(/\s+/g, ' ').trim();
  if (!note && !flip) throw new Error('An update needs some words.');
  if (!note) note = change.open ? 'Reopened on his word.' : 'Closed on his word.';
  const today = yymmdd();
  const entry = `- [${today}] ${note}`;

  // 1. the Updates log (created before Sources, or before the closing rule, if the item has none)
  const { start, end } = range;
  const ui = lines.slice(start, end).findIndex((l) => l.trim() === '**Updates**');
  if (ui !== -1) {
    let j = start + ui + 1;
    while (j < end && (lines[j].startsWith('- ') || /^\s+\S/.test(lines[j]))) j++;
    lines.splice(j, 0, entry);
  } else {
    let at = lines.slice(start, end).findIndex((l) => l.startsWith('**Sources.**'));
    if (at === -1) { for (let j = end - 1; j > start; j--) if (lines[j].trim() === '---') { at = j - start; break; } }
    const k = at === -1 ? end : start + at;
    const block = ['**Updates**', entry, ''];
    if (lines[k - 1] !== undefined && lines[k - 1].trim() !== '') block.unshift('');
    lines.splice(k, 0, ...block);
  }

  // 2. the status tag, in the heading and in the "Where the items stand" table
  if (flip) {
    const tag = change.open ? '`[OPEN]`' : `\`[CLOSED ${today}]\``;
    lines[start] = lines[start].replace(/`\[(OPEN|CLOSED(?: \d{6})?)\]`\s*$/, tag);
    const r = lines.findIndex((l) => { const m = l.match(ROW); return m && Number(m[1]) === Number(num); });
    if (r !== -1) lines[r] = lines[r].replace(/`\[[^\]]+\]`(\s*\|\s*)(.*?)(\s*\|\s*)$/, (_a, s1, w, s2) => `${tag}${s1}${change.open ? w : '—'}${s2}`);
  }

  // 3 and 4. the intro's "Nine are open and fifty-six are closed" sentence, recounted, and as_of
  save(rel, abs, recount(lines, eol));
  return parse(rel);
}

// The one register every project's action items go into: the register with the most numbered items (the Database Team
// register, today). Ties go to the first path. null when the vault has no register yet.
function sharedRegister() {
  let best = null, most = -1;
  for (const rel of inFolder('')) {
    let n = 0;
    try { n = itemRanges(fs.readFileSync(vault.resolveInside(rel), 'utf8').split(/\r?\n/)).length; } catch { continue; }
    if (n > most) { best = rel; most = n; }
  }
  return best;
}
// The register a project's new action items go into when there is no shared one: the first one in its folder, or
// (none yet) a minimal one made at <project>/Records/actionitem-register.md.
function registerFor(projectRel) {
  const found = inFolder(projectRel);
  if (found.length) return found[0];
  const rel = `${projectRel}/Records/actionitem-register.md`;
  const abs = vault.resolveInside(rel);
  if (!abs) throw new Error('That path is outside the notes folder.');
  const name = path.basename(projectRel).replace(/_/g, ' ');
  const today = iso();
  writeText(abs, [
    '---',
    'concept_class: action-item',
    `title: ${name} Action Items`,
    `created: ${today}`,
    `as_of: ${today}`,
    '---',
    '',
    `# ${name} Action Items`,
    '',
    'Zero are open and zero are closed.',
    '',
    '## Where the items stand',
    '',
    '| # | Item | Status | Waiting on |',
    '| --- | --- | --- | --- |',
    '',
  ].join('\n'));
  markWritten(rel);
  return rel;
}

// A note that starts with "action item": a new numbered `[OPEN]` item sourced from the note, plus its table row. Every
// project's items go into the shared register, and each carries a `**Project.**` line naming the project it came from.
function addFromNote(projectRel, title, sourceRel, projectName) {
  const clean = String(title || '').replace(/[`|]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('Add what needs doing after "action item".');
  const rel = sharedRegister() || registerFor(projectRel);
  const origin = String(projectName || '').replace(/[`|*]/g, '').replace(/\s+/g, ' ').trim();
  const abs = vault.resolveInside(rel);
  const text = fs.readFileSync(abs, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let num = 0;
  for (const l of lines) { const m = l.match(HEAD); if (m) num = Math.max(num, Number(m[1])); }
  num += 1;
  const today = yymmdd();
  const link = path.posix.relative(path.posix.dirname(rel), sourceRel);
  const section = [
    `## ${num} — ${clean} \`[OPEN]\``,
    '',
    `**Summary.** ${clean}.`,
    '',
    ...(origin ? [`**Project.** ${origin}`, ''] : []),
    '**Updates**',
    `- [${today}] Auto-added from today's notes. Source: [\`${sourceRel}\`](${link}).`,
    '',
    `**Sources.** [\`${sourceRel}\`](${link}).`,
    '',
    '---',
    '',
  ];
  // Insert right after the last item's own section, not at the end of the file: a register can carry prose after
  // its last item (Database Team's "## Provenance and decay"), and the new item belongs with the numbered list.
  const ranges = itemRanges(lines);
  lines.splice(ranges.length ? ranges[ranges.length - 1].end : lines.length, 0, ...section);

  const tableRow = `| ${num} | ${clean} | \`[OPEN]\` | — |`;
  let last = -1;
  for (let j = 0; j < lines.length; j++) if (ROW.test(lines[j])) last = j;
  if (last === -1) {
    const h = lines.findIndex((l) => l.trim() === '## Where the items stand');
    if (h !== -1) {
      let j = h + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (lines[j] && lines[j].startsWith('|')) j++;
      if (lines[j] && lines[j].startsWith('|')) j++;
      lines.splice(j, 0, tableRow);
    }
  } else {
    lines.splice(last + 1, 0, tableRow);
  }

  save(rel, abs, recount(lines, eol));
  return { file: rel, num, register: parse(rel) };
}

module.exports = { isRegister, inFolder, parse, update, addFromNote, registerFor, sharedRegister };
