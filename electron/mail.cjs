// Mail: read the last week of mail from classic Outlook on this PC, say which messages need a reply, draft those.
//
// Read-only. Outlook's own automation is used (no Entra registration, no password, no network call to Microsoft), so
// it works only while classic Outlook is open. Nothing is ever sent, moved, deleted or marked in Outlook; drafts are
// text shown in Agentic OS, for the user to copy into Outlook.
//
// What is kept (mail.json in the app data folder, never inside the vault):
//   - every mail that is not bulk: sender, subject, date, a short summary and searchable "atoms". No message text.
//   - for mail judged to need a reply: the whole message text and a draft reply, until it is marked done or dismissed,
//     and then the text and draft are deleted.
// Bulk mail (Jira, ServiceNow, digests, no-reply senders, calendar replies) is skipped by rule and never reaches a model.
// "Doesn't need a reply" and "done" are remembered in mail-feedback.json and shown to the classifier as examples.
const { execFile } = require('child_process');
const store = require('./store.cjs');

const DAYS = 7;                // how far back a pull looks the first time, and the most it ever looks back
const OVERLAP_MS = 24 * 3600000; // later pulls start this long before the last good pull, for mail that reaches Outlook late (asleep, off VPN)
const KEEP_DAYS = 30;          // summaries older than this are dropped (open replies stay until closed)
const BODY_MAX = 20_000;       // characters of message text kept for a mail that needs a reply
const BODY_FOR_MODEL = 3_000;  // characters of each message the classifier sees
const BATCH = 8;
const EXAMPLES = 14;           // feedback examples shown to the classifier

const file = () => require('path').join(store.dataDir(), 'mail.json');
const feedbackFile = () => require('path').join(store.dataDir(), 'mail-feedback.json');
const load = () => { const j = store.readJson(file(), null); return j && j.items ? j : { lastPull: 0, items: {} }; };
const save = (m) => store.tryWriteJson(file(), m);

// A small log of every scheduled attempt and the reason for every skip, so a pull that quietly never ran can be seen.
const logFile = () => require('path').join(store.dataDir(), 'mail-log.json');
const readLog = () => { const j = store.readJson(logFile(), []); return Array.isArray(j) ? j : []; };
function log(kind, note) { // kind: scheduler | skip | check | pull | retry | error
  const l = readLog(), last = l[l.length - 1];
  if ((kind === 'skip' || kind === 'check') && last && last.kind === kind && last.note.replace(/d+/g, '#') === String(note).replace(/d+/g, '#')) { last.at = Date.now(); last.n = (last.n || 1) + 1; store.tryWriteJson(logFile(), l); return; } // the same line every 10 minutes is one line with a count
  l.push({ at: Date.now(), kind, note: String(note || '').slice(0, 300) });
  store.tryWriteJson(logFile(), l.slice(-200));
}
const loadFeedback = () => { const j = store.readJson(feedbackFile(), []); return Array.isArray(j) ? j : []; };

// ---------- skipped by rule, no model ----------
// Only ServiceNow messages are skipped for now (loosened [261023] from a longer list: Jira, no-reply, digests, invites and
// so on). Everything else goes to the classifier, which still decides what needs a reply.
const BULK_SENDER = /(service-?now|\bsnow\b)/i;
const BULK_SUBJECT = BULK_SENDER;
const isBulk = (m) => BULK_SENDER.test(`${m.from} ${m.fromAddr}`) || BULK_SUBJECT.test(m.subject);

// ---------- reading Outlook (read-only) ----------
const READ_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Fail($m) { (@{ error = $m } | ConvertTo-Json -Compress); exit 0 }
if (-not (Get-Process OUTLOOK -ErrorAction SilentlyContinue)) { Fail 'Outlook is not open. Open classic Outlook, wait until it has finished loading, then try again.' }
try { $ol = New-Object -ComObject Outlook.Application; $ns = $ol.GetNamespace('MAPI'); $me = $ns.CurrentUser.Name } catch { Fail ('Could not reach Outlook: ' + $_.Exception.Message) }
$skip = @('Deleted Items','Junk Email','Drafts','Outbox','Sync Issues','Conflicts','Local Failures','Server Failures','Conversation History','Team Chat','Conversation Action Settings','Quick Step Settings','RSS Feeds')
$since = [DateTimeOffset]::FromUnixTimeMilliseconds(__SINCEMS__).LocalDateTime.ToString('MM/dd/yyyy hh:mm tt', [Globalization.CultureInfo]::InvariantCulture)
$filter = "[ReceivedTime] >= '" + $since + "'"
$out = New-Object System.Collections.ArrayList
function Walk($f) {
  if ($skip -contains $f.Name) { return }
  if ($f.DefaultItemType -eq 0) {
    foreach ($m in $f.Items.Restrict($filter)) {
      if ($m.Class -ne 43) { continue }
      $verb = 0
      try { $verb = [int]$m.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x10810003') } catch {}
      $addr = ''
      if ($m.SenderEmailType -eq 'SMTP') { $addr = $m.SenderEmailAddress }
      $body = [string]$m.Body
      if ($body.Length -gt __BODY__) { $body = $body.Substring(0, __BODY__) }
      [void]$out.Add(@{ id = $m.EntryID; folder = $f.Name; subject = [string]$m.Subject; from = [string]$m.SenderName; fromAddr = [string]$addr; to = [string]$m.To; cc = [string]$m.CC; received = $m.ReceivedTime.ToString('yyyy-MM-ddTHH:mm:ss'); unread = [bool]$m.UnRead; verb = $verb; body = $body })
    }
  }
  foreach ($c in $f.Folders) { Walk $c }
}
try { foreach ($s in $ns.Stores) { Walk $s.GetRootFolder() } } catch { Fail ('Reading mail failed: ' + $_.Exception.Message) }
# Mail we already hold that still waits on a reply: look each one up directly (a reply made since is on an old message, outside the window).
$open = New-Object System.Collections.ArrayList
foreach ($id in @(__OPENIDS__)) {
  try { $o = $ns.GetItemFromID($id); $v = 0; try { $v = [int]$o.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x10810003') } catch {}; [void]$open.Add(@{ id = $id; verb = $v }) } catch {}
}
(@{ me = $me; items = @($out); open = @($open) } | ConvertTo-Json -Depth 4 -Compress)
`;
const OPEN_SCRIPT = (id) => `$ol = New-Object -ComObject Outlook.Application; $ol.Session.GetItemFromID('${id}').Display()`;

const ps = (script, timeout) => new Promise((resolve, reject) => {
  if (process.platform !== 'win32') return reject(new Error('Reading mail needs classic Outlook on Windows; it is not available on a Mac.'));
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { maxBuffer: 128 * 1024 * 1024, timeout, windowsHide: true, encoding: 'utf8' },
    (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).split('\n')[0].slice(0, 300))) : resolve(stdout)));
});

const asList = (x) => (Array.isArray(x) ? x : x ? [x] : []);
async function readOutlook({ sinceMs, openIds = [] } = {}) {
  const ids = openIds.filter((id) => /^[0-9A-Fa-f]+$/.test(id)).map((id) => `'${id}'`).join(',');
  const script = READ_SCRIPT.replace(/__SINCEMS__/g, String(Math.floor(sinceMs || Date.now() - DAYS * 86400000))).replace(/__BODY__/g, String(BODY_MAX)).replace(/__OPENIDS__/g, ids);
  const out = await ps(script, 5 * 60 * 1000);
  let j;
  try { j = JSON.parse(out.replace(/^﻿/, '').trim()); } catch { throw new Error('Outlook answered with something unreadable.'); }
  if (j.error) throw new Error(j.error);
  return { me: String(j.me || ''), items: asList(j.items), open: asList(j.open) };
}

// ---------- the model steps ----------
const SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, summary: { type: 'string' }, atoms: { type: 'array', items: { type: 'string' } },
    needsReply: { type: 'boolean' }, reason: { type: 'string' },
  }, required: ['id', 'summary', 'atoms', 'needsReply', 'reason'] } } },
  required: ['items'],
};
function system(examples) {
  const ex = examples.length ? `\n\nThe user has already judged some mail. Follow their judgement:\n${examples.map((e) => `- ${e.label === 'no-reply' ? 'NO reply needed' : 'DID need a reply'}: from ${e.from}, "${e.subject}"${e.summary ? ` (${e.summary.slice(0, 120)})` : ''}`).join('\n')}` : '';
  return `You read a person's email to index it and to tell them what needs their attention. For each message write:
- summary: 1-2 plain sentences: who wants what, or what the message says. Use the names and IDs as written.
- atoms: up to 8 short exact things worth searching by: ticket or record IDs, database or server names, people's names, dates, decisions, numbers. Copy them exactly.
- needsReply: true ONLY if a real person wrote this to the user (they are on the To line, or named in a CC with a direct ask) AND expects an answer or action from the user (a question, a request, a decision, a deadline), AND nothing says it is already handled. False for announcements, thanks and acknowledgements, FYIs, group broadcasts, automated notices, and threads where the user is only copied with no ask of them.
- reason: one short sentence on why (what is being asked of the user, or why nothing is). Never invent anything that is not in the message.${ex}`;
}
const DRAFT_SYSTEM = `You write the first draft of an email reply for Sterling Martin, a technical product owner on a database team. Write only the body of the reply: no subject line, no commentary. Plain, direct, short, no filler and no cheerleading. Start with the sender's first name (names appear as "Last, First"; use the first name). Answer what was asked. If a fact, date or decision is needed that the email does not give, put it in [square brackets] for Sterling to fill in rather than guessing; promise nothing the email does not already commit to. End with "Sterling".`;

async function classify(batch, oneShot, examples) {
  const prompt = batch.map((m) => `=== id: ${m.id}\nfrom: ${m.from}\nto you: ${m.addressed}\nsubject: ${m.subject}\nreceived: ${m.received}\n\n${m.body.slice(0, BODY_FOR_MODEL)}`).join('\n\n');
  const r = await oneShot({ system: system(examples), prompt, schema: SCHEMA, model: 'haiku', timeoutMs: 3 * 60 * 1000 }); // a batch of 8 messages with structured output can run long
  return ((r.out && r.out.items) || []);
}
// The drafts follow the no-ai-slop skill (skills/no-ai-slop/SKILL.md): the rules are in the prompt, and slop() checks the
// result in code for the patterns a machine can see, because a prompt alone gets ignored now and then.
const SLOP_RULES = `Write like a direct colleague, not an assistant. Rules:
- Say the answer or the ask in the first sentence. No opener ("Thanks for reaching out", "I hope this finds you well", "Great question") and no recap ending ("Let me know if you have any questions", "Thanks again", "Looking forward to").
- Plain verbs and concrete facts: names, dates, numbers, ticket IDs from the email. "decided", not "made a decision". Active voice. Repeat the clear word instead of rotating synonyms.
- Never use: delve, foster, leverage, utilize, facilitate, empower, streamline, robust, cutting-edge, seamless, ensure (as filler), circle back, touch base, reach out, going forward, moving forward, at the end of the day, it's worth noting, I wanted to. No em dashes; use a period or comma.
- No "not X, but Y" contrasts, no "Here's the thing", no colon reveals, no fake enthusiasm, no exclamation marks, no emoji, no bold, no bullet lists unless the email asks for several separate things.
- Keep it short: usually two to five sentences. Do not add pleasantries the original email did not call for.`;
const SLOP = [
  [/[—–]/, 'a dash'], [/!/, 'an exclamation mark'],
  [/\b(delve|foster|leverage|utilize|facilitate|empower|streamline|robust|cutting-edge|seamless|paradigm|game[- ]changer|holistic|synergy)\w*/i, 'a banned word'],
  [/\b(hope this (email )?finds you|reach(ing)? out|circle back|touch base|going forward|moving forward|at the end of the day|it'?s worth noting|i wanted to|thanks (so much )?for (reaching|your (email|message|note)))\b/i, 'a stock phrase'],
  [/\b(let me know if you (have|need)|feel free to|don'?t hesitate|looking forward to|thanks again|happy to help)\b/i, 'a recap or pleasantry ending'],
  [/\bnot (just |only |merely )?[^.\n]{1,60}\bbut\b|\bisn'?t [^.\n]{1,40}[.,;] it'?s\b/i, 'a "not X but Y" contrast'],
];
const slop = (text) => SLOP.filter(([re]) => re.test(text)).map(([, why]) => why);
async function draftFor(m, oneShot) {
  const prompt = `From: ${m.from}\nSubject: ${m.subject}\nReceived: ${m.received}\n\n${m.body}`;
  const system = `${DRAFT_SYSTEM}\n\n${SLOP_RULES}`;
  let text = String((await oneShot({ system, prompt, model: 'sonnet' })).text || '').trim();
  const found = slop(text);
  if (found.length) { // one retry, naming exactly what to remove; keep the better of the two
    const again = String((await oneShot({ system, prompt: `${prompt}\n\n--- Your first draft:\n${text}\n\nIt contains ${found.join(', ')}. Rewrite the draft without them. Same facts, same length or shorter. Output only the reply body.`, model: 'sonnet' })).text || '').trim();
    if (again && slop(again).length <= found.length) text = again;
  }
  return text;
}

// ---------- pulling ----------
let running = null;
const addressedTo = (m, me) => {
  const has = (s) => me && String(s || '').toLowerCase().includes(me.toLowerCase());
  return has(m.to) ? 'on the To line' : has(m.cc) ? 'on the CC line' : 'not named (a group or list)';
};

// opts: { oneShot, emit, reader (tests) }. Returns { fetched, bulk, added, needReply, closed, failed, error }.
async function pull({ oneShot, emit = () => {}, reader = readOutlook } = {}) {
  if (running) return { already: true };
  running = { startedAt: Date.now() };
  const res = { fetched: 0, bulk: 0, added: 0, needReply: 0, closed: 0, failed: 0, error: '' };
  try {
    emit({ type: 'start' });
    const db = load();
    // Only mail received since the last pull that had nothing left to retry (minus a short overlap, for mail that reaches Outlook late).
    // No such pull on record yet: read the whole window once.
    const sinceMs = db.sinceOk ? Math.max(db.sinceOk - OVERLAP_MS, Date.now() - DAYS * 86400000) : Date.now() - DAYS * 86400000;
    const startedAt = Date.now();
    const openIds = Object.values(db.items).filter((e) => e.status === 'open').map((e) => e.id);
    const { me, items, open = [] } = await reader({ sinceMs, openIds });
    res.fetched = items.length;
    // 1. mail we already hold: a reply made since closes it
    for (const m of [...items, ...open]) {
      const have = db.items[m.id];
      if (have && have.status === 'open' && m.verb >= 102 && m.verb <= 104) { have.status = 'done'; have.closedAt = Date.now(); delete have.body; delete have.draft; res.closed++; }
    }
    // 2. new mail, bulk skipped by rule
    const fresh = [];
    for (const m of items) {
      if (db.items[m.id]) continue;
      if (isBulk(m) || (me && String(m.from).toLowerCase() === me.toLowerCase())) { res.bulk++; continue; } // bulk, or the user's own notes to self
      fresh.push({ ...m, addressed: addressedTo(m, me) });
    }
    const examples = [...loadFeedback()].slice(-EXAMPLES);
    for (let i = 0; i < fresh.length; i += BATCH) {
      const batch = fresh.slice(i, i + BATCH);
      emit({ type: 'progress', done: i, total: fresh.length });
      let out = [];
      try { out = await classify(batch, oneShot, examples); } catch (e) { res.failed += batch.length; res.error = String((e && e.message) || e); continue; }
      for (const m of batch) {
        const c = out.find((x) => x.id === m.id);
        if (!c || !c.summary) { res.failed++; continue; } // not stored: the next pull tries it again
        const replied = m.verb >= 102 && m.verb <= 104;
        const e = { id: m.id, folder: m.folder, subject: m.subject, from: m.from, received: m.received, summary: String(c.summary).slice(0, 400), atoms: (c.atoms || []).map(String).slice(0, 10), reason: String(c.reason || '').slice(0, 240), unread: !!m.unread, status: 'info', addedAt: Date.now() };
        if (c.needsReply && !replied) {
          e.status = 'open';
          e.body = m.body.slice(0, BODY_MAX);
          try { e.draft = await draftFor(m, oneShot); } catch (err) { e.draft = ''; e.draftError = String((err && err.message) || err).slice(0, 160); }
          res.needReply++;
        }
        db.items[m.id] = e; res.added++;
      }
      save(db); // a long pull that is stopped keeps what it did
    }
    // 3. old summaries go; open replies stay until closed
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const [id, e] of Object.entries(db.items)) if (e.status !== 'open' && Date.parse(e.received) < cutoff) delete db.items[id];
    db.lastPull = Date.now();
    if (!res.failed) db.sinceOk = startedAt; // a pull with messages to retry keeps the window where it was, so they are read again
    save(db);
    log(res.added || res.closed || res.failed ? 'pull' : 'check', res.added || res.closed || res.failed ? `Pulled ${res.fetched} messages: ${res.added} new, ${res.needReply} need a reply${res.closed ? `, ${res.closed} closed by a reply` : ''}${res.failed ? `, ${res.failed} to retry${res.error ? ` (${res.error.slice(0, 120)})` : ''}` : ''}.` : `Checked ${res.fetched} messages, nothing new.`);
    emit({ type: 'done', ...res });
  } catch (err) {
    res.error = String((err && err.message) || err);
    log('error', `Pull failed: ${res.error}`);
    emit({ type: 'error', error: res.error });
  } finally { running = null; }
  return res;
}

// ---------- what the screen shows, and the two ways to close a reply ----------
// Not ok when the last scheduled attempt failed or was put off, or when no pull has succeeded for over a day.
function health(lastPullAt, now = Date.now()) {
  const tried = readLog().filter((e) => ['pull', 'check', 'retry', 'error'].includes(e.kind)).pop();
  if (tried && (tried.kind === 'retry' || tried.kind === 'error') && tried.at > (lastPullAt || 0)) return { ok: false, why: tried.note };
  if (lastPullAt && now - lastPullAt > 3 * 3600 * 1000) return { ok: false, why: 'No successful check in over 3 hours.' };
  return { ok: true, why: '' };
}
const strip = (e) => { const { body: _b, draft: _d, ...rest } = e; return rest; };

// ---------- the watch list ----------
// Things worth raising that are not replies: a migration or decommission finished, a date someone wants, something stuck, an escalation.
// Plain rules over the stored subject and summary (no model, no tokens), so they also cover mail already held. Last 7 days only.
const MIG = /\b(migrat\w*|cutover|decom\w*|decommission\w*|IDC|sysgen|database|DB|RITM\d+|CLOUDVS-\d+|ticket)\b/i;
const WATCH = [
  { kind: 'complete', label: 'Complete', test: (t) => /\b(migrat\w*|cutover|decom\w*|decommission\w*|go[- ]?live|provision\w*)\b[^.]{0,50}\b(complete|completed|done|finished|successful\w*)\b|\bsuccessfully (migrated|decommissioned|cut over)\b|\bcutover (is )?(done|complete)/i.test(t) },
  { kind: 'blocker', label: 'Blocked', test: (t) => MIG.test(t) && /\b(blocked|blocker|delayed|slipp\w+|on hold|failed|failure|not ready|unable to|cannot be|can'?t be|waiting on|stuck)\b/i.test(t) },
  { kind: 'escalation', label: 'Escalation', test: (t) => /\b(urgent|escalat\w+|asap)\b/i.test(t) },
  { kind: 'date', label: 'Date wanted', test: (t) => MIG.test(t) && /\b(needed by|confirm\w* (the |a )?(cutover|migration|go[- ]?live)? ?date|by (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w* \d{1,2}|cutover date)\b/i.test(t) },
];
// Jira notices never go on the watch list (ignored [261026], on Sterling's request); neither do out-of-office replies.
const JIRA = /^\[JIRA\]/i;
const OOO = /^(automatic reply|out of office)/i;
const watchOf = (e) => {
  const subj = e.subject || '';
  if (OOO.test(subj) || JIRA.test(subj)) return null;
  const t = `${subj}. ${e.summary || ''}`;
  const hit = WATCH.find((w) => w.test(t));
  return hit ? { kind: hit.kind, label: hit.label } : null;
};
const threadOf = (s) => String(s || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim().toLowerCase();
function watchList(db, now = Date.now()) {
  const dismissed = db.watchDismissed || {};
  const since = now - DAYS * 86400000;
  const seen = new Set();
  return Object.values(db.items)
    .filter((e) => e.status === 'info' && !dismissed[e.id] && Date.parse(e.received) >= since)
    .sort((a, b) => String(b.received).localeCompare(String(a.received)))
    .map((e) => ({ e, w: watchOf(e) })).filter((x) => x.w)
    .filter(({ e }) => { const k = threadOf(e.subject); if (seen.has(k)) return false; seen.add(k); return true; }) // newest per thread
    .sort((a, b) => WATCH.findIndex((w) => w.kind === a.w.kind) - WATCH.findIndex((w) => w.kind === b.w.kind) || String(b.e.received).localeCompare(String(a.e.received)))
    .map(({ e, w }) => ({ ...strip(e), watch: w.kind, watchLabel: w.label, suggestion: suggestionOf(e, w.kind) }));
}
// What Agentic OS would suggest doing about a watch item. Advice only: nothing is changed in Jira, Outlook or the notes.
const FINISHED = /^(done|closed|resolved|complete\w*|app decommed|decommed|decommissioned)$/i;
function suggestionOf(e, kind) {
  const j = e.jira;
  if (kind === 'complete') {
    if (!j) return 'Click Check Jira to see whether this is a database and what Jira says about it.';
    if (!j.confirmed) return 'No matching CIPDBPE item in Jira. If this is a database, check the SYSGEN or name in the mail and create or link the Jira item; if it is an application or server, mark it Seen.';
    if (FINISHED.test(j.status || '')) return `${j.key} is already ${j.status} in Jira. Nothing to change; mark it Seen.`;
    return `The mail says this finished, but ${j.key} is still "${j.status || 'unknown'}" in Jira. Suggest moving ${j.key} to its final status and adding the completion date as a comment. Open it in Jira to do that.`;
  }
  if (kind === 'blocker') return 'Suggest an action item to chase whoever is blocking it, and a line in the risk register if it affects the 31 March 2027 exit date.';
  if (kind === 'date') return 'Suggest replying with the date you can commit to, and recording it on the Jira item as a comment.';
  if (kind === 'escalation') return 'Suggest an action item to answer it today, and a note to the person asking once it is handled.';
  return '';
}
function unwatch(id) {
  const db = load();
  if (!db.items[String(id)]) return false;
  db.watchDismissed = { ...(db.watchDismissed || {}), [String(id)]: Date.now() };
  save(db);
  return true;
}

// ---------- Jira check for completions (read-only, through the twg CLI) ----------
// A completion is only worth logging if it is a database. Jira is the judge: a CIPDBPE Epic (Feature) whose summary
// ('SYSGEN... | NAME') names the same thing. Jira notices carry their own key. Result is kept on the mail's entry.
const TWG = () => { const p = require('path').join(process.env.LOCALAPPDATA || '', 'Programs', 'twg', 'bin', 'twg.exe'); return require('fs').existsSync(p) ? p : 'twg'; };
const SKIP_TOKEN = /^(RITM|TASK|INC|CHG|SYSGEN|CIPDBPE|CLOUDVS|SCPA|HTTP)/i;
function dbCandidates(e) {
  const key = (String(e.subject).match(/\((CIPDBPE-\d+)\)/) || [])[1];
  const names = (e.atoms || []).map(String).filter((a) => /^[A-Za-z][A-Za-z0-9_]{3,}$/.test(a) && a === a.toUpperCase() && !SKIP_TOKEN.test(a));
  // SYSGEN numbers are the exact identifier: Jira summaries read "SYSGEN787541246 | NAME". Looked for in the subject, summary and atoms.
  const text = `${e.subject || ''} ${e.summary || ''} ${(e.atoms || []).join(' ')}`;
  const sysgens = [...new Set((text.match(/\bSYSGEN\d{6,}\b/gi) || []).map((s) => s.toUpperCase()))].slice(0, 5);
  return { key, sysgens, names: [...new Set(names)].slice(0, 5) };
}
function twgQuery(jql) {
  return new Promise((resolve) => {
    execFile(TWG(), ['jira', 'workitem', 'query', '--jql', jql, '--limit', '5', '-o', 'json', '--output-summary', 'none'], { timeout: 60_000, windowsHide: true, maxBuffer: 4_000_000 }, (err, out) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(out).data.issues || []); } catch { resolve(null); }
    });
  });
}
const BASE = 'project = CIPDBPE AND issuetype in ("Epic (Feature)")';
async function jiraCheck(e, query = twgQuery) {
  const { key, sysgens, names } = dbCandidates(e);
  const hit = (i) => ({ confirmed: true, key: i.key, summary: i.summary, status: (i.status && i.status.name) || '', url: i.url || '' });
  if (key) { const r = await query(`${BASE} AND key = ${key}`); if (r === null) return null; if (r[0]) return hit(r[0]); }
  for (const s of sysgens) {
    const r = await query(`${BASE} AND summary ~ "${s}"`);
    if (r === null) return null;
    const exact = r.find((i) => String(i.summary).toUpperCase().includes(s));
    if (exact) return hit(exact);
  }
  for (const n of names) {
    const r = await query(`${BASE} AND summary ~ "${n}"`);
    if (r === null) return null; // twg unavailable or signed out: try again later, record nothing
    const exact = r.find((i) => String(i.summary).split(/[|\s]+/).some((t) => t.toLowerCase() === n.toLowerCase()));
    if (exact) return hit(exact);
  }
  return { confirmed: false };
}
// Checks every Complete flag not yet confirmed. Returns { checked, total, confirmed, unconfirmed, down }; down means twg could not be reached.
async function checkWatch({ query = twgQuery } = {}) {
  const db = load();
  const todo = watchList(db).filter((e) => e.watch === 'complete' && !((db.items[e.id] || {}).jira || {}).confirmed); // unconfirmed ones are asked again: the Jira item may exist by now
  let n = 0, yes = 0, down = false;
  for (const w of todo) {
    const r = await jiraCheck(db.items[w.id], query);
    if (!r) { down = true; break; } // twg not reachable: stop, the next pull tries again
    db.items[w.id].jira = { ...r, at: Date.now() }; n++; if (r.confirmed) yes++;
  }
  if (n) save(db);
  return { checked: n, total: todo.length, confirmed: yes, unconfirmed: n - yes, down };
}

function state() {
  const db = load();
  const all = Object.values(db.items);
  const byDate = (a, b) => String(b.received).localeCompare(String(a.received));
  return {
    watch: watchList(db),
    lastPull: db.lastPull || 0, running: !!running, log: readLog().slice(-30).reverse(), health: health(db.lastPull || 0),
    open: all.filter((e) => e.status === 'open').sort(byDate), // with body and draft
    info: all.filter((e) => e.status === 'info').sort(byDate).map(strip),
    closed: all.filter((e) => e.status === 'done' || e.status === 'dismissed').length,
    feedback: loadFeedback().length,
  };
}
function close(id, status) {
  const db = load();
  const e = db.items[id];
  if (!e) return false;
  const fb = loadFeedback();
  fb.push({ at: Date.now(), label: status === 'dismissed' ? 'no-reply' : 'reply', from: e.from, subject: e.subject, summary: e.summary });
  store.tryWriteJson(feedbackFile(), fb.slice(-200));
  e.status = status; e.closedAt = Date.now();
  delete e.body; delete e.draft; delete e.draftError; // the text is only kept while a reply is waiting
  save(db);
  return true;
}
const dismiss = (id) => close(String(id), 'dismissed'); // "doesn't need a reply": also teaches the classifier
const done = (id) => close(String(id), 'done');         // "replied / handled"

// Show a message in Outlook's own window (read-only).
async function openInOutlook(id) {
  id = String(id || '');
  if (!/^[0-9A-Fa-f]+$/.test(id)) throw new Error('not a message id');
  await ps(OPEN_SCRIPT(id), 60_000);
  return true;
}

// ---------- the background pull ----------
// Every CHECK_MS. Reading the headers from Outlook costs no tokens; only mail Agentic OS does not already hold reaches a model,
// and a reply made in Outlook still closes its item. Agentic OS never starts Outlook: when it is not open the check waits and
// tries again, quietly (this is not a failure, so Health stays green).
const CHECK_MS = 10 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const OUTLOOK_CLOSED = /outlook is not open|could not reach outlook/i;

// deps: { oneShot, emit, onDone({ ok, ms, note }), after(result) (e.g. refresh the search index; result is what the pull
// returned, so it can skip the work when the pull found nothing new), ready() (false until set up) }
function startDaily(deps) {
  let retryAt = 0;
  let started = false;
  const check = async () => {
    try {
      if (!started) { started = true; log('scheduler', 'Daily mail check started.'); }
      if (running) return log('skip', 'A pull is already running.');
      if (Date.now() < retryAt) return log('skip', 'Waiting to retry after the last attempt failed.');
      if (deps.ready && !deps.ready()) return log('skip', 'Agentic OS is not set up yet.');
      const t0 = Date.now();
            const r = await pull({ oneShot: deps.oneShot, emit: deps.emit });
      if (!r || r.already) return;
      if (r.error && !r.added && OUTLOOK_CLOSED.test(r.error)) { retryAt = Date.now() + RETRY_MS; log('retry', 'Outlook is not open; trying again in 30 minutes.'); deps.onDone({ ok: true, ms: Date.now() - t0, note: 'Outlook was not open; will try again' }); return; }
      if (r.error && !r.added) { retryAt = Date.now() + RETRY_MS; log('error', `Pull failed: ${r.error}`); deps.onDone({ ok: false, ms: Date.now() - t0, note: r.error }); return; }
      if (deps.after) { try { await deps.after(r); } catch { /* search catches up on its own */ } }
      const note = r.added || r.closed || r.failed ? `${r.added} new, ${r.needReply} need a reply${r.failed ? `, ${r.failed} to retry` : ''}` : 'Checked, nothing new';
      deps.onDone({ ok: !r.failed, ms: Date.now() - t0, note });
    } catch (e) { log('error', `Check crashed: ${String((e && e.message) || e)}`); }
  };
  setTimeout(check, 4 * 60 * 1000); // after start-up has settled
  setInterval(check, CHECK_MS);
}

// Entries for the search index: summaries and atoms only, never message text.
function searchEntries() {
  return Object.values(load().items).map((e) => ({
    id: `mail:${e.id}`, path: `mail:${e.id}`, kind: 'mail', scope: 'mail', title: `${e.subject || '(no subject)'} — ${e.from}`.slice(0, 160), project: 'Mail', type: 'mail',
    date: String(e.received).slice(0, 10), dateFrom: 'received', headings: '', lead: '', staleWhen: '', hash: e.id.slice(-24), size: 0,
    summary: e.summary + (e.reason ? ` ${e.reason}` : ''), questions: [], atoms: [e.from, ...(e.atoms || [])], enriched: true,
  }));
}

module.exports = { suggestionOf, checkWatch, jiraCheck, dbCandidates, pull, state, dismiss, done, unwatch, watchOf, openInOutlook, searchEntries, isBulk, addressedTo, startDaily, slop, draftFor, DAYS };
