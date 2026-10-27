import type { PlanWindow, UsageV2, UsageWindow } from '../types';

// Charge: how much is left.
//  plan: the Claude plan's two windows (5-hour session, week), as Claude Code reports them.
//  api:  spend today / this month against your budgets (any API key).
function untilText(resetsAt: number | null, now: number) {
  if (!resetsAt) return '';
  const ms = Math.max(0, resetsAt - now);
  const h = Math.floor(ms / 3.6e6), m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1000) % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
const n = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v)));
const CYAN = 'var(--acc)', ORANGE = 'var(--txt3)'; // theme colours, so the meters follow light and dark

interface Row { label: string; left: number | null; color: string; detail: string; text?: string }
function rows(usage: UsageV2, now: number): Row[] {
  if (usage.mode === 'plan') {
    const r = (label: string, w: PlanWindow | null, color: string): Row => ({ label, color, left: w ? Math.max(0, 1 - w.used / 100) : null, detail: w ? (w.resetsAt ? `resets ${untilText(w.resetsAt, now)}` : 'full') : 'after first message' });
    return [r('Session', usage.session, CYAN), r('Week', usage.week, ORANGE)];
  }
  const r = (label: string, w: UsageWindow, color: string): Row => ({ label, color, left: Math.max(0, 1 - w.spent / (w.budget || 1)), detail: `$${w.spent.toFixed(2)} of $${w.budget} · ${untilText(w.resetsAt, now)}` });
  return [r('Today', usage.day, CYAN), r('Month', usage.month, ORANGE)];
}
const sourceOf = (usage: UsageV2 | null, brain: string) => (!usage ? '' : usage.mode === 'plan' ? `${usage.planName ? usage.planName[0].toUpperCase() + usage.planName.slice(1) : brain} plan` : `${brain} · API key`);

export default function Charge({ usage, now, brain }: { usage: UsageV2 | null; now: number; brain: string }) {
  return (
    <section className="panel charge">
      <h4><span className="lbl">Charge</span><span className="mono small muted">{sourceOf(usage, brain)}</span></h4>
      {!usage ? <span className="muted small">loading…</span> : rows(usage, now).map((r) => (
        <div className="charge-row" key={r.label}>
          <span className="charge-label">{r.label}</span>
          <span className="meter" role="img" aria-label={r.left == null ? `${r.label}: ${r.text ?? 'not known yet'}` : `${r.label}: ${Math.round(r.left * 100)} percent left`} style={{ ['--c' as string]: r.color }}>
            <i style={{ width: `${r.left == null ? 0 : Math.max(2, r.left * 100)}%` }} />
          </span>
          <span className="charge-num">
            <b>{r.text ?? (r.left == null ? '—' : `${Math.round(r.left * 100)}%`)}</b>
            <span className="mono small muted num">{r.detail}</span>
          </span>
        </div>
      ))}
    </section>
  );
}

// The same two readings for the title bar, as plain numbers: what is left, in the colours of the two bars on the
// home screen (cyan first, orange second). No bars here; the Charge card has them.
export function MiniCharge({ usage, now, onClick }: { usage: UsageV2 | null; now: number; onClick(): void }) {
  if (!usage) return null;
  const rs = rows(usage, now);
  if (rs.every((r) => r.left == null && !r.text)) return null; // nothing known yet: say nothing rather than dashes
  const tip = rs.map((r) => `${r.label}: ${r.text ? `${r.text} ${r.detail}` : r.left == null ? 'not known yet' : `${Math.round(r.left * 100)}% left`}`).join(' · ');
  return (
    <button className="bar-usage nodrag" onClick={onClick} title={`${tip}. Click for the token dashboard.`}>
      {rs.map((r, i) => (
        <span key={r.label}>{i > 0 && <i>·</i>}<b style={{ color: i === 0 ? 'var(--acc)' : 'var(--orange)' }}>{r.text ?? (r.left == null ? '—' : `${Math.round(r.left * 100)}%`)}</b></span>
      ))}
      <em>left</em>
    </button>
  );
}
