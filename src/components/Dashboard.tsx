import { useEffect, useState } from 'react';
import type { LedgerSummary, LedgerTotals } from '../types';

// Token dashboard: what you actually pay a month, next to what the same tokens would have cost at API prices.
// "At API prices" is the SDK's own cost figure, which it reports even on a plan, so on a plan it is an equivalent and not a bill.
const n = (v: number) => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v));
const usd = (v: number) => v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
const modelName = (m: string) => m.replace(/^claude-/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function Tile({ label, t }: { label: string; t: LedgerTotals }) {
  return (
    <div className="dash-tile">
      <span className="lbl">{label}</span>
      <b>{n(t.tokens)}</b>
      <span className="mono small muted">tokens · {usd(t.cost)} at API prices</span>
      <span className="mono small muted">{t.questions} {t.questions === 1 ? 'question' : 'questions'}</span>
    </div>
  );
}

export default function Dashboard({ onClose }: { onClose(): void }) {
  const [s, setS] = useState<LedgerSummary | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const load = () => window.aos.usage.ledger().then(setS);
  useEffect(() => { load(); }, []);

  const savePrice = async () => {
    await window.aos.usage.setPlanPrice(Number(draft.replace(/[^0-9.]/g, '')) || 0);
    setEditing(false);
    load();
  };

  const max = s ? Math.max(1, ...s.days.map((d) => d.tokens)) : 1;
  const m = s?.month;
  const api = s?.mode === 'api';
  const paid = s && m ? (api ? m.cost : s.planPrice) : null; // what actually leaves the account each month
  const times = paid && m ? m.cost / paid : null;
  const fresh = m ? m.input + m.output : 0;
  const cached = m ? m.cacheRead + m.cacheWrite : 0;
  const modelCost = m && m.cost > 0 ? m.cost : 1;

  return (
    <div className="viewer-wrap tool" onClick={onClose}>
      <section className="panel viewer dash" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <span className="lbl strong">Token dashboard</span>
          <span className="flex" />
          <button className="ghost small" onClick={onClose} aria-label="Close dashboard">✕</button>
        </div>
        <div className="viewer-body">
          {!s ? <span className="muted small">loading…</span> : s.all.questions === 0 ? (
            <p className="muted">Nothing counted yet. Ask the assistant something and it will show up here; the count starts from the first question after this update.</p>
          ) : <>
            <h3 className="lbl first">This month</h3>
            <div className="dash-bubbles">
              <div className="bubble paid">
                <span className="lbl">What you actually pay</span>
                {paid == null ? <b>—</b> : <b>{usd(paid)}</b>}
                <span className="small muted">{api ? 'billed to your API key so far this month' : `${s.planName ? s.planName[0].toUpperCase() + s.planName.slice(1) : 'Claude'} plan, a flat monthly price`}</span>
                {!api && (editing ? (
                  <span className="price-edit">
                    $<input autoFocus inputMode="decimal" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') savePrice(); if (e.key === 'Escape') setEditing(false); }} aria-label="Monthly plan price in dollars" />
                    <button className="pill" onClick={savePrice}>Save</button>
                  </span>
                ) : (
                  <button className="pill" onClick={() => { setDraft(s.planPrice ? String(s.planPrice) : ''); setEditing(true); }}>
                    {s.planPriceKnown ? 'Change price' : 'A guess: set your real price'}
                  </button>
                ))}
              </div>
              <div className="bubble worth">
                <span className="lbl">What the tokens would have cost</span>
                <b>{usd(m!.cost)}</b>
                <span className="small muted">{n(m!.tokens)} tokens at API prices, across {m!.questions} {m!.questions === 1 ? 'question' : 'questions'}</span>
                {times != null && <span className="mono small times">{times >= 10 ? Math.round(times) : times.toFixed(1)}× what you pay</span>}
              </div>
            </div>
            <p className="muted small">{m!.reads} files read and {m!.edits} edits this month{m!.questions ? `, ${usd(m!.cost / m!.questions)} of API-price work per question` : ''}. {n(fresh)} of the tokens were fresh and {n(cached)} reused from cache, which is cheap but makes up most of the count because every question re-reads the whole chat so far (a shorter chat is a cheaper one).</p>

            <h3 className="lbl">By model, this month</h3>
            <div className="dash-bubbles">
              {s.models.length === 0 ? <span className="muted small">No questions this month yet.</span> : s.models.map((r) => (
                <div className="bubble model" key={r.model}>
                  <span className="lbl">{modelName(r.model)}</span>
                  <b>{usd(r.cost)}</b>
                  <span className="small muted">{n(r.tokens)} tokens · {r.questions} {r.questions === 1 ? 'question' : 'questions'}</span>
                  <span className="bar" aria-hidden><i style={{ width: `${Math.max(2, (r.cost / modelCost) * 100)}%` }} /></span>
                  <span className="mono small muted">{Math.round((r.cost / modelCost) * 100)}% of the month</span>
                </div>
              ))}
            </div>

            <h3 className="lbl">Earlier</h3>
            <div className="dash-tiles">
              <Tile label="Today" t={s.today} />
              <Tile label="Last 7 days" t={s.week} />
            </div>

            <h3 className="lbl">Last 14 days</h3>
            <svg className="dash-chart" viewBox="0 0 280 90" role="img" aria-label="Tokens per day, last 14 days">
              {s.days.map((d, i) => {
                const h = (d.tokens / max) * 70;
                return (
                  <g key={d.day}>
                    <rect x={i * 20 + 3} y={76 - h} width={14} height={Math.max(h, d.tokens ? 1 : 0)} rx={2} fill="#22d3ee" opacity={i === 13 ? 1 : 0.55}>
                      <title>{`${d.day}: ${n(d.tokens)} tokens, ${usd(d.cost)}`}</title>
                    </rect>
                    {(i % 3 === 0 || i === 13) && <text x={i * 20 + 10} y={88} textAnchor="middle" fontSize="7" fill="#9ca3af">{d.day.slice(5)}</text>}
                  </g>
                );
              })}
              <line x1="0" x2="280" y1="76.5" y2="76.5" style={{ stroke: 'rgba(var(--ink),.15)' }} />
            </svg>
            <p className="muted small">Counting since {s.since ? new Date(s.since).toLocaleDateString() : '—'}. Only questions asked through this app are counted, not other Claude Code sessions.</p>
          </>}
        </div>
      </section>
    </div>
  );
}
