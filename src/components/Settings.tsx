import { useEffect, useState } from 'react';
import { getTheme, setTheme, type Theme } from '../theme';
import type { Basics } from '../types';
import BrainSetup from './BrainSetup';
import Icon from '../icons';
import NotesSetup from './NotesSetup';
import WorkersSetup from './WorkersSetup';
import Skills from './Skills';
import Value from './Value';
import Health from './Health';

// Settings: the look, the brain, the other models it can hand work to, the notes folder, the app itself, and the
// Skills, Value and Health pages (moved here from the side list).
export type Page = 'look' | 'brain' | 'others' | 'notes' | 'skills' | 'value' | 'health' | 'app';
const PAGES: { id: Page; label: string; icon: string; desktop?: boolean }[] = [
  { id: 'look', label: 'Look', icon: 'sun' },
  { id: 'brain', label: 'Brain', icon: 'brain', desktop: true },
  { id: 'others', label: 'Other models', icon: 'spark', desktop: true },
  { id: 'notes', label: 'Notes folder', icon: 'files', desktop: true },
  { id: 'skills', label: 'Skills', icon: 'skills' },
  { id: 'value', label: 'Value', icon: 'value' },
  { id: 'health', label: 'Health', icon: 'health' },
  { id: 'app', label: 'This app', icon: 'power', desktop: true },
];

export default function Settings({ onClose, onSetup, start, onOpen, chatItems, onAsk }: { onClose(): void; onSetup(): void; start?: Page; onOpen(path: string): void; chatItems: number; onAsk(text: string): void }) {
  const [page, setPage] = useState<Page>(start || 'look');
  const pages = PAGES;
  return (
    <div className="viewer-wrap tool" onClick={onClose}>
      <section className="panel viewer settings" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <span className="lbl strong">Settings</span>
          <span className="flex" />
          <button className="ghost small" onClick={onClose} aria-label="Close settings">✕</button>
        </div>
        <div className="viewer-body">
          <div className="set">
            <nav className="set-nav" aria-label="Settings pages">
              {pages.map((p) => <button key={p.id} className={page === p.id ? 'on' : ''} onClick={() => setPage(p.id)}><Icon name={p.icon} size={16} />{p.label}</button>)}
            </nav>
            <div className="set-body" key={page}>
              {page === 'look' && <Look />}
              {page === 'brain' && <><h2>Brain</h2><p>The AI Agentic OS thinks with. Use the gateway address and key you were given, an Anthropic key, or your own Claude plan. Switching takes effect on the next question; open chats start fresh on the new brain.</p><BrainSetup compact /></>}
              {page === 'others' && <><h2>Other models</h2><p>Models and coding agents Agentic OS can hand a job to, using your company's keys. Claude stays the brain: it writes the instructions, asks you once before each job, and checks the work before anything lands in your notes.</p><WorkersSetup /></>}
              {page === 'notes' && <Notes />}
              {page === 'skills' && <Skills embedded onClose={onClose} onOpen={onOpen} />}
              {page === 'value' && <Value embedded onClose={onClose} />}
              {page === 'health' && <Health embedded onClose={onClose} onOpen={onOpen} chatItems={chatItems} onAsk={onAsk} />}
              {page === 'app' && <AppPage onSetup={onSetup} />}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// Appearance only: Agentic OS is text only at launch, so there is no voice to set, and no spending meter until it is known
// how a gateway reports cost.
function Look() {
  const [theme, setLook] = useState<Theme>(getTheme);
  const look = (t: Theme) => { setLook(t); setTheme(t); };
  return (
    <>
      <h2>Look</h2>
      <div className="setting">
        <div className="setting-head"><span className="lbl">Appearance</span><span className="small muted">{theme === 'light' ? 'Light' : 'Dark'}</span></div>
        <div className="cn-seg theme-seg" role="radiogroup" aria-label="Appearance" style={{ alignSelf: 'flex-start' }}>
          <button role="radio" aria-checked={theme === 'light'} className={theme === 'light' ? 'on' : ''} onClick={() => look('light')}>Light</button>
          <button role="radio" aria-checked={theme === 'dark'} className={theme === 'dark' ? 'on' : ''} onClick={() => look('dark')}>Dark</button>
        </div>
        <p className="muted small">Changes straight away and is remembered.</p>
      </div>
    </>
  );
}

function Notes() {
  return (
    <>
      <h2>Notes folder</h2>
      <p>The folder Agentic OS reads and writes. The map, Projects and Skills all come from it.</p>
      <NotesSetup />
      <p className="muted small">Changing it takes effect at once. Chats already open keep the instructions they started with, so start a new chat afterwards.</p>
    </>
  );
}

function AppPage({ onSetup }: { onSetup(): void }) {
  const [b, setB] = useState<Basics | null>(null);
  const [name, setName] = useState('');
  useEffect(() => { window.aos.setup.get().then((x) => { setB(x); setName(x.userName); }); }, []);
  if (!b) return <span className="muted small">loading…</span>;
  const set = (patch: Partial<Basics>) => window.aos.setup.set(patch).then(setB);
  return (
    <>
      <h2>This app</h2>
      <label className="lab" style={{ maxWidth: 320 }}>What Agentic OS calls you<input className="field" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && set({ userName: name.trim() })} maxLength={40} /></label>
      <div className="card opt">
        <div><b>Start at login</b><p>Opens Agentic OS when you sign in to this computer.</p></div>
        <button className="switch" role="switch" aria-checked={b.openAtLogin} aria-label="Start at login" onClick={() => set({ openAtLogin: !b.openAtLogin })} />
      </div>
      <div className="card opt">
        <div><b>Run setup again</b><p>Walk through the welcome steps: name, brain, notes folder, extras.</p></div>
        <button className="ghost" onClick={onSetup}>Open setup</button>
      </div>
      <p className="muted small mono">Agentic OS v{b.version}</p>
    </>
  );
}
