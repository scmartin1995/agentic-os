// `window.aos`: everything the screen can ask the app to do. Built here, once, on top of a two-call bridge:
//   - in the desktop window the bridge is Electron's (electron/preload.cjs)
//   - on a paired phone it is the app's local web server (electron/remote.cjs): fetch for calls, one event stream back
// So every component talks to the same object wherever it runs.
import type {
  ActionItem, NoteEntry, SavedNote, Basics, BrainEvent, BrainStatus, ChatSummary, CliStatus, ConnectorMode, ConnectorPolicy, ConnectorsSummary, DreamCard, DreamEvent, DreamState, FileContent,
  GraphData, HealthSummary, LedgerSummary, Method, Models, PhoneState, ProjectInfo, ProvidersState, SavedChat, SkillInfo, TreeNode, UsageV2, ValueSummary,
} from './types';

interface Bridge { kind: 'desktop' | 'phone'; quiet?: boolean; invoke(channel: string, ...args: unknown[]): Promise<any>; on(channel: string, fn: (payload: any) => void): () => void }

// ---- the phone's bridge ----
function b64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const pack = (v: unknown): unknown => (v instanceof ArrayBuffer ? { __b64: b64(v) } : ArrayBuffer.isView(v) ? { __b64: b64(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer) } : v);

function phoneBridge(): Bridge {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const subs = new Map<string, Set<(p: any) => void>>();
  let es: EventSource | null = null;
  const connect = () => {
    es = new EventSource(`/api/events?c=${id}`);
    es.onmessage = (m) => {
      try { const { channel, payload } = JSON.parse(m.data); subs.get(channel)?.forEach((fn) => fn(payload)); } catch { /* not ours */ }
    };
    es.onopen = () => window.dispatchEvent(new CustomEvent('aos-link', { detail: true }));
    es.onerror = () => window.dispatchEvent(new CustomEvent('aos-link', { detail: false })); // the browser retries by itself
  };
  connect();
  return {
    kind: 'phone',
    async invoke(channel, ...args) {
      const res = await fetch('/api/invoke', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client': id }, body: JSON.stringify({ channel, args: args.map(pack) }) });
      if (res.status === 401) { location.reload(); throw new Error('This phone is no longer paired.'); }
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || 'That did not work.');
      return j.result;
    },
    on(channel, fn) {
      if (!subs.has(channel)) subs.set(channel, new Set());
      subs.get(channel)!.add(fn);
      return () => { subs.get(channel)?.delete(fn); };
    },
  };
}

const bridge: Bridge = (window as unknown as { aosBridge?: Bridge }).aosBridge ?? phoneBridge();
export const onPhone = bridge.kind === 'phone';
export const quiet = !!bridge.quiet; // a hidden test capture: don't open the microphone
const call = <T,>(channel: string) => (...args: unknown[]) => bridge.invoke(channel, ...args) as Promise<T>;
const never = <T,>(value: T) => () => Promise.resolve(value); // desktop-only things, on a phone

const aos = {
  kind: bridge.kind,
  window: {
    state: onPhone ? never({ full: true, max: false }) : call<{ full: boolean; max: boolean }>('window:state'),
    onState: (fn: (s: { full: boolean; max: boolean }) => void) => bridge.on('window:state', fn),
    minimize: call<boolean>('window:minimize'), maximize: call<boolean>('window:maximize'), close: call<boolean>('window:close'),
  },
  vault: {
    info: call<{ root: string; exists: boolean; notes: number }>('vault:info'),
    tree: call<{ root: string; children: TreeNode[] }>('vault:tree'),
    graph: call<GraphData>('vault:graph'),
    read: (rel: string) => bridge.invoke('vault:read', rel) as Promise<FileContent>,
    skills: call<{ groups: { name: string; skills: SkillInfo[] }[] }>('vault:skills'),
    projects: call<ProjectInfo[]>('vault:projects'),
    openExternal: (rel: string) => bridge.invoke('vault:openExternal', rel) as Promise<string>,
    onChanged: (fn: (info: { outside: string[] }) => void) => bridge.on('vault:changed', (i) => fn(i || { outside: [] })),
  },
  usage: {
    get: call<UsageV2>('usage:get'), ledger: call<LedgerSummary>('usage:ledger'),
    setPlanPrice: (v: number) => bridge.invoke('usage:setPlanPrice', v) as Promise<boolean>,
  },
  stt: {
    status: call<{ available: boolean }>('stt:status'),
    transcribe: (pcm: ArrayBuffer) => bridge.invoke('stt:transcribe', pcm) as Promise<{ text?: string; error?: string }>,
  },
  voice: {
    status: call<{ available: boolean; muted: boolean }>('voice:status'),
    mute: onPhone ? (m: boolean) => Promise.resolve(m) : (m: boolean) => bridge.invoke('voice:mute', m) as Promise<boolean>,
    settings: call<{ speed: number; defaultSpeed: number; min: number; max: number }>('voice:settings'),
    setSpeed: (v: number) => bridge.invoke('voice:setSpeed', v) as Promise<number>,
    preview: call<string | null>('voice:preview'),
  },
  connectors: {
    summary: (chatId?: string) => bridge.invoke('connectors:summary', chatId) as Promise<ConnectorsSummary>,
    refresh: (chatId?: string) => bridge.invoke('connectors:refresh', chatId) as Promise<ConnectorsSummary>,
    logo: (name: string) => bridge.invoke('connectors:logo', name) as Promise<string | null>,
    setMode: (m: ConnectorMode) => bridge.invoke('connectors:setMode', m) as Promise<ConnectorMode>,
    setPolicy: (key: string, name: string, p: ConnectorPolicy) => bridge.invoke('connectors:setPolicy', key, name, p) as Promise<boolean>,
  },
  insights: {
    health: (chatItems?: number) => bridge.invoke('insights:health', chatItems || 0) as Promise<HealthSummary>,
    value: call<ValueSummary>('insights:value'),
    setHourlyRate: (v: number) => bridge.invoke('insights:setHourlyRate', v) as Promise<boolean>,
    setSkillMinutes: (skill: string, v: number | null) => bridge.invoke('insights:setSkillMinutes', skill, v) as Promise<boolean>,
  },
  // Notes and Action items panels (electron/actions.cjs).
  actions: {
    list: call<{ items: ActionItem[]; open: number }>('actions:list'),
    close: (project: string, raw: string) => bridge.invoke('actions:close', project, raw) as Promise<{ raw: string }>,
    reopen: (project: string, raw: string) => bridge.invoke('actions:reopen', project, raw) as Promise<{ raw: string }>,
    update: (project: string, raw: string, text: string) => bridge.invoke('actions:update', project, raw, text) as Promise<{ raw: string }>,
  },
  notes: {
    projects: call<string[]>('notes:projects'),
    list: (project: string | null) => bridge.invoke('notes:list', project) as Promise<NoteEntry[]>,
    add: (project: string, text: string) => bridge.invoke('notes:add', project, text) as Promise<SavedNote>,
    where: (project: string) => bridge.invoke('notes:where', project) as Promise<{ file: string; actions: string; week: string }>,
  },
  dreams: {
    state: call<DreamState>('dreams:state'), run: call<boolean>('dreams:run'),
    mark: (day: string, id: string, status: DreamCard['status']) => bridge.invoke('dreams:mark', day, id, status) as Promise<boolean>,
    setSettings: (patch: Partial<DreamState['settings']>) => bridge.invoke('dreams:setSettings', patch) as Promise<DreamState['settings']>,
    onEvent: (fn: (e: DreamEvent) => void) => bridge.on('dreams:event', fn),
  },
  attach: { save: (name: string, bytes: ArrayBuffer) => bridge.invoke('attach:save', name, bytes) as Promise<{ path?: string; name?: string; error?: string }> },
  chats: {
    list: call<ChatSummary[]>('chats:list'),
    load: (id: string) => bridge.invoke('chats:load', id) as Promise<SavedChat | null>,
    save: (chat: SavedChat) => bridge.invoke('chats:save', chat) as Promise<boolean>,
    remove: (id: string) => bridge.invoke('chats:remove', id) as Promise<boolean>,
  },
  // The brain: whichever LLM was chosen in onboarding (electron/engine.cjs).
  brain: {
    status: call<BrainStatus>('brain:status'),
    send: (text: string, speak?: boolean, files?: string[], chat?: string) => bridge.invoke('brain:send', text, !!speak, files || [], chat || null) as Promise<void>,
    stop: (chat?: string) => bridge.invoke('brain:stop', chat || null) as Promise<boolean>,
    openChat: (chat: string, sessionId: string | null) => bridge.invoke('brain:openChat', chat, sessionId || null) as Promise<boolean>,
    approve: (id: number, yes: boolean, question?: string) => bridge.invoke('brain:approve', id, yes, question || '') as Promise<boolean>,
    onEvent: (fn: (e: BrainEvent) => void) => bridge.on('brain:event', fn),
  },
  setup: {
    get: call<Basics>('setup:get'),
    set: (patch: Partial<Basics>) => bridge.invoke('setup:set', patch) as Promise<Basics>,
    pickFolder: call<{ path: string; notes: number } | null>('setup:pickFolder'),
    starterVault: call<{ path: string; notes: number }>('setup:starterVault'),
    voice: call<{ whisper: boolean; piper: boolean; wakeModel: boolean }>('setup:voice'),
  },
  providers: {
    state: call<ProvidersState>('providers:state'),
    test: (o: { id: string; key?: string; baseUrl?: string }) => bridge.invoke('providers:test', o) as Promise<{ ok: boolean; models?: string[]; suggested?: Models; error?: string }>,
    save: (o: { id: string; method: Method; key?: string; baseUrl?: string; models?: Partial<Models>; price?: { in?: number; out?: number } | null }) => bridge.invoke('providers:save', o) as Promise<{ ok: boolean; error?: string }>,
    forgetKey: (id: string) => bridge.invoke('providers:forgetKey', id) as Promise<boolean>,
    cliStatus: (id: string) => bridge.invoke('providers:cliStatus', id) as Promise<CliStatus>,
    openLogin: (id: string) => bridge.invoke('providers:openLogin', id) as Promise<{ ok: boolean; error?: string }>,
    cliInstall: (id: string) => bridge.invoke('providers:cliInstall', id) as Promise<{ ok: boolean; error?: string }>,
    openKeyPage: (id: string) => bridge.invoke('providers:openKeyPage', id) as Promise<boolean>,
  },
  discord: {
    get: call<{ configured: boolean; token: { saved: boolean; tail: string }; userId: string }>('discord:get'),
    set: (o: { token?: string; userId?: string }) => bridge.invoke('discord:set', o) as Promise<boolean>,
    clear: call<boolean>('discord:clear'),
  },
  phone: {
    get: call<PhoneState>('phone:get'),
    set: (o: { enabled?: boolean; port?: number }) => bridge.invoke('phone:set', o) as Promise<PhoneState>,
    unpair: call<PhoneState>('phone:unpair'),
    qr: (base: string) => bridge.invoke('phone:qr', base) as Promise<{ url: string; qr: string } | null>,
  },
};

export type Aos = typeof aos;
declare global { interface Window { aos: Aos } }
window.aos = aos;
export default aos;
