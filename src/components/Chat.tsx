import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Phase } from '../listen';
import type { ChatSummary } from '../types';
import Icon from '../icons';

// A file dropped, pasted or picked into the chat: saved by the app, so the assistant can read it from `path`.
export interface Attached { name: string; path: string; preview?: string }

export interface ChatItem {
  role: 'you' | 'assistant' | 'system' | 'approval';
  text: string;
  files?: { name: string; preview?: string }[];
  tools?: { name: string; label: string; path: string | null }[];
  helpers?: { id: string; name: string; desc: string; state: 'running' | 'done' | 'failed' }[]; // subagents the assistant handed work to
  approval?: { id: number; risky: boolean; what?: string; answer?: boolean; asked?: string; helper?: boolean };
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// the assistant writes markdown (bold, bullets, links). Show it formatted rather than as raw ** and -.
// Web links open in the browser; anything else in a link is left alone so the window never navigates away.
function Reply({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true }) as string), [text]);
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') || '';
    if (/^https?:/.test(href)) window.open(href, '_blank', 'noopener');
  };
  return <div className="reply" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

// What the assistant did on the way to an answer. The last few steps show; the rest fold away so a long job stays readable.
const SHOWN = 4;
function Steps({ tools, onOpen }: { tools: NonNullable<ChatItem['tools']>; onOpen(path: string): void }) {
  const [all, setAll] = useState(false);
  const list = all || tools.length <= SHOWN + 1 ? tools : tools.slice(-SHOWN);
  const hidden = tools.length - list.length;
  return (
    <div className="steps">
      {hidden > 0 && <button className="chip more mono" onClick={() => setAll(true)} title="Show every step">+{hidden} earlier</button>}
      {list.map((t, j) => (
        <button key={j} className="chip mono" disabled={!t.path} onClick={() => t.path && onOpen(t.path)} title={t.path || t.label}>
          <i className="dot" />{t.name} {t.label.split('/').pop()}
        </button>
      ))}
    </div>
  );
}

const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Up late' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening'; };
const STARTERS = ['What did I work on this week?', 'Which projects have gone quiet?', 'What should I pick up next?'];

export default function Chat({ items, busy, ready, name, aiName, onSend, onStop, onOpen, mic, onApprove, asking, onAsk, chat, setupNeeded }: {
  items: ChatItem[]; busy: boolean; ready: boolean; name: string; aiName: string;
  onSend(text: string, voice?: boolean, files?: Attached[]): void; onStop(): void; onOpen(path: string): void;
  onApprove(id: number, yes: boolean): void;
  asking: number | null; // approval the assistant is waiting on: typing now asks them about it instead
  onAsk(id: number, question: string): void;
  // live: what each chat in memory is doing (several run at once); unsaved: chats not on disk yet (still on their first reply)
  chat: { current: string; onNew(): void; onOpen(id: string): void; onForget(id: string): void; live: Record<string, { busy: boolean; needs: boolean; unread: boolean }>; unsaved: ChatSummary[] };
  mic: { phase: Phase; hold(down: boolean): void } | null;
  setupNeeded?: string; // the brain isn't usable yet: say why instead of taking questions
}) {
  const [draft, setDraft] = useState('');
  // Chats list: every past conversation, newest first. Click one to flip back to it.
  const [menu, setMenu] = useState(false);
  const [past, setPast] = useState<ChatSummary[]>([]);
  const toggleMenu = async () => {
    if (menu) { setMenu(false); return; }
    setPast(await window.aos.chats.list());
    setMenu(true);
  };
  const forget = async (id: string) => { await window.aos.chats.remove(id); chat.onForget(id); setPast((xs) => xs.filter((x) => x.id !== id)); };
  // What a chat is doing: needs an answer, working, a reply waiting, or just sitting there. Drives the dot, the label and the group.
  const kind = (id: string): 'needs' | 'working' | 'new' | 'idle' => { const c = chat.live[id]; return !c ? 'idle' : c.needs ? 'needs' : c.busy ? 'working' : c.unread ? 'new' : 'idle'; };
  const rank = { needs: 0, working: 1, new: 2, idle: 3 };
  const rows = [...chat.unsaved.filter((u) => !past.some((x) => x.id === u.id)), ...past].sort((a, b) => rank[kind(a.id)] - rank[kind(b.id)] || b.updated - a.updated);
  const groupName = (id: string) => ({ needs: 'Needs you', working: 'Working now', new: 'New replies', idle: 'Earlier' }[kind(id)]);
  const kindLabel = { needs: 'Needs your answer', working: 'Working…', new: 'New reply', idle: '' };
  const elsewhere = Object.entries(chat.live).filter(([id, c]) => id !== chat.current && (c.busy || c.needs || c.unread));
  // The list closes when you click anywhere else, or press Escape.
  const listRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => { const t = e.target as Node; if (!listRef.current?.contains(t) && !btnRef.current?.contains(t)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc); };
  }, [menu]);
  const long = items.length > 40;
  // Long-chat nudge: past 60 items every new question re-reads the lot, so one quiet line under the last message
  // offers a fresh chat. "Not now" hides it for the next 20 items of that chat.
  const NUDGE_AT = 60;
  const [snooze, setSnooze] = useState<Record<string, number>>({});
  const nudge = !busy && asking == null && items.length > NUDGE_AT && items.length >= (snooze[chat.current] ?? 0);
  const box = useRef<HTMLTextAreaElement>(null);
  // grow with the text, up to about 5 lines
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    b.style.height = 'auto';
    const h = draft ? Math.min(b.scrollHeight, 120) : 38;
    b.style.height = h + 'px';
    b.style.overflowY = draft && b.scrollHeight > 120 ? 'auto' : 'hidden';
  }, [draft]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [items]);

  // Dropped, pasted or picked files: each is saved by the app first, then shown as a chip until sent.
  const [files, setFiles] = useState<Attached[]>([]);
  const [problem, setProblem] = useState('');
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const addFiles = async (list: File[]) => {
    setProblem('');
    for (const f of list) {
      const fname = f.name && f.name !== 'image.png' ? f.name : `screenshot-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png`;
      const r = await window.aos.attach.save(fname, await f.arrayBuffer());
      // data: URL, because the page's security policy doesn't allow blob: images
      const preview = f.type.startsWith('image/') ? await new Promise<string>((ok) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result)); fr.readAsDataURL(f); }) : undefined;
      if (r.path) setFiles((xs) => [...xs, { name: r.name || fname, path: r.path!, preview }]);
      else setProblem(r.error || "Couldn't take that file.");
    }
  };
  const dropOn = {
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } },
    onDragLeave: (e: React.DragEvent) => { if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) addFiles(Array.from(e.dataTransfer.files)); },
  };
  const unattach = (path: string) => setFiles((xs) => xs.filter((f) => f.path !== path));

  const submit = () => {
    const t = draft.trim();
    if (asking != null) { if (t) { onAsk(asking, t); setDraft(''); } return; } // files wait for a normal message
    if ((!t && !files.length) || busy) return;
    onSend(t, false, files);
    setDraft('');
    setFiles([]);
    setProblem('');
  };
  const [copied, setCopied] = useState(-1);
  const copy = (i: number, text: string) => { navigator.clipboard?.writeText(text).then(() => { setCopied(i); setTimeout(() => setCopied(-1), 1200); }).catch(() => {}); };
  const title = items.find((x) => x.role === 'you')?.text || '';
  const recording = mic?.phase === 'recording';

  return (
    <section className="chat" {...dropOn}>
      <div className="chat-head">
        <span className="lbl">Conversation</span>
        <span className="title" title={title}>{title}</span>
        <button ref={btnRef} className={`pill chats-btn${menu ? ' on' : ''}`} onClick={toggleMenu} aria-expanded={menu} title="Past chats: click one to flip back to it">
          Chats{elsewhere.length > 0 && <b className={`chats-badge${elsewhere.some(([, c]) => c.needs) ? ' needs' : ''}`}>{elsewhere.length}</b>} <span aria-hidden>▾</span>
        </button>
        <button className={`pill newchat${long ? ' long' : ''}`} onClick={() => { setMenu(false); chat.onNew(); }}
          title={long ? 'This chat is getting long. A fresh one keeps answers quick and cheap.' : 'Start a fresh conversation. This one is saved under Chats.'}>
          + New
        </button>
      </div>
      {menu && (
        <div className="chat-list" role="menu" ref={listRef}>
          {rows.length === 0 && <div className="mono small muted chat-empty">No saved chats yet.</div>}
          {rows.map((c, i) => {
            const k = kind(c.id);
            const first = i === 0 || groupName(rows[i - 1].id) !== groupName(c.id);
            return (
              <div key={c.id}>
                {first && <div className={`chat-group mono ${k}`}>{groupName(c.id)}</div>}
                <div className={`chat-item ${k}${c.id === chat.current ? ' cur' : ''}`}>
                  <button className="chat-open" role="menuitem" onClick={() => { setMenu(false); chat.onOpen(c.id); }}>
                    <i className={`chat-dot ${k}`} aria-hidden />
                    <span className="chat-text">
                      <span className="chat-title">{c.title}</span>
                      <span className={`mono small chat-sub ${k}`}>
                        {[c.id === chat.current ? 'open now' : '', kindLabel[k], k === 'idle' && c.interrupted ? 'Interrupted: say carry on' : '', k === 'idle' || k === 'new' ? ago(c.updated) : '', c.count ? `${c.count} msgs` : ''].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  </button>
                  {c.id !== chat.current && k !== 'working' && <button className="chat-x" onClick={() => forget(c.id)} aria-label={`Forget ${c.title}`} title="Forget this chat">×</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="msgs">
        {items.length === 0 && (
          <div className="welcome">
            <h2>{ready ? `${greeting()}${name ? `, ${name}` : ''}.` : 'Starting up…'}</h2>
            {setupNeeded ? <p>{setupNeeded}</p> : <>
              <p>Ask me anything about your notes and I'll go digging. Talk, type, or drop a file on me.</p>
              <div className="starters">
                {STARTERS.map((s) => <button key={s} onClick={() => onSend(s)} disabled={!ready || busy}><Icon name="spark" size={15} />{s}</button>)}
              </div>
            </>}
          </div>
        )}
        {items.map((m, i) => m.role === 'you' ? (
          <div key={i} className="msg you">
            {m.files && m.files.length > 0 && (
              <div className="you-files">
                {m.files.map((f, j) => f.preview
                  ? <img key={j} src={f.preview} alt={f.name} title={f.name} />
                  : <span key={j} className="file-chip mono">{f.name}</span>)}
              </div>
            )}
            {m.text}
          </div>
        ) : m.role === 'approval' && m.approval ? (
          <div key={i} className={`approval ${m.approval.risky ? 'risky' : ''}`}>
            <div className="who">{m.approval.helper ? (m.approval.risky ? 'A helper wants to do something risky' : 'A helper wants to') : m.approval.risky ? 'The assistant wants to do something risky' : 'The assistant wants to'}</div>
            {m.approval.what && <p className="approval-what">{m.approval.what}</p>}
            <p className="mono approval-cmd">{m.text}</p>
            {m.approval.answer === undefined ? (
              <>
                <div className="row-btns">
                  <button className="yes" onClick={() => onApprove(m.approval!.id, true)}>Yes</button>
                  <button className="ghost" onClick={() => onApprove(m.approval!.id, false)}>No</button>
                  <button className="ghost" onClick={() => box.current?.focus()}>Ask first</button>
                </div>
                <div className="mono small muted ask-hint">Not sure? Type or say a question. Nothing runs until you say yes.</div>
              </>
            ) : <div className="mono small muted">{m.approval.asked ? 'You asked first. Nothing ran.' : m.approval.answer ? 'You said yes.' : 'You said no.'}</div>}
          </div>
        ) : m.role === 'system' ? (
          <div key={i} className={`msg sys${m.text.startsWith('🦴') || m.text.startsWith('🌙') ? ' bone' : ''}`}>{m.text}</div>
        ) : (
          <div key={i} className="msg from-ai">
            <div className="who">{aiName}{m.text && !(busy && i === items.length - 1) && <button className="copy" onClick={() => copy(i, m.text)}>{copied === i ? 'copied' : 'copy'}</button>}</div>
            {m.helpers && m.helpers.length > 0 && (
              <div className="steps helpers">
                {m.helpers.map((h) => (
                  <div key={h.id} className={`chip helper mono ${h.state}`} title={h.desc}>
                    <i className="dot" />{h.name}: {h.desc || 'working'}{h.state === 'running' ? ' …' : h.state === 'failed' ? ' (stopped)' : ''}
                  </div>
                ))}
              </div>
            )}
            {m.tools && m.tools.length > 0 && <Steps tools={m.tools} onOpen={onOpen} />}
            {m.text ? <Reply text={m.text} /> : busy && i === items.length - 1 ? <span className="typing" aria-label="Working"><i /><i /><i /></span> : null}
          </div>
        ))}
        {nudge && (
          <div className="msg sys bone long-nudge">
            <span>🦴 Long chat: {items.length} messages, and each new question re-reads them all. A fresh one is quicker and cheaper; this one stays under Chats.</span>
            <span className="row-btns">
              <button className="linkish" onClick={() => { setMenu(false); chat.onNew(); }}>Start fresh</button>
              <button className="linkish" onClick={() => setSnooze((s) => ({ ...s, [chat.current]: items.length + 20 }))}>Not now</button>
            </span>
          </div>
        )}
        <div ref={end} />
      </div>
      {(files.length > 0 || problem) && (
        <div className="attach-tray">
          {files.map((f) => (
            <span key={f.path} className="attach">
              {f.preview ? <img src={f.preview} alt="" /> : <Icon name="file" size={14} />}
              <span className="mono">{f.name}</span>
              <button onClick={() => unattach(f.path)} aria-label={`Remove ${f.name}`} title="Remove">×</button>
            </span>
          ))}
          {problem && <span className="attach-problem mono">{problem}</span>}
        </div>
      )}
      <div className={`inputbar ${recording ? 'hearing' : ''} ${over ? 'drop' : ''}`}>
        {mic && (
          <button className={`mic ${recording ? 'live' : ''}`} aria-label="Hold to talk" title="Hold to talk (or hold Space)"
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); mic.hold(true); }}
            onPointerUp={() => mic.hold(false)} onPointerCancel={() => mic.hold(false)} onContextMenu={(e) => e.preventDefault()}>
            <Icon name="mic" />
          </button>
        )}
        <button className="clip" aria-label="Attach a file" title="Attach a file or photo" onClick={() => picker.current?.click()}><Icon name="clip" /></button>
        <input ref={picker} type="file" multiple hidden onChange={(e) => { const l = Array.from(e.target.files || []); e.target.value = ''; if (l.length) addFiles(l); }} />
        <label htmlFor="ask" className="sr">Message the assistant</label>
        <textarea id="ask" ref={box} rows={1} value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => { const pasted = Array.from(e.clipboardData.files); if (pasted.length) { e.preventDefault(); addFiles(pasted); } }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder={over ? 'Drop it here…' : recording ? 'Listening…' : mic?.phase === 'transcribing' ? 'Catching that…' : asking != null ? 'Ask about it before you decide…' : busy ? 'Working on it…' : 'Ask, or drop a file…'} />
        {asking != null && draft.trim()
          ? <button className="send" onClick={submit} aria-label="Ask about this" title="Ask (Enter)"><Icon name="up" size={16} /></button>
          : busy
          ? <button className="send stop" onClick={onStop} aria-label="Stop" title="Stop"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="3" /></svg></button>
          : <button className="send" onClick={submit} disabled={(!draft.trim() && !files.length) || !!setupNeeded} aria-label="Send" title="Send (Enter)"><Icon name="up" size={16} /></button>}
      </div>
    </section>
  );
}
