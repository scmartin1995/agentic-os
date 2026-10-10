import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Basics, AssistantState, BrainEvent, BrainStatus, ChatSummary, DreamEvent, GraphData, TreeNode, UsageV2 } from './types';
import { onPhone, quiet } from './aos';
import { Voice } from './audio';
import { getTheme, setTheme, type Theme } from './theme';
import { getGraphShape, setGraphShape, type GraphShape } from './graphShape';
import { groupColor, LEGEND } from './colors';
import Icon from './icons';
import Assistant from './components/Assistant';
import Chat, { type Attached, type ChatItem } from './components/Chat';
import Files from './components/Files';
import Viewer from './components/Viewer';
import Charge from './components/Charge';
import { Rail, Tabs, ToolsSheet, type Tab, type Tool } from './components/Nav';
import Palette, { type Action } from './components/Palette';
import Onboarding from './components/Onboarding';
import Dashboard from './components/Dashboard';
import Settings from './components/Settings';
import Skills from './components/Skills';
import Projects from './components/Projects';
import Dreams from './components/Dreams';
import Health from './components/Health';
import Connectors from './components/Connectors';
import Actions from './components/Actions';
import Notes from './components/Notes';
import { Listener, type Phase } from './listen';

// The 3D graph is the heaviest thing in the app, so it loads on its own: straight away on a PC, and on a phone only
// if the Graph tab is opened.
const Graph = lazy(() => import('./components/Graph'));

// Several chats run at once. Each keeps its own messages, read trail, session and busy/approval state;
// the window shows one at a time and the others carry on in the background.
interface ChatState {
  items: ChatItem[]; read: string[]; wrote: string[];
  busy: boolean;
  sessionId: string | null;
  unread: boolean; // finished, or needs an answer, while it was off screen
}
const blank = (): ChatState => ({ items: [], read: [], wrote: [], busy: false, sessionId: null, unread: false });
// The approval card a chat is waiting on, if any (the latest one: several helpers can ask at once).
const pendingIn = (xs: ChatItem[]) => { for (let i = xs.length - 1; i >= 0; i--) { const a = xs[i].approval; if (a && a.answer === undefined && a.id >= 0) return a.id; } return null; };
const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const hasYou = (s: ChatState) => s.items.some((x) => x.role === 'you');
const chatTitle = (xs: ChatItem[]) => {
  const first = xs.find((x) => x.role === 'you');
  return (first?.text || (first?.files?.length ? 'Attached files' : 'Chat')).replace(/\s+/g, ' ').slice(0, 70);
};
const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const stored = (k: string, d: boolean) => { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch { return d; } };
const store1 = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* private mode */ } };
const COL_MIN = 320;
const STAGE_MIN = 740; // rail, gaps and the room the cards and file list need beside the chat
const colMax = () => Math.max(COL_MIN, Math.min(900, Math.round(window.innerWidth * 0.6), window.innerWidth - STAGE_MIN));
const storedCol = () => { try { const v = Number(localStorage.getItem('aos-col')); return v >= COL_MIN ? v : null; } catch { return null; } };

export default function App() {
  const [basics, setBasics] = useState<Basics | null>(null);
  const [setup, setSetup] = useState(false); // the welcome steps are on screen
  const [brain, setBrain] = useState<BrainStatus | null>(null);
  const loadBrain = useCallback(() => window.aos.brain.status().then(setBrain).catch(() => {}), []);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [graph, setGraph] = useState<GraphData>({ nodes: [], links: [] });
  const [vaultRoot, setVaultRoot] = useState('');
  const [notes, setNotes] = useState(0);
  const [usage, setUsage] = useState<UsageV2 | null>(null);
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
  const [viewerStamp, setViewerStamp] = useState(0);
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
  const [settingsPage, setSettingsPage] = useState<'look' | 'brain' | 'phone' | undefined>(undefined);
  const openTool = (t: Tool, page?: 'look' | 'brain' | 'phone') => { open(null); setSettingsPage(page); setTool(t); };
  const openToolRef = useRef(openTool); openToolRef.current = openTool; // for key handlers set up once
  const goHome = () => { open(null); setTool(null); };
  const [tab, setTab] = useState<Tab>('chat'); // small screens: which section is showing
  const [filesOn, setFilesOn] = useState(() => stored('aos-files', true));
  const [colW, setColW] = useState<number | null>(storedCol); // chat column width in px; null = the default
  const dragCol = (e: React.PointerEvent<HTMLDivElement>) => {
    const left = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().left;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let w = 0;
    const move = (m: PointerEvent) => { w = Math.round(Math.max(COL_MIN, Math.min(colMax(), m.clientX - left))); setColW(w); };
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      if (w) try { localStorage.setItem('aos-col', String(w)); } catch { /* private mode */ }
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };
  const resetCol = () => { setColW(null); try { localStorage.removeItem('aos-col'); } catch { /* private mode */ } };
  const [palette, setPalette] = useState(false);
  // The graph is rebuilt from scratch (new key) if the graphics card drops it, or from Ctrl+K "Reload the graph".
  const [graphKey, setGraphKey] = useState(0);
  const [graphNote, setGraphNote] = useState('');
  const graphLost = useCallback(() => {
    setGraphNote('The graph lost its drawing surface. Restarting it…');
    setTimeout(() => { setGraphKey((k) => k + 1); setGraphNote(''); }, 1500);
  }, []);
  // Words the assistant says after using a tool start a new paragraph, instead of running on from the line before.
  const gap = useRef<Record<string, boolean>>({});
  const [lastText, setLastText] = useState(0);
  // Theme and map shape: switched from the top bar and the map header, remembered on this PC.
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const switchTheme = (t: Theme) => { setTheme(t); setThemeState(t); };
  const [shape, setShape] = useState<GraphShape>(getGraphShape);
  useEffect(() => { const f = () => setShape(getGraphShape()); window.addEventListener('aos-graph-shape', f); return () => window.removeEventListener('aos-graph-shape', f); }, []);
  // Counts beside Projects and Skills in the nav, read again whenever the workspace changes.
  const [projectCount, setProjectCount] = useState(0);
  const [skillCount, setSkillCount] = useState(0);
  const loadCounts = useCallback(() => {
    window.aos.notes.projects().then((ps) => setProjectCount(ps.filter((p) => p !== 'Inbox').length)).catch(() => {});
    window.aos.vault.skills().then((s) => setSkillCount(s.groups.reduce((a, g) => a + g.skills.length, 0))).catch(() => {});
  }, []);
  // Dreams: open cards from the latest dream (dock badge, title-bar moon, home card) and when it ran.
  const [dream, setDream] = useState<{ unread: number; at: number | null; headline: string }>({ unread: 0, at: null, headline: '' });
  const loadDreams = useCallback(() => window.aos.dreams.state().then((s) => {
    const openCards = s.latest ? s.latest.cards.filter((c) => c.status === 'open') : [];
    setDream({ unread: openCards.length, at: s.latest ? s.latest.at : null, headline: openCards[0]?.headline || '' });
  }).catch(() => {}), []);
  // Open action items across every project (the dock badge on Actions). Re-read whenever the workspace changes.
  const [openActs, setOpenActs] = useState(0);
  const loadActs = useCallback(() => window.aos.actions.list().then((r) => setOpenActs(r.open)).catch(() => {}), []);
  const [speaking, setSpeaking] = useState(false);
  const [voiceOk, setVoiceOk] = useState(false);
  const [sttOk, setSttOk] = useState(false);
  const [phase, setPhase] = useState<Phase>('off');
  const pendingRef = useRef<number | null>(null); // approval the chat on screen is waiting on
  // The card shows the answer itself when the 'approved' event comes back (approval ids are unique across chats).
  const approve = (id: number, yes: boolean) => window.aos.brain.approve(id, yes);
  // He wants to know more before saying yes or no. Nothing runs; the assistant explains, then asks again.
  const askAbout = (id: number, question: string) => {
    setItems((xs) => [...xs, { role: 'you', text: question }, { role: 'assistant', text: '', tools: [] }]);
    return window.aos.brain.approve(id, false, question);
  };
  // Voice answers: wait until the assistant has finished asking out loud before opening the mic.
  const askPending = useRef(false);
  const askTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [wakeOn, setWakeOn] = useState(() => !onPhone && stored('aos-wake', true));
  const listener = useRef<Listener | null>(null);
  const [muted, setMuted] = useState(() => stored('aos-muted', false));

  // the assistant's voice: clips arrive per sentence and play back to back (audio.ts).
  const voice = useMemo(() => new Voice(), []);
  useEffect(() => { voice.onSpeaking = setSpeaking; }, [voice]);
  const hush = () => voice.hush();
  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    store1('aos-muted', m);
    window.aos.voice.mute(m);
    if (m) hush();
  };
  const [now, setNow] = useState(Date.now());
  const [win, setWin] = useState({ full: onPhone, max: false });
  const [linked, setLinked] = useState(true); // phone: is the PC reachable

  // The 3D graph is only handed new data when the set of notes or links changed. An edit inside a note (most
  // vault changes, and every edit the assistant makes) leaves it alone.
  const graphSig = useRef('');
  const loadVault = useCallback(async () => {
    const [t, g] = await Promise.all([window.aos.vault.tree(), window.aos.vault.graph()]);
    setTree(t.children);
    setVaultRoot(t.root);
    const sig = JSON.stringify([g.nodes.map((n) => [n.id, !!n.received]), g.links.map((l) => [l.source, l.target])]);
    if (sig !== graphSig.current) { graphSig.current = sig; setGraph(g); }
    setNotes(g.nodes.length); // one node per note
  }, []);

  useEffect(() => {
    window.aos.setup.get().then((b) => { setBasics(b); setSetup(!b.onboarded && !onPhone); });
    loadVault();
    loadBrain();
    window.aos.usage.get().then(setUsage);
    window.aos.voice.status().then((v) => setVoiceOk(v.available));
    window.aos.voice.mute(muted);
    loadActs();
    loadCounts();
    const off = window.aos.vault.onChanged((info) => {
      loadVault();
      loadActs();
      loadCounts();
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
    // The nightly review runs on its own; it only ever shows as one quiet line, never a reply or a pause.
    loadDreams();
    const offDreams = window.aos.dreams.onEvent((e: DreamEvent) => {
      loadDreams();
      const text = e.phase === 'start' ? 'Nightly review: reading this week\'s chats...'
        : e.phase === 'done' ? (e.count ? `Nightly review: ${e.count} new suggestion${e.count === 1 ? ' is' : 's are'} ready. Open Nightly review from the nav.` : 'Nightly review: nothing worth your time tonight.')
        : e.phase === 'error' ? `The nightly review couldn't run: ${e.message}` : null;
      if (text) setItems((xs) => {
        const last = xs[xs.length - 1];
        const swap = last && last.role === 'system' && /^(Nightly review|The nightly review)/.test(last.text);
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
  }, [loadVault, loadDreams, loadBrain, loadActs, loadCounts]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.body.classList.toggle('windowed', !win.full && !onPhone); document.body.classList.toggle('fullscreen', win.full && !onPhone); document.body.classList.toggle('phone', onPhone); }, [win.full]);

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
    if (e.type === 'brainChanged') { loadBrain(); window.aos.usage.get().then(setUsage); return; }
    const cid = e.chat || chatId.current;
    if (e.type === 'limits' && !e.chat) { window.aos.usage.get().then(setUsage); return; } // the launch check
    if (!(cid in storeRef.current)) return; // a chat this screen doesn't have open (another screen's, or forgotten)
    const here = cid === chatId.current; // events from other chats land in their own chat, quietly
    const setIt = (f: (xs: ChatItem[]) => ChatItem[]) => upd(cid, (s) => ({ items: f(s.items) }));
    if (e.type === 'start') {
      if (here) { hush(); busyRef.current = true; }
      upd(cid, (s) => ({ busy: true, items: [...s.items, { role: 'assistant', text: '', tools: [] }] }));
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
      if (!e.helper) setIt((xs) => toReply(xs, (b) => ({ ...b, tools: [...(b.tools || []), { name: e.name, label, path: e.path }] })));
      if (e.path) upd(cid, (s) => ({ read: [...s.read.filter((p) => p !== e.path), e.path!] }));
      if (e.path && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(e.name)) upd(cid, (s) => ({ wrote: s.wrote.includes(e.path!) ? s.wrote : [...s.wrote, e.path!] }));
    }
    if (e.type === 'helper') {
      if (e.phase === 'start') setIt((xs) => toReply(xs, (b) => ({ ...b, helpers: [...(b.helpers || []), { id: e.id, name: e.name, desc: e.desc, state: 'running' as const }] })));
      else setIt((xs) => xs.map((x) => (x.helpers?.some((h) => h.id === e.id) ? { ...x, helpers: (x.helpers || []).map((h) => (h.id === e.id ? { ...h, state: e.ok ? 'done' as const : 'failed' as const } : h)) } : x)));
    }
    if (e.type === 'audio' && here && !mutedRef.current) voice.add(e.seq, e.data);
    if (e.type === 'approval') {
      upd(cid, (s) => ({ unread: s.unread || !here, items: [...s.items, { role: 'approval', text: e.summary, approval: { id: e.id, risky: e.risky, what: e.what || undefined, helper: e.helper } }] }));
      if (here) {
        pendingRef.current = e.id;
        if (!byVoice.current) {
          // typed question: answer on the card, no mic
        } else if (voiceOkRef.current && !mutedRef.current) {
          askPending.current = true; // the speech-ended effect opens the mic
          if (askTimer.current) clearTimeout(askTimer.current);
          askTimer.current = setTimeout(() => { if (askPending.current) { askPending.current = false; listener.current?.listenNow(); } }, 9000); // if their voice never plays
        } else {
          listener.current?.listenNow();
        }
      }
    }
    if (e.type === 'approved') {
      if (here && pendingRef.current === e.id) pendingRef.current = null;
      setIt((xs) => xs.map((x) => (x.approval?.id === e.id ? { ...x, approval: { ...x.approval, answer: e.yes, asked: e.question || undefined } } : x)));
    }
    if (e.type === 'open' && here) { open(e.path); setViewerStamp((n) => n + 1); } // the assistant's open_file tool; the stamp makes the viewer re-read a file that is already showing
    if (e.type === 'session') upd(cid, () => ({ sessionId: e.id }));
    if (e.type === 'error' || e.type === 'note') setIt((xs) => { const last = xs[xs.length - 1]; const swap = false; return [...(swap ? xs.slice(0, -1) : xs), { role: 'system', text: e.message }]; });
    if (e.type === 'result' || e.type === 'limits') window.aos.usage.get().then(setUsage);
    if (e.type === 'done') { if (here) busyRef.current = false; upd(cid, (s) => ({ busy: false, unread: s.unread || !here })); }
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Typed questions get typed follow-ups: the mic only reopens after a spoken one.
  const byVoice = useRef(false);
  const send = (text: string, spoken = false, files: Attached[] = []) => {
    byVoice.current = spoken;
    setTab('chat');
    setItems((xs) => [...xs, { role: 'you', text, files: files.map(({ name, preview }) => ({ name, preview })) }]);
    window.aos.brain.send(text || 'Have a look at what I attached.', spoken, files.map((f) => f.path), chatId.current);
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  // Every chat is kept on disk (electron/chats.cjs) so it can be reopened from the Chats list.
  const savedRef = useRef(new Map<string, ChatItem[]>()); // what is already on disk, by items identity
  const savedBusy = useRef(new Map<string, boolean>()); // whether the copy on disk says the chat was replying
  const busySaved = useRef(new Map<string, number>()); // when each replying chat was last checkpointed
  const saveChat = (id: string, s: ChatState) => {
    if (!hasYou(s)) return; // nothing said yet (just system notes): not worth keeping
    window.aos.chats.save({ id, title: chatTitle(s.items), sessionId: s.sessionId, items: s.items, read: s.read, wrote: s.wrote, busy: s.busy });
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
    if (onPhone) return; // the PC may simply still be working on them
    window.aos.chats.list().then((xs) => {
      const cut = xs.filter((x) => x.interrupted);
      if (!cut.length) return;
      const names = cut.slice(0, 3).map((x) => '"' + x.title.slice(0, 50) + '"').join(', ');
      const who = cut.length === 1 ? 'a chat was' : `${cut.length} chats were`;
      setItems((ys) => [...ys, { role: 'system', text: `The app closed while ${who} mid-reply: ${names}${cut.length > 3 ? ' and more' : ''}. Open ${cut.length === 1 ? 'it' : 'them'} from Chats and say "carry on".` }]);
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Switching chats stops nothing: the one you leave keeps working in the background and the window shows the other.
  // Empty chats that were never used are dropped on the way.
  const keepers = (st: Record<string, ChatState>, keep: string) => Object.fromEntries(Object.entries(st).filter(([id, s]) => id === keep || s.busy || hasYou(s)));
  const show = (id: string) => {
    hush();
    askPending.current = false;
    byVoice.current = false;
    open(null); setLastText(0); setTab('chat');
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
  // disk and the assistant carries on that chat's session, history and all.
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
      if (c.busy && !onPhone) xs.push({ role: 'system', text: 'This chat was cut off mid-reply when the app closed. Say "carry on" and the assistant will pick up from here.' });
      else { savedRef.current.set(id, xs); savedBusy.current.set(id, false); }
      setStore((st) => ({ ...st, [id]: { ...blank(), items: xs, read: c.read || [], wrote: c.wrote || [], sessionId: c.sessionId } }));
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

  // Microphone: "Hey the assistant" and push-to-talk (hold Space outside the text box, or hold the mic button).
  useEffect(() => {
    const l = new Listener();
    l.onPhase = setPhase;
    l.onText = (t) => {
      // While the assistant is waiting on a yes/no, a spoken answer goes to them, not as a new question.
      if (pendingRef.current != null) {
        const s = t.toLowerCase();
        const id = pendingRef.current;
        if (/\b(no|nope|nah|don'?t|stop|cancel|leave it|never mind|hold off)\b/.test(s)) approve(id, false);
        else if (/\b(yes|yeah|yep|yup|sure|go ahead|go for it|do it|okay|ok|please|fine|alright|right)\b/.test(s)) approve(id, true);
        else askAbout(id, t); // not a yes or no: treat it as a question about the action
        return;
      }
      if (!busyRef.current) sendRef.current(t, true);
    };
    l.onError = (m) => setItems((xs) => [...xs, { role: 'system', text: m }]);
    listener.current = l;
    window.aos.stt.status().then((s) => setSttOk(s.available));
    const typing = (e: KeyboardEvent) => { const t = e.target as HTMLElement; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); };
    const down = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'p')) { e.preventDefault(); setPalette((p) => !p); return; }
      // Ctrl+Shift+A: Action items. Ctrl+Shift+N: Notes.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && /^[an]$/i.test(e.key)) { e.preventDefault(); openToolRef.current(e.key.toLowerCase() === 'a' ? 'actions' : 'notes'); return; }
      if (e.code === 'Space' && !e.repeat && !typing(e) && !(e.target as HTMLElement)?.closest?.('button')) { e.preventDefault(); l.pushToTalk(true); }
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space' && !typing(e)) { l.pushToTalk(false); } };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // "Hey the assistant" starts listening once setup is finished (never during the welcome steps, or in a test capture).
  const wakeStarted = useRef(false);
  useEffect(() => {
    if (wakeStarted.current || !sttOk || !wakeOn || setup || !basics?.onboarded || quiet) return;
    wakeStarted.current = true;
    listener.current?.setWake(true);
  }, [sttOk, wakeOn, setup, basics]);

  // He can't wake themselves: ignore the wake word while they're working or talking.
  useEffect(() => { if (listener.current) listener.current.paused = (busy && pending == null) || speaking; }, [busy, speaking, pending]);

  // Conversation: when the assistant finishes a spoken answer, the mic reopens briefly for a reply.
  const wasSpeaking = useRef(false);
  useEffect(() => {
    const ended = wasSpeaking.current && !speaking;
    wasSpeaking.current = speaking;
    // He just finished asking for approval: listen for the answer now (wake word on or off).
    if (ended && pendingRef.current != null && askPending.current) {
      askPending.current = false;
      if (askTimer.current) clearTimeout(askTimer.current);
      setTimeout(() => listener.current?.listenNow(), 200);
      return;
    }
    if (ended && !busy && pending == null && wakeOn && !muted && phase === 'waiting' && byVoice.current) {
      setTimeout(() => { if (!busyRef.current && pendingRef.current == null) listener.current?.listenNow(true); }, 250);
    }
  }, [speaking, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleWake = () => {
    const on = !wakeOn;
    setWakeOn(on);
    store1('aos-wake', on);
    listener.current?.setWake(on);
  };

  // the assistant's state comes from what is happening, never from buttons.
  // "Talking" means audio is playing; text streaming in without audio is "replying".
  // refs so listener callbacks (set up once) see current values
  const itemsRef = useRef(items); itemsRef.current = items;
  busyRef.current = busy;
  pendingRef.current = pending;
  const voiceOkRef = useRef(voiceOk); voiceOkRef.current = voiceOk;
  const mutedRef = useRef(muted); mutedRef.current = muted;

  const assistant: AssistantState = phase === 'recording' ? 'listening' : speaking ? 'talking' : (muted || !voiceOk || !byVoice.current ? now - lastText < 1500 : false) ? 'replying' : busy ? 'thinking' : 'idle';
  const reading = busy ? read[read.length - 1] ?? null : null;
  const stateText = assistant === 'listening' ? 'Listening' : assistant === 'thinking' ? 'Thinking it over' : assistant === 'talking' ? 'Talking' : assistant === 'replying' ? 'Replying' : 'Ready';
  const sub = phase === 'transcribing' ? 'catching that…' : assistant === 'listening' ? (listener.current?.inFollowUp ? 'anything else?' : "go on, I'm listening") : assistant === 'thinking' ? `${read.length} file${read.length === 1 ? '' : 's'} read` : assistant === 'talking' ? 'answering you' : phase === 'waiting' ? "say 'hey computer', hold Space, or type" : phase === 'loading' ? 'warming up the ears…' : !sttOk ? 'type to talk to me' : onPhone ? 'hold the mic to talk, or type' : 'hold Space to talk, or type';
  // Live loudness for the stage: their voice while they talks, the microphone while they listens.
  const level = useCallback(() => (listener.current?.phase === 'recording' ? { level: listener.current.level, bins: null } : { level: voice.level(), bins: voice.spectrum() }), [voice]);

  const provider = brain?.provider;
  const provColor = ({ claude: '#d97757', openai: '#10a37f', gemini: '#4c8df6', antigravity: '#8b7cf6', local: '#a3a3a3', custom: '#c4b5fd' } as Record<string, string>)[provider?.id || 'claude'];
  const setupNeeded = brain && !brain.onboarded ? (onPhone ? 'The app has not been set up yet. Finish the welcome steps on the PC first.' : 'Finish the welcome steps to choose a brain.') : brain && !brain.ready ? 'My brain is not ready. Open Settings, then Brain, and pick a model.' : undefined;
  const badges = { dreams: dream.unread, actions: openActs };
  const counts = { projects: projectCount, skills: skillCount };
  const aiName = basics?.assistantName || 'Assistant';
  // The legend under the map: notes per top folder, in LEGEND's order, then everything else as Other.
  const legend = useMemo(() => {
    const by: Record<string, number> = {};
    for (const n of graph.nodes) by[n.group] = (by[n.group] || 0) + 1;
    const known = LEGEND.filter((l) => by[l.group]).map((l) => ({ ...l, n: by[l.group] }));
    const other = Object.entries(by).filter(([g]) => !LEGEND.some((l) => l.group === g)).reduce((a, [, n]) => a + n, 0);
    return other ? [...known, { group: 'other', label: 'Other', n: other }] : known;
  }, [graph]);
  const pickTool = (t: Tool) => openTool(t);
  const actions: Action[] = [
    { id: 'new', label: 'New chat', icon: 'plus', run: newChat },
    { id: 'home', label: 'Home: show the node map', icon: 'home', run: () => { goHome(); setTab('graph'); } },
    { id: 'graph', label: 'Redraw the node map', icon: 'home', run: () => { goHome(); setGraphKey((k) => k + 1); } },
    { id: 'theme', label: `Switch to ${getTheme() === 'dark' ? 'light' : 'dark'} mode`, icon: 'sun', run: () => switchTheme(getTheme() === 'dark' ? 'light' : 'dark') },
    { id: 'files', label: filesOn ? 'Hide the file tree' : 'Show the file tree', icon: 'files', run: () => { setFilesOn(!filesOn); store1('aos-files', !filesOn); } },
    ...(voiceOk ? [{ id: 'mute', label: muted ? 'Unmute spoken answers' : 'Mute spoken answers', icon: muted ? 'sound' : 'mute', run: toggleMute }] : []),
    ...(sttOk && !onPhone ? [{ id: 'wake', label: wakeOn ? 'Turn off "Hey computer"' : 'Turn on "Hey computer"', icon: 'ear', run: toggleWake }] : []),
    ...(!onPhone ? [{ id: 'brain', label: 'Change the brain (AI and sign-in)', icon: 'brain', run: () => openTool('settings', 'brain') }, { id: 'phone', label: 'Pair a phone', icon: 'phone', run: () => openTool('settings', 'phone') }] : []),
    ...(busy ? [{ id: 'stop', label: 'Stop the assistant', icon: 'power', run: () => { window.aos.brain.stop(chatId.current); } }] : []),
  ];
  const covered = !!(tool || openFile);
  const showGraph = !onPhone || tab === 'graph';
  if (!basics) return <div className="os"><div className="backdrop"><i /></div></div>;
  if (setup) return <Onboarding basics={basics} onDone={() => { setSetup(false); window.aos.setup.get().then(setBasics); loadBrain(); loadVault(); window.aos.usage.get().then(setUsage); }} />;

  return (
    <div className={`os ${filesOn ? 'files-on' : 'files-off'}${covered ? ' has-pane' : ''}`} data-tab={tab} style={colW ? { ['--col' as string]: `clamp(${COL_MIN}px, ${colW}px, calc(100vw - ${STAGE_MIN}px))` } : undefined}>
      <header className="bar">
        <div className="brand"><i className="logo" aria-hidden /><b>Agentic OS</b></div>
        <span className="now-state"><i className="dot" />{stateText}</span>
        <span className="flex" />
        <button className="search-pill nodrag" onClick={() => setPalette(true)} aria-label="Search and commands" title="Search files, chats and tools (Ctrl+K)"><Icon name="search" size={15} /><span>Search or jump to…</span><kbd>Ctrl K</kbd></button>
        <span className="flex" />
        {others.length > 0 && (
          <button className={`pill other-chats ${needYou.length ? 'needs' : others.some(([, c]) => c.busy) ? 'busy' : ''}`} onClick={() => openChat((needYou[0] || others[0])[0])}
            title="Other chats are working, or have something for you. Click to go to one.">
            {needYou.length ? `${needYou.length} other chat${needYou.length === 1 ? '' : 's'} need${needYou.length === 1 ? 's' : ''} you` : `${others.filter(([, c]) => c.busy).length || others.length} other chat${(others.filter(([, c]) => c.busy).length || others.length) === 1 ? '' : 's'} ${others.some(([, c]) => c.busy) ? 'working' : 'done'}`}
          </button>
        )}
        {dream.at != null && (
          <button className="pill moon" onClick={() => openTool('dreams')} title="Open the nightly review">
            <span>Nightly review</span>
            {dream.unread > 0 && <b className="n">{dream.unread}</b>}
          </button>
        )}
        <span className="pill mono notes-count" title={vaultRoot}>{notes} notes in {vaultRoot.split(/[\\/]/).filter(Boolean).pop() || 'your workspace'}</span>
        {provider && (
          <button className={`pill engine-chip${brain?.ready ? '' : ' off'}`} style={{ ['--pc' as string]: provColor }} onClick={() => !onPhone && openTool('settings', 'brain')}
            title={`Running on ${provider.name} (${provider.method === 'subscription' ? 'your subscription' : provider.method === 'local' ? 'this PC' : 'an API key'}).${onPhone ? '' : ' Click to change.'}`}>
            <i /><span>{provider.name}</span>
          </button>
        )}
        <span className="clock">{new Date(now).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
        <div className="seg theme-seg nodrag" role="group" aria-label="Theme">
          <button className={theme === 'dark' ? 'on' : ''} onClick={() => switchTheme('dark')}>Dark</button>
          <button className={theme === 'light' ? 'on' : ''} onClick={() => switchTheme('light')}>Light</button>
        </div>
      </header>

      <Rail tool={tool} onPick={pickTool} onHome={goHome} badges={badges} counts={counts} filesOn={filesOn} onFiles={() => { setFilesOn(!filesOn); store1('aos-files', !filesOn); }}
        user={basics.userName} brain={provider ? `${provider.name}${provider.method === 'subscription' ? ', your plan' : provider.method === 'local' ? ', this PC' : ', API key'}` : ''} />

      <aside className="panel col">
        {!onPhone && <div className="col-grip" onPointerDown={dragCol} onDoubleClick={resetCol} title="Drag to make the chat wider or narrower. Double-click to reset." />}
        <Assistant name={aiName} state={assistant} sub={sub}
          voice={voiceOk ? { muted, toggle: toggleMute } : null}
          wake={sttOk && !onPhone ? { on: wakeOn, loading: phase === 'loading', toggle: toggleWake } : null} wakeWord="Hey computer" />
        <Chat items={items} busy={busy} ready={!!brain} name={basics.userName} aiName={aiName} onSend={send} onApprove={approve} onStop={() => window.aos.brain.stop(chatId.current)} onOpen={open}
          asking={pending} onAsk={askAbout} chat={{ current: currentChat, onNew: newChat, onOpen: openChat, onForget: forgetChat, live, unsaved }}
          mic={sttOk ? { phase, hold: (d) => listener.current?.pushToTalk(d) } : null} setupNeeded={setupNeeded} />
      </aside>

      <main className={`stage${covered ? ' covered' : ''}`}>
        <section className="panel map">
          <div className="map-head">
            <span className="lbl">Node map</span>
            <span className="small muted">{notes} notes, {graph.links.length} links{read.length > 0 && <> · <b>{read.length}</b> read this chat</>}{wrote.length > 0 && <> · <b>{wrote.length}</b> edited</>}</span>
            <span className="flex" />
            <div className="seg" role="group" aria-label="Map shape">
              <button className={shape === 'brain' ? 'on' : ''} onClick={() => setGraphShape('brain')}>Cluster</button>
              <button className={shape === 'tree' ? 'on' : ''} onClick={() => setGraphShape('tree')}>Tree</button>
            </div>
            <button className="ghost small" onClick={() => setGraphKey((k) => k + 1)} title="Redraw the map and fit it to the window">Fit</button>
          </div>
          <div className="graph-layer">
            {showGraph && <Suspense fallback={null}><Graph key={graphKey} data={graph} read={read} wrote={wrote} reading={reading} open={openFile} onOpen={open} paused={covered} onLost={graphLost} /></Suspense>}
            {graphNote && !covered && <div className="graph-note">{graphNote}</div>}
            {notes === 0 && <div className="graph-note">No notes yet. Add markdown files to your workspace and they show up here.</div>}
            <div className="legend-chips">
              {legend.map((l) => <span key={l.group}><i style={{ background: groupColor(l.group, theme === 'light') }} />{l.label} <b className="num">{l.n}</b></span>)}
            </div>
          </div>
        </section>
        {openFile && <Viewer path={openFile} stamp={viewerStamp} onClose={() => open(null)} onBack={back} onOpen={open} />}
        {/* The tool stays mounted (just hidden) under an open file, so Back lands on the same project, scroll and search. */}
        {tool && (
          <div style={{ display: openFile ? 'none' : 'contents' }}>
            {tool === 'dashboard' && <Dashboard onClose={() => setTool(null)} />}
            {tool === 'settings' && <Settings onClose={() => setTool(null)} start={settingsPage} onSetup={() => { setTool(null); setSetup(true); }} />}
            {tool === 'skills' && <Skills onClose={() => setTool(null)} onOpen={open} />}
            {tool === 'projects' && <Projects onClose={() => setTool(null)} onOpen={open} />}
            {/* Do it: the card's action goes to the assistant as a normal message, so risky steps still ask first. */}
            {tool === 'dreams' && <Dreams onClose={() => { setTool(null); loadDreams(); }} busy={busy} onDo={(action) => { setTool(null); loadDreams(); newChat(); sendRef.current(action); }} />}
            {tool === 'actions' && <Actions onClose={() => setTool(null)} onOpen={open} onNotes={() => openTool('notes')} onChanged={loadActs} />}
            {tool === 'notes' && <Notes onClose={() => setTool(null)} onOpen={open} onActions={() => openTool('actions')} onChanged={loadActs} />}
            {tool === 'connectors' && <Connectors onClose={() => setTool(null)} chatId={currentChat} onBrain={() => openTool('settings', 'brain')} />}
            {tool === 'health' && <Health onClose={() => setTool(null)} onOpen={open} chatItems={items.length} onAsk={(t) => { setTool(null); if (!busyRef.current) sendRef.current(t); }} />}
          </div>
        )}
      </main>

      <aside className="side">
        <Charge usage={usage} now={now} brain={provider?.name || 'Claude'} />
        <Files tree={tree} root={vaultRoot} read={read} reading={reading} open={openFile} onOpen={open} />
        <section className="panel trail">
          <h4><span className="lbl">{busy ? 'Reading now' : 'This chat'}</span><span className="mono small muted">{read.length ? `${read.length} files` : ''}</span></h4>
          {read.length === 0 ? <span className="empty">Files the assistant opens light up on the map and list here.</span> : (
            <ol>{read.slice(-4).reverse().map((p) => (
              <li key={p} className={`${p === reading ? 'now' : ''} ${wrote.includes(p) ? 'wrote' : ''}`}><button onClick={() => open(p)} title={p}><i /><span>{p}</span></button></li>
            ))}</ol>
          )}
        </section>
      </aside>

      <ToolsSheet onPick={pickTool} badges={badges} />
      <Tabs tab={tab} onTab={(t) => { if (t !== 'tools') { setTool(null); open(null); } setTab(t); }} badge={dream.unread} />
      {palette && <Palette tree={tree} actions={actions} onTool={pickTool} onFile={open} onChat={openChat} onAsk={(t) => { if (!busyRef.current) sendRef.current(t); }} onClose={() => setPalette(false)} />}
      {onPhone && !linked && <div className="link-lost">Can't reach the PC. Trying again…</div>}
    </div>
  );
}
