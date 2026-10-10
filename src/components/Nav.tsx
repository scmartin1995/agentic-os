import Icon from '../icons';

// Navigation: a labelled list down the left on a PC, and a tab bar plus a tools sheet on a phone or a narrow window.
export type Tool = 'dashboard' | 'settings' | 'skills' | 'projects' | 'actions' | 'notes' | 'dreams' | 'health' | 'connectors';
export type Tab = 'chat' | 'files' | 'tools' | 'graph';

// The workspace pages first, then the pages about the app itself.
export const TOOLS: { tool: Tool; label: string; icon: string; about: string; group: 'work' | 'app' }[] = [
  { tool: 'projects', label: 'Projects', icon: 'projects', about: 'Every project folder and its files', group: 'work' },
  { tool: 'actions', label: 'Actions', icon: 'actions', about: 'Open action items from every project (Ctrl+Shift+A)', group: 'work' },
  { tool: 'notes', label: 'Notes', icon: 'notes', about: 'Jot a dated note into a project (Ctrl+Shift+N)', group: 'work' },
  { tool: 'skills', label: 'Skills', icon: 'skills', about: 'How the assistant does each kind of task', group: 'work' },
  { tool: 'dreams', label: 'Nightly review', icon: 'dreams', about: 'Ideas worth acting on, from a look over your week', group: 'app' },
  { tool: 'dashboard', label: 'Usage', icon: 'dashboard', about: 'What was used and what it cost', group: 'app' },
  { tool: 'health', label: 'Health', icon: 'health', about: 'Skills, notes and background jobs', group: 'app' },
  { tool: 'connectors', label: 'Connectors', icon: 'connectors', about: 'Apps the assistant can reach', group: 'app' },
];

export function Rail({ tool, onPick, onHome, badges, counts, filesOn, onFiles, user, brain }: {
  tool: Tool | null; onPick(t: Tool): void; onHome(): void; badges: Partial<Record<Tool, number>>; counts: Partial<Record<Tool, number>>;
  filesOn: boolean; onFiles(): void; user: string; brain: string;
}) {
  const item = (t: (typeof TOOLS)[number]) => (
    <button key={t.tool} className={tool === t.tool ? 'on' : ''} onClick={() => onPick(t.tool)} title={t.about} aria-current={tool === t.tool}>
      <Icon name={t.icon} size={16} /><span>{t.label}</span>
      {badges[t.tool] ? <b className="n" aria-label={`${badges[t.tool]} open`}>{badges[t.tool]}</b> : counts[t.tool] ? <em className="count">{counts[t.tool]}</em> : null}
    </button>
  );
  return (
    <nav className="rail" aria-label="Pages">
      <button className={tool === null ? 'on' : ''} onClick={onHome} title="Home: the node map" aria-current={tool === null}><Icon name="home" size={16} /><span>Home</span></button>
      {TOOLS.filter((t) => t.group === 'work').map(item)}
      <div className="sepline" />
      {TOOLS.filter((t) => t.group === 'app').map(item)}
      <div className="gap" />
      <button className={filesOn ? 'on-soft' : ''} onClick={onFiles} title="Show or hide the file tree" aria-pressed={filesOn}><Icon name="files" size={16} /><span>File tree</span></button>
      <button className={tool === 'settings' ? 'on' : ''} onClick={() => onPick('settings')} title="Settings"><Icon name="settings" size={16} /><span>Settings</span></button>
      <div className="sepline" />
      <div className="rail-user"><b>{user || 'You'}</b><span className="mono">{brain}</span></div>
    </nav>
  );
}

export function Tabs({ tab, onTab, badge }: { tab: Tab; onTab(t: Tab): void; badge: number }) {
  const items: { id: Tab; label: string; icon: string }[] = [
    { id: 'chat', label: 'Chat', icon: 'chat' }, { id: 'files', label: 'Files', icon: 'files' },
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
      {[...TOOLS, { tool: 'settings' as Tool, label: 'Settings', icon: 'settings', about: 'Voice, look, brain and phone', group: 'app' as const }].map((t) => (
        <button key={t.tool} className="card" onClick={() => onPick(t.tool)}>
          <Icon name={t.icon} />{t.label}<span>{t.about}</span>
          {!!badges[t.tool] && <b className="n">{badges[t.tool]}</b>}
        </button>
      ))}
    </div>
  );
}
