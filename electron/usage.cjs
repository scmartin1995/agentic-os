// Charge meter data.
//  - plan mode: claude.ai plan windows (5-hour session, 7-day week) as reported by Claude Code.
//    Last known values are kept on disk so the meter has something to show at startup.
//  - api mode:  spend vs a daily and monthly budget
//    (AGENTIC_OS_DAILY_BUDGET / AGENTIC_OS_MONTHLY_BUDGET, defaults $5 / $50).
const path = require('path');
const { app } = require('electron');
const store = require('./store.cjs');

const file = () => path.join(app.getPath('userData'), 'usage.json');
const budgets = () => { try { return require('./settings.cjs').get('budgets') || {}; } catch { return {}; } };
const daily = () => Number(process.env.AGENTIC_OS_DAILY_BUDGET || budgets().daily || 5);
const monthly = () => Number(process.env.AGENTIC_OS_MONTHLY_BUDGET || budgets().monthly || 50);

function load() { return { days: {}, plan: {}, ...store.readJson(file(), {}) }; }
function save(d) { store.tryWriteJson(file(), d); }

function addCost(usd) {
  const d = load();
  const day = new Date().toISOString().slice(0, 10);
  d.days[day] = (d.days[day] || 0) + usd;
  save(d);
}

// kind: 'five_hour' | 'seven_day' | ...; used: 0-100; resetsAt: epoch ms
function setPlanWindow(kind, used, resetsAt, plan) {
  const d = load();
  d.plan[kind] = { used, resetsAt, seen: Date.now() };
  if (plan) d.planName = plan;
  save(d);
}

function get(mode) {
  const d = load();
  const now = new Date();
  if (mode === 'plan') {
    const win = (k) => {
      const w = d.plan[k];
      if (!w) return null;
      // a window that has reset since we last heard about it is full again
      return w.resetsAt && w.resetsAt < Date.now() ? { used: 0, resetsAt: null, seen: w.seen } : w;
    };
    return { mode: 'plan', planName: d.planName || null, session: win('five_hour'), week: win('seven_day') };
  }
  if (mode === 'sub') {
    // ChatGPT or Google plan through their own CLI: they don't report limits, so count the tokens used here.
    const ledger = require('./ledger.cjs');
    const rows = ledger.load();
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const sum = (from) => rows.filter((r) => r.t >= from).reduce((n, r) => n + ledger.tokens(r), 0);
    return { mode: 'sub', day: { tokens: sum(start.getTime()) }, week: { tokens: sum(Date.now() - 7 * 24 * 3600 * 1000) } };
  }
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const spentDay = d.days[day] || 0;
  const spentMonth = Object.entries(d.days).filter(([k]) => k.startsWith(month)).reduce((s, [, v]) => s + v, 0);
  const tomorrow = new Date(now); tomorrow.setHours(24, 0, 0, 0);
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return {
    mode: 'api',
    day: { spent: spentDay, budget: daily(), resetsAt: tomorrow.getTime() },
    month: { spent: spentMonth, budget: monthly(), resetsAt: nextMonth.getTime() },
  };
}

module.exports = { get, addCost, setPlanWindow };
