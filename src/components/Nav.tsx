import Icon from '../icons';

// Navigation. v1 hid its tools behind a hamburger menu; v2 keeps them one click away:
// a dock down the left on a PC, and a tab bar plus a tools sheet on a phone or a narrow window.
export type Tool = 'dashboard' | 'settings' | 'skills' | 'projects' | 'actions' | 'mail' | 'notes' | 'dreams' | 'value' | 'health' | 'connectors';
export type Tab = 'chat' | 'files' | 'tools' | 'graph';

// Pages that now live under Settings. Not in the side list, but still found by search (Ctrl+K); openTool sends them to Settings.
export const SETTINGS_TOOLS: { tool: Tool; label: string; icon: string; about: string }[] = [
  { tool: 'skills', label: 'Skills', icon: 'skills', about: 'How Agentic OS does each kind of task (in Settings)' },
  { tool: 'value', label: 'Value', icon: 'value', about: 'Time saved and what it is worth (in Settings)' },
  { tool: 'health', label: 'Health', icon: 'health', about: 'Skills, notes and background jobs (in Settings)' },
];

export const TOOLS: { tool: Tool; label: string; icon: string; about: string }[] = [
  { tool: 'projects', label: 'Projects', icon: 'projects', about: 'Every project and what it produced' },
  { tool: 'actions', label: 'Action Panel', icon: 'actions', about: 'Open action items from every project (Ctrl+Shift+A)' },
  { tool: 'mail', label: 'Mail', icon: 'mail', about: 'Last week of Outlook: what needs a reply, with a draft' },
  { tool: 'notes', label: 'Notes', icon: 'notes', about: 'Jot a dated note into a project (Ctrl+Shift+N)' },
  { tool: 'dreams', label: 'Dreams', icon: 'dreams', about: 'Nightly ideas worth acting on' },
  { tool: 'connectors', label: 'Connectors', icon: 'connectors', about: 'Apps Agentic OS can reach' },
];

// The side list (look B, "Calm paper"): the name at the top, every tool as a labelled row, and at the bottom who is
// signed in and which brain Agentic OS is on. On a Mac the window dots sit above the name.
// The arrow next to the name folds the list to its icons (and back); App remembers the choice.
export function Rail({ tool, onPick, onHome, badges, top, who, slim, onSlim }: {
  tool: Tool | null; onPick(t: Tool): void; onHome(): void; badges: Partial<Record<Tool, number>>;
  slim?: boolean; onSlim?(v: boolean): void;
  top?: React.ReactNode;
  who?: { name: string; line: string; ok: boolean; onClick(): void };
}) {
  return (
    <nav className="rail side" aria-label="Tools">
      {top}
      <div className="side-brand"><i className="brand-dot" aria-hidden /><b>Agentic OS</b>
        {onSlim && <button className="side-fold" onClick={() => onSlim(!slim)} title={slim ? 'Show the labels' : 'Fold to icons'} aria-label={slim ? 'Show the labels' : 'Fold to icons'} aria-expanded={!slim}><Icon name="chev" size={16} /></button>}
      </div>
      <button className={tool === null ? 'on' : ''} onClick={onHome} title="Home: chat, with your notes map at the side" aria-label="Home"><Icon name="home" /><span>Home</span></button>
      {TOOLS.map((t) => (
        <button key={t.tool} className={tool === t.tool ? 'on' : ''} onClick={() => onPick(t.tool)} title={t.about} aria-label={t.label}>
          <Icon name={t.icon} /><span>{t.label}</span>
          {!!badges[t.tool] && <b className="n" aria-label={`${badges[t.tool]} new`}>{badges[t.tool]}</b>}
        </button>
      ))}
      <div className="gap" />
      <button className={tool === 'settings' ? 'on' : ''} onClick={() => onPick('settings')} title="Settings" aria-label="Settings"><Icon name="settings" /><span>Settings</span></button>
      {who && (
        <button className="side-who" onClick={who.onClick} title="Which AI Agentic OS uses and how it signs in. Click to change.">
          <Icon name="brain" /><span><b>{who.name || 'You'}</b><em className={who.ok ? '' : 'off'}>{who.line}</em></span>
        </button>
      )}
    </nav>
  );
}

export function Tabs({ tab, onTab, badge }: { tab: Tab; onTab(t: Tab): void; badge: number }) {
  const items: { id: Tab; label: string; icon: string }[] = [
    { id: 'chat', label: 'Agentic OS', icon: 'chat' }, { id: 'files', label: 'Projects', icon: 'projects' },
    { id: 'tools', label: 'Tools', icon: 'tools' }, { id: 'graph', label: 'Map', icon: 'home' },
  ];
  return (
    <nav className="tabs" aria-label="Sections">
      {items.map((t) => (
        <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => onTab(t.id)} aria-current={tab === t.id}>
          <Icon name={t.icon} /><span>{t.label}</span>
          {t.id === 'tools' && badge > 0 && <b className="n">{badge}</b>}
        </button>
      ))}
    </nav>
  );
}

export function ToolsSheet({ onPick, badges }: { onPick(t: Tool): void; badges: Partial<Record<Tool, number>> }) {
  return (
    <div className="sheet-tools">
      {[...TOOLS, { tool: 'settings' as Tool, label: 'Settings', icon: 'settings', about: 'Look, brain and notes folder' }].map((t) => (
        <button key={t.tool} className="card" onClick={() => onPick(t.tool)}>
          <Icon name={t.icon} />{t.label}<span>{t.about}</span>
          {!!badges[t.tool] && <b className="n">{badges[t.tool]}</b>}
        </button>
      ))}
    </div>
  );
}
