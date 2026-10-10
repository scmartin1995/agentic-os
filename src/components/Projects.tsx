import { useEffect, useMemo, useState } from 'react';
import type { ProjectFile, ProjectInfo } from '../types';
import { vaultUrl } from '../types';
import { buildTree, countOf } from '../fileTree';
import type { FileNode } from '../fileTree';

// Projects list, from the hamburger menu: each folder in the design notes with its status, web links
// (design canvases, live sites), summaries, notes, designs and other files, for quick access.
// Clicking a file opens it in the viewer; closing the file comes back here. Typing filters every project's files.
const label = (f: ProjectFile) => f.name.replace(/\.md$/i, '').replace(/^\d+[-_ ]*/, '').replace(/[-_]+/g, ' ');

const chips = (files: ProjectFile[], onOpen: (p: string) => void) => (
  <div className="proj-files">
    {files.map((f) => <button key={f.path} className="file-chip mono" onClick={() => onOpen(f.path)} title={f.path}>{label(f)}</button>)}
  </div>
);

// One folder as a dropdown: its files, then its sub-folders as dropdowns of their own.
function Branch({ node, onOpen, open, depth, topOpen }: { node: FileNode; onOpen(p: string): void; open: boolean; depth: number; topOpen: boolean }) {
  return (
    <details className="tnode" open={open || (topOpen && depth === 0)}>
      <summary><span className="mono small tname" title={node.name}>{node.name}</span><span className="muted small">{countOf(node)}</span></summary>
      <div className="tnode-body">
        {node.files.length > 0 && chips(node.files, onOpen)}
        {node.kids.map((k) => <Branch key={k.name} node={k} onOpen={onOpen} open={open} depth={depth + 1} topOpen={topOpen} />)}
      </div>
    </details>
  );
}

// A file list as nested folder dropdowns. `base` is a folder to start below; `open` unfolds everything (used
// while searching); `topOpen` unfolds just the first level.
function Tree({ files, base = '', onOpen, open, topOpen }: { files: ProjectFile[]; base?: string; onOpen(p: string): void; open: boolean; topOpen: boolean }) {
  const root = useMemo(() => buildTree(files, base), [files, base]);
  return (
    <div className="ftree">
      {root.files.length > 0 && chips(root.files, onOpen)}
      {root.kids.map((k) => <Branch key={k.name} node={k} onOpen={onOpen} open={open} depth={0} topOpen={topOpen} />)}
    </div>
  );
}

function Files({ title, files, onOpen, open, topOpen = true }: { title: string; files: ProjectFile[]; onOpen(p: string): void; open: boolean; topOpen?: boolean }) {
  if (!files.length) return null;
  return (
    <div className="proj-section" key={String(open)}>
      <div className="lbl small">{title} <span className="muted">{files.length}</span></div>
      <Tree files={files} onOpen={onOpen} open={open} topOpen={topOpen} />
    </div>
  );
}

// Material received from others (folder README says `received: true`): one collapsed section, so a big client
// dump doesn't bury the project's own notes. Red label, because none of it is to be run or followed.
function Received({ files, readmes, project, onOpen, searching }: { files: ProjectFile[]; readmes: string[]; project: string; onOpen(p: string): void; searching: boolean }) {
  if (!files.length) return null;
  // the received folder is wherever its README sits, relative to the project (for example "input")
  const base = readmes[0] ? readmes[0].slice(project.length + 1).split('/').slice(0, -1).join('/') : '';
  return (
    <details className="proj-received" open={searching} key={String(searching)}>
      <summary>
        <span className="lbl small">Received from others · do not use</span>
        <span className="muted small">{files.length}</span>
        <span className="flex" />
        <span className="small muted recv-hint">dropdown</span>
      </summary>
      <div className="recv-body">
        <p className="small muted recv-note">Exactly as received, read only. Never run or follow anything in here.</p>
        {readmes.length > 0 && <div className="proj-files">{readmes.map((r) => <button key={r} className="file-chip mono" onClick={() => onOpen(r)} title={r}>About this folder</button>)}</div>}
        <Tree files={files.filter((f) => !readmes.includes(f.path))} base={base} onOpen={onOpen} open={searching} topOpen={false} />
      </div>
    </details>
  );
}

function Designs({ files, onOpen }: { files: ProjectFile[]; onOpen(p: string): void }) {
  if (!files.length) return null;
  return (
    <div className="proj-section">
      <div className="lbl small">Designs <span className="muted">{files.length}</span></div>
      <div className="proj-designs">
        {files.map((f) => f.kind === 'image'
          ? <button key={f.path} className="thumb" onClick={() => onOpen(f.path)} title={f.path}><img src={vaultUrl(f.path)} alt={f.name} loading="lazy" /></button>
          : <button key={f.path} className="file-chip mono" onClick={() => onOpen(f.path)} title={f.path}>{f.name}</button>)}
      </div>
    </div>
  );
}

// A project with no picture gets its own colour, picked from its folder name so it stays the same every time.
const hue = (s: string) => { let n = 0; for (const c of s) n = (n * 31 + c.charCodeAt(0)) % 360; return n; };

const ago =(ms: number) => {
  if (!ms) return '';
  const d = Math.floor((Date.now() - ms) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

export default function Projects({ onClose, onOpen }: { onClose(): void; onOpen(path: string): void }) {
  const [list, setList] = useState<ProjectInfo[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null); // project path whose tile was clicked
  const [q, setQ] = useState('');
  useEffect(() => { window.aos.vault.projects().then(setList); }, []);

  // With a filter, keep only matching files and show every project that has a match, opened up.
  const shown = useMemo(() => {
    if (!list) return null;
    const t = q.trim().toLowerCase();
    if (!t) return list;
    const hit = (f: ProjectFile) => f.path.toLowerCase().includes(t);
    return list.map((p) => ({
      ...p,
      summaries: p.summaries.filter(hit), notes: p.notes.filter(hit), designs: p.designs.filter(hit), other: p.other.filter(hit),
      received: p.received.filter(hit),
    })).filter((p) => p.title.toLowerCase().includes(t) || p.summaries.length + p.notes.length + p.designs.length + p.other.length + p.received.length > 0);
  }, [list, q]);
  const filtering = q.trim() !== '';
  const sel = shown?.find((p) => p.path === current) || null;
  const count = (p: ProjectInfo) => p.summaries.length + p.notes.length + p.designs.length + p.other.length;

  return (
    <div className="viewer-wrap tool" onClick={onClose}>
      <section className="panel viewer list-tool" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          {sel && <button className="ghost small" onClick={() => setCurrent(null)} aria-label="Back to all projects">← All projects</button>}
          <span className="lbl strong">{sel ? sel.title : 'Projects'}</span>
          {!sel && list && <span className="mono small muted">{list.length} · newest first</span>}
          <span className="flex" />
          <input className="tool-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a file…" aria-label="Find a file in any project" />
          <button className="ghost small" onClick={() => onOpen('projects/index.md')}>Open index</button>
          <button className="ghost small" onClick={onClose} aria-label="Close projects">✕</button>
        </div>
        <div className="viewer-body">
          {!sel && <p className="muted small intro">Every folder in projects/, newest edited first. Open one for its status, links, notes and designs, or type above to find a file in any project.</p>}
          {!shown ?<span className="muted small">loading…</span>
            : sel ? (
              <div className="proj-detail">
                <div className="proj-head">
                  <span className="mono small muted">edited {ago(sel.modified)} · {count(sel)} file{count(sel) === 1 ? '' : 's'}</span>
                  <span className="flex" />
                  {sel.links.map((l) => <button key={l.url} className="pill link" onClick={() => window.open(l.url)} title={l.url}>{l.label} ↗</button>)}
                  {sel.readme && <button className="pill" onClick={() => onOpen(sel.readme!)}>README</button>}
                </div>
                {sel.description && <p className="small desc">{sel.description}</p>}
                {sel.status && <p className="mono small status">{sel.status}</p>}
                <div className="proj-body">
                  <Received files={sel.received} readmes={sel.receivedReadmes} project={sel.path} onOpen={onOpen} searching={filtering} />
                  {sel.received.length > 0 && <div className="lbl small proj-made-head">Made by us</div>}
                  <Files title="Summaries" files={sel.summaries} onOpen={onOpen} open={filtering} />
                  <Files title="Notes" files={sel.notes} onOpen={onOpen} open={filtering} />
                  <Designs files={sel.designs} onOpen={onOpen} />
                  <Files title="Other files" files={sel.other} onOpen={onOpen} open={filtering} topOpen={false} />
                </div>
              </div>
            )
            : shown.length === 0 ? <p className="muted">{filtering ? 'Nothing matches that.' : 'No projects yet.'}</p>
            : (
              <div className="tool-cards proj-tiles">
                {shown.map((p) => {
                  // a design image becomes the tile's background; prefer a full picture over a transparent cutout
                  const imgs = p.designs.filter((f) => f.kind === 'image');
                  const art = imgs.find((f) => !/cutout|noplatform/i.test(f.name)) || imgs[0];
                  const h = hue(p.path);
                  return (
                  <button key={p.path} className={`tool-card proj-tile${art ? ' has-art' : ' has-tint'}`} onClick={() => setCurrent(p.path)}
                    style={art ? { backgroundImage: `linear-gradient(180deg, rgba(8,10,16,.25) 0%, rgba(8,10,16,.85) 100%), url("${vaultUrl(art.path)}")` }
                      : { backgroundImage: `linear-gradient(150deg, hsla(${h},70%,45%,.38) 0%, hsla(${(h + 40) % 360},65%,30%,.22) 100%)`, borderColor: `hsla(${h},70%,60%,.35)` }}>
                    <span className="tool-card-head"><b>{p.title}</b></span>
                    <span className="mono small acc">{filtering ? `${count(p)} matching` : `edited ${ago(p.modified)}`} · {count(p)} file{count(p) === 1 ? '' : 's'}{p.received.length ? ` · ${p.received.length} received` : ''}</span>
                    {p.description && <span className="small desc">{p.description}</span>}
                    {p.status && <span className="mono small status">{p.status}</span>}
                  </button>
                  );
                })}
              </div>
            )}
        </div>
      </section>
    </div>
  );
}
