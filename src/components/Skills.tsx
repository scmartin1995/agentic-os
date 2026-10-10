import { useEffect, useState } from 'react';
import type { SkillInfo } from '../types';

// Skills list, from the hamburger menu: every skill in the design notes, grouped as skills/index.md groups them.
// Clicking one opens its SKILL.md; closing the note comes back here.
export default function Skills({ onClose, onOpen }: { onClose(): void; onOpen(path: string): void }) {
  const [groups, setGroups] = useState<{ name: string; skills: SkillInfo[] }[] | null>(null);
  useEffect(() => { window.aos.vault.skills().then((r) => setGroups(r.groups)); }, []);
  const count = groups?.reduce((n, g) => n + g.skills.length, 0) ?? 0;

  return (
    <div className="viewer-wrap tool" onClick={onClose}>
      <section className="panel viewer list-tool" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <span className="lbl strong">Skills</span>
          {groups && <span className="mono small muted">{count} in skills/</span>}
          <span className="flex" />
          <button className="ghost small" onClick={() => onOpen('skills/index.md')}>Open index</button>
          <button className="ghost small" onClick={onClose} aria-label="Close skills">✕</button>
        </div>
        <div className="viewer-body">
          <p className="muted small intro">How the assistant (and any agent using the workspace) does a kind of task. Ask for one by name, or just say the kind of thing it's for. New ones come from saying "learn this"; "wrap up" updates them.</p>
          {!groups ? <span className="muted small">loading…</span>
            : groups.length === 0 ? <p className="muted">No skills yet. Add one as <span className="mono">{'skills/<name>/SKILL.md'}</span> in your workspace.</p>
            : groups.map((g) => (
              <div key={g.name} className="tool-group">
                <h3>{g.name}</h3>
                <div className="tool-cards">
                  {g.skills.map((s) => (
                    <button key={s.path} className="tool-card" onClick={() => onOpen(s.path)} title={`Open ${s.path}`}>
                      <span className="tool-card-head">
                        <b>{s.title}</b>
                        {s.pinned && <span className="badge">pinned</span>}
                      </span>
                      <span className="mono small acc">{s.name}</span>
                      <span className="small desc">{s.description}</span>
                      {s.tags.length > 0 && <span className="tags">{s.tags.map((t) => <i key={t} className="mono">{t}</i>)}</span>}
                    </button>
                  ))}
                </div>
              </div>
            ))}
        </div>
      </section>
    </div>
  );
}
