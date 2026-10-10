import { useMemo, useState } from 'react';
import type { TreeNode } from '../types';

// The workspace's file tree, with a filter box. Files the assistant has read carry a mark, the one
// they are reading glows, and folders on the way to it open by themselves.
function Node({ n, depth, read, reading, open, onOpen, expanded, toggle }: {
  n: TreeNode; depth: number; read: Set<string>; reading: string | null; open: string | null;
  onOpen(p: string): void; expanded: Set<string>; toggle(p: string): void;
}) {
  const pad = { paddingLeft: 8 + depth * 14 };
  if (n.dir) {
    const isOpen = expanded.has(n.path);
    return (
      <>
        <button className={`tree-row ${isOpen ? 'bright' : ''}`} style={pad} onClick={() => toggle(n.path)} aria-expanded={isOpen}>
          <span className="tw">{isOpen ? '▾' : '▸'}</span>{n.name}/
        </button>
        {isOpen && n.children?.map((c) => <Node key={c.path} n={c} depth={depth + 1} {...{ read, reading, open, onOpen, expanded, toggle }} />)}
      </>
    );
  }
  const state = n.path === reading ? 'now' : read.has(n.path) ? 'read' : '';
  return (
    <button className={`tree-row ${state} ${open === n.path ? 'sel' : ''}`} style={pad} onClick={() => onOpen(n.path)} title={n.path}>
      <span className={`mark ${state}`} />{n.name}
      {n.kind && n.kind !== 'md' && <span className={`tag ${n.kind}`}>{n.kind}</span>}
    </button>
  );
}

export const flatten = (nodes: TreeNode[], out: TreeNode[] = []) => { for (const n of nodes) { if (n.dir) flatten(n.children || [], out); else out.push(n); } return out; };

export default function Files({ tree, root, read, reading, open, onOpen }: {
  tree: TreeNode[]; root: string; read: string[]; reading: string | null; open: string | null; onOpen(p: string): void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['projects']));
  const toggle = (p: string) => setExpanded((s) => { const c = new Set(s); c.has(p) ? c.delete(p) : c.add(p); return c; });
  const [q, setQ] = useState('');
  const readSet = useMemo(() => new Set(read), [read]);
  const all = useMemo(() => flatten(tree), [tree]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length ? all.filter((f) => words.every((w) => f.path.toLowerCase().includes(w))).slice(0, 200) : null;

  // Auto-expand folders on the path to whatever the agent is reading.
  const target = reading || open;
  if (target) {
    const parts = target.split('/');
    const need = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/')).filter((p) => !expanded.has(p));
    if (need.length) setTimeout(() => setExpanded((s) => new Set([...s, ...need])));
  }
  const name = root.split(/[\\/]/).filter(Boolean).pop() || 'notes';

  return (
    <section className="panel files">
      <div className="files-head">
        <span className="lbl" title={root}>{name}</span>
        <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter files…" aria-label="Filter files" />
      </div>
      <div className="tree mono">
        {hits ? (hits.length ? hits.map((f) => (
          <button key={f.path} className={`tree-row ${f.path === reading ? 'now' : readSet.has(f.path) ? 'read' : ''} ${open === f.path ? 'sel' : ''}`} onClick={() => onOpen(f.path)} title={f.path}>
            <span className={`mark ${f.path === reading ? 'now' : readSet.has(f.path) ? 'read' : ''}`} />{f.path}
          </button>
        )) : <div className="muted small" style={{ padding: 10 }}>Nothing matches.</div>)
          : tree.length ? tree.map((n) => <Node key={n.path} n={n} depth={0} read={readSet} {...{ reading, open, onOpen, expanded, toggle }} />)
          : <div className="muted small" style={{ padding: 10 }}>No files here yet.</div>}
      </div>
      <div className="legend mono small muted"><span><i className="mark read" />read</span><span><i className="mark now" />reading</span><span className="flex" />{all.length} files</div>
    </section>
  );
}
