import { useEffect, useRef, useState } from 'react';
import type { ActionItem } from '../types';
import { projectColor } from '../colors';
import { ageDays, dayLong, errText, fromYmd, fromYymmdd, pretty, splitWaiting } from '../notesShared';

// Action items: one flat list of every open item, oldest first. Every project's items sit in the one action-item register
// now (electron/registers.cjs), and each shows the project it came from as a small label. Closed items are kept in the
// register (the history); "Show closed" lists them dimmed, and Reopen puts one back. A register item is never reworded:
// Update adds a dated line to its Updates instead.
export default function Actions({ onClose, onOpen, onNotes, onChanged }: { onClose(): void; onOpen(path: string): void; onNotes(): void; onChanged(): void }) {
  const [items, setItems] = useState<ActionItem[] | null>(null);
  const [showClosed, setShowClosed] = useState(false);
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
        say(it.register ? 'Closed in the register, with a dated line.' : 'Closed. It stays in the file under Closed.', { project: it.project, raw: r.raw });
      } catch (e) { say(errText(e)); }
      setLeaving(null); setExpanded(null);
      await load(); onChanged();
    }, 260);
  };
  // The Update button: reword an item in place. The note it came from is left alone (notes and items are not one to one).
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const startEdit = (it: ActionItem) => { setEditing(it.raw); setDraft(it.register ? '' : it.text); };
  const [history, setHistory] = useState<string | null>(null);
  const saveEdit = async (it: ActionItem) => {
    const text = draft.trim();
    if (!text) return;
    if (text === it.text && !it.register) { setEditing(null); return; }
    try {
      const r = await window.aos.actions.update(it.project, it.raw, text);
      setEditing(null); setExpanded(r.raw);
      setFlash(r.raw); setTimeout(() => setFlash(null), 1600);
      say(it.register ? 'Update added to the register.' : 'Updated.');
    } catch (e) { say(errText(e)); }
    await load();
  };
  const reopen = async (it: ActionItem) => {
    try {
      const r = await window.aos.actions.reopen(it.project, it.raw);
      setFlash(r.raw); setTimeout(() => setFlash(null), 1600);
      say('Back on the list.');
    } catch (e) { say(errText(e)); }
    await load(); onChanged();
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
  const closed = (items || []).filter((i) => i.done).sort((a, b) => (b.closed || '').localeCompare(a.closed || ''));
  // the project an item came from; an item with no origin (a hand-typed checklist line) belongs to its own project
  const from = (it: ActionItem) => it.origin || pretty(it.project);

  const row = (it: ActionItem) => {
    const [full, waiting] = splitWaiting(it.text);
    // a numbered line ("84 — …") shows its register number as a tag, the same as a register item
    const nm = full.match(/^(\d+)\s+[—–-]\s+([\s\S]*)$/);
    const num = it.num ?? (nm ? Number(nm[1]) : null);
    const text = nm ? nm[2] : full;
    const age = it.done ? null : ageDays(it.added);
    const ex = expanded === it.raw;
    return (
      <div key={it.raw} className={`ai-item${it.done ? ' done' : ''}${ex ? ' ex' : ''}${leaving === it.raw ? ' out' : ''}${flash === it.raw ? ' flash' : ''}`}>
        <div className="ai-row">
          {it.done
            ? <button className="ai-check on" onClick={() => reopen(it)} aria-label={`Reopen: ${text}`} title="Reopen" />
            : <button className="ai-check" onClick={() => close(it)} aria-label={`Mark done: ${text}`} title="Mark done" />}
          <button className="ai-text" onClick={() => setExpanded(ex ? null : it.raw)} aria-expanded={ex}>
            {text}
            <span className="ai-meta">
              <span className="ai-proj"><i className="ai-dot" style={{ background: projectColor(from(it)) }} />{from(it)}</span>
              {num != null && <span className="ai-num">#{num}</span>}
              {it.added && <span>Added {dayLong(fromYmd(it.added.slice(0, 10)))}{it.added.length > 10 ? `, ${it.added.slice(11)}` : ''}</span>}
              {it.done && it.closed && <span>Closed {dayLong(fromYmd(it.closed.slice(0, 10)))}</span>}
              {age != null && <span className={`ai-age${age >= 3 ? ' old' : ''}`}>{age === 0 ? 'today' : `${age}d`}</span>}
              {waiting && <span className="ai-wait">waiting on {waiting}</span>}
            </span>
          </button>
        </div>
        {ex && (
          <div className="ai-detail">
            {editing === it.raw ? (
              <>
                <textarea className="nt-box ai-edit" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus
                  aria-label={it.register ? 'What changed on this item' : 'Reword this action item'} placeholder={it.register ? 'What changed? Saved as a dated line under Updates.' : undefined}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(it); } if (e.key === 'Escape') setEditing(null); }} />
                <div className="ai-btns">
                  <button className="btn go" onClick={() => saveEdit(it)} disabled={!draft.trim()}>Save</button>
                  <button className="btn quiet" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                {it.register && it.summary && it.summary.replace(/\.$/, '') !== text && <p className="small muted">{it.summary}</p>}
                {it.register ? <>Item {it.num} in <span className="mono">{it.register}</span>. </>
                  : it.note ? <>From a note in <span className="mono">{it.note.split('/').pop()}</span>. </> : <>Typed straight into the file. </>}{it.done ? 'Tick the circle to put it back on the list.' : 'Tick the circle to close it.'}
                <div className="ai-btns">
                  {!it.done && <button className="btn" onClick={() => startEdit(it)}>{it.register ? 'Add an update' : 'Update'}</button>}
                  {!!it.updates?.length && <button className="btn quiet" onClick={() => setHistory(history === it.raw ? null : it.raw)} aria-expanded={history === it.raw}>{history === it.raw ? 'Hide history' : `History (${it.updates.length})`}</button>}
                  {it.note && <button className="btn" onClick={() => onOpen(it.note!)}>Show the note</button>}
                  <button className="btn quiet" onClick={() => onOpen(it.file)}>Open the file</button>
                </div>
                {history === it.raw && (
                  <ul className="ai-history">
                    {it.updates!.map((u, i) => (
                      <li key={i}><span className="ai-hist-when">{u.date ? dayLong(fromYymmdd(u.date)) : ''}</span><span className="ai-hist-text">{u.text}</span></li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

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
            {items && open.length === 0 && (
              <div className="ix-empty">Nothing open. Start a note with "action item" in Notes to add one. <button className="linkish" onClick={onNotes}>Open Notes</button></div>
            )}
            {open.length > 0 && <div className="ai-list">{open.map(row)}</div>}
            {items && closed.length > 0 && (
              <div className="ai-closed">
                <button className="linkish" onClick={() => setShowClosed(!showClosed)} aria-expanded={showClosed}>{showClosed ? 'Hide closed' : `Show closed (${closed.length})`}</button>
                {showClosed && <div className="ai-list">{closed.map(row)}</div>}
              </div>
            )}
            {items && (open.length > 0 || closed.length > 0) && (
              <p className="ai-foot">Showing open items only, from every project. Closed items are kept in the action-item register{items.some((i) => i.register) ? ' (Database Team)' : ''}.</p>
            )}
          </div>
        </div>
        <div className={`nt-toast${toast ? ' show' : ''}`} role="status">{toast?.text}{toast?.undo && <button onClick={undo}>Undo</button>}</div>
      </section>
    </div>
  );
}
