// Token ledger: one row per finished question, kept on disk so the dashboard can show spend and value.
// `cost` is what that question's tokens would cost at API prices (the SDK reports it even on a plan), so on a
// plan it is an equivalent, not a bill. Rows older than 120 days are dropped.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const store = require('./store.cjs');

const file = () => path.join(app.getPath('userData'), 'ledger.json');
const KEEP_MS = 120 * 24 * 3600 * 1000;

// Monthly plan prices, for "value for money". AGENTIC_OS_PLAN_PRICE overrides; otherwise a guess by plan name.
const PLAN_PRICES = { pro: 20, max: 100 };

// A plan price typed into the dashboard wins over the env var and the guess.
const settingsFile = () => path.join(app.getPath('userData'), 'ledger-settings.json');
function settings() { return store.readJson(settingsFile(), {}); }
const saveSettings = (s) => { store.writeJson(settingsFile(), s); return true; };
function setPlanPrice(v) {
  const price = Number(v);
  const s = settings();
  if (price > 0) s.planPrice = price; else delete s.planPrice;
  return saveSettings(s);
}

// Value panel: what the user's time is worth, and their estimate of minutes saved per use of each skill.
// The default rate is a placeholder; the user sets their own in the Value panel.
const DEFAULT_RATE = 50;
function setHourlyRate(v) {
  const rate = Number(v);
  const s = settings();
  if (rate > 0) s.hourlyRate = rate; else delete s.hourlyRate;
  return saveSettings(s);
}
function setSkillMinutes(skill, v) {
  const min = Number(v);
  const s = settings();
  s.skillMinutes = s.skillMinutes || {};
  if (min >= 0 && Number.isFinite(min)) s.skillMinutes[String(skill)] = min; else delete s.skillMinutes[String(skill)];
  return saveSettings(s);
}

function load() {
  const r = store.readJson(file(), []);
  return Array.isArray(r) ? r : [];
}

// row: { model, input, output, cacheRead, cacheWrite, cost, reads, edits, error }
// From 2026-10-04 also: asked (model the app picked), light (short lookup by the model picker's test),
// skills (skills the question ran), ms (how long it took), chat (chat id), kind ('ask' | 'auto' | 'dream').
// Older rows lack these; readers must treat them as unknown, not zero.
//
// Cost (fixed 2026-10-04): Claude Code's cost counter is a running total for the whole Claude session, and it
// carries on climbing across the questions of one chat. Until this fix `cost` stored that running total, so a
// 30-question chat counted its first question 30 times and the dashboard overstated spend about seven times.
// Now a row passes `total` (the counter) and `fresh` (the question started a new Claude session), and `cost` is
// this question's own share: the rise since the chat's last row. migrate() converts the older rows once.
const round = (v) => Math.round(v * 1e6) / 1e6;
const sameChat = (a, b) => (a.chat || '') === (b.chat || '');
function ownCost(rows, row) {
  if (typeof row.total !== 'number') return row.cost || 0; // dreams: one call, no running total
  if (row.fresh) return row.total;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind === 'dream' || !sameChat(r, row)) continue;
    const before = typeof r.total === 'number' ? r.total : r.cost || 0; // a row from before the fix holds the total in `cost`
    return row.total >= before ? round(row.total - before) : row.total; // a lower counter means a new session
  }
  return row.total;
}

// Returns the question's own cost.
function add(row) {
  const rows = load().filter((r) => Date.now() - r.t < KEEP_MS);
  const cost = ownCost(rows, row);
  rows.push({ t: Date.now(), ...row, cost });
  store.tryWriteJson(file(), rows); // a failed save is logged; the question's answer is already on screen
  return cost;
}

// One-off repair at launch: rows written before the cost fix become per-question costs. Within a chat a cost
// that climbs is the running total (take the rise); a cost that drops is a fresh session (take it whole). Rows
// with no chat id (before 2026-10-04) are treated as one chat, which they were. The untouched file is kept
// next to it as ledger.before-cost-fix.json. Returns how many rows changed.
function migrate() {
  const rows = load();
  if (!rows.some((r) => r.kind !== 'dream' && typeof r.total !== 'number')) return 0;
  try { fs.copyFileSync(file(), path.join(path.dirname(file()), 'ledger.before-cost-fix.json'), fs.constants.COPYFILE_EXCL); } catch { /* already kept */ }
  const last = {}; // chat -> running total so far
  let n = 0;
  for (const r of rows) {
    if (r.kind === 'dream') continue;
    const k = r.chat || '';
    if (typeof r.total !== 'number') {
      const total = r.cost || 0, before = last[k];
      r.total = total;
      r.cost = before != null && total >= before ? round(total - before) : total;
      n++;
    }
    last[k] = r.total;
  }
  store.writeJson(file(), rows);
  return n;
}

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const tokens = (r) => (r.input || 0) + (r.output || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0);

function total(rows) {
  const t = { questions: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, reads: 0, edits: 0 };
  for (const r of rows) {
    t.questions++; t.tokens += tokens(r);
    t.input += r.input || 0; t.output += r.output || 0; t.cacheRead += r.cacheRead || 0; t.cacheWrite += r.cacheWrite || 0;
    t.cost += r.cost || 0; t.reads += r.reads || 0; t.edits += r.edits || 0;
  }
  return t;
}

function summary(planName, mode) {
  const rows = load();
  const now = Date.now();
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const monthStart = new Date(startOfDay.getFullYear(), startOfDay.getMonth(), 1).getTime();

  // last 14 days, oldest first, zero-filled so the chart has no gaps
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(startOfDay); d.setDate(d.getDate() - i);
    days.push({ day: dayKey(d.getTime()), tokens: 0, cost: 0 });
  }
  for (const r of rows) { const s = days.find((d) => d.day === dayKey(r.t)); if (s) { s.tokens += tokens(r); s.cost += r.cost || 0; } }

  const byModel = {};
  for (const r of rows.filter((x) => x.t >= monthStart)) {
    const m = r.model || 'unknown';
    (byModel[m] = byModel[m] || []).push(r);
  }

  const saved = Number(settings().planPrice);
  const envPrice = Number(process.env.AGENTIC_OS_PLAN_PRICE);
  const key = (planName || '').toLowerCase();
  const price = saved > 0 ? saved : envPrice > 0 ? envPrice : (PLAN_PRICES[key] ?? (planName ? 100 : null));
  return {
    mode,
    planName: planName || null,
    planPrice: price,
    planPriceKnown: saved > 0 || envPrice > 0 || key in PLAN_PRICES,
    planPriceSaved: saved > 0,
    today: total(rows.filter((r) => r.t >= startOfDay.getTime())),
    week: total(rows.filter((r) => now - r.t < 7 * 24 * 3600 * 1000)),
    month: total(rows.filter((r) => r.t >= monthStart)),
    all: total(rows),
    since: rows.length ? rows[0].t : null,
    days,
    models: Object.entries(byModel).map(([model, rs]) => ({ model, ...total(rs) })).sort((a, b) => b.cost - a.cost),
  };
}

module.exports = { add, migrate, summary, setPlanPrice, setHourlyRate, setSkillMinutes, settings, load, tokens, DEFAULT_RATE };
