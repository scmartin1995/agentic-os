import { useEffect, useState } from 'react';
import type { SkillInfo } from '../types';
import aos from '../aos';

// Skills that have a Run button: jobs that repeat and need nothing from the user once started.
const RUNNABLE = new Set(['idc-dashboard-refresh', 'dba-portal-comparison']);
type Past = { at: string; skill: string; model: string; ok: boolean; secs: number; note: string };
type Live = { skill: string; since: number };

// Skills list, from the hamburger menu: every skill in skills/, grouped as skills/index.md groups them.
// Clicking one opens its SKILL.md; closing the note comes back here.
// Run starts it without a chat (electron/skillrun.cjs); each run is one line in runs.log.
export default function Skills({ onClose, onOpen, embedded }: { onClose(): void; onOpen(path: string): void; embedded?: boolean }) {
  const [groups, setGroups] = useState<{ name: string; skills: SkillInfo[] }[] | null>(null);
  const [live, setLive] = useState<Live[]>([]);
  const [past, setPast] = useState<Past[]>([]);
  const [model, setModel] = useState<'haiku' | 'sonnet'>('sonnet');
  const [check, setCheck] = useState<string>('');
  useEffect(() => { window.aos.vault.skills().then((r) => setGroups(r.groups)); }, []);
  useEffect(() => {
    const load = () => { aos.skillRun.state().then(setLive).catch(() => {}); aos.skillRun.recent(8).then(setPast).catch(() => {}); };
    load();
    return aos.skillRun.onEvent(load);
  }, []);
  const count = groups?.reduce((n, g) => n + g.skills.length, 0) ?? 0;
  const busy = (name: string) => live.some((l) => l.skill === name);

  const run = (name: string) => { aos.skillRun.run(name, model).catch((e) => setCheck(`${name}: ${String(e?.message || e)}`)); };
  const test = async () => {
    setCheck('Testing the gateway…');
    const r = await aos.skillRun.test();
    setCheck(r.ok ? `Background runs work: ${r.model} answered "${r.reply}" in ${r.secs}s.` : `Background runs failed: ${r.error}`);
  };

  return (
    <div className={`viewer-wrap tool${embedded ? ' embedded' : ''}`} onClick={onClose}>
      <section className="panel viewer list-tool" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <span className="lbl strong">Skills</span>
          {groups && <span className="mono small muted">{count} in skills/</span>}
          <span className="flex" />
          <select className="ghost small" value={model} onChange={(e) => setModel(e.target.value as 'haiku' | 'sonnet')} title="Model used by Run" aria-label="Model for Run">
            <option value="sonnet">Run on Sonnet</option>
            <option value="haiku">Run on Haiku</option>
          </select>
          <button className="ghost small" onClick={test} title="Sends one tiny request the way Run would, to check the gateway allows it">Test gateway</button>
          <button className="ghost small" onClick={() => onOpen('skills/index.md')}>Open index</button>
          {!embedded && <button className="ghost small" onClick={onClose} aria-label="Close skills">✕</button>}
        </div>
        <div className="viewer-body">
          <p className="muted small intro">How Agentic OS (and any agent using the vault) does a kind of task. Ask for one by name, or just say the kind of thing it's for. New ones come from saying "learn this"; "wrap up" updates them.</p>
          {check && <p className="small mono">{check}</p>}
          {past.length > 0 && (
            <div className="tool-group">
              <h3>Recent runs</h3>
              {past.map((p, i) => (
                <div key={i} className="small" style={{ padding: '3px 0' }} title={p.note}>
                  <span className="mono muted">{p.at}</span> · <b>{p.skill}</b> · {p.ok ? 'done' : 'failed'} in {p.secs}s · <span className="muted">{p.note.slice(0, 110)}</span>
                </div>
              ))}
            </div>
          )}
          {!groups ? <span className="muted small">loading…</span>
            : groups.length === 0 ? <p className="muted">No skills yet. They live in skills/.</p>
            : groups.map((g) => (
              <div key={g.name} className="tool-group">
                <h3>{g.name}</h3>
                <div className="tool-cards">
                  {g.skills.map((s) => (
                    <div key={s.path} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <button className="tool-card" style={{ flex: 1 }} onClick={() => onOpen(s.path)} title={`Open ${s.path}`}>
                        <span className="tool-card-head">
                          <b>{s.title}</b>
                          {s.pinned && <span className="badge">pinned</span>}
                        </span>
                        <span className="mono small acc">aos:{s.name}</span>
                        <span className="small desc">{s.description}</span>
                        {s.tags.length > 0 && <span className="tags">{s.tags.map((t) => <i key={t} className="mono">{t}</i>)}</span>}
                      </button>
                      {RUNNABLE.has(s.name) && (busy(s.name)
                        ? <button className="ghost small" onClick={() => aos.skillRun.stop(s.name)}>Running… stop</button>
                        : <button className="ghost small" onClick={() => run(s.name)} title="Runs this skill start to finish with no chat; the result shows under Recent runs">▶ Run</button>)}
                    </div>
                  ))}
                </div>
              </div>
            ))}
        </div>
      </section>
    </div>
  );
}
