import { useEffect, useState } from 'react';
import type { DreamCard, DreamDimension, DreamState } from '../types';

// Dreams: what Agentic OS noticed overnight, as four cards. "Do it" sends the card's action to Agentic OS as a normal
// chat message (so edits still get the usual yes/no card) and ticks the card done. Agreed with the user 2026-10-04.
export const DIM: Record<DreamDimension, { label: string; color: string }> = {
  chats: { label: 'Chats', color: '#78a9ff' },
  cost: { label: 'Cost', color: '#be95ff' },
  skills: { label: 'Skills', color: '#be95ff' },
  memory: { label: 'Memory', color: '#f1c21b' },
  sessions: { label: 'Sessions', color: '#82cfff' },
  workflow: { label: 'Workflow', color: '#a6c8ff' },
  outside: { label: 'Outside', color: '#6fdc8c' },
  business: { label: 'Business', color: '#ffb3b8' },
};
const ORDER = Object.keys(DIM) as DreamDimension[];

const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase();
const dayName = (day: string) => new Date(day + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const hourName = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' }).toLowerCase();
const isToday = (t: number) => new Date(t).toDateString() === new Date().toDateString();
// "Last night" only for a dream that ran overnight; a daytime one (Dream now, or a catch-up) is "Today".
const whenSaid = (d: { at: number; day: string }) => (isToday(d.at) ? (new Date(d.at).getHours() < 6 ? 'Last night' : 'Today') : `On ${dayName(d.day)}`);

export default function Dreams({ onClose, onDo, busy }: { onClose(): void; onDo(action: string): void; busy: boolean }) {
  const [s, setS] = useState<DreamState | null>(null);
  const [schedule, setSchedule] = useState(false);
  const load = () => window.aos.dreams.state().then(setS);
  useEffect(() => {
    load();
    return window.aos.dreams.onEvent(() => load());
  }, []);

  const d = s?.latest ?? null;
  const mark = async (c: DreamCard, status: DreamCard['status']) => { if (d) { await window.aos.dreams.mark(d.day, c.id, status); load(); } };
  const doIt = async (c: DreamCard) => { await mark(c, 'done'); onDo(c.action); };
  const setWeb = async (web: boolean) => { await window.aos.dreams.setSettings({ web }); load(); };
  const setHour = async (hour: number) => { await window.aos.dreams.setSettings({ hour }); load(); };
  const dream = () => { window.aos.dreams.run(); setS((x) => (x ? { ...x, running: true } : x)); };

  const open = d ? d.cards.filter((c) => c.status === 'open') : [];
  const mins = open.filter((c) => c.savesKind === 'time').reduce((a, c) => a + (Number((c.saves.match(/\d+/) || ['0'])[0]) || 0), 0);

  return (
    <div className="viewer-wrap tool" onClick={onClose}>
      <section className="panel viewer" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <span className="lbl strong">Dreams</span>
          <span className="small ix-sub">Agentic OS looks over your week every night and hands you the few things worth doing</span>
          <span className="flex" />
          <button className="ghost small" onClick={onClose} aria-label="Close Dreams">✕</button>
        </div>
        <div className="viewer-body">
          {!s ? <span className="muted small">loading…</span> : (
            <div className="ix">
              <div className={`dream-hero${s.running ? ' running' : ''}`}>
                <div style={{ position: 'relative' }}>
                  {s.running ? <h2>Dreaming… <em>reading this week's chats</em></h2>
                    : d ? <h2>{whenSaid(d)} I looked at <em>{d.read.questions} questions</em> and found <em>{d.cards.length} {d.cards.length === 1 ? 'thing' : 'things'}</em></h2>
                    : <h2>No dreams yet</h2>}
                  <span className="small muted">
                    {d ? `Dreamed ${isToday(d.at) ? 'today' : dayName(d.day)} at ${clock(d.at)} · read ${d.read.days} days of questions, skill use and token costs · took ${Math.max(1, Math.round(d.ms / 1000))} seconds${d.dropped ? ` · ${d.dropped} card${d.dropped === 1 ? '' : 's'} dropped for evidence that didn't check out` : ''}`
                      : 'The first one runs a couple of minutes after the app starts, then every night.'}
                  </span>
                  <div className="dims" aria-label="What the dream looked at">
                    {ORDER.map((k) => (
                      <span key={k} className={`dim${d && d.dims.includes(k) ? '' : ' off'}`} style={{ ['--dc' as string]: DIM[k].color }}><i />{DIM[k].label}</span>
                    ))}
                  </div>
                </div>
                <div className="dream-side" style={{ position: 'relative' }}>
                  <button className="btn go big" onClick={dream} disabled={s.running}>☾ {s.running ? 'Dreaming…' : 'Dream now'}</button>
                  <span className="small muted">Next dream: {isToday(s.next) ? 'today' : 'tonight'} {hourName(s.settings.hour)}</span>
                  {!schedule ? (
                    <span className="small muted">Web check <b style={{ color: s.settings.web ? 'var(--acc-hi)' : 'var(--txt3)' }}>{s.settings.web ? 'on' : 'off'}</b> · <button className="linkish" onClick={() => setSchedule(true)}>Change schedule</button></span>
                  ) : (
                    <span className="small muted">Dream at{' '}
                      <select className="hour-sel" value={s.settings.hour} onChange={(e) => setHour(Number(e.target.value))} aria-label="Hour to dream">
                        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourName(h)}</option>)}
                      </select>{' '}
                      <button className="linkish" onClick={() => setSchedule(false)}>Done</button>
                    </span>
                  )}
                </div>
              </div>

              {d && d.cards.length > 0 && (
                <div className="ix-sec">
                  <div className="ix-sechead">
                    <h3 className="lbl">{isToday(d.at) ? "Today's" : 'Latest'} {d.cards.length === 4 ? 'four' : d.cards.length}</h3>
                    {mins > 0 && <span className="small ix-sub">Worth about <b style={{ color: 'var(--acc-hi)' }}>{mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`} a week</b> if you do the open ones (a guess, see Value)</span>}
                  </div>
                  <div className="dcards">
                    {d.cards.map((c) => (
                      <article key={c.id} className={`dcard${c.status !== 'open' ? ' done' : ''}`} style={{ ['--dc' as string]: DIM[c.dimension]?.color || '#78a9ff' }}>
                        <div className="dcard-top">
                          <span className="chipx" style={{ ['--dc' as string]: DIM[c.dimension]?.color }}>{DIM[c.dimension]?.label || c.dimension}</span>
                          {c.saves && <span className={`save${c.savesKind === 'money' ? ' money' : ''}`}>{c.saves}</span>}
                        </div>
                        <h4>{c.headline}</h4>
                        <p>{c.why}</p>
                        {c.evidence && <div className="evid">{c.evidence}</div>}
                        <div className="dcard-act">
                          {c.status === 'open' ? <>
                            <button className="btn go" onClick={() => doIt(c)} title={c.action}>{c.button || 'Do it'}</button>
                            <button className="btn" onClick={() => mark(c, 'done')}>Mark done</button>
                            <button className="btn quiet" onClick={() => mark(c, 'skip')}>Not useful</button>
                          </> : <>
                            <span className="tick">{c.status === 'done' ? '✓ Done' : '✕ Not useful'}</span>
                            <button className="btn quiet" onClick={() => mark(c, 'open')}>Undo</button>
                          </>}
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              )}
              {d && d.cards.length === 0 && <div className="ix-empty">Nothing worth your time came out of this one. That happens when the week was quiet or everything is already in hand.</div>}

              <div className="webcard">
                <button className={`toggle${s.settings.web ? ' on' : ''}`} onClick={() => setWeb(!s.settings.web)} role="switch" aria-checked={s.settings.web} aria-label="Web check" />
                <div><b style={{ color: 'var(--txt)' }}>Worth a look (from the web)</b><br />When this is on, the dream also searches for fresh skills and ideas that fit what you've been building, and says where each came from. Off by default.</div>
              </div>

              {s.earlier.length > 0 && (
                <div className="ix-sec">
                  <div className="ix-sechead"><h3 className="lbl">Earlier dreams</h3><span className="small ix-sub">Done and not-useful cards are remembered, so they don't come back</span></div>
                  <div className="earlier">
                    {s.earlier.map((e) => (
                      <div className="erow" key={e.day}>
                        <span className="mono">{dayName(e.day)}</span>
                        <span className="pipsm">{Array.from({ length: Math.max(e.total, 1) }, (_, i) => <i key={i} className={i < e.done ? 'on' : ''} />)}</span>
                        <span className="small muted">{e.total === 0 ? 'no cards' : `${e.done} of ${e.total} done${e.skipped ? `, ${e.skipped} not useful` : ''}`}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
