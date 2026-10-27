import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatSummary, SearchHit, TreeNode } from '../types';
import Icon from '../icons';
import { flatten } from './Files';
import { SETTINGS_TOOLS, TOOLS, type Tool } from './Nav';
import { dedupeTwins } from './dedupe';

// Ctrl+K: one box to jump anywhere. Tools, actions, past chats and every file in the vault, filtered as you type.
// Anything that isn't a match can be sent to Agentic OS as a question with Enter.
export interface Action { id: string; label: string; icon: string; run(): void }
interface Item { key: string; group: string; label: string; icon: string; path?: string; sub?: string; flags?: string[]; run(): void }

export default function Palette({ tree, actions, onTool, onFile, onChat, onAsk, onClose }: {
  tree: TreeNode[]; actions: Action[]; onTool(t: Tool): void; onFile(p: string): void; onChat(id: string): void; onAsk(text: string): void; onClose(): void;
}) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  useEffect(() => { window.aos.chats.list().then(setChats).catch(() => {}); }, []);
  const files = useMemo(() => flatten(tree), [tree]);
  const list = useRef<HTMLDivElement>(null);
  // Search of what the notes say, not just their names: summaries made by the search index, newest first among equals.
  const [found, setFound] = useState<SearchHit[]>([]);
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) { setFound([]); return; }
    let live = true;
    const t = setTimeout(() => { window.aos.search.query(text, 8).then((r) => { if (live) setFound(r); }).catch(() => { if (live) setFound([]); }); }, 160);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  const items = useMemo<Item[]>(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (s: string) => words.every((w) => s.toLowerCase().includes(w));
    const out: Item[] = [];
    for (const t of [...TOOLS, ...SETTINGS_TOOLS, { tool: 'settings' as Tool, label: 'Settings', icon: 'settings', about: 'look brain notes folder' }]) if (hit(`${t.label} ${t.about} open`)) out.push({ key: 't:' + t.tool, group: 'Go to', label: t.label, icon: t.icon, run: () => onTool(t.tool) });
    for (const a of actions) if (hit(a.label)) out.push({ key: 'a:' + a.id, group: 'Do', label: a.label, icon: a.icon, run: a.run });
    for (const c of chats.filter((c) => hit(c.title)).slice(0, words.length ? 8 : 4)) out.push({ key: 'c:' + c.id, group: 'Chats', label: c.title, icon: 'chat', run: () => onChat(c.id) });
    if (words.length) {
      // file name matches first, then matches anywhere in the path
      const named = files.filter((f) => hit(f.name)), pathed = files.filter((f) => !hit(f.name) && hit(f.path));
      for (const f of [...named, ...pathed].slice(0, 40)) out.push({ key: 'f:' + f.path, group: 'Files', label: f.name, icon: 'file', path: f.path, run: () => onFile(f.path) });
      // what the notes say: skip any file already listed by name above, and open a past chat from its hit
      const listed = new Set(out.filter((o) => o.path).map((o) => o.path));
      // a working copy next to the finished file (same title, same session folder) is listed once, the finished one
      const twinFree = dedupeTwins(found.filter((h) => h.kind === 'note'), (h) => h.title, (h) => h.path);
      for (const h of found) {
        if (h.kind === 'note' && !twinFree.includes(h)) continue;
        if (h.kind === 'chat') { out.push({ key: 's:' + h.path, group: 'Documents', label: h.title, icon: 'chat', sub: h.summary, run: () => onChat(h.path.replace(/^chat:/, '')) }); continue; }
        if (h.kind === 'mail') { out.push({ key: 's:' + h.path, group: 'Documents', label: h.title, icon: 'mail', sub: h.summary, run: () => onTool('mail') }); continue; }
        if (listed.has(h.path)) continue;
        const flags: string[] = [];
        if (h.staleWhen) flags.push('Check: ' + h.staleWhen);
        if (h.newerTwin) flags.push('A newer copy: ' + h.newerTwin);
        out.push({ key: 's:' + h.path, group: 'Documents', label: h.title, icon: 'file', path: h.path, sub: h.summary, flags, run: () => onFile(h.path) });
      }
      out.push({ key: 'ask', group: 'Ask', label: `Ask Agentic OS: "${q.trim()}"`, icon: 'spark', run: () => onAsk(q.trim()) });
    }
    return out;
  }, [q, chats, files, actions, found]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => { list.current?.querySelector('.pal-item.on')?.scrollIntoView({ block: 'nearest' }); }, [at]);
  const go = (it?: Item) => { if (!it) return; onClose(); it.run(); };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(items[at]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <div className="pal-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="panel pal" role="dialog" aria-label="Search and commands">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key} placeholder="Search files, chats and tools, or ask Agentic OS…" aria-label="Search" />
        <div className="pal-list" ref={list}>
          {items.map((it, i) => (
            <div key={it.key}>
              {(i === 0 || items[i - 1].group !== it.group) && <div className="pal-group">{it.group}</div>}
              <button className={`pal-item${i === at ? ' on' : ''}`} onMouseEnter={() => setAt(i)} onClick={() => go(it)}>
                <Icon name={it.icon} />
                {it.sub || it.flags?.length ? (
                  <span className="pal-two"><span className="pal-title">{it.label}</span>{it.sub && <span className="pal-sub">{it.sub}</span>}{it.flags?.map((f) => <span key={f} className="pal-flag">{f}</span>)}{it.path && <span className="pal-path">{it.path}</span>}</span>
                ) : (<><span>{it.label}</span>{it.path && <span className="path">{it.path}</span>}</>)}
              </button>
            </div>
          ))}
          {items.length === 0 && <div className="muted small" style={{ padding: 16 }}>Nothing matches.</div>}
        </div>
        <div className="pal-foot"><span>↑↓ move</span><span>Enter open</span><span>Esc close</span></div>
      </div>
    </div>
  );
}
