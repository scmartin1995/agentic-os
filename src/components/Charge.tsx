import type { PlanWindow, UsageV2, UsageWindow } from '../types';

// Usage: how much is left.
//  plan: the Claude plan's two windows (5-hour session, week), as Claude Code reports them.
//  api:  spend today / this month against your budgets (any API key).
//  sub:  a ChatGPT or Google plan through their own app reports no limits, so tokens used are shown instead.
function untilText(resetsAt: number | null, now: number) {
  if (!resetsAt) return '';
  const ms = Math.max(0, resetsAt - now);
  const h = Math.floor(ms / 3.6e6), m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1000) % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
const n = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v)));
const FIRST = 'var(--acc)', SECOND = 'var(--orange)';

interface Row { label: string; left: number | null; color: string; detail: string; text?: string }
function rows(usage: UsageV2, now: number): Row[] {
  if (usage.mode === 'plan') {
    const r = (label: string, w: PlanWindow | null, color: string): Row => ({ label, color, left: w ? Math.max(0, 1 - w.used / 100) : null, detail: w ? (w.resetsAt ? `resets in ${untilText(w.resetsAt, now)}` : 'full') : 'after the first question' });
    return [r('Session', usage.session, FIRST), r('Week', usage.week, SECOND)];
  }
  if (usage.mode === 'sub') return [
    { label: 'Today', color: FIRST, left: null, text: n(usage.day.tokens), detail: 'tokens' },
    { label: '7 days', color: SECOND, left: null, text: n(usage.week.tokens), detail: 'tokens' },
  ];
  const r = (label: string, w: UsageWindow, color: string): Row => ({ label, color, left: Math.max(0, 1 - w.spent / (w.budget || 1)), detail: `$${w.spent.toFixed(2)} of $${w.budget} · ${untilText(w.resetsAt, now)}` });
  return [r('Today', usage.day, FIRST), r('Month', usage.month, SECOND)];
}
const sourceOf = (usage: UsageV2 | null, brain: string) => (!usage ? '' : usage.mode === 'plan' ? `${usage.planName ? usage.planName[0].toUpperCase() + usage.planName.slice(1) : brain} plan` : usage.mode === 'sub' ? `${brain} plan` : `${brain} · API key`);

// Ten pips per row, lit for what is left; every row uses the same three columns so the labels, pips and
// percentages line up.
const PIPS = 10;
export default function Charge({ usage, now, brain }: { usage: UsageV2 | null; now: number; brain: string }) {
  return (
    <section className="panel charge">
      <h4><span className="lbl">Usage</span><span className="mono small muted">{sourceOf(usage, brain)}</span></h4>
      {!usage ? <span className="muted small">loading…</span> : rows(usage, now).map((r) => {
        const lit = r.left == null ? 0 : Math.round(r.left * PIPS);
        return (
          <div className="charge-row" key={r.label}>
            <span className="charge-label">{r.label}</span>
            <span className="pips" role="img" aria-label={r.left == null ? `${r.label}: ${r.text ?? 'not known yet'}` : `${r.label}: ${Math.round(r.left * 100)} percent left`}>
              {Array.from({ length: PIPS }, (_, i) => <i key={i} className={i < lit ? 'on' : ''} />)}
            </span>
            <b className="charge-pct num">{r.text ?? (r.left == null ? '—' : `${Math.round(r.left * 100)}%`)}</b>
            <span className="charge-reset mono small muted num">{r.detail}</span>
          </div>
        );
      })}
    </section>
  );
}

// The same two readings for the title bar, as plain numbers: what is left, in the colours of the two bars on the
// home screen (accent first, second colour second). No bars here; the Charge card has them.
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
      <em>{usage.mode === 'sub' ? 'tokens' : 'left'}</em>
    </button>
  );
}
