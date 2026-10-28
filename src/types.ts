export type FileKind = 'md' | 'html' | 'pdf' | 'csv' | 'image' | 'text' | 'other';

export interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  kind?: FileKind;
  children?: TreeNode[];
}

export interface GraphData {
  nodes: { id: string; name: string; group: string; project?: string; received?: boolean }[];
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
// headless: the skill says it can run on its own (`headless: true` in its header), so it gets a Run button.
export interface SkillInfo { name: string; title: string; description: string; tags: string[]; pinned: boolean; headless: boolean; path: string; group: string }
export interface ProjectFile { name: string; path: string; kind: FileKind; sub: string; modified?: number; created?: number }
// What a file is for, as the Projects panel shows it. auto is what its folder makes it; type is that unless corrected.
export type FileType = 'deliverable' | 'note' | 'record' | 'evidence' | 'working' | 'raw';
export interface Deliverable extends ProjectFile {
  title: string; description: string; modified: number; auto: FileType; type: FileType;
  overridden?: boolean; from?: string; bundle?: number; group?: string;
}
export interface SessionInfo { name: string; path: string; date: string; title: string; readme: string | null; outcome: string; output: Deliverable[]; evidence: Deliverable[] }
export interface ProjectInfo {
  folder: string; path: string; modified: number; title: string; description: string; status: string; readme: string | null;
  breadcrumb: string; // the folder's own name, or "<parent> / <folder>" when it was promoted out of a non-project parent
  links: { label: string; url: string }[];
  okf: boolean; // has the Client Facing / Raw / Records / Sessions / Tools layout
  deliverables: Deliverable[]; // what it hands over, newest first (electron/vault.cjs projects() has the rules)
  sessionNotes: Deliverable[]; // write-ups in sessions' Output folders, newest first
  records: Deliverable[];
  sessions: SessionInfo[]; // newest first
  working: Deliverable[]; // everything else of its own, newest first
  raw: { label: string; count: number }[]; // Raw and Tools, counted
  search: Deliverable[]; // every file, for the finder and the recently edited strip
  corrections: number; // panel corrections inside this project
  designs: ProjectFile[]; // pictures, for the tile
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
  jobs: { dreams: JobRun | null; lessonsPass: JobRun | null; searchIndex: JobRun | null; mailPull: JobRun | null; notes: number };
}
export type ConnectorMode = 'ondemand' | 'always' | 'never';
export type ConnectorStatus = 'connected' | 'needs-auth' | 'failed' | 'pending' | 'disabled' | 'builtin' | 'removed' | 'unknown';
export interface ConnectorInfo { id: string; name: string; kind: string; color: string }
// One row per connector found: connected now, or only seen in the logs. Counts are from the session logs.
export interface ConnectorRow extends ConnectorInfo {
  key: string; status: ConnectorStatus; tools: number | null;
  total: number; d7: number; d30: number; last: number; days: number[]; topTools: { name: string; n: number }[];
}
export interface ConnectorsSummary { since: number | null; mode: ConnectorMode; checkedAt: number | null; items: ConnectorRow[]; builtIn: ConnectorInfo[] }
// A CLI tool Agentic OS itself installed (as opposed to a claude.ai-linked connector). Usage is read from the
// same session logs as connectors, just the skills a tool owns rather than an mcp server's calls.
export interface ToolRow {
  id: string; name: string; icon: string | null; skills: string[]; active: boolean; color: string;
  total: number; d7: number; d30: number; last: number; days: number[];
  worker?: boolean; kind?: WorkerKind; // an Other model (electron/workers.cjs); counts come from its own call log
}
export interface ToolsSummary { since: number | null; items: ToolRow[] }
// Other models (electron/workers.cjs): non-Claude workers Agentic OS dispatches to through the company gateway.
export type WorkerKind = 'agent' | 'model';
export type WireApi = 'responses' | 'chat';
export interface WorkerState {
  id: string; name: string; kind: WorkerKind; blurb: string; pkg: string; color: string; defaultGoodFor: string;
  model: string; wireApi: WireApi; goodFor: string; enabled: boolean; key: { saved: boolean; tail: string }; installed: boolean;
}
export interface WorkersState { baseUrl: string; encrypted: boolean; items: WorkerState[] }
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
  | { type: 'tool'; name: string; input: Record<string, unknown>; path: string | null; helper?: boolean; parent?: string }
  | { type: 'plan'; todos: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] }
  | { type: 'helper'; phase: 'start' | 'end'; id: string; name: string; desc: string; ok?: boolean; brief?: string }
  | { type: 'toolActive'; id: string; name: string; icon: string | null; color: string }
  | { type: 'result'; isError: boolean; costUsd?: number }
  | { type: 'limits'; kind?: string; used?: number; resetsAt?: number | null }
  | { type: 'audio'; seq: number; data: string }
  | { type: 'approval'; id: number; tool: string; summary: string; what: string; spoken: string; risky: boolean; canAll: boolean; helper?: boolean; chatTitle?: string }
  | { type: 'autoApproved'; summary: string }
  | { type: 'approved'; id: number; yes: boolean; question?: string }
  | { type: 'session'; id: string }
  | { type: 'error'; message: string }
  | { type: 'note'; message: string }
  | { type: 'open'; path: string }
  | { type: 'done' }
);

// A conversation kept on disk so it can be reopened (electron/chats.cjs). `items` is what the chat panel showed.
export interface ChatSummary { id: string; title: string; updated: number; count: number; interrupted?: boolean }
export interface SavedChat { id: string; title: string; sessionId: string | null; items: unknown[]; read: string[]; wrote: string[]; updated?: number; busy?: boolean; pick?: { model: string | null; effort: string | null } }

export type OrbState = 'idle' | 'listening' | 'thinking' | 'talking' | 'replying';

// ---- v2 ----
export type UsageV2 = Usage;

export type Method = 'subscription' | 'key';
export interface ProviderDef {
  id: string; name: string; by: string; color: string; methods: Method[];
  blurb: string; subscription?: string; keyUrl?: string; keyLooks?: string;
}
export interface Models { light: string; standard: string; strong: string }
// The gateway settings the window may see: header values never leave the main process, only their names.
export interface GatewayState { disableBetas: boolean; certFile: string; headerNames: string[] }
export interface GatewayExtra { headers?: string; disableBetas: boolean; certFile: string }
// What was found in Claude Code's own settings file (never the key or header values).
export interface ImportFound { baseUrl: string; keyFrom: string; headerNames: string[]; models: Models; switches: string[]; certFile: string; notes: string[] }
export interface ProvidersState {
  catalog: ProviderDef[];
  current: { id: string; method: Method; baseUrl: string; models: Models; key: { saved: boolean; tail: string }; price: { in?: number; out?: number } | null; gateway: GatewayState };
  encrypted: boolean;
}
export interface BrainStatus {
  ready: boolean; choices?: { id: string | null; name: string; note: string; unavailable?: boolean }[]; mode: 'plan' | 'api'; model: string; busy: boolean; running: string[]; allowEdits: boolean; onboarded: boolean;
  provider: { id: string; name: string; method: Method };
}
export interface Basics { onboarded: boolean; userName: string; vaultPath: string; vaultSet: boolean; okfMode: 'leave' | 'index' | 'tidy' | null; wakeWord: boolean; budgets: { daily: number; monthly: number }; openAtLogin: boolean; version: string }
export interface CliStatus { installed: boolean; signedIn: boolean; plan?: string; who?: string; name?: string; pkg?: string; error?: string }
export interface V1Look { found: boolean; groups: { id: string; label: string; count: number }[]; discord: boolean }
export type BrainEvent = ClaudeEvent | { chat?: string; type: 'brainChanged' };

// "Agentic OS discover" (electron/discover.cjs) and the choice about how notes are kept (electron/okf.cjs).
export type OkfMode = 'leave' | 'index' | 'tidy';
export interface DiscoverReport {
  root: string; exists: boolean; files: number; folders: number; truncated: boolean; slow?: boolean; partial?: boolean; headersSkipped?: boolean; error?: string;
  kinds: { notes: number; text: number; web: number; pdf: number; images: number; office: number; other: number };
  notes: { count: number; withHeader: number; sampled: number };
  structure: { foldersWithNotes: number; foldersWithIndex: number; hasRootIndex: boolean; hasLog: boolean; hasRules: boolean; hasSkills: boolean; hasManifest: boolean; manifestName: string | null };
  obsidian: boolean; git: boolean; topFolders: { name: string; files: number; notes: number; newest: number }[]; big: { rel: string; mb: number }[]; secrets: string[]; symlinks: number; newest: number;
  verdict: 'empty' | 'loose' | 'structured'; indexCoverage: number; headerCoverage: number;
}
export interface OkfResult { mode: OkfMode; made: string[]; kept: number; indexes: number; skills: number; manifest: 'ok' | 'other' }

// Search (electron/search.cjs)
export interface SearchHit { path: string; kind: 'note' | 'chat' | 'mail'; title: string; project: string; type: string; date: string; score: number; summary: string; staleWhen: string; enriched: boolean; newerTwin: string }
// Mail panel (electron/mail.cjs). `open` carries the message text and draft; `info` never does.
export interface MailItem { id: string; folder: string; subject: string; from: string; received: string; summary: string; atoms: string[]; reason: string; unread: boolean; status: 'open' | 'info' | 'done' | 'dismissed'; body?: string; draft?: string; draftError?: string; watch?: 'complete' | 'blocker' | 'escalation' | 'date'; watchLabel?: string; suggestion?: string; jira?: { confirmed: boolean; key?: string; summary?: string; status?: string; url?: string; at: number } }
export interface MailState { watch: MailItem[]; lastPull: number; running: boolean; open: MailItem[]; info: MailItem[]; closed: number; feedback: number; log: { at: number; kind: string; note: string; n?: number }[]; health: { ok: boolean; why: string } }
export interface MailPullResult { fetched: number; bulk: number; added: number; needReply: number; closed: number; failed: number; error: string; already?: boolean }
export interface SearchStatus { seeded: boolean; outputs: number; notes: number; chats: number; enriched: number; built: number | null; running: { total: number; done: number; startedAt: number } | null }

// Notes and Action items panels (electron/actions.cjs): plain markdown in the notes folder.
export interface ActionItem { project: string; name: string; origin?: string; file: string; raw: string; done: boolean; text: string; added: string | null; closed: string | null; note: string | null; register?: string; num?: number; summary?: string; updates?: { date: string; text: string }[] }
export interface NoteEntry { project: string; name: string; file: string; date: string; time: string; action: boolean; text: string }
// One week of older notes (before last week): its Monday as YYYY-MM-DD and its entries, newest first.
export interface NoteWeek { monday: string; entries: NoteEntry[] }
export interface SavedNote { project: string; file: string; date: string; time: string; action: ActionItem | null }

// Files inside the vault: the desktop window loads them over vault://, a paired phone over the app's web server.
export const vaultUrl = (rel: string) => 'vault://files/' + rel.split('/').map(encodeURIComponent).join('/');
