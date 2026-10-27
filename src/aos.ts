// `window.aos`: everything the screen can ask the app to do, built once on top of Electron's two-call bridge
// (electron/preload.cjs).
import type {
  ActionItem, NoteEntry, NoteWeek, SavedNote, DiscoverReport, OkfMode, OkfResult, Basics, BrainEvent, BrainStatus, ChatSummary, CliStatus, ConnectorMode, GatewayExtra, GatewayStyle, ImportFound, ConnectorsSummary, ToolsSummary, DreamCard, DreamEvent, DreamState, FileContent,
  FileType, GraphData, HealthSummary, LedgerSummary, Method, Models, ProjectInfo, ProvidersState, SavedChat, SkillInfo, TreeNode, UsageV2, V1Look, ValueSummary,
  WireApi, WorkersState, SearchHit, SearchStatus, MailState, MailPullResult,
} from './types';

interface Bridge { kind: 'desktop'; os?: 'mac' | 'win'; quiet?: boolean; invoke(channel: string, ...args: unknown[]): Promise<any>; on(channel: string, fn: (payload: any) => void): () => void }

const bridge: Bridge = (window as unknown as { aosBridge: Bridge }).aosBridge;
export const quiet = !!bridge.quiet; // a hidden test capture: don't open the microphone
export const os: 'mac' | 'win' = bridge.os === 'mac' ? 'mac' : 'win'; // where the window buttons go
const call = <T,>(channel: string) => (...args: unknown[]) => bridge.invoke(channel, ...args) as Promise<T>;

const aos = {
  kind: bridge.kind,
  window: {
    state: call<{ full: boolean; max: boolean; min?: boolean }>('window:state'),
    onState: (fn: (s: { full: boolean; max: boolean }) => void) => bridge.on('window:state', fn),
    minimize: call<boolean>('window:minimize'), maximize: call<boolean>('window:maximize'), close: call<boolean>('window:close'),
  },
  vault: {
    info: call<{ root: string; exists: boolean; notes: number }>('vault:info'),
    tree: call<{ root: string; children: TreeNode[] }>('vault:tree'),
    graph: call<GraphData>('vault:graph'),
    noteCount: call<number>('vault:noteCount'), // just the number of notes; the graph builds every note and link to tell you the same
    read: (rel: string) => bridge.invoke('vault:read', rel) as Promise<FileContent>,
    skills: call<{ groups: { name: string; skills: SkillInfo[] }[] }>('vault:skills'),
    projects: call<ProjectInfo[]>('vault:projects'),
    setOverride: (rel: string, type: FileType | null) => bridge.invoke('vault:setOverride', rel, type) as Promise<{ count: number }>,
    clearOverrides: (projectRel: string) => bridge.invoke('vault:clearOverrides', projectRel) as Promise<{ count: number }>,
    openExternal: (rel: string) => bridge.invoke('vault:openExternal', rel) as Promise<string>,
    reveal: (rel: string) => bridge.invoke('vault:reveal', rel) as Promise<boolean>,
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
    mute: (m: boolean) => bridge.invoke('voice:mute', m) as Promise<boolean>,
    settings: call<{ speed: number; defaultSpeed: number; min: number; max: number }>('voice:settings'),
    setSpeed: (v: number) => bridge.invoke('voice:setSpeed', v) as Promise<number>,
    preview: call<string | null>('voice:preview'),
  },
  connectors: {
    summary: call<ConnectorsSummary>('connectors:summary'), refresh: call<ConnectorsSummary>('connectors:refresh'),
    logo: (name: string) => bridge.invoke('connectors:logo', name) as Promise<string | null>,
    setMode: (m: ConnectorMode) => bridge.invoke('connectors:setMode', m) as Promise<ConnectorMode>,
  },
  tools: {
    summary: call<ToolsSummary>('tools:summary'),
    disconnect: (id: string) => bridge.invoke('tools:disconnect', id) as Promise<{ ok: boolean; moved?: string[]; error?: string }>,
    reconnect: (id: string) => bridge.invoke('tools:reconnect', id) as Promise<{ ok: boolean; error?: string }>,
    removeCompletely: (id: string) => bridge.invoke('tools:removeCompletely', id) as Promise<{ ok: boolean; deleted?: string[]; error?: string }>,
  },
  insights: {
    health: (chatItems?: number) => bridge.invoke('insights:health', chatItems || 0) as Promise<HealthSummary>,
    value: call<ValueSummary>('insights:value'),
    setHourlyRate: (v: number) => bridge.invoke('insights:setHourlyRate', v) as Promise<boolean>,
    setSkillMinutes: (skill: string, v: number | null) => bridge.invoke('insights:setSkillMinutes', skill, v) as Promise<boolean>,
  },
  actions: {
    list: call<{ items: ActionItem[]; open: number }>('actions:list'),
    close: (project: string, raw: string) => bridge.invoke('actions:close', project, raw) as Promise<{ raw: string }>,
    reopen: (project: string, raw: string) => bridge.invoke('actions:reopen', project, raw) as Promise<{ raw: string }>,
    update: (project: string, raw: string, text: string) => bridge.invoke('actions:update', project, raw, text) as Promise<{ raw: string }>,
  },
  notes: {
    projects: call<string[]>('notes:projects'),
    list: (project: string | null) => bridge.invoke('notes:list', project) as Promise<NoteEntry[]>,
    older: (project: string | null) => bridge.invoke('notes:older', project) as Promise<NoteWeek[]>,
    add: (project: string, text: string) => bridge.invoke('notes:add', project, text) as Promise<SavedNote>,
    where: (project: string) => bridge.invoke('notes:where', project) as Promise<{ file: string; actions: string; week: string }>,
  },
  search: {
    query: (q: string, limit?: number, scope?: 'output' | 'all') => bridge.invoke('search:query', q, limit || 12, scope || 'output') as Promise<SearchHit[]>,
    status: call<SearchStatus>('search:status'),
    review: (limit?: number) => bridge.invoke('search:review', limit || 40) as Promise<{ path: string; title: string; project: string; date: string; staleWhen: string }[]>,
    build: (opts?: { dry?: boolean; only?: string; limit?: number }) => bridge.invoke('search:build', opts || {}) as Promise<Record<string, unknown>>,
  },
  mail: {
    state: call<MailState>('mail:state'), pull: call<MailPullResult>('mail:pull'),
    dismiss: (id: string) => bridge.invoke('mail:dismiss', id) as Promise<boolean>,
    done: (id: string) => bridge.invoke('mail:done', id) as Promise<boolean>,
    checkWatch: () => bridge.invoke('mail:checkWatch') as Promise<{ checked: number; total: number; confirmed: number; unconfirmed: number; down: boolean }>,
    unwatch: (id: string) => bridge.invoke('mail:unwatch', id) as Promise<boolean>,
    openInOutlook: (id: string) => bridge.invoke('mail:openInOutlook', id) as Promise<boolean>,
    onEvent: (fn: (e: { type: 'start' | 'progress' | 'done' | 'error' | 'changed'; done?: number; total?: number; error?: string }) => void) => bridge.on('mail:event', fn),
  },
  skillRun: {
    run: (skill: string, model: 'haiku' | 'sonnet') => bridge.invoke('skills:run', skill, model) as Promise<{ ok: boolean; secs: number; note: string }>,
    stop: (skill: string) => bridge.invoke('skills:stop', skill) as Promise<boolean>,
    state: call<{ skill: string; since: number }[]>('skills:state'),
    recent: (limit?: number) => bridge.invoke('skills:recent', limit || 30) as Promise<{ at: string; skill: string; model: string; ok: boolean; secs: number; note: string }[]>,
    test: call<{ ok: boolean; secs?: number; model?: string; reply?: string; error?: string }>('skills:test'),
    onEvent: (fn: (e: { type: 'start' | 'done'; skill: string; model?: string; ok?: boolean; secs?: number; note?: string }) => void) => bridge.on('skills:event', fn),
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
    refreshModels: (force?: boolean) => bridge.invoke('brain:refreshModels', !!force) as Promise<{ id: string | null; name: string; note: string; unavailable?: boolean }[]>,
    setPick: (chat: string, model: string | null, effort: string | null) => bridge.invoke('brain:setPick', chat, model, effort) as Promise<{ model: string | null; effort: string | null }>,
    stop: (chat?: string) => bridge.invoke('brain:stop', chat || null) as Promise<boolean>,
    openChat: (chat: string, sessionId: string | null) => bridge.invoke('brain:openChat', chat, sessionId || null) as Promise<boolean>,
    approve: (id: number, yes: boolean, all?: boolean, question?: string) => bridge.invoke('brain:approve', id, yes, !!all, question || '') as Promise<boolean>,
    allowEdits: (v: boolean) => bridge.invoke('brain:allowEdits', v) as Promise<boolean>,
    onEvent: (fn: (e: BrainEvent) => void) => bridge.on('brain:event', fn),
  },
  setup: {
    get: call<Basics>('setup:get'),
    set: (patch: Partial<Basics>) => bridge.invoke('setup:set', patch) as Promise<Basics>,
    pickFolder: call<{ path: string; notes: number } | null>('setup:pickFolder'),
    starterVault: call<{ path: string; notes: number }>('setup:starterVault'),
    discover: call<DiscoverReport>('setup:discover'),
    applyOkf: (mode: OkfMode) => bridge.invoke('setup:applyOkf', mode) as Promise<OkfResult>,
    v1: call<V1Look>('setup:v1'),
    importV1: (want: Record<string, boolean>) => bridge.invoke('setup:importV1', want) as Promise<Record<string, number>>,
    voice: call<{ whisper: boolean; piper: boolean; wakeModel: boolean }>('setup:voice'),
  },
  providers: {
    state: call<ProvidersState>('providers:state'),
    test: (o: { id: string; key?: string; baseUrl?: string; style?: GatewayStyle; headers?: string; disableBetas?: boolean; model?: string }) => bridge.invoke('providers:test', o) as Promise<{ ok: boolean; models?: string[]; suggested?: Models; error?: string; kind?: string }>,
    save: (o: { id: string; method: Method; key?: string; baseUrl?: string; models?: Partial<Models>; price?: { in?: number; out?: number } | null; gateway?: Partial<GatewayExtra> }) => bridge.invoke('providers:save', o) as Promise<{ ok: boolean; error?: string }>,
    importSettings: call<{ ok: boolean; found?: ImportFound; error?: string }>('providers:importSettings'),
    applyImport: call<{ ok: boolean; error?: string; check: { ok: boolean; error: string; kind: string; models: string[] } | null }>('providers:applyImport'),
    forgetKey: (id: string) => bridge.invoke('providers:forgetKey', id) as Promise<boolean>,
    cliStatus: () => bridge.invoke('providers:cliStatus') as Promise<CliStatus>,
    openLogin: () => bridge.invoke('providers:openLogin') as Promise<{ ok: boolean; error?: string }>,
    openKeyPage: () => bridge.invoke('providers:openKeyPage') as Promise<boolean>,
  },
  workers: {
    state: call<WorkersState>('workers:state'),
    test: (o: { id: string; key?: string; baseUrl?: string }) => bridge.invoke('workers:test', o) as Promise<{ ok: boolean; models?: string[]; error?: string }>,
    save: (o: { id: string; key?: string; baseUrl?: string; model?: string; wireApi?: WireApi; goodFor?: string; enabled?: boolean }) => bridge.invoke('workers:save', o) as Promise<{ ok: boolean; error?: string }>,
    forgetKey: (id: string) => bridge.invoke('workers:forgetKey', id) as Promise<boolean>,
  },
  discord: {
    get: call<{ configured: boolean; token: { saved: boolean; tail: string }; userId: string }>('discord:get'),
    set: (o: { token?: string; userId?: string }) => bridge.invoke('discord:set', o) as Promise<boolean>,
    clear: call<boolean>('discord:clear'),
  },
};

export type Aos = typeof aos;
declare global { interface Window { aos: Aos } }
window.aos = aos;
export default aos;
