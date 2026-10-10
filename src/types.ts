export type FileKind = 'md' | 'html' | 'pdf' | 'csv' | 'image' | 'text' | 'other';

export interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  kind?: FileKind;
  children?: TreeNode[];
}

export interface GraphData {
  nodes: { id: string; name: string; group: string; received?: boolean }[];
  links: { source: string; target: string }[];
}

export interface FileContent {
  kind?: FileKind;
  path?: string;
  size?: number;
  text?: string;
  note?: string;
  error?: string;
}

// Menu tools (electron/vault.cjs skills() and projects()).
export interface SkillInfo { name: string; title: string; description: string; tags: string[]; pinned: boolean; path: string; group: string }
export interface ProjectFile { name: string; path: string; kind: FileKind; sub: string }
export interface ProjectInfo {
  folder: string; path: string; modified: number; title: string; description: string; status: string; readme: string | null;
  links: { label: string; url: string }[];
  summaries: ProjectFile[]; notes: ProjectFile[]; designs: ProjectFile[]; other: ProjectFile[];
  // material given to us by others (a folder whose README says `received: true`): read-only, never run
  received: ProjectFile[]; receivedReadmes: string[];
}

export interface UsageWindow { spent: number; budget: number; resetsAt: number }
export interface PlanWindow { used: number; resetsAt: number | null; seen: number }
export type Usage =
  | { mode: 'api'; day: UsageWindow; month: UsageWindow }
  | { mode: 'plan'; planName: string | null; session: PlanWindow | null; week: PlanWindow | null };

export interface LedgerTotals { questions: number; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; reads: number; edits: number }
export interface LedgerSummary {
  mode: 'plan' | 'api';
  planName: string | null; planPrice: number | null; planPriceKnown: boolean; planPriceSaved: boolean;
  today: LedgerTotals; week: LedgerTotals; month: LedgerTotals; all: LedgerTotals;
  since: number | null;
  days: { day: string; tokens: number; cost: number }[];
  models: (LedgerTotals & { model: string })[];
}

// Health and Value panels (electron/insights.cjs). Times are ms; null = never / unknown.
export interface SkillHealth { name: string; title: string; path: string; last: number | null; uses: number; share: number; state: 'ok' | 'quiet' | 'dead' | 'none' }
export interface MemoryHealth { folder: string; title: string; notes: number | null; chat: number | null; behind: number; mentionsSince: number }
export interface JobRun { at: number; ok: boolean; ms: number; note: string }
export interface HealthSummary {
  since: number | null;
  skills: SkillHealth[];
  memory: MemoryHealth[];
  sessions: { days: { day: string; n: number }[]; today: number; avg: number };
  chat: { items: number; long: number };
  jobs: { dreams: JobRun | null; boneCollector: JobRun | null; notes: number };
}
export type ConnectorMode = 'ondemand' | 'always' | 'never';
export type ConnectorStatus = 'connected' | 'needs-auth' | 'failed' | 'pending' | 'disabled' | 'builtin' | 'removed' | 'unknown';
export type ConnectorPolicy = ConnectorMode | 'hidden' | 'shown';
export interface ConnectorInfo { id: string; name: string; kind?: string; color: string; icon?: string }
// One row per thing the assistant can call: connected now, or only seen in the logs. Counts are from the session logs.
export interface ConnectorRow extends ConnectorInfo {
  key: string; status: ConnectorStatus; statusText?: string; note: string; tools: number | null;
  total: number; d30: number; last: number; days: number[]; topTools: { name: string; n: number }[];
  policy: ConnectorMode | null; own: boolean; fixed?: string; loaded: 'chat' | 'every' | null;
}
export interface ConnectorTile extends ConnectorInfo { on: boolean }
export interface ConnectorsSummary {
  since: number | null; mode: ConnectorMode; checkedAt: number | null; tokensPerTool: number;
  brain: ConnectorInfo & { note: string; detail: string };
  apps: ConnectorRow[]; yours: ConnectorRow[]; browser: ConnectorRow[]; own: ConnectorRow[];
  pc: ConnectorTile[]; skills: number | null; hidden: { key: string; name: string }[];
}
export interface ValueSummary {
  rate: number; rateIsDefault: boolean; salary: number;
  hours: number; uses: number; questions: number; worth: number; pay: number; planName: string | null; net: number; times: number | null;
  bySkill: { name: string; uses: number; minutes: number; hours: number; known: boolean }[];
  weeks: { label: string; hours: number }[];
  since: number | null;
  fit: {
    cacheShare: number | null; rightSized: number | null; sizedCount: number;
    heavyLookups: { n: number; cost: number; saving: number | null };
    auto: { n: number; cost: number; saving: number | null };
    longChats: number; haikuKnown: boolean;
  };
}
// Dreams (electron/dreams.cjs)
export type DreamDimension = 'chats' | 'cost' | 'skills' | 'memory' | 'sessions' | 'workflow' | 'outside' | 'business';
export interface DreamCard { id: string; dimension: DreamDimension; headline: string; why: string; evidence: string; saves: string; savesKind: 'time' | 'money'; button: string; action: string; status: 'open' | 'done' | 'skip' }
export interface Dream { day: string; at: number; ms: number; reason: string; read: { questions: number; days: number }; dims: DreamDimension[]; dropped: number; web: boolean; cards: DreamCard[] }
export interface DreamState { latest: Dream | null; earlier: { day: string; total: number; done: number; skipped: number }[]; settings: { hour: number; web: boolean }; running: boolean; next: number }
export type DreamEvent = { phase: 'start'; reason: string } | { phase: 'done'; count: number; unread: number } | { phase: 'error'; message: string } | { phase: 'marked'; unread: number };

// Every event comes tagged with the chat it belongs to (several chats run at once).
export type ClaudeEvent = { chat?: string } & (
  | { type: 'start' }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: Record<string, unknown>; path: string | null; helper?: boolean }
  | { type: 'helper'; phase: 'start' | 'end'; id: string; name: string; desc: string; ok?: boolean; brief?: string }
  | { type: 'result'; isError: boolean; costUsd?: number }
  | { type: 'limits'; kind?: string; used?: number; resetsAt?: number | null }
  | { type: 'audio'; seq: number; data: string }
  | { type: 'approval'; id: number; tool: string; summary: string; what: string; spoken: string; risky: boolean; helper?: boolean; chatTitle?: string }
  | { type: 'approved'; id: number; yes: boolean; question?: string }
  | { type: 'session'; id: string }
  | { type: 'error'; message: string }
  | { type: 'note'; message: string }
  | { type: 'open'; path: string }
  | { type: 'done' }
);

// A conversation kept on disk so it can be reopened (electron/chats.cjs). `items` is what the chat panel showed.
export interface ChatSummary { id: string; title: string; updated: number; count: number; interrupted?: boolean }
export interface SavedChat { id: string; title: string; sessionId: string | null; items: unknown[]; read: string[]; wrote: string[]; updated?: number; busy?: boolean }

export type AssistantState = 'idle' | 'listening' | 'thinking' | 'talking' | 'replying';

// ---- v2 ----
// A subscription that isn't Claude (ChatGPT or Google plan through their CLI) reports no limits: tokens only.
export type UsageV2 = Usage | { mode: 'sub'; day: { tokens: number }; week: { tokens: number } };

export type Method = 'subscription' | 'key' | 'local';
export interface ProviderDef {
  id: string; name: string; by: string; color: string; level: 'full' | 'core'; methods: Method[]; engines: Record<string, string>;
  blurb: string; subscription?: string; baseUrl?: string; keyUrl?: string; keyLooks?: string;
  cli?: { cmd: string; pkg: string; install?: string; login: string; name: string }; presets?: { name: string; url: string }[];
}
export interface Models { light: string; standard: string; strong: string }
export interface ProvidersState {
  catalog: ProviderDef[];
  current: { id: string; method: Method; baseUrl: string; models: Models; engine: string; key: { saved: boolean; tail: string }; price: { in?: number; out?: number } | null };
  encrypted: boolean;
}
export interface BrainStatus {
  ready: boolean; mode: 'plan' | 'api' | 'sub'; model: string; busy: boolean; running: string[]; onboarded: boolean;
  provider: { id: string; name: string; method: Method; engine: string; level: 'full' | 'core' };
}
export interface Basics { onboarded: boolean; userName: string; assistantName: string; vaultPath: string; vaultSet: boolean; wakeWord: boolean; budgets: { daily: number; monthly: number }; openAtLogin: boolean; version: string }
export interface CliStatus { installed: boolean; signedIn: boolean; plan?: string; who?: string; name?: string; pkg?: string; error?: string }
export interface PhoneLink { address: string; name: string; kind: 'tailscale' | 'wifi'; url: string; qr: string }
export interface PhoneState { enabled: boolean; running: boolean; port: number; phones: number; error: string; links: PhoneLink[] }
export type BrainEvent = ClaudeEvent | { chat?: string; type: 'brainChanged' };

// Files inside the workspace: the desktop window loads them over vault://, a paired phone over the app's web server.
const onPhone = typeof window !== 'undefined' && !(window as unknown as { aosBridge?: unknown }).aosBridge;
export const vaultUrl = (rel: string) => (onPhone ? '/vault/' : 'vault://files/') + rel.split('/').map(encodeURIComponent).join('/');

// Notes and Action items panels (electron/actions.cjs): plain markdown in the workspace.
export interface ActionItem { project: string; name: string; file: string; raw: string; done: boolean; text: string; added: string | null; closed: string | null; note: string | null }
export interface NoteEntry { project: string; name: string; file: string; date: string; time: string; action: boolean; text: string }
export interface SavedNote { project: string; file: string; date: string; time: string; action: ActionItem | null }
