import { useEffect, useState } from 'react';
import type { HealthSummary, JobRun } from '../types';
import { projectColor } from '../colors';

// Health: what's working and what has gone stale - skills by last use, project notes against how recently
// they came up in chat, sessions per day, this chat's length, and the jobs that run on their own.
const DAY = 24 * 3600 * 1000;
const ago = (t: number | null) => {
  if (!t) return 'never';
  const d = Math.floor((Date.now() - t) / DAY);
  return d <= 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
};
const short = (t: number | null) => (!t ? 'never' : ago(t).replace(' ago', ''));
const minsAgo = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : ago(t); };
const STATE = { ok: 'In use', quiet: 'Quiet', dead: 'Not used lately', none: 'No use yet' } as const;

function Job({ name, run, when, idle }: { name: string; run?: JobRun | null; when: string; idle?: string }) {
  return (
    <div className="sch">
      <i className={`live${run || idle == null ? '' : ' idle'}`} />
      <span><b style={{ fontWeight: 600 }}>{name}</b><br /><span className="small muted">{when}{run ? ` · last ran ${minsAgo(run.at)}${run.ms ? `, ${Math.max(1, Math.round(run.ms / 1000))} s` : ''}` : idle ? ` · ${idle}` : ''}</span></span>
      <span className={`state ${run && !run.ok ? 'dead' : run || idle == null ? 'ok' : 'quiet'}`} title={run?.note || ''}>{run ? (run.ok ? 'OK' : 'Failed') : idle == null ? 'OK' : 'Waiting'}</span>
    </div>
  );
}

export default function Health({ onClose, onOpen, chatItems, onAsk, embedded }: { onClose(): void; onOpen(p: string): void; chatItems: number; onAsk(text: string): void; embedded?: boolean }) {
  const [h, setH] = useState<HealthSummary | null>(null);
  useEffect(() => { window.aos.insights.health(chatItems).then(setH); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const inUse = h ? h.skills.filter((s) => s.state === 'ok').length : 0;
  const behind = h ? h.memory.filter((m) => m.behind > 0).length : 0;
  const long = chatItems >= (h?.chat.long ?? 40);
  const memMax = h ? Math.max(DAY, ...h.memory.map((m) => Date.now() - Math.min(m.notes || Date.now(), m.chat || Date.now()))) : DAY;
  const fresh = (t: number | null) => (t ? Math.max(4, 100 - ((Date.now() - t) / memMax) * 96) : 0);
  const sMax = h ? Math.max(1, ...h.sessions.days.map((d) => d.n)) : 1;
  const young = h && h.since ? Date.now() - h.since < 30 * DAY : true;

  return (
    <div className={`viewer-wrap tool${embedded ? ' embedded' : ''}`} onClick={onClose}>
      <section className="panel viewer" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <span className="lbl strong">Health</span>
          <span className="small ix-sub">Skills, notes and sessions: what is working and what has gone stale</span>
          <span className="flex" />
          {!embedded && <button className="ghost small" onClick={onClose} aria-label="Close Health">✕</button>}
        </div>
        <div className="viewer-body">
          {!h ? <span className="muted small">reading your history…</span> : (
            <div className="ix">
              <div className="dash-tiles">
                <div className="dash-tile"><span className="lbl">Skills</span><b>{inUse} of {h.skills.length}</b><span className="mono small muted">used in the last 14 days</span></div>
                <div className="dash-tile"><span className="lbl">Memory</span><b>{behind ? `${behind} behind` : 'In step'}</b><span className="mono small muted">{behind ? 'projects talked about more than written up' : 'notes keep up with your chats'}</span></div>
                <div className="dash-tile"><span className="lbl">Sessions</span><b>{h.sessions.today} today</b><span className="mono small muted">avg {h.sessions.avg.toFixed(1)} on active days</span></div>
                <div className="dash-tile"><span className="lbl">This chat</span><b>{chatItems} items</b><span className="mono small muted" style={long ? { color: 'var(--orange-soft)' } : undefined}>{long ? 'getting long, a new one is cheaper' : `fresh chat nudge at ${h.chat.long}`}</span></div>
              </div>

              <div className="ix-sec">
                <div className="ix-sechead"><h3 className="lbl">Skills: what's pulling its weight</h3><span className="small ix-sub">from every Claude Code session in the vault{h.since ? `, since ${new Date(h.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}</span></div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="srow head"><span>Skill</span><span>Last used</span><span>Use over 30 days</span><span>Uses</span><span /></div>
                  {h.skills.map((s) => (
                    <div className="srow" key={s.name} onClick={() => onOpen(s.path)} style={{ cursor: 'pointer' }} title="Open the skill">
                      <span className="nm"><i>aos:</i>{s.name}</span>
                      <span className="muted">{ago(s.last)}</span>
                      <span className={`fresh${s.state === 'quiet' ? ' q' : s.state === 'dead' ? ' d' : ''}`}><i style={{ width: `${s.uses ? Math.max(4, s.share * 100) : 0}%` }} /></span>
                      <span className="mono muted">{s.uses}</span>
                      <span className={`state ${s.state === 'none' ? 'quiet' : s.state}`} style={s.state === 'none' ? { color: 'var(--txt3)', background: 'rgba(var(--ink),.05)', borderColor: 'rgba(var(--ink),.14)' } : undefined}>{STATE[s.state]}</span>
                    </div>
                  ))}
                </div>
                <span className="small muted" style={{ marginTop: 10 }}>
                  {young ? 'History only goes back a few days, so unused skills say "No use yet" rather than dead. ' : ''}
                  An unused skill still costs a little in every chat, because its name and description are always loaded.{' '}
                  <button className="linkish" onClick={() => onAsk('Run the skill-tidy skill: look at which skills I never use and suggest what to archive or merge. Ask before changing anything.')}>Ask Agentic OS to run skill-tidy</button> to archive the dead ones.
                </span>
              </div>

              <div className="ix-sec">
                <div className="ix-sechead"><h3 className="lbl">Memory: are the notes keeping up with your chats?</h3><span className="small ix-sub">last note edit vs last time a question named the project</span></div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {h.memory.map((m) => {
                    const col = projectColor(m.folder); // same hue as the project's cluster on the graph
                    const quiet = !m.behind && (!m.chat || Date.now() - m.chat > 14 * DAY) && (!m.notes || Date.now() - m.notes > 14 * DAY);
                    return (
                      <div className="mrow" key={m.folder}>
                        <span className="nm" style={{ ['--dc' as string]: col }}><i />{m.folder}</span>
                        <span className="twin">
                          <div><span>notes {short(m.notes)}</span><span className="tk"><i style={{ width: `${fresh(m.notes)}%`, background: col }} /></span></div>
                          <div><span>chats {short(m.chat)}</span><span className="tk"><i style={{ width: `${fresh(m.chat)}%`, background: 'var(--acc)' }} /></span></div>
                        </span>
                        <span className={`state ${m.behind > 20 ? 'dead' : m.behind ? 'quiet' : 'ok'}`}>{m.behind ? `${m.behind} days behind` : !m.chat ? 'not discussed' : quiet ? 'quiet, fine' : 'in step'}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="cols2">
                <div className="panelcard">
                  <div className="ix-sechead" style={{ margin: 0 }}><h3 className="lbl">Sessions a day</h3><span className="small ix-sub">last 14 days</span></div>
                  <div className="wk" style={{ height: 120 }}>
                    {h.sessions.days.map((d, i) => (
                      <div key={d.day} className={i === h.sessions.days.length - 1 ? 'cur' : ''} title={`${d.day}: ${d.n} session${d.n === 1 ? '' : 's'}`}>
                        <i style={{ height: `${(d.n / sMax) * 100}%` }} />{i % 4 === 1 || i === h.sessions.days.length - 1 ? d.day : ''}
                      </div>
                    ))}
                  </div>
                  <span className="small muted">A session is a run of questions with no gap over 30 minutes.</span>
                  <div className="ctxmeter">
                    <div className="row"><span className="small muted">This chat</span><span className="mono small" style={long ? { color: 'var(--orange-soft)' } : undefined}>{chatItems} of {h.chat.long} before a fresh one is cheaper</span></div>
                    <span className="pips" style={{ display: 'flex', width: '100%' }}>
                      {Array.from({ length: 10 }, (_, i) => { const on = i < Math.min(10, Math.round((chatItems / h.chat.long) * 10)); const c = long ? '#be95ff' : '#78a9ff'; return <i key={i} className={on ? 'on' : ''} style={on ? { background: c, boxShadow: `0 0 6px ${c}` } : undefined} />; })}
                    </span>
                  </div>
                </div>
                <div className="panelcard">
                  <div className="ix-sechead" style={{ margin: 0 }}><h3 className="lbl">Running on its own</h3><span className="small ix-sub">what works while you don't</span></div>
                  <Job name="Dreams" run={h.jobs.dreams} when="nightly" idle="hasn't run yet" />
                  <Job name="Lessons pass" run={h.jobs.lessonsPass} when="every 10 questions" idle="hasn't run since this update" />
                  <Job name="Search index" run={h.jobs.searchIndex} when="hourly" idle="hasn't run yet" />
                  <Job name="Mail pull" run={h.jobs.mailPull} when="every 10 minutes" idle="hasn't run yet" />
                  <Job name="Vault watcher" when={`live · ${h.jobs.notes} notes`} />
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
