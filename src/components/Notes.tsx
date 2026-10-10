import { useEffect, useRef, useState } from 'react';
import type { ActionItem, NoteEntry } from '../types';
import { projectColor } from '../colors';
import { PREFIX, dayLong, errText, fromYmd, hhmm, mondayOf, pretty, ymd } from '../notesShared';

// Notes: jot a note into a project's notes.md (projects/<P>/notes.md, or inbox/notes.md), stamped with the date and
// time. A note that starts with "action item" is also added to that project's action-items.md. See electron/actions.cjs.
const LAST = 'aos-notes-project';
const remembered = () => { try { return localStorage.getItem(LAST) || ''; } catch { return ''; } };

export default function Notes({ onClose, onOpen, onActions, onChanged }: { onClose(): void; onOpen(path: string): void; onActions(): void; onChanged(): void }) {
  const [projects, setProjects] = useState<string[]>([]);
  const [cur, setCur] = useState(remembered);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [file, setFile] = useState('');
  const [entries, setEntries] = useState<NoteEntry[] | null>(null);
  const [acts, setActs] = useState<ActionItem[]>([]);
  const [all, setAll] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(new Date());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    window.aos.notes.projects().then((ps) => {
      setProjects(ps);
      setCur((c) => (ps.includes(c) ? c : ps[0] || 'Inbox'));
    }).catch(() => setProjects(['Inbox']));
    const t = setInterval(() => setNow(new Date()), 20000);
    box.current?.focus();
    return () => { clearInterval(t); if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, []);
  const load = () => {
    if (!cur) return;
    window.aos.notes.list(all ? null : cur).then(setEntries).catch(() => setEntries([]));
    window.aos.actions.list().then((r) => setActs(r.items)).catch(() => {});
  };
  useEffect(() => {
    if (!cur) return;
    load();
    window.aos.notes.where(cur).then((w) => setFile(w.file)).catch(() => setFile(''));
    try { localStorage.setItem(LAST, cur); } catch { /* private mode */ }
    return window.aos.vault.onChanged(() => load());
  }, [cur, all]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = text.match(PREFIX);
  const body = m ? text.slice(m[0].length).trim() : text.trim();
  const canSave = !!text.trim() && !!body && !saving && !!cur;
  const say = (t: string) => { if (toastTimer.current) clearTimeout(toastTimer.current); setToast(t); toastTimer.current = setTimeout(() => setToast(null), 3200); };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const r = await window.aos.notes.add(cur, text);
      setText('');
      setFlash(`${r.project}|${r.date}|${r.time}`);
      setTimeout(() => setFlash(null), 1800);
      say(r.action ? `Saved to ${pretty(cur)} and added to Action items.` : `Saved to ${pretty(cur)}, stamped ${r.time}.`);
      load(); onChanged();
    } catch (e) { say(errText(e)); }
    setSaving(false);
    box.current?.focus();
  };

  // Which action item came from which note: same project, added at the note's date and time.
  const status = (n: NoteEntry) => {
    if (!n.action) return null;
    const a = acts.find((x) => x.project === n.project && x.added === `${n.date} ${n.time}`);
    return a ? (a.done ? 'closed' : 'open') : 'open';
  };
  const thisWeek = mondayOf(now).getTime();
  let lastWeek: number | null = null, lastDay: string | null = null;

  return (
    <div className="viewer-wrap tool" onClick={onClose}>
      <section className="panel viewer" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <span className="lbl strong">Notes</span>
          <span className="small ix-sub">dated and time-stamped, filed in the project's notes</span>
          <span className="flex" />
          <button className="ghost small" onClick={onClose} aria-label="Close Notes">✕</button>
        </div>
        <div className="viewer-body">
          <div className="nt-grid">
            <div className="nt-write">
              <select className="nt-field" value={cur} onChange={(e) => setCur(e.target.value)} aria-label="File this note in">
                {projects.map((p) => <option key={p} value={p}>{p === 'Inbox' ? 'Inbox (not sure yet)' : pretty(p)}</option>)}
              </select>
              <textarea ref={box} className={`nt-box${m ? ' ai' : ''}`} value={text} onChange={(e) => setText(e.target.value)} aria-label="Note"
                onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); } }}
                placeholder={'Type a note. Start with "action item:" to also add it to your action items.'} />
              {m && (
                <div className={`nt-detect${body ? '' : ' warn'}`} role="status">
                  {body ? <><svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="8" /><path d="M8.5 12.2l2.3 2.3 4.7-4.9" /></svg><span>Starts with <b>action item</b>. Saving also adds it to Action items under <b>{pretty(cur)}</b>.</span></>
                    : <span>Add what needs doing after "action item".</span>}
                </div>
              )}
              <div className="nt-tools">
                <span className="small muted">Ctrl+Enter saves</span>
                <button className="btn go" onClick={save} disabled={!canSave}>{saving ? 'Saving…' : m ? 'Save and add item' : 'Save note'}</button>
              </div>
              <p className="nt-stamp">Stamped <b>{dayLong(now)} {now.getFullYear()}, {hhmm(now)}</b> · filed in <span className="mono">{file || '…'}</span></p>
            </div>

            <div className="nt-feed">
              <div className="nt-feedhead">
                <h3 className="lbl">This week and last</h3>
                <label className="nt-tog"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All projects</label>
              </div>
              {entries && entries.length === 0 && <div className="ix-empty">No notes in {all ? 'any project' : pretty(cur)} this week or last. Older notes stay in the project's notes.md.</div>}
              {(entries || []).map((n) => {
                const d = fromYmd(n.date);
                const wk = mondayOf(d).getTime();
                const weekHead = wk !== lastWeek;
                const dayHead = weekHead || n.date !== lastDay;
                lastWeek = wk; lastDay = n.date;
                const end = new Date(wk); end.setDate(end.getDate() + 6);
                const pm = n.text.match(PREFIX);
                const st = status(n);
                return (
                  <div key={`${n.project}|${n.date}|${n.time}|${n.text.slice(0, 20)}`}>
                    {weekHead && (
                      <div className="nt-week">{wk === thisWeek ? 'This week' : 'Last week'} · {dayLong(new Date(wk))} to {dayLong(end)}
                        {!all && <button className="mono linkish" onClick={() => onOpen(n.file)} title="Open this week's notes file">{n.file}</button>}
                      </div>
                    )}
                    {dayHead && <div className="nt-day">{dayLong(d)}{n.date === ymd(now) ? ' (today)' : ''}</div>}
                    <div className={`nt-entry${flash === `${n.project}|${n.date}|${n.time}` ? ' flash' : ''}`}>
                      <span className="mono nt-time">{n.time === "00:00" ? "" : n.time}</span>
                      <div>
                        <div className="nt-text">{pm ? <><span className="nt-pfx">{pm[0].trim()}</span> {n.text.slice(pm[0].length)}</> : n.text}</div>
                        {(all || st) && (
                          <div className="nt-tags">
                            {all && <span className="nt-tag proj" style={{ color: projectColor(n.project) }}>{n.name}</span>}
                            {st && <button className={`nt-tag${st === 'closed' ? ' closed' : ''}`} onClick={onActions} title="Open Action items">action item, {st}</button>}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className={`nt-toast${toast ? ' show' : ''}`} role="status">{toast}</div>
      </section>
    </div>
  );
}
