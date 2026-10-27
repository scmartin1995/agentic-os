import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { FileContent } from '../types';
import { vaultUrl } from '../types';
import { revealLabel } from './Projects';

const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
function resolveRel(from: string, href: string) {
  const out: string[] = dirOf(from) ? dirOf(from).split('/') : [];
  for (const seg of href.split('#')[0].split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(decodeURIComponent(seg));
  }
  return out.join('/');
}

function parseCsv(text: string) {
  return text.trim().split(/\r?\n/).slice(0, 500).map((line) => {
    const cells: string[] = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    return cells;
  });
}

export default function Viewer({ path, onClose, onBack, onOpen }: { path: string; onClose(): void; onBack(): void; onOpen(p: string): void }) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [source, setSource] = useState(false);
  useEffect(() => { setFile(null); setSource(false); window.aos.vault.read(path).then(setFile); }, [path]);

  const html = useMemo(() => {
    if (file?.kind !== 'md' || !file.text) return '';
    const body = file.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''); // hide frontmatter in the rendered view
    return DOMPurify.sanitize(marked.parse(body, { async: false }) as string);
  }, [file]);

  // Links inside a note open inside the app; web links open in the browser.
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    e.preventDefault();
    if (/^https?:/.test(href)) { window.open(href); return; }
    if (href.startsWith('#')) return;
    let rel = resolveRel(path, href);
    if (href.endsWith('/')) rel += '/README.md';
    onOpen(rel);
  };

  const canSource = file && (file.kind === 'md' || file.kind === 'html');
  const isSkill = /\/SKILL\.md$/i.test(path);
  return (
    <div className="viewer-wrap tool" onClick={onClose}>
      <section className="panel viewer" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <button className="ghost small" onClick={onBack} aria-label="Back">← Back</button>
          <span className="mono small">{path}</span>
          <span className="flex" />
          {canSource && (
            <span className="seg mono small">
              <button className={!source ? 'on' : ''} onClick={() => setSource(false)}>Rendered</button>
              <button className={source ? 'on' : ''} onClick={() => setSource(true)}>Source</button>
            </span>
          )}
          {/* A skill is its whole folder (SKILL.md plus any references or scripts), so that folder is what gets shown, ready to share */}
          <button className="ghost small" onClick={() => { window.aos.vault.reveal(isSkill ? path.slice(0, -'/SKILL.md'.length) : path).catch(() => {}); }}>{isSkill ? `${revealLabel} (skill folder)` : revealLabel}</button>
          <button className="ghost small" onClick={() => window.aos.vault.openExternal(path)}>Open in its own app</button>
          <button className="ghost small" onClick={onClose} aria-label="Close file">✕</button>
        </div>
        <div className="viewer-body">
          {!file ? <p className="muted">Loading…</p>
            : file.error ? <p className="muted">Couldn't open this file.</p>
            : source && file.text != null ? <pre className="code">{file.text}</pre>
            : file.kind === 'md' ? <article className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
            : file.kind === 'html' ? <iframe className="frame" title={path} sandbox="allow-scripts" src={vaultUrl(path)} />
            : file.kind === 'pdf' ? <iframe className="frame" title={path} src={vaultUrl(path)} />
            : file.kind === 'image' ? <img className="pic" src={vaultUrl(path)} alt={path} />
            : file.kind === 'csv' && file.text != null ? (
              <div className="table-box"><table>{parseCsv(file.text).map((r, i) => <tr key={i}>{r.map((c, j) => i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>)}</tr>)}</table></div>
            )
            : file.text != null ? <pre className="code">{file.text}</pre>
            : <div className="muted"><p>{file.note || 'No preview for this file type.'}</p><button className="ghost" onClick={() => window.aos.vault.openExternal(path)}>Open in its own app</button></div>}
        </div>
      </section>
    </div>
  );
}
