import { useEffect, useRef, useState } from 'react';
import type { ActionItem } from '../types';
import { projectColor } from '../colors';
import { ageDays, dayLong, errText, fromYmd, pretty, splitWaiting } from '../notesShared';

// Action items: every open checkbox line from every project's action-items.md (and inbox/action-items.md), grouped
// by project, oldest first. Ticked items stay in the files; this page only shows what's still open. Items come from
// notes that start with "action item" (the Notes page) or from lines typed straight into the files.
export default function Actions({ onClose, onOpen, onNotes, onChanged }: { onClose(): void; onOpen(path: string): void; onNotes(): void; onChanged(): void }) {
  const [items, setItems] = useState<ActionItem[] | null>(null);
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: { project: string; raw: string } } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = () => window.aos.actions.list().then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(() => { load(); return window.aos.vault.onChanged(() => load()); }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const say = (text: string, undo?: { project: string; raw: string }) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, undo });
    toastTimer.current = setTimeout(() => setToast(null), undo ? 5000 : 3000);
  };
  const close = (it: ActionItem) => {
    setLeaving(it.raw);
    setTimeout(async () => {
      try {
        const r = await window.aos.actions.close(it.project, it.raw);
        say('Closed. It stays in the file under Closed.', { project: it.project, raw: r.raw });
      } catch (e) { say(errText(e)); }
      setLeaving(null); setExpanded(null);
      await load(); onChanged();
    }, 260);
  };
  // The Update button: reword an item in place. The note it came from is left alone (notes and items are not one to one).
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const startEdit = (it: ActionItem) => { setEditing(it.raw); setDraft(it.text); };
  const saveEdit = async (it: ActionItem) => {
    const text = draft.trim();
    if (!text) return;
    if (text === it.text) { setEditing(null); return; }
    try {
      const r = await window.aos.actions.update(it.project, it.raw, text);
      setEditing(null); setExpanded(r.raw);
      setFlash(r.raw); setTimeout(() => setFlash(null), 1600);
      say('Updated.');
    } catch (e) { say(errText(e)); }
    await load();
  };
  const undo = async () => {
    const u = toast?.undo;
    if (!u) return;
    try {
      const r = await window.aos.actions.reopen(u.project, u.raw);
      setFlash(r.raw); setTimeout(() => setFlash(null), 1600);
      say('Back on the list.');
    } catch (e) { say(errText(e)); }
    await load(); onChanged();
  };

  const open = (items || []).filter((i) => !i.done).sort((a, b) => (a.added || '9').localeCompare(b.added || '9'));
  const closedCount = (items || []).length - open.length;
  const projects = [...new Set(open.map((i) => i.project))];
  const shown = filter === 'all' || !projects.includes(filter) ? projects : [filter];
  const fileFor = filter !== 'all' ? (items || []).find((i) => i.project === filter)?.file : null;

  return (
    <div className="viewer-wrap tool" onClick={onClose}>
      <section className="panel viewer" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <span className="lbl strong">Action items</span>
          <span className="small ix-sub">{items ? <><b className="ai-count">{open.length}</b> open, from every project</> : 'reading…'}</span>
          <span className="flex" />
          <button className="ghost small" onClick={onClose} aria-label="Close Action items">✕</button>
        </div>
        <div className="viewer-body">
          <div className="ai-wrap">
            {items && open.length > 0 && (
              <select className="nt-field" value={shown.length === 1 && filter !== 'all' ? filter : 'all'} onChange={(e) => setFilter(e.target.value)} aria-label="Show action items for">
                <option value="all">All projects ({open.length})</option>
                {projects.map((p) => <option key={p} value={p}>{pretty(p)} ({open.filter((i) => i.project === p).length})</option>)}
              </select>
            )}
            {items && open.length === 0 && (
              <div className="ix-empty">Nothing open. Start a note with "action item" in Notes to add one. <button className="linkish" onClick={onNotes}>Open Notes</button></div>
            )}
            {shown.map((p) => {
              const group = open.filter((i) => i.project === p);
              return (
                <section key={p} className="ai-group">
                  <h3 className="ai-grp-h"><i className="ai-dot" style={{ background: projectColor(p) }} />{pretty(p)}<span>{group.length}</span></h3>
                  {group.map((it) => {
                    const [text, waiting] = splitWaiting(it.text);
                    const age = ageDays(it.added);
                    const ex = expanded === it.raw;
                    return (
                      <div key={it.raw} className={`ai-item${ex ? ' ex' : ''}${leaving === it.raw ? ' out' : ''}${flash === it.raw ? ' flash' : ''}`}>
                        <div className="ai-row">
                          <button className="ai-check" onClick={() => close(it)} aria-label={`Mark done: ${text}`} title="Mark done" />
                          <button className="ai-text" onClick={() => setExpanded(ex ? null : it.raw)} aria-expanded={ex}>
                            {text}
                            <span className="ai-meta">
                              {it.added && <span>Added {dayLong(fromYmd(it.added.slice(0, 10)))}{it.added.length > 10 ? `, ${it.added.slice(11)}` : ''}</span>}
                              {age != null && <span className={`ai-age${age >= 3 ? ' old' : ''}`}>{age === 0 ? 'today' : `${age}d`}</span>}
                              {waiting && <span className="ai-wait">waiting on {waiting}</span>}
                            </span>
                          </button>
                        </div>
                        {ex && (
                          <div className="ai-detail">
                            {editing === it.raw ? (
                              <>
                                <textarea className="nt-box ai-edit" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Reword this action item" autoFocus
                                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(it); } if (e.key === 'Escape') setEditing(null); }} />
                                <div className="ai-btns">
                                  <button className="btn go" onClick={() => saveEdit(it)} disabled={!draft.trim()}>Save</button>
                                  <button className="btn quiet" onClick={() => setEditing(null)}>Cancel</button>
                                </div>
                              </>
                            ) : (
                              <>
                                {it.note ? <>From a note in <span className="mono">{it.note.split('/').pop()}</span>. </> : <>Typed straight into the file. </>}Tick the circle to close it.
                                <div className="ai-btns">
                                  <button className="btn" onClick={() => startEdit(it)}>Update</button>
                                  {it.note && <button className="btn" onClick={() => onOpen(it.note!)}>Show the note</button>}
                                  <button className="btn quiet" onClick={() => onOpen(it.file)}>Open the file</button>
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </section>
              );
            })}
            {items && (open.length > 0 || closedCount > 0) && (
              <p className="ai-foot">Showing open items only. <b>{closedCount}</b> closed {closedCount === 1 ? 'is' : 'are'} kept in each project's action-items file.{fileFor && <> <button className="linkish" onClick={() => onOpen(fileFor)}>Open the {pretty(filter)} file</button></>}</p>
            )}
          </div>
        </div>
        <div className={`nt-toast${toast ? ' show' : ''}`} role="status">{toast?.text}{toast?.undo && <button onClick={undo}>Undo</button>}</div>
      </section>
    </div>
  );
}
