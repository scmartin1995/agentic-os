import { useEffect, useState } from 'react';
import type { ValueSummary } from '../types';

// Value: is this worth it? Time saved (real uses x the user's own minute estimates), what that time is worth at
// its hourly rate, net of the plan price, and where tokens are spent on more model than the job needed.
const usd = (v: number) => (Math.abs(v) >= 100 ? `$${Math.round(v).toLocaleString()}` : `$${v.toFixed(2)}`);
const hrs = (h: number) => (h >= 10 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`);
const label = (name: string) => (name === '_questions' ? 'Everyday questions' : name);

function Pips({ share, color }: { share: number; color: string }) {
  const lit = Math.round(share * 10);
  return <span className="pips">{Array.from({ length: 10 }, (_, i) => <i key={i} className={i < lit ? 'on' : ''} style={i < lit ? { background: color, boxShadow: `0 0 6px ${color}` } : undefined} />)}</span>;
}

export default function Value({ onClose, embedded }: { onClose(): void; embedded?: boolean }) {
  const [v, setV] = useState<ValueSummary | null>(null);
  const [rateEdit, setRateEdit] = useState<string | null>(null);
  const [minEdit, setMinEdit] = useState<{ name: string; value: string } | null>(null);
  const load = () => window.aos.insights.value().then(setV);
  useEffect(() => { load(); }, []);

  const saveRate = async () => {
    if (rateEdit == null) return;
    let n = Number(rateEdit.replace(/[^0-9.]/g, '')) || 0;
    if (n > 1000) n = Math.round((n / 2080) * 100) / 100; // typed a yearly salary: turn it into an hourly rate
    await window.aos.insights.setHourlyRate(n);
    setRateEdit(null); load();
  };
  const saveMin = async () => {
    if (!minEdit) return;
    const n = Number(minEdit.value);
    await window.aos.insights.setSkillMinutes(minEdit.name, Number.isFinite(n) && minEdit.value.trim() !== '' ? n : null);
    setMinEdit(null); load();
  };

  const rows = v ? v.bySkill.filter((x) => x.uses > 0 || x.name === '_questions') : [];
  const idle = v ? v.bySkill.filter((x) => x.uses === 0 && x.name !== '_questions') : [];
  const maxH = Math.max(0.01, ...rows.map((x) => x.hours));
  const maxW = v ? Math.max(0.01, ...v.weeks.map((w) => w.hours)) : 1;
  const firstWeek = v ? v.weeks.findIndex((w) => w.hours > 0) : -1;

  const Row = ({ x }: { x: ValueSummary['bySkill'][number] }) => (
    <div className={`hbar${x.uses ? '' : ' zero'}`}>
      <span className="nm">{x.name === '_questions' ? label(x.name) : <><i>aos:</i>{x.name}</>}</span>
      <span className="track"><i style={{ width: `${(x.hours / maxH) * 100}%` }} /></span>
      <span className="num">
        <b>{hrs(x.hours)}</b> · {x.uses}× ·{' '}
        {minEdit?.name === x.name ? (
          <span className="min-edit">
            <input autoFocus inputMode="decimal" value={minEdit.value} onChange={(e) => setMinEdit({ name: x.name, value: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') saveMin(); if (e.key === 'Escape') setMinEdit(null); }} onBlur={saveMin} aria-label={`Minutes saved per use of ${label(x.name)}`} /> min
          </span>
        ) : <>{x.minutes} min <button className="pencil" onClick={() => setMinEdit({ name: x.name, value: String(x.minutes) })} aria-label={`Change minutes for ${label(x.name)}`}>✎</button></>}
      </span>
    </div>
  );

  return (
    <div className={`viewer-wrap tool${embedded ? ' embedded' : ''}`} onClick={onClose}>
      <section className="panel viewer" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <span className="lbl strong">Value</span>
          <span className="small ix-sub">Is this worth it? Time saved, what that time is worth, and where the money goes</span>
          <span className="flex" />
          {!embedded && <button className="ghost small" onClick={onClose} aria-label="Close Value">✕</button>}
        </div>
        <div className="viewer-body">
          {!v ? <span className="muted small">reading your history…</span> : (
            <div className="ix">
              <div className="dash-bubbles">
                <div className="bubble paid"><span className="lbl">What you pay</span><b>{v.pay ? usd(v.pay) : '—'}</b><span className="small muted">{v.pay ? `${v.planName ? v.planName[0].toUpperCase() + v.planName.slice(1) : 'Claude'} plan, a flat monthly price` : 'set it in the Token dashboard'}</span></div>
                <div className="bubble time"><span className="lbl">Time Agentic OS saved you</span><b>{hrs(v.hours)}</b><span className="small muted">estimated from {v.questions} questions and {v.uses} skill uses this month</span></div>
                <div className="bubble worth"><span className="lbl">What that time is worth</span><b>{usd(v.worth)}</b><span className="small muted">at {usd(v.rate)} an hour</span></div>
                <div className="bubble net"><span className="lbl">Net gain this month</span><b>{v.net >= 0 ? '+' : '−'}{usd(Math.abs(v.net))}</b><span className="mono small times">{v.times != null ? `${v.times >= 10 ? Math.round(v.times) : v.times.toFixed(1)}× what you pay` : 'add your plan price to compare'}</span></div>
              </div>

              <div className="row" style={{ justifyContent: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                <div className="rate">
                  <span>Your time is worth</span>
                  {rateEdit != null ? (
                    <><input autoFocus inputMode="decimal" value={rateEdit} onChange={(e) => setRateEdit(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveRate(); if (e.key === 'Escape') setRateEdit(null); }} aria-label="Hourly rate, or yearly salary" />
                      <button className="btn go" onClick={saveRate}>Save</button></>
                  ) : <><b>{usd(v.rate)}</b><span>an hour{v.rateIsDefault ? `, from $${v.salary.toLocaleString()} a year` : ''}</span><button className="btn" onClick={() => setRateEdit(String(v.rate))}>Change</button></>}
                </div>
                <span className="small muted" style={{ maxWidth: 560 }}>The minutes saved per use are your own estimates, because nothing can measure them. Change one with the pencil and every number here follows. You can type a yearly salary as the rate too.</span>
              </div>

              <div className="cols2">
                <div className="panelcard">
                  <div className="ix-sechead" style={{ margin: 0 }}><h3 className="lbl">Where the time came from</h3><span className="small ix-sub">this month</span></div>
                  <div className="hbars">{rows.map((x) => <Row key={x.name} x={x} />)}</div>
                  {idle.length > 0 && (
                    <details>
                      <summary className="small muted" style={{ cursor: 'pointer' }}>{idle.length} skills not used this month (set their minutes now)</summary>
                      <div className="hbars" style={{ marginTop: 10 }}>{idle.map((x) => <Row key={x.name} x={x} />)}</div>
                    </details>
                  )}
                </div>
                <div className="panelcard">
                  <div className="ix-sechead" style={{ margin: 0 }}><h3 className="lbl">Hours saved a week</h3><span className="small ix-sub">last 8 weeks</span></div>
                  <div className="wk">{v.weeks.map((w, i) => (
                    <div key={w.label} className={i === v.weeks.length - 1 ? 'cur' : ''} title={`week to ${w.label}: ${w.hours.toFixed(1)} h`}>
                      <i style={{ height: `${Math.max(w.hours ? 3 : 0, (w.hours / maxW) * 100)}%` }} />{w.hours ? w.hours.toFixed(1) : ''}
                    </div>
                  ))}</div>
                  <span className="small muted">{firstWeek > 0 ? `History starts ${v.since ? new Date(v.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'recently'}, so earlier weeks are empty, not zero.` : 'Weeks run to today.'}</span>
                </div>
              </div>

              <div className="ix-sec">
                <div className="ix-sechead"><h3 className="lbl">Model fit: are you paying for more than the job needed?</h3><span className="small ix-sub">from the token ledger, this month</span></div>
                <div className="cols2">
                  <div className="panelcard">
                    {v.fit.cacheShare != null && <div className="gauge"><Pips share={v.fit.cacheShare} color="#78a9ff" /><b>{Math.round(v.fit.cacheShare * 100)}%</b><span className="small muted">of tokens were cheap cache re-reads (mostly the wiki indexes every answer reads)</span></div>}
                    {v.fit.rightSized != null
                      ? <div className="gauge"><Pips share={v.fit.rightSized} color="#be95ff" /><b>{Math.round(v.fit.rightSized * 100)}%</b><span className="small muted">of {v.fit.sizedCount} questions ran on the right-sized model</span></div>
                      : <span className="small muted">Right-sizing starts counting from this update: each question now records whether it was a quick lookup.</span>}
                    <span className="small muted">Right-sized means a quick lookup that opens a chat ran on Haiku, the cheapest model. One in the middle of a chat stays on that chat's model, which is cheaper than switching.</span>
                  </div>
                  <div className="panelcard">
                    <Fit title={`${v.fit.heavyLookups.n} quick lookup${v.fit.heavyLookups.n === 1 ? '' : 's'} opened a chat on a bigger model`} saving={v.fit.heavyLookups.saving} cost={v.fit.heavyLookups.cost} note="One-line first questions with nothing to change. Haiku covers them." none={v.fit.heavyLookups.n === 0} />
                    <Fit title={`${v.fit.longChats} chat${v.fit.longChats === 1 ? '' : 's'} grew past 60 messages`} note="Long chats re-send everything each turn. A fresh chat is cheaper." none={v.fit.longChats === 0} />
                    <Fit title={`Lessons pass ran ${v.fit.auto.n} time${v.fit.auto.n === 1 ? '' : 's'} on Sonnet`} cost={v.fit.auto.cost} note="On purpose: it edits skills, and on Sonnet it reads the chat from cache." none={v.fit.auto.n === 0} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Fit({ title, note, saving, cost, none }: { title: string; note: string; saving?: number | null; cost?: number; none: boolean }) {
  return (
    <div className="fit" style={none ? { opacity: 0.55 } : undefined}>
      <div className="fit-top"><b>{title}</b>{!none && saving != null && saving > 0.005 ? <span className="save money">save ~{usd(saving)}</span> : !none && cost ? <span className="save money">{usd(cost)}</span> : null}</div>
      <span className="small muted">{none ? 'Nothing to fix here this month.' : note}</span>
    </div>
  );
}
