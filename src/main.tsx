import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';

import './styles/panels.css';
import './styles/shell.css';
import './styles/notes.css';
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
      <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: '#060608', color: '#cfe9ee', font: '16px/1.5 Segoe UI, system-ui, sans-serif' }}>
        <div style={{ maxWidth: 480, margin: 20, padding: '28px 32px', border: '1px solid rgba(227,154,111,.35)', borderRadius: 14 }}>
          <h1 style={{ margin: '0 0 8px', fontSize: 18, color: '#e39a6f' }}>Something broke in the window</h1>
          <p style={{ margin: '0 0 14px', color: '#9db4ba' }}>Your chats are saved. Reload to carry on.</p>
          <p style={{ margin: '0 0 16px', color: '#6c8288', fontSize: 13 }}>{this.state.err}</p>
          <button onClick={() => location.reload()} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #6fe3f2', background: 'transparent', color: '#6fe3f2', cursor: 'pointer' }}>Reload</button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(<Safety><App /></Safety>);
