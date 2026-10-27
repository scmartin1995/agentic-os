// Numbers for the Health and Value panels, all counted on the PC (no Claude calls).
// Sources: the session logs (history.cjs: questions and skill runs), the token ledger (ledger.cjs: cost, models,
// sizes), the vault (skills list, projects and when their notes last changed) and the saved chats.
const vault = require('./vault.cjs');
const ledger = require('./ledger.cjs');
const history = require('./history.cjs');
const chats = require('./chats.cjs');
const jobs = require('./jobs.cjs');

const DAY = history.DAY;
const startOfDay = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayKey = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };

// Skill states (adjustable): used within 14 days = in use; within 40 = quiet; otherwise not used lately.
const ACTIVE_DAYS = 14, QUIET_DAYS = 40;
// Notes count as "behind" when chats about a project are this much newer than its last note edit.
const BEHIND_DAYS = 7;

// Starting guesses for minutes saved per use, by skill. The user edits them in the Value panel.
const MINUTES = {
  'client-email-draft': 20, 'vault-health-check': 30, 'lessons-review': 5, 'grill-me': 20, 'weekly-review': 30,
  'systematic-debugging': 20, 'one-three-one': 10, spike: 30, learn: 15, 'skill-tidy': 15, 'model-selection': 1,
};
const DEFAULT_MINUTES = 10;
// Ordinary questions (no skill) save time too: looking something up in the notes yourself. Its own editable row.
const QUESTIONS = '_questions';
MINUTES[QUESTIONS] = 3;

function allSkills() {
  try { return vault.skills().groups.flatMap((g) => g.skills.map((s) => ({ name: s.name, title: s.title, path: s.path }))); } catch { return []; }
}

// How a project is referred to in chat: its folder name with underscores as spaces, and its title.
function projectWords(p) {
  const words = new Set([p.folder.toLowerCase(), p.folder.replace(/_/g, ' ').toLowerCase()]);
  const short = (p.title || '').split(/\s[-:–]\s/)[0].trim().toLowerCase();
  if (short.length >= 4) words.add(short);
  return [...words].filter((w) => w.length >= 3);
}

async function health(chatItems = 0) {
  const now = Date.now();
  const h = await history.load();

  const lastUse = {}, uses30 = {};
  for (const s of h.skills) {
    lastUse[s.skill] = Math.max(lastUse[s.skill] || 0, s.t);
    if (now - s.t < 30 * DAY) uses30[s.skill] = (uses30[s.skill] || 0) + 1;
  }
  const maxUses = Math.max(1, ...Object.values(uses30));
  const skills = allSkills().map((s) => {
    const last = lastUse[s.name] || null;
    const age = last ? (now - last) / DAY : null;
    // Never used: only call it dead once the history is long enough to judge (it starts 2026-10-03).
    const judged = h.since != null && now - h.since > QUIET_DAYS * DAY;
    const state = age != null && age <= ACTIVE_DAYS ? 'ok' : age != null && age <= QUIET_DAYS ? 'quiet' : age != null || judged ? 'dead' : 'none';
    return { ...s, last, uses: uses30[s.name] || 0, share: (uses30[s.name] || 0) / maxUses, state };
  }).sort((a, b) => (b.last || 0) - (a.last || 0) || b.uses - a.uses);

  let projects = [];
  try { projects = vault.projects(); } catch { /* vault unreadable */ }
  const memory = projects.map((p) => {
    const words = projectWords(p);
    let lastChat = null, since = 0;
    for (const q of h.prompts) {
      const t = q.text.toLowerCase();
      if (words.some((w) => t.includes(w))) { lastChat = q.t; if (q.t > p.modified) since++; }
    }
    const behind = lastChat && lastChat - p.modified > BEHIND_DAYS * DAY ? Math.round((lastChat - p.modified) / DAY) : 0;
    return { folder: p.folder, title: p.title, notes: p.modified || null, chat: lastChat, behind, mentionsSince: since };
  }).sort((a, b) => b.behind - a.behind || (Math.max(b.notes || 0, b.chat || 0) - Math.max(a.notes || 0, a.chat || 0)));

  // A session = a run of questions with no gap over 30 minutes (the same idle gap that starts a fresh
  // conversation). Claude session ids can't be used: the app gets a new one on almost every question.
  const starts = [];
  let prev = 0;
  for (const q of h.prompts) { if (q.t - prev > 30 * 60 * 1000) starts.push(q.t); prev = q.t; }
  const days = [];
  for (let i = 13; i >= 0; i--) { const d0 = startOfDay(now - i * DAY); days.push({ day: dayKey(d0), from: d0, to: d0 + DAY, n: 0 }); }
  for (const d of days) d.n = starts.filter((t) => t >= d.from && t < d.to).length;
  const active = days.filter((d) => d.n > 0);

  const j = jobs.all();
  let notes = 0;
  try { notes = vault.info().notes; } catch { /* ignore */ }
  return {
    since: h.since,
    skills,
    memory,
    sessions: { days: days.map(({ day, n }) => ({ day, n })), today: days[days.length - 1].n, avg: active.length ? active.reduce((a, d) => a + d.n, 0) / active.length : 0 },
    chat: { items: chatItems, long: 40 },
    jobs: { dreams: j.dreams || null, lessonsPass: j.lessonsPass || null, searchIndex: j.searchIndex || null, mailPull: j.mailPull || null, notes },
  };
}

// Cost per token for a model, from the user's own ledger rows (so no price table to go stale).
function perToken(rows, modelPrefix) {
  let c = 0, t = 0;
  for (const r of rows) if (String(r.model || '').startsWith(modelPrefix) && !r.error) { c += r.cost || 0; t += ledger.tokens(r); }
  return t > 0 ? c / t : null;
}

async function value(planName = null) {
  const now = Date.now();
  const s = ledger.settings();
  const rate = Number(s.hourlyRate) > 0 ? Number(s.hourlyRate) : ledger.DEFAULT_RATE;
  const minutes = (name) => (s.skillMinutes && s.skillMinutes[name] != null ? Number(s.skillMinutes[name]) : MINUTES[name] ?? DEFAULT_MINUTES);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

  const h = await history.load();
  const monthUses = {};
  for (const u of h.skills) if (u.t >= monthStart) monthUses[u.skill] = (monthUses[u.skill] || 0) + 1;
  const known = new Set(allSkills().map((x) => x.name));
  const bySkill = Object.entries(monthUses).map(([name, uses]) => ({ name, uses, minutes: minutes(name), hours: (uses * minutes(name)) / 60, known: known.has(name) }))
    .sort((a, b) => b.hours - a.hours);
  // skills with no uses yet still show, so their minutes can be set before they're used
  for (const name of known) if (!monthUses[name]) bySkill.push({ name, uses: 0, minutes: minutes(name), hours: 0, known: true });
  const asked = h.prompts.filter((q) => q.t >= monthStart).length;
  bySkill.unshift({ name: QUESTIONS, uses: asked, minutes: minutes(QUESTIONS), hours: (asked * minutes(QUESTIONS)) / 60, known: true });
  const hours = bySkill.reduce((a, x) => a + x.hours, 0);
  const uses = bySkill.filter((x) => x.name !== QUESTIONS).reduce((a, x) => a + x.uses, 0);

  // hours saved per week, last 8 weeks (week = 7 days ending today)
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const to = startOfDay(now) + DAY - i * 7 * DAY, from = to - 7 * DAY;
    const hrs = h.skills.filter((u) => u.t >= from && u.t < to).reduce((a, u) => a + minutes(u.skill) / 60, 0)
      + (h.prompts.filter((q) => q.t >= from && q.t < to).length * minutes(QUESTIONS)) / 60;
    weeks.push({ label: dayKey(to - DAY), hours: hrs });
  }

  const sum = ledger.summary(planName, 'plan');
  const pay = sum.planPrice || 0;
  const worth = hours * rate;

  // Model fit, from this month's ledger rows.
  const rows = ledger.load().filter((r) => r.t >= monthStart);
  const haiku = perToken(ledger.load(), 'claude-haiku');
  // A short lookup only counts against the fit when it opened a chat and still didn't get Haiku.
  // Mid-chat ones stay on the chat's model on purpose (pickModel in claude.cjs), a failed run did no work, and rows
  // from before `fresh` was recorded can't say which they were (and often name the wrong model), so they are left out.
  const sized = rows.filter((r) => typeof r.light === 'boolean' && typeof r.fresh === 'boolean' && !r.error);
  const heavyLookups = sized.filter((r) => r.light && r.fresh && !String(r.model || '').startsWith('claude-haiku'));
  const saving = (rs) => (haiku == null ? null : rs.reduce((a, r) => a + Math.max(0, (r.cost || 0) - ledger.tokens(r) * haiku), 0));
  const auto = rows.filter((r) => r.kind === 'auto' && !String(r.model || '').startsWith('claude-haiku'));
  const tokensAll = rows.reduce((a, r) => a + ledger.tokens(r), 0);
  const cacheRead = rows.reduce((a, r) => a + (r.cacheRead || 0), 0);
  const longChats = chats.list(200).filter((c) => c.updated >= monthStart && c.count > 60).length;

  return {
    rate, rateIsDefault: !(Number(s.hourlyRate) > 0), salary: 0,
    hours, uses, questions: asked, worth, pay, planName: sum.planName, net: worth - pay, times: pay > 0 ? worth / pay : null,
    bySkill, weeks, since: h.since,
    fit: {
      cacheShare: tokensAll ? cacheRead / tokensAll : null,
      rightSized: sized.length ? 1 - heavyLookups.length / sized.length : null,
      sizedCount: sized.length,
      heavyLookups: { n: heavyLookups.length, cost: heavyLookups.reduce((a, r) => a + (r.cost || 0), 0), saving: saving(heavyLookups) },
      auto: { n: auto.length, cost: auto.reduce((a, r) => a + (r.cost || 0), 0), saving: saving(auto) },
      longChats,
      haikuKnown: haiku != null,
    },
  };
}

// One row per skill in the vault: last used and uses in the last 30 and 90 days, read from the same session logs as
// the Health panel. For the skill-tidy skill and the skill_use tool. `loggedSince` is when the log starts, so a
// skill with no uses is only "unused" for as long as the log reaches back.
async function skillUse() {
  const now = Date.now();
  const h = await history.load();
  const last = {}, d30 = {}, d90 = {};
  for (const s of h.skills) {
    last[s.skill] = Math.max(last[s.skill] || 0, s.t);
    if (now - s.t < 30 * DAY) d30[s.skill] = (d30[s.skill] || 0) + 1;
    if (now - s.t < 90 * DAY) d90[s.skill] = (d90[s.skill] || 0) + 1;
  }
  const iso = (t) => (t ? new Date(t).toISOString().slice(0, 10) : null);
  const rows = allSkills().map((s) => ({ name: s.name, lastUsed: iso(last[s.name]), uses30: d30[s.name] || 0, uses90: d90[s.name] || 0 }))
    .sort((a, b) => a.uses90 - b.uses90 || (a.lastUsed || '').localeCompare(b.lastUsed || '') || a.name.localeCompare(b.name));
  return { loggedSince: iso(h.since), rows };
}

module.exports = { health, value, skillUse, QUESTIONS };
