import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { ChatSummary } from '../types';
import Icon from '../icons';
import { Listener, type Phase } from '../listen';

// A file dropped, pasted or picked into the chat: saved by the app, so Agentic OS can read it from `path`.
export interface Attached { name: string; path: string; preview?: string }

export interface ChatItem {
  role: 'you' | 'assistant' | 'system' | 'approval';
  text: string;
  files?: { name: string; preview?: string }[];
  tools?: { name: string; label: string; path: string | null }[];
  plan?: { content: string; status: 'pending' | 'in_progress' | 'completed' }[]; // the job's steps (TodoWrite), shown in the tracker
  now?: string; t0?: number; t1?: number; // latest action, start and end time of this reply
  helpers?: { id: string; name: string; desc: string; state: 'running' | 'done' | 'failed'; last?: string }[]; // subagents Agentic OS handed work to
  activeTools?: { id: string; name: string; icon: string | null; color: string }[]; // registered Tools (Connectors & Tools) used this turn
  approval?: { id: number; risky: boolean; canAll: boolean; what?: string; answer?: boolean; all?: boolean; asked?: string; helper?: boolean };
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// Agentic OS writes markdown (bold, bullets, links). Show it formatted rather than as raw ** and -.
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

// What Agentic OS did on the way to an answer. The last few steps show; the rest fold away so a long job stays readable.
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

// Progress above the input box: the job's step list (when Agentic OS made one), what it is doing now, and each helper's own latest step.
function Tracker({ m, busy }: { m: ChatItem; busy: boolean }) {
  const [picked, setOpen] = useState<boolean | null>(null); // null until the user clicks: then open by itself while a job with steps runs
  const [, tick] = useState(0);
  useEffect(() => { if (!busy) return; const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id); }, [busy]);
  const plan = m.plan || [];
  const open = picked ?? (busy && plan.length > 0);
  const helpers = m.helpers || [];
  const done = plan.filter((p) => p.status === 'completed').length;
  const secs = m.t0 ? Math.max(0, Math.round(((m.t1 || Date.now()) - m.t0) / 1000)) : 0;
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const running = helpers.filter((h) => h.state === 'running').length;
  const activeIdx = plan.findIndex((p) => p.status === 'in_progress');
  const title = busy ? (plan.length ? plan[activeIdx]?.content || 'Working…' : 'Working…') : plan.length ? `Done · ${plan.length} step${plan.length === 1 ? '' : 's'}` : 'Done';
  const pct = plan.length ? (done / plan.length) * 100 : busy ? 0 : 100;
  const subs = (
    <div className="trk-sub">
      {helpers.map((h) => (
        <div key={h.id} className={`trk-ag ${h.state}`}>
          <i className="trk-dot" /><span className="trk-agname">{h.name}: {h.desc || 'working'}</span>
          <span className="trk-agtool mono">{h.state === 'running' ? h.last || 'starting…' : h.state === 'failed' ? 'stopped' : 'done'}</span>
        </div>
      ))}
    </div>
  );
  return (
    <div className={`trk${open ? ' open' : ''}${busy ? ' busy' : ''}`}>
      <button className="trk-top" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'Hide the steps' : 'Show the steps'}>
        <span className="trk-chev" aria-hidden>▾</span>
        <span className="trk-title">{title}</span>
        <span className="trk-count mono">{plan.length ? (busy && done < plan.length ? `Step ${(activeIdx >= 0 ? activeIdx : done) + 1}/${plan.length}` : `${done} of ${plan.length}`) : running ? `${running} helper${running === 1 ? '' : 's'}` : ''}{busy || m.t1 ? `${plan.length || running ? ' · ' : ''}${clock}` : ''}</span>
      </button>
      <div className={`trk-bar${busy && !plan.length ? ' indet' : ''}`}><i style={{ width: `${pct}%` }} /></div>
      {busy && m.now && <div className="trk-now mono">{m.now}</div>}
      {open && (
        <div className="trk-steps">
          {plan.map((p, i) => (
            <div key={i} className={`trk-st ${p.status}`}>
              <i className="trk-dot" /><div><div className="trk-t">{p.content}</div>{i === activeIdx && helpers.length > 0 && subs}</div>
            </div>
          ))}
          {(activeIdx < 0 || !plan.length) && helpers.length > 0 && subs}
          {!plan.length && helpers.length === 0 && <div className="trk-note">No step list for this one. The line above is what Agentic OS is doing right now.</div>}
        </div>
      )}
    </div>
  );
}

const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Up late' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening'; };
const STARTERS = ['What did I work on this week?', 'Which projects have gone quiet?', 'What should I pick up next?'];

// The model picker by the input box: Auto lets Agentic OS choose (cheapest that fits); a named model is used for every question in the chat.
export interface ModelPick { model: string | null; effort: string | null }
const FALLBACK_MODELS: { id: string | null; name: string; note: string; unavailable?: boolean }[] = [
  { id: null, name: 'Auto', note: 'Agentic OS picks the cheapest that fits' },
  { id: 'haiku', name: 'Haiku', note: 'Quick lookups, cheapest' },
  { id: 'sonnet', name: 'Sonnet', note: 'Everyday work' },
  { id: 'opus', name: 'Opus', note: 'Harder tasks and code' },
  { id: 'fable', name: 'Fable', note: 'The strongest, costliest' },
];
const EFFORTS: { id: string | null; name: string }[] = [{ id: null, name: 'Default' }, { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }];

export default function Chat({ items, busy, ready, name, onSend, onStop, onOpen, onApprove, asking, onAsk, chat, setupNeeded, lead, onMinimise, pick, onPick, choices }: {
  items: ChatItem[]; busy: boolean; ready: boolean; name: string;
  onSend(text: string, voice?: boolean, files?: Attached[]): void; onStop(): void; onOpen(path: string): void;
  onApprove(id: number, yes: boolean, all?: boolean): void;
  asking: number | null; // approval Agentic OS is waiting on: typing now asks it about it instead
  onAsk(id: number, question: string): void;
  // live: what each chat in memory is doing (several run at once); unsaved: chats not on disk yet (still on their first reply)
  chat: { current: string; onNew(): void; onOpen(id: string): void; onForget(id: string): void; live: Record<string, { busy: boolean; needs: boolean; unread: boolean }>; unsaved: ChatSummary[] };
  pick: ModelPick; onPick(p: ModelPick): void; // the model picker; per chat
  choices?: { id: string | null; name: string; note: string; unavailable?: boolean }[]; // what the picker offers (from the engine: depends on the gateway)
  onMinimise?(): void; // tuck the chat away to a strip on the left
  setupNeeded?: string; // the brain isn't usable yet: say why instead of taking questions
  lead?: React.ReactNode; // shown at the start of the chat's top row (look B puts the orb's one-line status there)
}) {
  const [draft, setDraft] = useState('');
  const [pickOpen, setPickOpen] = useState(false);
  const pickRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickOpen) return;
    const away = (e: MouseEvent) => { if (!pickRef.current?.contains(e.target as Node)) setPickOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [pickOpen]);
  // the list can arrive after the first look (the gateway is asked once it is running), so it is fetched again when the menu opens
  const [fresh, setFresh] = useState<typeof FALLBACK_MODELS | null>(null);
  useEffect(() => { if (pickOpen) window.aos.brain.refreshModels().then(setFresh).catch(() => {}); }, [pickOpen]);
  const MODELS = fresh && fresh.length > 1 ? fresh : choices && choices.length ? choices : FALLBACK_MODELS;
  // a model chosen earlier that this account does not offer (a saved chat, or the settings changed) goes back to Auto
  // Through a gateway any typed name is allowed, so only a direct account falls back to Auto here.
  const gatewayPick = !!pick.model && !FALLBACK_MODELS.some((m) => m.id === pick.model);
  useEffect(() => { if (pick.model && !gatewayPick && !MODELS.some((m) => m.id === pick.model)) onPick({ ...pick, model: null }); }, [pick.model, choices]); // eslint-disable-line react-hooks/exhaustive-deps
  const shorten = (n: string) => (n.length > 30 ? `…${n.slice(-28)}` : n); // a typed name can be a long profile ARN
  const pickName = MODELS.find((m) => m.id === pick.model)?.name || (pick.model ? shorten(pick.model) : 'Auto');
  const [typed, setTyped] = useState('');
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
  // Press to talk: hold Space (when not typing, or the box is empty) or hold the mic button. Words from the
  // Windows speech engine are added to the box to check before sending.
  const [phase, setPhase] = useState<Phase>('off');
  const [micError, setMicError] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const ear = useRef<Listener | null>(null);
  const getEar = () => {
    if (!ear.current) {
      const l = new Listener();
      l.onPhase = setPhase;
      l.onError = setMicError;
      l.onText = (t) => { setMicError(''); setDraft((d) => (d && !/s$/.test(d) ? d + ' ' : d) + t); box.current?.focus(); };
      ear.current = l;
    }
    return ear.current;
  };
  // On a Mac, speech to text needs whisper.cpp added to tools/whisper; until it is there the mic button and Space-to-talk stay off.
  const [canTalk, setCanTalk] = useState(true);
  useEffect(() => { window.aos.stt.status().then((s) => setCanTalk(!!s.available)).catch(() => setCanTalk(false)); }, []);
  const talkOk = useRef(true); talkOk.current = canTalk;
  const talk = (down: boolean) => { if (!talkOk.current) return; if (down) setMicError(''); getEar().pushToTalk(down); };
  useEffect(() => {
    const editable = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); };
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.tagName === 'BUTTON') return;
      if (editable(e.target) && !(el?.id === 'ask' && !draftRef.current)) return; // typing: Space stays a space
      e.preventDefault();
      if (!e.repeat) talk(true);
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space' && ear.current?.phase === 'recording') { e.preventDefault(); talk(false); } };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);
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

  return (
    <section className={`chat${items.length === 0 ? ' empty' : ''}`} {...dropOn}>
      <div className="chat-head">
        {lead ?? <span className="lbl">Chat</span>}
        <span className="title" title={title}>{title}</span>
        <button ref={btnRef} className={`pill chats-btn${menu ? ' on' : ''}`} onClick={toggleMenu} aria-expanded={menu} title="Past chats: click one to flip back to it">
          Chats{elsewhere.length > 0 && <b className={`chats-badge${elsewhere.some(([, c]) => c.needs) ? ' needs' : ''}`}>{elsewhere.length}</b>} <span aria-hidden>▾</span>
        </button>
        <button className={`pill newchat${long ? ' long' : ''}`} onClick={() => { setMenu(false); chat.onNew(); }}
          title={long ? 'This chat is getting long. A fresh one keeps answers quick and cheap.' : 'Start a fresh conversation. This one is saved under Chats.'}>
          + New
        </button>
        {onMinimise && <button className="pill chat-min-btn" onClick={() => { setMenu(false); onMinimise(); }} title="Tuck the chat away. The Chat strip on the left brings it back.">Hide chat</button>}
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
              <p>Ask a question about your notes. You can type, talk, or drop a file here.</p>
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
            <div className="who">{m.approval.helper ? (m.approval.risky ? 'A helper wants to do something risky' : 'A helper wants to') : m.approval.risky ? 'Agentic OS wants to do something risky' : 'Agentic OS wants to'}</div>
            {m.approval.what && <p className="approval-what">{m.approval.what}</p>}
            <p className="mono approval-cmd">{m.text}</p>
            {m.approval.answer === undefined ? (
              <>
                <div className="row-btns">
                  <button className="yes" onClick={() => onApprove(m.approval!.id, true)}>Yes</button>
                  {m.approval.canAll && <button className="yes all" onClick={() => onApprove(m.approval!.id, true, true)}>Yes to all edits</button>}
                  <button className="ghost" onClick={() => onApprove(m.approval!.id, false)}>No</button>
                  <button className="ghost" onClick={() => box.current?.focus()}>Ask first</button>
                </div>
                <div className="mono small muted ask-hint">Not sure? Type or say a question. Nothing runs until you say yes.</div>
              </>
            ) : <div className="mono small muted">{m.approval.asked ? 'You asked first. Nothing ran.' : m.approval.answer ? (m.approval.all ? 'You said yes to all edits.' : 'You said yes.') : 'You said no.'}</div>}
          </div>
        ) : m.role === 'system' ? (
          <div key={i} className={`msg sys${m.text.startsWith('🌙') ? ' note' : ''}`}>{m.text}</div>
        ) : (
          <div key={i} className="msg from-assistant">
            <div className="who">Agentic OS{m.text && !(busy && i === items.length - 1) && <button className="copy" onClick={() => copy(i, m.text)}>{copied === i ? 'copied' : 'copy'}</button>}</div>
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
            {m.activeTools && m.activeTools.length > 0 && (
              <div className="steps" style={{ marginBottom: 8 }}>
                {m.activeTools.map((t) => <span key={t.id} className="pill busy" style={{ ['--acc' as string]: t.color }}>{t.name}</span>)}
              </div>
            )}
            {m.text ? <Reply text={m.text} /> : busy && i === items.length - 1 ? <span className="typing" aria-label="Agentic OS is working"><i /><i /><i /></span> : null}
          </div>
        ))}
        {nudge && (
          <div className="msg sys note long-nudge">
            <span>Long chat: {items.length} messages, and each new question re-reads them all. A fresh one is quicker and cheaper; this one stays under Chats.</span>
            <span className="row-btns">
              <button className="linkish" onClick={() => { setMenu(false); chat.onNew(); }}>Start fresh</button>
              <button className="linkish" onClick={() => setSnooze((s) => ({ ...s, [chat.current]: items.length + 20 }))}>Not now</button>
            </span>
          </div>
        )}
        <div ref={end} />
      </div>
      {(() => {
        const last = items[items.length - 1];
        const a = last && last.role === 'assistant' ? last : null; // the tracker belongs to the newest reply
        return a && a.t0 && (busy || a.plan?.length || a.helpers?.length) ? <Tracker m={a} busy={busy} /> : null;
      })()}
      {(files.length > 0 || problem || micError) && (
        <div className="attach-tray">
          {files.map((f) => (
            <span key={f.path} className="attach">
              {f.preview ? <img src={f.preview} alt="" /> : <Icon name="file" size={14} />}
              <span className="mono">{f.name}</span>
              <button onClick={() => unattach(f.path)} aria-label={`Remove ${f.name}`} title="Remove">×</button>
            </span>
          ))}
          {micError && <span className="attach-problem mono">{micError}</span>}
          {problem && <span className="attach-problem mono">{problem}</span>}
        </div>
      )}
      <div className={`inputbar${over ? ' drop' : ''}`}>
        <button className="clip" aria-label="Attach a file" title="Attach a file or photo" onClick={() => picker.current?.click()}><Icon name="clip" /></button>
        <input ref={picker} type="file" multiple hidden onChange={(e) => { const l = Array.from(e.target.files || []); e.target.value = ''; if (l.length) addFiles(l); }} />
        {canTalk && <button className={`mic${phase === 'recording' ? ' live' : ''}`} aria-label="Hold to talk" title="Hold to talk (or hold Space)" onPointerDown={(e) => { e.preventDefault(); talk(true); }} onPointerUp={() => talk(false)} onPointerLeave={() => ear.current?.phase === 'recording' && talk(false)} disabled={phase === 'transcribing'}><Icon name="mic" size={16} /></button>}
        <label htmlFor="ask" className="sr">Message Agentic OS</label>
        <textarea id="ask" ref={box} rows={1} value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => { const pasted = Array.from(e.clipboardData.files); if (pasted.length) { e.preventDefault(); addFiles(pasted); } }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder={phase === 'recording' ? 'Listening… let go to finish' : phase === 'transcribing' ? 'Writing that down…' : over ? 'Drop it here…' : asking != null ? 'Ask about it before you decide…' : busy ? 'Agentic OS is on it…' : 'Ask Agentic OS…'} />
        {asking != null && draft.trim()
          ? <button className="send" onClick={submit} aria-label="Ask Agentic OS about this" title="Ask (Enter)"><Icon name="up" size={16} /></button>
          : busy
          ? <button className="send stop" onClick={onStop} aria-label="Stop Agentic OS" title="Stop"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="3" /></svg></button>
          : <button className="send" onClick={submit} disabled={(!draft.trim() && !files.length) || !!setupNeeded} aria-label="Send" title="Send (Enter)"><Icon name="up" size={16} /></button>}
      </div>
      <div className="mpick-row">
        <div className="mpick" ref={pickRef}>
          <button className={`mpick-btn${pick.model ? ' pinned' : ''}`} onClick={() => setPickOpen(!pickOpen)} aria-haspopup="menu" aria-expanded={pickOpen}
            title={pick.model ? `You chose the model for this chat: ${pick.model}` : 'Agentic OS chooses the model. Click to choose one yourself.'}>
            {pickName}{pick.effort ? ` · ${EFFORTS.find((x) => x.id === pick.effort)?.name}` : ''}<span aria-hidden> ▾</span>
          </button>
          {pickOpen && (
            <div className="mpick-menu" role="menu">
              <div className="mpick-h">Model</div>
              {MODELS.map((m) => (
                <button key={m.name} role="menuitemradio" aria-checked={pick.model === m.id} className={`mpick-opt${pick.model === m.id ? ' on' : ''}${m.unavailable ? ' off' : ''}`} disabled={m.unavailable}
                  onClick={() => onPick({ ...pick, model: m.id })}><b>{m.name}</b><span>{m.note}</span></button>
              ))}
              <div className="mpick-h">Or type a model name</div>
              <input className="field mono" style={{ margin: '2px 0 4px', padding: '6px 9px', fontSize: 12.5 }} value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} placeholder="exact name, then Enter"
                onKeyDown={(e) => { if (e.key === 'Enter' && typed.trim()) { onPick({ ...pick, model: typed.trim() }); setTyped(''); setPickOpen(false); } }} />
              <div className="mpick-h">Effort</div>
              <div className="mpick-eff">
                {EFFORTS.map((x) => (
                  <button key={x.name} role="menuitemradio" aria-checked={pick.effort === x.id} className={pick.effort === x.id ? 'on' : ''} onClick={() => onPick({ ...pick, effort: x.id })}>{x.name}</button>
                ))}
              </div>
              <p className="mpick-fine">Applies to this chat from the next question. Pinning a model turns off the assistant's own switching.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
