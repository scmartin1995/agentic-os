import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/300.css'; // look B's light headings
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import './styles/panels.css';
import './styles/shell.css';
import './styles/notes.css';
import './styles/paper.css'; // look B ("Calm paper"): layout and look, loaded last so it wins
import './aos'; // builds window.aos (desktop bridge or phone link) before anything draws
import App from './App';
import { applyTheme } from './theme';

applyTheme(); // dark or light (Settings), set before the first paint so a light window never flashes dark panels

// If the page itself throws while drawing, show a way back instead of an empty window. Chats are saved on disk.
class Safety extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { err: e instanceof Error ? e.message : String(e) }; }
  render() {
    if (this.state.err === null) return this.props.children;
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: '#161616', color: '#f4f4f4', font: '16px/1.5 Segoe UI, system-ui, sans-serif' }}>
        <div style={{ maxWidth: 480, margin: 20, padding: '28px 32px', border: '1px solid rgba(190,149,255,.35)', borderRadius: 14 }}>
          <h1 style={{ margin: '0 0 8px', fontSize: 18, color: '#be95ff' }}>Something broke in the assistant's window</h1>
          <p style={{ margin: '0 0 14px', color: '#a8a8a8' }}>Your chats are saved. Reload to carry on.</p>
          <p style={{ margin: '0 0 16px', color: '#8d8d8d', fontSize: 13 }}>{this.state.err}</p>
          <button onClick={() => location.reload()} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #78a9ff', background: 'transparent', color: '#78a9ff', cursor: 'pointer' }}>Reload</button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(<Safety><App /></Safety>);
