import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionItem, Basics, OrbState, BrainEvent, BrainStatus, ChatSummary, DreamEvent, ProjectInfo, TreeNode } from './types';
import { os } from './aos';
import WindowButtons from './components/WindowButtons';
import { getTheme, setTheme } from './theme';
import Icon from './icons';
import Orb from './components/Orb';
import Chat, { type Attached, type ChatItem, type ModelPick } from './components/Chat';
import Viewer from './components/Viewer';
import { Rail, Tabs, ToolsSheet, type Tab, type Tool } from './components/Nav';
import Palette, { type Action } from './components/Palette';
import Onboarding from './components/Onboarding';
import Settings, { type Page as SettingsPage } from './components/Settings';
import Mail from './components/Mail';
import Projects from './components/Projects';
import Dreams from './components/Dreams';
import Connectors from './components/Connectors';
import Actions from './components/Actions';
import Notes from './components/Notes';

import Ring from './components/Ring';

// Several chats run at once. Each keeps its own messages, read trail, session and busy/approval state;
// the window shows one at a time and the others carry on in the background.
interface ChatState {
  items: ChatItem[]; read: string[]; wrote: string[];
  busy: boolean;
  sessionId: string | null;
  pick: ModelPick; // what the picker by the input box is set to for this chat
  unread: boolean; // finished, or needs an answer, while it was off screen
}
const blank = (): ChatState => ({ items: [], read: [], wrote: [], busy: false, sessionId: null, pick: { model: null, effort: null }, unread: false });
// The approval card a chat is waiting on, if any (the latest one: several helpers can ask at once).
const pendingIn = (xs: ChatItem[]) => { for (let i = xs.length - 1; i >= 0; i--) { const a = xs[i].approval; if (a && a.answer === undefined && a.id >= 0) return a.id; } return null; };
const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const hasYou = (s: ChatState) => s.items.some((x) => x.role === 'you');
const chatTitle = (xs: ChatItem[]) => {
  const first = xs.find((x) => x.role === 'you');
  return (first?.text || (first?.files?.length ? 'Attached files' : 'Chat')).replace(/\s+/g, ' ').slice(0, 70);
};
const ago = (iso: string | null) => {
  if (!iso) return '';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return Number.isNaN(d) ? '' : d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days`;
};
const agoMs = (ms: number) => {
  if (!ms) return '';
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days`;
};
const stored = (k: string, d: boolean) => { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch { return d; } };
const COL_MIN = 320;
const STAGE_MIN = 560; // the side list (228) and the room an open tool or the big map needs beside the chat (about 330)
const colMax = () => Math.max(COL_MIN, Math.min(900, Math.round(window.innerWidth * 0.6), window.innerWidth - STAGE_MIN));
const ASIDE_MIN = 260;
const asideMax = () => Math.max(ASIDE_MIN, Math.min(760, window.innerWidth - 228 - 420)); // the chat keeps at least 420 px
const storedNum = (k: string, min: number) => { try { const v = Number(localStorage.getItem(k)); return v >= min ? v : null; } catch { return null; } };
const store1 = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* private mode */ } };

export default function App() {
  const [basics, setBasics] = useState<Basics | null>(null);
  const [setup, setSetup] = useState(false); // the welcome steps are on screen
  const [brain, setBrain] = useState<BrainStatus | null>(null);
  const loadBrain = useCallback(() => window.aos.brain.status().then(setBrain).catch(() => {}), []);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [vaultRoot, setVaultRoot] = useState('');
  const [notes, setNotes] = useState(0);
  const [recent, setRecent] = useState<{ path: string; title: string; project: string; modified: number }[]>([]); // newest deliverables, any project
  const chatId = useRef('');
  if (!chatId.current) chatId.current = newId();
  const [currentChat, setCurrentChat] = useState(chatId.current);
  const [store, setStore] = useState<Record<string, ChatState>>(() => ({ [chatId.current]: blank() }));
  const storeRef = useRef(store); storeRef.current = store;
  const upd = useCallback((id: string, f: (s: ChatState) => Partial<ChatState>) =>
    setStore((st) => ({ ...st, [id]: { ...(st[id] ?? blank()), ...f(st[id] ?? blank()) } })), []);
  // The chat on screen. read = files the agent touched in it, in order; wrote = the subset that were edited or created (their links glow red).
  const cur = store[currentChat] ?? blank();
  const { items, read, wrote, busy } = cur;
  const pending = pendingIn(items);
  const setItems = useCallback((f: (xs: ChatItem[]) => ChatItem[]) => upd(chatId.current, (s) => ({ items: f(s.items) })), [upd]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  // Files opened one from another (note links) leave a trail so Back steps to the previous file; with no
  // trail left, Back closes the viewer. Everything goes through openRef so listeners set up once stay current.
  const [trail, setTrail] = useState<string[]>([]);
  const openRef = useRef<string | null>(null);
  const open = useCallback((p: string | null) => {
    const was = openRef.current;
    setTrail((t) => (p === null ? [] : was && was !== p ? [...t, was] : t));
    openRef.current = p;
    setOpenFile(p);
  }, []);
  const back = () => {
    const prev = trail[trail.length - 1];
    if (prev === undefined) { open(null); return; }
    setTrail((t) => t.slice(0, -1));
    openRef.current = prev;
    setOpenFile(prev);
  };
  // The tool on the stage, if any. A file opened from a tool sits on top of it, and closing that file goes back to the tool.
  const [tool, setTool] = useState<Tool | null>(null);
  const [settingsPage, setSettingsPage] = useState<SettingsPage | undefined>(undefined);
  // Skills, Value and Health are pages of Settings now; asking for one opens Settings on that page.
  const openTool = (t: Tool, page?: SettingsPage) => {
    open(null);
    if (t === 'skills' || t === 'value' || t === 'health') { setSettingsPage(t); setTool('settings'); return; }
    setSettingsPage(page); setTool(t);
  };
  const openToolRef = useRef(openTool); openToolRef.current = openTool; // for key handlers set up once
  const goHome = () => { open(null); setTool(null); };
  const [tab, setTab] = useState<Tab>('chat'); // small screens: which section is showing
  // The chat can be tucked away to a thin strip on the left, giving the right-hand panel the whole width.
  const [chatMin, setChatMinState] = useState(() => stored('aos-chat-min', false));
  const setChatMin = (v: boolean) => { setChatMinState(v); store1('aos-chat-min', v); };
  // The side list can fold to its icons, for more room.
  const [railSlim, setRailSlimState] = useState(() => stored('aos-rail-slim', false));
  const setRailSlim = (v: boolean) => { setRailSlimState(v); store1('aos-rail-slim', v); };
  // The line between the chat and the right-hand panel can be dragged. At home it sets the right column's width; with a
  // tool, a file or the big map open it sets the chat's width (the panel takes the rest). Double-click resets.
  const [colW, setColW] = useState<number | null>(() => storedNum('aos-col', COL_MIN)); // chat width with a panel open
  const [asideW, setAsideW] = useState<number | null>(() => storedNum('aos-aside', ASIDE_MIN)); // right column width at home
  const wideRef = useRef(false);
  const dragSplit = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const wide = wideRef.current;
    const colLeft = (document.querySelector('.os > .col') as HTMLElement | null)?.getBoundingClientRect().left ?? 0;
    document.body.classList.add('dragging-split');
    let w = 0;
    const move = (m: PointerEvent) => {
      if (wide) { w = Math.round(Math.max(COL_MIN, Math.min(colMax(), m.clientX - colLeft))); setColW(w); }
      else { w = Math.round(Math.max(ASIDE_MIN, Math.min(asideMax(), window.innerWidth - m.clientX))); setAsideW(w); }
    };
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      document.body.classList.remove('dragging-split');
      if (w) try { localStorage.setItem(wide ? 'aos-col' : 'aos-aside', String(w)); } catch { /* private mode */ }
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };
  const resetSplit = () => {
    const k = wideRef.current ? 'aos-col' : 'aos-aside';
    if (wideRef.current) setColW(null); else setAsideW(null);
    try { localStorage.removeItem(k); } catch { /* private mode */ }
  };
  // Arrow keys move the line too, so it can be resized without a mouse.
  const keySplit = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = (e.shiftKey ? 80 : 24) * (e.key === 'ArrowLeft' ? -1 : 1);
    // Start from the width already set (not the one on screen), so quick repeated presses add up before a redraw.
    const save = (k: string, w: number) => { try { localStorage.setItem(k, String(w)); } catch { /* private mode */ } return w; };
    if (wideRef.current) {
      const shown = (document.querySelector('.os > .col') as HTMLElement | null)?.getBoundingClientRect().width ?? COL_MIN;
      setColW((w) => save('aos-col', Math.round(Math.max(COL_MIN, Math.min(colMax(), (w ?? shown) + step)))));
    } else {
      const shown = (document.querySelector('.os > .stage') as HTMLElement | null)?.getBoundingClientRect().width ?? ASIDE_MIN;
      setAsideW((w) => save('aos-aside', Math.round(Math.max(ASIDE_MIN, Math.min(asideMax(), (w ?? shown) - step)))));
    }
  };
  const [palette, setPalette] = useState(false);
  // The home ring is rebuilt from scratch (new key) from Ctrl+K "Reload the ring".
  const [ringKey, setRingKey] = useState(0);
  // Words Agentic OS says after using a tool start a new paragraph, instead of running on from the line before.
  const gap = useRef<Record<string, boolean>>({});
  const [lastText, setLastText] = useState(0);
  // Dreams: open cards from the latest dream (dock badge, title-bar moon, home card) and when it ran.
  const [dream, setDream] = useState<{ unread: number; at: number | null; headline: string }>({ unread: 0, at: null, headline: '' });
  const loadDreams = useCallback(() => window.aos.dreams.state().then((s) => {
    const openCards = s.latest ? s.latest.cards.filter((c) => c.status === 'open') : [];
    setDream({ unread: openCards.length, at: s.latest ? s.latest.at : null, headline: openCards[0]?.headline || '' });
  }).catch(() => {}), []);
  // Open action items across every project (the dock badge on Actions). Re-read whenever the notes folder changes.
  const [openActs, setOpenActs] = useState(0);
  // Mail waiting on a reply (the dock badge on Mail). Re-read whenever the background check or a manual pull finishes.
  const [mailOpen, setMailOpen] = useState(0);
  useEffect(() => {
    const load = () => window.aos.mail.state().then((m) => setMailOpen(m.open.length)).catch(() => {});
    load();
    const off = window.aos.mail.onEvent((e) => { if (e.type === 'done' || e.type === 'error' || e.type === 'changed') load(); });
    const t = setInterval(load, 5 * 60 * 1000);
    return () => { off(); clearInterval(t); };
  }, []);
  const [actsList, setActsList] = useState<ActionItem[]>([]); // the first few open ones, for the side column
  const loadActs = useCallback(() => window.aos.actions.list().then((r) => { setOpenActs(r.open); setActsList(r.items.filter((x) => !x.done).slice(0, 3)); }).catch(() => {}), []);
  // Home is the chat with the notes map beside it. The map can be minimised for a chat-only view (stageMin); a tool or a file still opens beside the chat.
  const mapBig = true;
  const [stageMin, setStageMinState] = useState(() => stored('aos-stage-min', false));
  const setStageMin = (v: boolean) => { setStageMinState(v); store1('aos-stage-min', v); };
  const pendingRef = useRef<number | null>(null); // approval the chat on screen is waiting on
  const [allowEdits, setAllowEdits] = useState(false);
  const approve = (id: number, yes: boolean, all = false) => {
    if (yes && all) setAllowEdits(true);
    // approval ids are unique across chats, so find the card wherever it is
    setStore((st) => Object.fromEntries(Object.entries(st).map(([k, s]) => [k, s.items.some((x) => x.approval?.id === id)
      ? { ...s, items: s.items.map((x) => (x.approval?.id === id ? { ...x, approval: { ...x.approval, all: yes && all } } : x)) } : s])));
    return window.aos.brain.approve(id, yes, all);
  };
  const stopAllowEdits = () => { setAllowEdits(false); window.aos.brain.allowEdits(false); };
  // It wants to know more before saying yes or no. Nothing runs; Agentic OS explains, then asks again.
  const askAbout = (id: number, question: string) => {
    setItems((xs) => [...xs, { role: 'you', text: question }, { role: 'assistant', text: '', tools: [] }]);
    return window.aos.brain.approve(id, false, false, question);
  };
  // Agentic OS is text only at launch: no microphone, wake word or spoken answers (taken out 8 Oct 2026).
  const [now, setNow] = useState(Date.now());
  const [win, setWin] = useState({ full: false, max: false });
  const [linked, setLinked] = useState(true);

  const loadVault = useCallback(async () => {
    const [t, count] = await Promise.all([window.aos.vault.tree(), window.aos.vault.noteCount()]);
    setTree(t.children);
    setVaultRoot(t.root);
    setNotes(count); // one per note (the link graph is not needed for this, and is the dearest thing to build)
    // The newest few deliverables across every project, for the side column (instead of a file tree).
    window.aos.vault.projects().then((ps: ProjectInfo[]) => setRecent(ps
      .flatMap((p) => (p.deliverables || []).map((d) => ({ path: d.path, title: d.title || d.name.replace(/\.[a-z0-9]+$/i, '').replace(/^\d+[-_ ]*/, '').replace(/[-_]+/g, ' '), project: p.title, modified: d.modified })))
      .sort((a, b) => b.modified - a.modified).slice(0, 4))).catch(() => {});
  }, []);

  useEffect(() => {
    window.aos.setup.get().then((b) => { setBasics(b); setSetup(!b.onboarded); });
    loadVault();
    loadBrain();
    window.aos.voice.mute(true); // text only: the app never makes spoken answers, even if voice tools are on the PC
    loadActs();
    const off = window.aos.vault.onChanged((info) => {
      loadVault();
      loadActs();
      if (info.outside.length) {
        // One short line (file names only); a back-to-back note replaces the last one instead of stacking.
        const names = info.outside.slice(0, 2).map((p: string) => p.split(/[\\/]/).pop()).join(', ');
        const text = `Edited elsewhere: ${names}${info.outside.length > 2 ? ` +${info.outside.length - 2}` : ''}`;
        setItems((xs) => {
          const last = xs[xs.length - 1];
          const isNote = last && last.role === 'system' && last.text.startsWith('Edited elsewhere:');
          return [...(isNote ? xs.slice(0, -1) : xs), { role: 'system', text }];
        });
      }
    });
    // Dreams run on their own; they only ever show as one quiet cyan line, never a reply or a pause.
    loadDreams();
    const offDreams = window.aos.dreams.onEvent((e: DreamEvent) => {
      loadDreams();
      const text = e.phase === 'start' ? "🌙 Dreams: reading this week's chats..."
        : e.phase === 'done' ? (e.count ? `🌙 Dreams: ${e.count} new recommendation${e.count === 1 ? ' is' : 's are'} ready. Open Dreams from the dock or the moon.` : '🌙 Dreams: nothing worth your time tonight.')
        : e.phase === 'error' ? `🌙 Dreams couldn't run: ${e.message}` : null;
      if (text) setItems((xs) => {
        const last = xs[xs.length - 1];
        const swap = last && last.role === 'system' && last.text.startsWith('🌙');
        return [...(swap ? xs.slice(0, -1) : xs), { role: 'system', text }];
      });
    });
    const tick = setInterval(() => setNow(Date.now()), 1000);
    // In a normal window (not full screen) the title bar is the drag handle.
    const offWin = window.aos.window.onState(setWin);
    window.aos.window.state().then(setWin);
    const link = (e: Event) => setLinked(!!(e as CustomEvent).detail);
    window.addEventListener('aos-link', link);
    return () => { off(); offWin(); offDreams(); clearInterval(tick); window.removeEventListener('aos-link', link); };
  }, [loadVault, loadDreams, loadBrain, loadActs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.body.classList.toggle('windowed', !win.full); document.body.classList.toggle('fullscreen', win.full); }, [win.full]);
  useEffect(() => { document.body.classList.toggle('mac', os === 'mac'); }, []);

  // Brain events drive the chat, the read trail, and the assistant's state.
  const busyRef = useRef(false); // the chat on screen is working
  // Streamed text and tools go into the current reply bubble even when a system note has landed after it.
  // A question or an approval card ends the bubble, so text after a card starts a new one below it.
  const toReply = (xs: ChatItem[], f: (b: ChatItem) => ChatItem) => {
    const c = [...xs];
    for (let i = c.length - 1; i >= 0; i--) {
      if (c[i].role === 'assistant') { c[i] = f(c[i]); return c; }
      if (c[i].role !== 'system') break;
    }
    return [...c, f({ role: 'assistant', text: '', tools: [] })];
  };
  useEffect(() => window.aos.brain.onEvent((e: BrainEvent) => {
    if (e.type === 'brainChanged') { loadBrain(); return; }
    const cid = e.chat || chatId.current;
    if (e.type === 'limits' && !e.chat) return; // the launch check (usage meters are out until Bedrock costs are understood)
    if (!(cid in storeRef.current)) return; // a chat this screen doesn't have open (another screen's, or forgotten)
    const here = cid === chatId.current; // events from other chats land in their own chat, quietly
    const setIt = (f: (xs: ChatItem[]) => ChatItem[]) => upd(cid, (s) => ({ items: f(s.items) }));
    if (e.type === 'start') {
      if (here) busyRef.current = true;
      upd(cid, (s) => ({ busy: true, items: [...s.items, { role: 'assistant', text: '', tools: [], t0: Date.now() }] }));
    }
    if (e.type === 'text') {
      if (here) setLastText(Date.now());
      const brk = gap.current[cid]; gap.current[cid] = false;
      setIt((xs) => toReply(xs, (b) => ({ ...b, text: b.text + (brk && b.text && !/\s$/.test(b.text) ? '\n\n' : '') + e.text })));
    }
    if (e.type === 'tool') {
      gap.current[cid] = true;
      const label = e.path || String(e.input?.pattern ?? e.input?.command ?? e.input?.query ?? e.input?.url ?? '').slice(0, 60);
      // a helper's own steps light up the graph but stay off the chip list, which would drown in them
      if (!e.helper) setIt((xs) => toReply(xs, (b) => ({ ...b, now: `${e.name} ${label}`.trim(), tools: [...(b.tools || []), { name: e.name, label, path: e.path }] })));
      else if (e.parent) setIt((xs) => xs.map((x) => (x.helpers?.some((h) => h.id === e.parent) ? { ...x, helpers: (x.helpers || []).map((h) => (h.id === e.parent ? { ...h, last: `${e.name} ${label}`.trim() } : h)) } : x)));
      if (e.path) upd(cid, (s) => ({ read: [...s.read.filter((p) => p !== e.path), e.path!] }));
      if (e.path && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(e.name)) upd(cid, (s) => ({ wrote: s.wrote.includes(e.path!) ? s.wrote : [...s.wrote, e.path!] }));
    }
    if (e.type === 'plan') setIt((xs) => toReply(xs, (b) => ({ ...b, plan: e.todos })));
    if (e.type === 'toolActive') {
      setIt((xs) => toReply(xs, (b) => (b.activeTools || []).some((x) => x.id === e.id) ? b
        : { ...b, activeTools: [...(b.activeTools || []), { id: e.id, name: e.name, icon: e.icon, color: e.color }] }));
    }
    if (e.type === 'helper') {
      if (e.phase === 'start') setIt((xs) => toReply(xs, (b) => ({ ...b, helpers: [...(b.helpers || []), { id: e.id, name: e.name, desc: e.desc, state: 'running' as const }] })));
      else setIt((xs) => xs.map((x) => (x.helpers?.some((h) => h.id === e.id) ? { ...x, helpers: (x.helpers || []).map((h) => (h.id === e.id ? { ...h, state: e.ok ? 'done' as const : 'failed' as const } : h)) } : x)));
    }
    if (e.type === 'approval') {
      upd(cid, (s) => ({ unread: s.unread || !here, items: [...s.items, { role: 'approval', text: e.summary, approval: { id: e.id, risky: e.risky, canAll: e.canAll, what: e.what || undefined, helper: e.helper } }] }));
      if (here) pendingRef.current = e.id; // answered on the card
    }
    if (e.type === 'autoApproved') setIt((xs) => [...xs, { role: 'system', text: `Auto-approved: ${e.summary}` }]);
    if (e.type === 'approved') {
      if (here && pendingRef.current === e.id) pendingRef.current = null;
      setIt((xs) => xs.map((x) => (x.approval?.id === e.id ? { ...x, approval: { ...x.approval, answer: e.yes, asked: e.question || undefined } } : x)));
    }
    if (e.type === 'open' && here) open(e.path); // The assistant's open_file tool
    if (e.type === 'session') upd(cid, () => ({ sessionId: e.id }));
    if (e.type === 'error' || e.type === 'note') setIt((xs) => { const last = xs[xs.length - 1]; const swap = e.message.startsWith('Lessons pass') && last && last.role === 'system' && last.text.startsWith('Lessons pass'); return [...(swap ? xs.slice(0, -1) : xs), { role: 'system', text: e.message }]; });
    if (e.type === 'done') { if (here) busyRef.current = false; upd(cid, (s) => ({ busy: false, unread: s.unread || !here, items: s.items.map((x, i) => (i === s.items.length - 1 && x.role === 'assistant' && x.t0 && !x.t1 ? { ...x, t1: Date.now() } : x)) })); }
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const send = (text: string, _spoken = false, files: Attached[] = []) => {
    setTab('chat');
    setChatMin(false);
    setItems((xs) => [...xs, { role: 'you', text, files: files.map(({ name, preview }) => ({ name, preview })) }]);
    // the picker's choice is set on the engine right before the question, so it holds after a restart or a reopened chat too
    const p = storeRef.current[chatId.current]?.pick || { model: null, effort: null };
    syncPick(chatId.current, p).finally(() => window.aos.brain.send(text || 'Have a look at what I attached.', false, files.map((f) => f.path), chatId.current));
  };
  // Tells the engine what the picker is set to, and shows what it actually took (a name it cannot use falls back to Auto, and the button says so).
  const syncPick = (cid: string, p: { model: string | null; effort: string | null }) =>
    window.aos.brain.setPick(cid, p.model, p.effort)
      .then((r) => { if (r && (r.model !== p.model || r.effort !== p.effort)) upd(cid, () => ({ pick: { model: r.model, effort: r.effort } })); })
      .catch(() => {});
  const sendRef = useRef(send);
  sendRef.current = send;

  // Every chat is kept on disk (electron/chats.cjs) so it can be reopened from the Chats list.
  const savedRef = useRef(new Map<string, ChatItem[]>()); // what is already on disk, by items identity
  const savedBusy = useRef(new Map<string, boolean>()); // whether the copy on disk says the chat was replying
  const busySaved = useRef(new Map<string, number>()); // when each replying chat was last checkpointed
  const saveChat = (id: string, s: ChatState) => {
    if (!hasYou(s)) return; // nothing said yet (just system notes): not worth keeping
    window.aos.chats.save({ id, title: chatTitle(s.items), sessionId: s.sessionId, items: s.items, read: s.read, wrote: s.wrote, busy: s.busy, pick: s.pick });
    savedRef.current.set(id, s.items);
    savedBusy.current.set(id, s.busy);
  };
  // Save every chat when it changes: right away once a reply is done, and every few seconds while one is still streaming
  // (marked busy on disk, so a cut-off chat can be told from a finished one). A throttle, not a debounce.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveTimer.current) return;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const t = Date.now();
      for (const [id, s] of Object.entries(storeRef.current)) {
        if (savedRef.current.get(id) === s.items && savedBusy.current.get(id) === s.busy) continue;
        // a chat still replying is checkpointed at most every 10 s, so a crash or a closed app loses at most a few seconds
        if (s.busy && t - (busySaved.current.get(id) ?? 0) < 10000) continue;
        if (s.busy) busySaved.current.set(id, t);
        saveChat(id, s);
      }
    }, 600);
  }, [store]); // eslint-disable-line react-hooks/exhaustive-deps

  // On launch, chats a crash or a closed app cut off mid-reply are pointed out once, so nothing is lost quietly.
  useEffect(() => {
    window.aos.chats.list().then((xs) => {
      const cut = xs.filter((x) => x.interrupted);
      if (!cut.length) return;
      const names = cut.slice(0, 3).map((x) => '"' + x.title.slice(0, 50) + '"').join(', ');
      const who = cut.length === 1 ? 'a chat was' : `${cut.length} chats were`;
      setItems((ys) => [...ys, { role: 'system', text: `Agentic OS closed while ${who} mid-reply: ${names}${cut.length > 3 ? ' and more' : ''}. Open ${cut.length === 1 ? 'it' : 'them'} from Chats and say "carry on".` }]);
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Switching chats stops nothing: the one you leave keeps working in the background and the window shows the other.
  // Empty chats that were never used are dropped on the way.
  const keepers = (st: Record<string, ChatState>, keep: string) => Object.fromEntries(Object.entries(st).filter(([id, s]) => id === keep || s.busy || hasYou(s)));
  const show = (id: string) => {
    open(null); setLastText(0); setTab('chat'); setChatMin(false);
    chatId.current = id;
    setCurrentChat(id);
    setStore((st) => keepers({ ...st, [id]: { ...(st[id] ?? blank()), unread: false } }, id));
  };
  // New chat: a fresh session, so old history stops riding along on every question.
  const newChat = () => {
    if (!hasYou(cur) && !cur.busy) { setTab('chat'); return; } // already looking at a fresh one
    const id = newId();
    setStore((st) => ({ ...st, [id]: blank() }));
    show(id);
  };
  // Flip to another chat. One that is still in memory (maybe working) is shown live; an old one is read back from
  // disk and Agentic OS carries on that chat's session, history and all.
  const openChat = async (id: string) => {
    if (id === chatId.current) { setTab('chat'); return; }
    if (!storeRef.current[id]) {
      const c = await window.aos.chats.load(id);
      if (!c) return;
      // An approval that was never answered can't be answered now (that run is over); a helper that was running is over too.
      const xs = (c.items as ChatItem[]).map((x) => ({
        ...x,
        ...(x.approval ? { approval: { ...x.approval, id: -1, answer: x.approval.answer ?? false } } : {}),
        ...(x.helpers ? { helpers: x.helpers.map((h) => (h.state === 'running' ? { ...h, state: 'failed' as const } : h)) } : {}),
      }));
      // A chat that was cut off mid-reply (the app closed or crashed) says so, and is saved again at once without the busy mark.
      if (c.busy) xs.push({ role: 'system', text: 'This chat was cut off mid-reply when Agentic OS closed. Say "carry on" and it will pick up from here.' });
      else { savedRef.current.set(id, xs); savedBusy.current.set(id, false); }
      setStore((st) => ({ ...st, [id]: { ...blank(), items: xs, read: c.read || [], wrote: c.wrote || [], sessionId: c.sessionId, pick: c.pick || { model: null, effort: null } } }));
      await window.aos.brain.openChat(id, c.sessionId);
    }
    show(id);
  };
  const forgetChat = (id: string) => setStore((st) => { const { [id]: _gone, ...rest } = st; return rest; });

  // Chats other than the one on screen: what they're doing, for the title bar and the Chats list.
  const others = Object.entries(store).filter(([id, s]) => id !== currentChat && (s.busy || s.unread));
  const needYou = others.filter(([, s]) => pendingIn(s.items) != null);
  const live: Record<string, { busy: boolean; needs: boolean; unread: boolean }> = {};
  for (const [id, s] of Object.entries(store)) live[id] = { busy: s.busy, needs: pendingIn(s.items) != null, unread: s.unread };
  const unsaved: ChatSummary[] = Object.entries(store).filter(([, s]) => hasYou(s)).map(([id, s]) => ({ id, title: chatTitle(s.items), updated: Date.now(), count: s.items.length }));

  // Keyboard: Ctrl+Shift+A / N open Actions and Notes, Ctrl+K the search. (No microphone or Space-to-talk at launch.)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && /^[an]$/i.test(e.key)) { e.preventDefault(); openToolRef.current(e.key.toLowerCase() === 'a' ? 'actions' : 'notes'); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'p')) { e.preventDefault(); setPalette((p) => !p); return; }
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, []);

  // The assistant's state comes from what is happening, never from buttons: text streaming in is "replying".
  busyRef.current = busy;
  pendingRef.current = pending;

  const orbState: OrbState = now - lastText < 1500 ? 'replying' : busy ? 'thinking' : 'idle';
  const reading = busy ? read[read.length - 1] ?? null : null;
  const stateText = orbState === 'thinking' ? 'Thinking it over' : orbState === 'replying' ? 'Replying' : 'Ready';
  const sub = orbState === 'thinking' ? `${read.length} file${read.length === 1 ? '' : 's'} read` : '';

  const provider = brain?.provider;
  const setupNeeded = brain && !brain.onboarded ? 'Finish the welcome steps to connect me.' : brain && !brain.ready ? 'My brain is not ready. Open Settings, then Brain, and check the connection.' : undefined;
  const badges = { dreams: dream.unread, actions: openActs, mail: mailOpen };
  const pickTool = (t: Tool) => openTool(t);
  const actions: Action[] = [
    { id: 'new', label: 'New chat', icon: 'plus', run: newChat },
    { id: 'home', label: stageMin ? 'Show the notes map' : 'Hide the notes map (chat only)', icon: 'home', run: () => { goHome(); setStageMin(!stageMin); setTab('graph'); } },
    { id: 'graph', label: 'Reload the ring', icon: 'home', run: () => { goHome(); setStageMin(false); setRingKey((k) => k + 1); } },
    { id: 'theme', label: `Switch to ${getTheme() === 'dark' ? 'light' : 'dark'} mode`, icon: 'sun', run: () => setTheme(getTheme() === 'dark' ? 'light' : 'dark') },
    { id: 'chatmin', label: chatMin ? 'Show the chat' : 'Hide the chat', icon: 'chat', run: () => { if (!solo) setChatMin(!chatMin); } },
    { id: 'brain', label: 'Change the brain (AI and sign-in)', icon: 'brain', run: () => openTool('settings', 'brain') },
    ...(busy ? [{ id: 'stop', label: 'Stop Agentic OS', icon: 'power', run: () => { window.aos.brain.stop(chatId.current); } }] : []),
  ];
  const covered = !!(tool || openFile);
  const wide = covered;
  const solo = !covered && stageMin; // chat only: nothing open beside it
  const chatHidden = chatMin && !solo;
  wideRef.current = wide;
  if (!basics) return <div className="os"><div className="backdrop"><i /></div></div>;
  if (setup) return <Onboarding basics={basics} windowBtns={<WindowButtons max={win.max} />} onDone={() => { setSetup(false); window.aos.setup.get().then(setBasics); loadBrain(); loadVault(); }} />;

  const sizes: Record<string, string> = {};
  if (colW) sizes['--col'] = `clamp(${COL_MIN}px, ${colW}px, calc(100vw - ${STAGE_MIN}px))`;
  if (asideW) sizes['--aside'] = `${asideW}px`;
  const chatAttention = busy || pending != null;

  return (
    <div className={`os${covered ? ' has-pane' : ''}${mapBig && !covered ? ' map-big' : ''}${solo ? ' solo' : ''}${chatHidden ? ' chat-min' : ''}${railSlim ? ' rail-slim' : ''}`} data-tab={tab} style={sizes}>
      <div className="backdrop"><i /></div>

      <header className="bar">
        <button className="search-pill nodrag" onClick={() => setPalette(true)} aria-label="Search and commands" title={`Search files, chats and tools (${os === 'mac' ? 'Cmd' : 'Ctrl'}+K)`}><Icon name="search" size={15} /><span>Search or jump to…</span><kbd>{os === 'mac' ? '⌘ K' : 'Ctrl K'}</kbd></button>
        <span className={`now-state s-${orbState}`}><i aria-hidden />{stateText}</span>
        <span className="flex" />
        {others.length > 0 && (
          <button className={`pill other-chats ${needYou.length ? 'needs' : others.some(([, c]) => c.busy) ? 'busy' : ''}`} onClick={() => openChat((needYou[0] || others[0])[0])}
            title="Other chats are working, or have something for you. Click to go to one.">
            {needYou.length ? `${needYou.length} other chat${needYou.length === 1 ? '' : 's'} need${needYou.length === 1 ? 's' : ''} you` : `${others.filter(([, c]) => c.busy).length || others.length} other chat${(others.filter(([, c]) => c.busy).length || others.length) === 1 ? '' : 's'} ${others.some(([, c]) => c.busy) ? 'working' : 'done'}`}
          </button>
        )}
        {allowEdits && (
          <button className="pill auto" onClick={stopAllowEdits} title="Agentic OS is editing the notes without asking. Click to make it ask again.">Edits auto-approved <span aria-hidden>✕</span></button>
        )}
        {dream.at != null && (
          <button className="pill moon" onClick={() => openTool('dreams')} title="Open Dreams">
            ☾ <span>Dreamed {new Date(dream.at).toDateString() === new Date(now).toDateString() ? new Date(dream.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase() : new Date(dream.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
            {dream.unread > 0 && <b className="n">{dream.unread}</b>}
          </button>
        )}
        <span className="clock">{new Date(now).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
        {os !== 'mac' && <WindowButtons max={win.max} />}
      </header>

      <Rail tool={tool} onPick={pickTool} onHome={goHome} badges={badges} slim={railSlim} onSlim={setRailSlim}
        top={os === 'mac' ? <div className="side-mac"><WindowButtons max={win.max} /></div> : undefined}
        who={{
          name: basics.userName,
          ok: !!brain?.ready,
          line: !provider ? 'Not connected' : !brain?.ready ? `${provider.name}, not ready` : `${provider.name}, ${provider.method === 'subscription' ? 'Claude plan' : 'gateway or API key'}`,
          onClick: () => openTool('settings', 'brain'),
        }} />

      <aside className="col" aria-label="Chat">
        {/* Minimised: a slim strip with one button to bring the chat back. The chat itself stays mounted (draft kept). */}
        {chatHidden && (
          <button className="chat-strip" onClick={() => setChatMin(false)} title="Show the chat" aria-label="Show the chat">
            <Icon name="chat" size={18} /><span>Chat</span>{chatAttention && <i className={pending != null ? 'needs' : ''} aria-hidden />}
          </button>
        )}
        {solo && (
          <button className="map-strip" onClick={() => setStageMin(false)} title="Show the notes map beside the chat">Show notes map</button>
        )}
        <div className="col-inner" hidden={chatHidden}>
          <Chat lead={<Orb state={orbState} sub={sub} voice={null} wake={null} />}
            onMinimise={solo ? undefined : () => setChatMin(true)}
            choices={brain?.choices}
            pick={store[currentChat]?.pick || { model: null, effort: null }}
            onPick={(p) => { const cid = chatId.current; upd(cid, () => ({ pick: p })); syncPick(cid, p); }}
            items={items} busy={busy} ready={!!brain} name={basics.userName} onSend={send} onApprove={approve} onStop={() => window.aos.brain.stop(chatId.current)} onOpen={open}
            asking={pending} onAsk={askAbout} chat={{ current: currentChat, onNew: newChat, onOpen: openChat, onForget: forgetChat, live, unsaved }}
            setupNeeded={setupNeeded} />
        </div>
      </aside>

      {/* The right-hand panel. At home it is a quiet overview (the notes map, what Agentic OS is reading, the newest
          deliverables, open actions, last night's dream); a tool or a file takes it over and widens it, and the chat
          narrows beside it. The line on its left edge can be dragged (or moved with the arrow keys) to resize it. */}
      <main className={`stage${covered ? ' covered' : ''}`}>
        {!chatHidden && !solo && (
          <div className="split-grip" role="separator" aria-orientation="vertical" tabIndex={0}
            aria-label={wide ? 'Resize the chat and the panel. Arrow keys move it.' : 'Resize the side panel. Arrow keys move it.'}
            title="Drag to resize. Double-click to reset." onPointerDown={dragSplit} onDoubleClick={resetSplit} onKeyDown={keySplit}><i /></div>
        )}
        <div className="ov" aria-label="Overview">
          <section className="ov-sec ov-map">
            <h3><span>Your notes</span><em>{notes} in {vaultRoot.split(/[\\/]/).filter(Boolean).pop() || 'your folder'}</em>
              <button className="linkish" onClick={() => setStageMin(true)} title="Minimise the notes map for more chat space">Hide</button>
            </h3>
            <div className="gbox ring-box">
              <Ring key={ringKey} covered={covered} onOpen={open} onTool={openTool} />
            </div>
          </section>
          {read.length > 0 && (
            <section className="ov-sec ov-trail">
              <h3><span>{busy ? 'Reading now' : 'Read in this chat'}</span><em>{read.length}{wrote.length ? `, ${wrote.length} edited` : ''}</em></h3>
              <ul>{read.slice(-4).reverse().map((p) => (
                <li key={p} className={`${p === reading ? 'now' : ''} ${wrote.includes(p) ? 'wrote' : ''}`}><button onClick={() => open(p)} title={p}><i aria-hidden /><span>{p.split('/').pop()}</span></button></li>
              ))}</ul>
            </section>
          )}
          <section className="ov-sec ov-recent">
            <h3><span>Latest deliverables</span><button className="linkish" onClick={() => openTool('projects')}>All projects</button></h3>
            {recent.length === 0 ? <p className="ov-empty">Nothing yet. Files saved in a project&apos;s output folder show up here.</p> : (
              <ul>{recent.map((d) => (
                <li key={d.path}><button onClick={() => open(d.path)} title={d.path}><span><b>{d.title}</b><small>{d.project}</small></span><em>{agoMs(d.modified)}</em></button></li>
              ))}</ul>
            )}
          </section>
          <section className="ov-sec ov-acts">
            <h3><span>Open actions{openActs ? `, ${openActs}` : ''}</span><button className="linkish" onClick={() => openTool('actions')}>All</button></h3>
            {actsList.length === 0 ? <p className="ov-empty">Nothing open. Start a note with "action item:" to add one.</p> : (
              <ul>{actsList.map((a) => (
                <li key={a.file + a.raw}><button onClick={() => openTool('actions')} title={`${a.name}: ${a.text}`}><i aria-hidden /><span>{a.text}</span><em>{ago(a.added)}</em></button></li>
              ))}</ul>
            )}
          </section>
          {dream.headline && (
            <section className="ov-sec ov-dream">
              <h3><span>Last night</span>{dream.unread > 0 && <em>{dream.unread} new</em>}</h3>
              <button className="ov-note" onClick={() => openTool('dreams')}>{dream.headline}</button>
            </section>
          )}
        </div>
        {openFile && <Viewer path={openFile} onClose={() => open(null)} onBack={back} onOpen={open} />}
        {/* The tool stays mounted (just hidden) under an open file, so Back lands on the same project, scroll and search. */}
        {tool && (
          <div style={{ display: openFile ? 'none' : 'contents' }}>
            {tool === 'settings' && <Settings onClose={() => setTool(null)} start={settingsPage} onOpen={open} chatItems={items.length} onAsk={(t) => { setTool(null); if (!busyRef.current) sendRef.current(t); }} onSetup={() => { setTool(null); setSetup(true); }} />}
            {tool === 'mail' && <Mail onClose={() => setTool(null)} />}
            {tool === 'actions' && <Actions onClose={() => setTool(null)} onOpen={open} onNotes={() => openTool('notes')} onChanged={loadActs} />}
            {tool === 'notes' && <Notes onClose={() => setTool(null)} onOpen={open} onActions={() => openTool('actions')} onChanged={loadActs} />}
            {tool === 'projects' && <Projects onClose={() => setTool(null)} onOpen={open} />}
            {/* Do it: the card's action goes to Agentic OS as a normal message, so risky steps still ask first. */}
            {tool === 'dreams' && <Dreams onClose={() => { setTool(null); loadDreams(); }} busy={busy} onDo={(action) => { setTool(null); loadDreams(); newChat(); sendRef.current(action); }} />}
            {tool === 'connectors' && <Connectors onClose={() => setTool(null)} />}
          </div>
        )}
      </main>

      <ToolsSheet onPick={pickTool} badges={badges} />
      {/* Narrow windows: the Projects tab opens the Projects tool rather than a file tree. */}
      <Tabs tab={tab} onTab={(t) => { if (t === 'files') { setTab('files'); openTool('projects'); return; } if (t !== 'tools') { setTool(null); open(null); } setTab(t); }} badge={dream.unread} />
      {palette && <Palette tree={tree} actions={actions} onTool={pickTool} onFile={open} onChat={openChat} onAsk={(t) => { if (!busyRef.current) sendRef.current(t); }} onClose={() => setPalette(false)} />}
    </div>
  );
}
