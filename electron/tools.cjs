// Tools panel: CLI tools Agentic OS itself installed (TWG CLI and the like), as opposed to connectors.cjs's
// claude.ai-linked apps. A tool is a skill (or a few) plus, usually, a program on this PC that the skill
// drives. Registered by the agent (register()) once it has installed something and confirmed it works —
// see the register_tool aos tool in claude.cjs. Usage is read the same way connectors.cjs reads it, just
// from history.cjs's h.skills instead of h.mcp.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const history = require('./history.cjs');
const policy = require('./policy.cjs');
const vault = require('./vault.cjs');
const store = require('./store.cjs');

const dataFile = (n) => path.join(store.dataDir(), n);
const registry = () => {
  const reg = store.readJson(dataFile('tools.json'), { items: [] });
  if (!reg || !Array.isArray(reg.items)) return { items: [] };
  return reg;
};
const save = (reg) => store.writeJson(dataFile('tools.json'), reg);

const skillDir = (name) => path.join(vault.ROOT, 'skills', name);
const archiveDir = (name) => path.join(vault.ROOT, 'skills', '_archive', name);

// A steady colour per name, same palette connectors.cjs uses, so a tool and a connector read as one family.
const CARBON = ['#33b1ff', '#8a3ffc', '#08bdba', '#ff7eb6', '#6fdc8c', '#4589ff', '#d2a106', '#d12771', '#bae6ff', '#ba4e00', '#d4bbff', '#007d79'];
function colorOf(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return CARBON[h % CARBON.length];
}

// ---- the panel ----
async function summary() {
  const h = await history.load();
  const now = Date.now(), DAY = history.DAY;
  const reg = registry();
  // skill name -> owning tool id, so usage counted per skill rolls up to its tool.
  const ownerOf = new Map();
  for (const t of reg.items) for (const s of t.skills || []) ownerOf.set(s, t.id);

  const by = {};
  for (const s of h.skills) {
    const owner = ownerOf.get(s.skill);
    if (!owner) continue; // a skill nobody registered as a tool (e.g. a built-in vault skill) isn't shown here
    const c = (by[owner] ||= { total: 0, d7: 0, d30: 0, last: 0, days: Array(14).fill(0) });
    c.total++;
    if (now - s.t < 7 * DAY) c.d7++;
    if (now - s.t < 30 * DAY) c.d30++;
    c.last = Math.max(c.last, s.t);
    const age = Math.floor((now - s.t) / DAY);
    if (age < 14) c.days[13 - age]++;
  }

  const items = reg.items.map((t) => {
    const c = by[t.id] || { total: 0, d7: 0, d30: 0, last: 0, days: Array(14).fill(0) };
    return { id: t.id, name: t.name, icon: t.icon || null, skills: t.skills || [], active: t.active !== false,
      color: colorOf(t.name), total: c.total, d7: c.d7, d30: c.d30, last: c.last, days: c.days };
  }).sort((a, b) => b.d30 - a.d30 || b.total - a.total || a.name.localeCompare(b.name));

  // Other models (workers.cjs) sit in the same list, with call counts from their own log.
  let workers = [];
  try { workers = await require('./workers.cjs').summaryRows(); } catch { /* workers are optional */ }
  items.push(...workers);

  return { since: h.since, items };
}

// ---- register (called by the agent after an install it already confirmed works) ----
function register({ name, icon, skills, binary, uninstall }) {
  const reg = registry();
  const id = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const entry = { id, name: String(name), icon: icon || null, skills: Array.isArray(skills) ? skills : [],
    binary: binary || null, uninstall: uninstall || null, addedAt: Date.now(), active: true };
  const i = reg.items.findIndex((t) => t.id === id);
  if (i >= 0) reg.items[i] = entry; else reg.items.push(entry);
  save(reg);
  return entry;
}

// ---- disconnect: archive the skill files, leave the program and any sign-in alone ----
function disconnect(id) {
  const reg = registry();
  const entry = reg.items.find((t) => t.id === id);
  if (!entry) return { ok: false, error: 'No tool with that id.' };
  const moved = [];
  for (const name of entry.skills) {
    const from = skillDir(name);
    if (!fs.existsSync(from)) continue;
    const to = archiveDir(name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    moved.push(name);
  }
  entry.active = false;
  save(reg);
  return { ok: true, moved };
}

// Undoes disconnect: restores archived skill files and marks the tool active again.
function reconnect(id) {
  const reg = registry();
  const entry = reg.items.find((t) => t.id === id);
  if (!entry) return { ok: false, error: 'No tool with that id.' };
  for (const name of entry.skills) {
    const from = archiveDir(name);
    if (!fs.existsSync(from)) continue;
    fs.renameSync(from, skillDir(name));
  }
  entry.active = true;
  save(reg);
  return { ok: true };
}

// ---- remove completely: uninstall the program, delete (not archive) the skill files, drop the entry ----
// MSI uninstall needs the original .msi path or the product's GUID, which msiexec /x accepts either way;
// "manual" is a best-effort fallback for an install with no uninstaller (e.g. TWG CLI's PowerShell-script
// path) — it removes the recorded install folder. Neither branch strips a PATH entry the installer may have
// added; that's a known gap.
function removeCompletely(id) {
  return new Promise((resolve) => {
    const reg = registry();
    const entry = reg.items.find((t) => t.id === id);
    if (!entry) return resolve({ ok: false, error: 'No tool with that id.' });

    const afterUninstall = () => {
      const deleted = [];
      for (const name of entry.skills) {
        for (const dir of [skillDir(name), archiveDir(name)]) { // a disconnected tool's files sit in the archive
          if (!fs.existsSync(dir)) continue;
          policy.backupAny(dir); // 30 days of recovery, same as any other delete Agentic OS makes
          fs.rmSync(dir, { recursive: true, force: true });
          if (!deleted.includes(name)) deleted.push(name);
        }
      }
      reg.items = reg.items.filter((t) => t.id !== id);
      save(reg);
      resolve({ ok: true, deleted });
    };

    const u = entry.uninstall;
    if (u && u.type === 'msi') {
      execFile('msiexec.exe', ['/x', u.path, '/qn', '/norestart'], { windowsHide: true, timeout: 120000 }, () => afterUninstall());
    } else if (u && u.type === 'manual' && u.path) {
      try { if (fs.existsSync(u.path)) { policy.backupAny(u.path); fs.rmSync(u.path, { recursive: true, force: true }); } } catch { /* best effort */ }
      afterUninstall();
    } else {
      afterUninstall(); // nothing recorded to uninstall — just drop the skill files and the entry
    }
  });
}

// For the live "in use now" badge: which registered, active tool owns a skill name, or null.
function ownerOf(skillName) {
  const t = registry().items.find((x) => x.active !== false && (x.skills || []).includes(skillName));
  return t ? { id: t.id, name: t.name, icon: t.icon || null, color: colorOf(t.name) } : null;
}

module.exports = { summary, register, disconnect, reconnect, removeCompletely, ownerOf };
