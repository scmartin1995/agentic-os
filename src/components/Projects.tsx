import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Deliverable, FileType, ProjectFile, ProjectInfo, SessionInfo } from '../types';
import { vaultUrl } from '../types';
import { projectColor, rememberProjects } from '../colors';
import { os } from '../aos';
import Icon from '../icons';

// Projects: every project as a tile, newest edited first (or oldest, with the sort button), under the five files most
// recently edited anywhere. Opening one shows its files in tabs by what they are for: what it handed over
// (Deliverables), session write-ups, records, sessions (each with its own output and evidence), and the rest. Which
// tab a file lands in is decided in electron/vault.cjs projects(); "Not a deliverable" / "Make it a deliverable"
// correct it, kept in .aos/panel-overrides.json. Typing searches every file, in this project or all of them.
const label = (f: ProjectFile) => f.name.replace(/\.[a-z0-9]+$/i, '').replace(/^\d+[-_ ]*/, '').replace(/[-_]+/g, ' ');
const titleOf = (f: Deliverable) => f.title || label(f);
const KIND: Record<string, string> = { md: 'Note', html: 'Web page', pdf: 'PDF', image: 'Image', csv: 'Spreadsheet', text: 'Text' };
const EXT: Record<string, string> = { xlsx: 'Workbook', xls: 'Workbook', pptx: 'Deck', docx: 'Document', zip: 'Bundle', tsv: 'Spreadsheet', vtt: 'Transcript' };
const kindName = (f: ProjectFile & { bundle?: number }) => {
  if (f.bundle) return `Bundle of ${f.bundle} files`;
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  return KIND[f.kind] && f.kind !== 'text' ? KIND[f.kind] : EXT[ext] || ext.toUpperCase() || 'File';
};
const TYPE: Record<FileType, string> = { deliverable: 'Deliverable', note: 'Session note', record: 'Record', evidence: 'Input or work file', working: 'Working file', raw: 'Raw or tool file' };
const GROUP: Record<string, string> = {
  platform: 'Platforms', inventory: 'Inventory', csp: 'Cloud providers', shareddb: 'Shared databases', app: 'Applications', process: 'Processes',
  principles: 'Principles', risk: 'Risks', actionitem: 'Registers', accomplishment: 'Registers', team: 'Teams', person: 'People', tool: 'Tools',
  course: 'Courses', lesson: 'Lessons',
};
const groupName = (g?: string) => (g ? GROUP[g] || g.charAt(0).toUpperCase() + g.slice(1) : 'Other');
const SCRIPT = /\.(ps1|psm1|pl|bat|cmd|sh|py|js|cjs|mjs|ts|ahk|vbs)$/i;
const isDashboard = (f: Deliverable) => f.kind === 'html' && /dashboard/i.test(f.name);
const SHOW_DEFAULT = 12;
const WORK_DEFAULT = 12;
export const revealLabel = os === 'mac' ? 'Show in Finder' : 'Show in File Explorer';

const ago = (ms?: number) => {
  if (!ms) return '';
  const d = Math.floor((Date.now() - ms) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const reveal = (p: string) => { window.aos.vault.reveal(p).catch(() => {}); };

type Order = 'newest' | 'oldest';
const ORDER_KEY = 'aos-projects-order';
const rememberedOrder = (): Order => { try { return localStorage.getItem(ORDER_KEY) === 'oldest' ? 'oldest' : 'newest'; } catch { return 'newest'; } };
const byTime = (order: Order) => (a: { modified?: number }, b: { modified?: number }) => (order === 'newest' ? (b.modified || 0) - (a.modified || 0) : (a.modified || 0) - (b.modified || 0));

type Tab = 'deliverables' | 'notes' | 'records' | 'sessions' | 'working' | 'raw';
// A correction: what clicking the button sets. null clears it, so the file goes back to where its folder puts it.
const demoteTo = (f: Deliverable): FileType | null => (f.auto === 'deliverable' ? (f.kind === 'md' && !f.bundle ? 'note' : 'evidence') : null);
const promoteTo = (f: Deliverable): FileType | null => (f.auto === 'deliverable' ? null : 'deliverable');
const inSession = (f: Deliverable) => /\/Sessions\/[^/]+\//.test(f.path);

const Dot = ({ type }: { type: FileType }) => <i className={`ty-dot ty-${type}`} aria-hidden />;

// One deliverable: a picture when it is one, otherwise its type, title, description and where it came from. The tile
// opens it; the folder button shows it in File Explorer; "Not a deliverable" sends it back to its session.
function Tile({ f, onOpen, onDemote }: { f: Deliverable; onOpen(p: string): void; onDemote?(f: Deliverable): void }) {
  const title = titleOf(f);
  return (
    <div className="dl-tile">
      <button className="dl-open" onClick={() => onOpen(f.path)} title={f.path}>
        {f.kind === 'image' && <span className="dl-thumb"><img src={vaultUrl(f.path)} alt="" loading="lazy" /></span>}
        <span className="dl-kind">{kindName(f)}</span>
        <b className="dl-title">{title}</b>
        {f.description && <span className="dl-desc">{f.description}</span>}
        {f.from && <span className="dl-from">{f.from}</span>}
        <span className="dl-when">{ago(f.modified)}</span>
      </button>
      <button className="dl-reveal" onClick={() => reveal(f.path)} aria-label={`${revealLabel}: ${title}`} title={revealLabel}><Icon name="files" size={16} /></button>
      {onDemote && <button className="dl-demote" onClick={() => onDemote(f)} title={inSession(f) ? 'Keep it with its session, under Sessions, instead of here' : 'Move it to Working files instead of here'}>Not a deliverable</button>}
    </div>
  );
}

// Deliverables: dashboards first, then everything else in the chosen order, each capped until "Show all".
function Deliverables({ files, onOpen, onDemote, order }: { files: Deliverable[]; onOpen(p: string): void; onDemote(f: Deliverable): void; order: Order }) {
  const [all, setAll] = useState<Record<string, boolean>>({});
  const dash = files.filter(isDashboard).sort(byTime(order));
  const rest = files.filter((f) => !isDashboard(f)).sort(byTime(order));
  const group = (key: string, name: string | null, fs: Deliverable[]) => {
    if (!fs.length) return null;
    const shown = all[key] ? fs : fs.slice(0, SHOW_DEFAULT);
    return (
      <div className="dl-group" key={key}>
        {name && <h4 className="dl-sub">{name} <span>{fs.length}</span></h4>}
        <div className="dl-grid">{shown.map((f) => <Tile key={f.path} f={f} onOpen={onOpen} onDemote={onDemote} />)}</div>
        {fs.length > shown.length && <button className="linkish dl-more" onClick={() => setAll({ ...all, [key]: true })}>Show all {fs.length}</button>}
      </div>
    );
  };
  return <>{group('dash', dash.length ? 'Dashboards' : null, dash)}{group('rest', dash.length ? 'Everything else' : null, rest)}</>;
}

// A plain list of files: name, where it is, when it changed, an optional badge and button, and show-in-folder.
function Rows({ files, onOpen, cap, where, badge, action }: {
  files: Deliverable[]; onOpen(p: string): void; cap: number;
  where?(f: Deliverable): string; badge?(f: Deliverable): ReactNode; action?(f: Deliverable): ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, cap);
  return (
    <>
      <ul className="pf-rows">
        {shown.map((f) => (
          <li key={f.path}>
            <button className="pf-open" onClick={() => onOpen(f.path)} title={f.path}>
              <span className="pf-name">{titleOf(f)}</span>
              <span className="pf-where">{where ? where(f) : f.sub || 'project folder'}{f.kind !== 'md' ? ` · ${kindName(f)}` : ''}</span>
              <span className="pf-when">{ago(f.modified)}</span>
            </button>
            {badge?.(f)}
            {action?.(f)}
            <button className="pf-reveal" onClick={() => reveal(f.path)} aria-label={`${revealLabel}: ${f.name}`} title={revealLabel}><Icon name="files" size={15} /></button>
          </li>
        ))}
      </ul>
      {files.length > shown.length && <button className="linkish dl-more" onClick={() => setAll(true)}>Show all {files.length}</button>}
    </>
  );
}

function Records({ files, onOpen }: { files: Deliverable[]; onOpen(p: string): void }) {
  const [g, setG] = useState<string | null>(null);
  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of files) { const n = groupName(f.group); m.set(n, (m.get(n) || 0) + 1); }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files]);
  const shown = g ? files.filter((f) => groupName(f.group) === g) : files;
  return (
    <>
      {groups.length > 1 && (
        <div className="pj-chips" role="group" aria-label="Show records about">
          <button className="pj-chip" aria-pressed={!g} onClick={() => setG(null)}>All<span>{files.length}</span></button>
          {groups.map(([n, c]) => <button key={n} className="pj-chip" aria-pressed={g === n} onClick={() => setG(g === n ? null : n)}>{n}<span>{c}</span></button>)}
        </div>
      )}
      <Rows key={g || 'all'} files={shown} onOpen={onOpen} cap={40} where={(f) => groupName(f.group)} />
    </>
  );
}

// Sessions newest first. Opening one shows what it produced (each marked deliverable or note, with the button to
// change that) and the material that went into it.
function Sessions({ list, onOpen, onSet }: { list: SessionInfo[]; onOpen(p: string): void; onSet(f: Deliverable, to: FileType | null, done: string): void }) {
  const [more, setMore] = useState(false);
  const shown = more ? list : list.slice(0, 20);
  const toggle = (f: Deliverable) => f.type === 'deliverable'
    ? <button className="linkish pf-act" onClick={() => onSet(f, demoteTo(f), 'No longer listed under Deliverables.')}>Not a deliverable</button>
    : <button className="linkish pf-act" onClick={() => onSet(f, promoteTo(f), 'Listed under Deliverables now.')}>Make it a deliverable</button>;
  return (
    <>
      <div className="ses-list">
        {shown.map((s) => (
          <details className="ses" key={s.path}>
            <summary>
              <span className="ses-date">{s.date}</span>
              <span className="ses-title">{s.title}</span>
              <span className="ses-count">{s.output.length ? plural(s.output.length, 'output') : 'no output'}{s.evidence.length ? `, ${s.evidence.length} in` : ''}</span>
            </summary>
            <div className="ses-body">
              {s.outcome && <p className="ses-outcome">{s.outcome}</p>}
              {s.readme && <div><button className="ghost small" onClick={() => onOpen(s.readme!)}>Session page</button></div>}
              <h4 className="ses-h">Output</h4>
              {s.output.length
                ? <Rows files={s.output} onOpen={onOpen} cap={30} where={(f) => TYPE[f.type]} badge={(f) => <Dot type={f.type} />} action={toggle} />
                : <p className="pd-empty small">Nothing filed in Output yet.</p>}
              {s.evidence.length > 0 && (
                <>
                  <h4 className="ses-h">What went in</h4>
                  <Rows files={s.evidence} onOpen={onOpen} cap={8} where={(f) => f.sub.split('/').pop() || 'session folder'} />
                </>
              )}
            </div>
          </details>
        ))}
      </div>
      {list.length > shown.length && <button className="linkish dl-more" onClick={() => setMore(true)}>Show all {list.length} sessions</button>}
    </>
  );
}

// The finder: every file whose name, title or folder matches, in this project or all of them.
function Results({ hits, total, onOpen, project }: { hits: (Deliverable & { project: string })[]; total: number; onOpen(p: string): void; project: boolean }) {
  if (!hits.length) return <p className="pd-empty">No file matches that. Try part of the name, or a folder.</p>;
  return (
    <section className="pd-sec">
      <h3>Files that match <span>{total}</span></h3>
      <Rows files={hits} onOpen={onOpen} cap={60} where={(f) => [project ? '' : (f as Deliverable & { project: string }).project, f.sub].filter(Boolean).join(' / ') || 'project folder'}
        badge={(f) => <Dot type={f.type} />} />
    </section>
  );
}

export default function Projects({ onClose, onOpen }: { onClose(): void; onOpen(path: string): void }) {
  const [list, setList] = useState<ProjectInfo[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null); // project path whose tile was clicked
  const [q, setQ] = useState('');
  const [order, setOrder] = useState<Order>(rememberedOrder);
  const [tabs, setTabs] = useState<Record<string, Tab>>({}); // the tab last open in each project
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flipOrder = () => { const o: Order = order === 'newest' ? 'oldest' : 'newest'; setOrder(o); try { localStorage.setItem(ORDER_KEY, o); } catch { /* private mode */ } };
  const load = () => window.aos.vault.projects().then((ps) => { rememberProjects(ps.map((p) => p.folder)); setList(ps); }).catch(() => setList([]));
  useEffect(() => { load(); return window.aos.vault.onChanged(() => load()); }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const say = (text: string, undo?: () => void) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, undo });
    toastTimer.current = setTimeout(() => setToast(null), undo ? 6000 : 3500);
  };
  // Set a correction, then offer to put it back exactly as it was.
  const setType = async (f: Deliverable, to: FileType | null, done: string) => {
    const before = f.overridden ? f.type : null;
    try {
      await window.aos.vault.setOverride(f.path, to);
      say(done, async () => { try { await window.aos.vault.setOverride(f.path, before); say('Put back.'); } catch (e) { say(String((e as Error).message || e)); } await load(); });
    } catch (e) { say(String((e as Error).message || e)); }
    await load();
  };
  const demote = (f: Deliverable) => setType(f, demoteTo(f), inSession(f) ? 'Moved back to its session. Find it under Sessions.' : 'Moved to Working files.');
  const clearAll = async (p: ProjectInfo) => {
    try { await window.aos.vault.clearOverrides(p.path); say(`Every correction in ${p.title} is undone.`); } catch (e) { say(String((e as Error).message || e)); }
    await load();
  };

  const ordered = useMemo(() => (list ? [...list].sort(byTime(order)) : null), [list, order]);
  const sel = ordered?.find((p) => p.path === current) || null;

  // the five files edited most recently, anywhere: what you were just reading or writing
  const recent = useMemo(() => (list || [])
    .flatMap((p) => p.search.map((f) => ({ ...f, project: p.title })))
    .filter((f) => f.type !== 'raw' && !SCRIPT.test(f.name))
    .sort((a, b) => (b.modified || 0) - (a.modified || 0)).slice(0, 5), [list]);

  const t = q.trim().toLowerCase();
  const found = useMemo(() => {
    if (!t || !ordered) return null;
    const scope = sel ? [sel] : ordered;
    const hits = scope.flatMap((p) => p.search.map((f) => ({ ...f, project: p.title })))
      .filter((f) => f.path.toLowerCase().includes(t) || !!f.title?.toLowerCase().includes(t))
      .sort(byTime(order));
    return { hits: hits.slice(0, 60), total: hits.length };
  }, [t, ordered, sel, order]);

  const tabList = (p: ProjectInfo): [Tab, string, number][] => ([
    ['deliverables', 'Deliverables', p.deliverables.length],
    ['notes', 'Session notes', p.sessionNotes.length],
    ['records', 'Records', p.records.length],
    ['sessions', 'Sessions', p.sessions.length],
    ['working', 'Working files', p.working.length],
    ['raw', 'Raw and tools', p.raw.reduce((n, r) => n + r.count, 0)],
  ] as [Tab, string, number][]).filter(([k, , n]) => n > 0 || k === 'deliverables');
  const tabOf = (p: ProjectInfo): Tab => { const k = tabs[p.path]; return k && tabList(p).some(([x]) => x === k) ? k : 'deliverables'; };

  return (
    <div className="viewer-wrap tool" onClick={onClose}>
      <section className="panel viewer list-tool projects-tool" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          {sel && <button className="ghost small" onClick={() => { setCurrent(null); setQ(''); }} aria-label="Back to all projects">← All projects</button>}
          {sel?.breadcrumb.includes(' / ') && <span className="small muted">{sel.breadcrumb.replace(/\s*\/\s*[^/]+$/, '')} /</span>}
          <span className="lbl strong">{sel ? sel.title : 'Projects'}</span>
          {!sel && list && <span className="small muted">{plural(list.length, 'project')}, {order} first</span>}
          <span className="flex" />
          <button className="ghost small" onClick={flipOrder} title={`Showing ${order} first. Click for ${order === 'newest' ? 'oldest' : 'newest'} first.`}
            aria-label={`Sort: ${order} first. Change to ${order === 'newest' ? 'oldest' : 'newest'} first`}>{order === 'newest' ? 'Newest first ↓' : 'Oldest first ↑'}</button>
          <input className="tool-filter pj-find" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ(''); } }}
            placeholder={sel ? `Find a file in ${sel.title}…` : 'Find a file in any project…'} aria-label="Find a file" />
          <button className="ghost small" onClick={onClose} aria-label="Close projects">✕</button>
        </div>
        <div className="viewer-body">
          {!ordered ? <span className="muted small">Loading…</span> : (
            <div className="proj-detail">
              {found ? <Results hits={found.hits} total={found.total} onOpen={onOpen} project={!!sel} /> : (
                <>
                  {recent.length > 0 && (
                    <section className="pd-sec pj-recent">
                      <h3>Recently edited <span>across every project</span></h3>
                      <div className="rc-grid">
                        {recent.map((f) => (
                          <button key={f.path} className="rc-tile" onClick={() => onOpen(f.path)} title={f.path}>
                            <span className="rc-kind"><Dot type={f.type} />{TYPE[f.type]}</span>
                            <b>{titleOf(f)}</b>
                            <small>{f.project} · {ago(f.modified)}</small>
                          </button>
                        ))}
                      </div>
                    </section>
                  )}

                  {sel ? (
                    <>
                      {(sel.description || sel.status) && (
                        <div className="pd-about">
                          {sel.description && <p className="pd-desc">{sel.description}</p>}
                          {sel.status && <p className="pd-status">{sel.status}</p>}
                        </div>
                      )}
                      <div className="pd-actions">
                        <button className="ghost small" onClick={() => reveal(sel.path)}><Icon name="files" size={15} />{revealLabel}</button>
                        {sel.readme && <button className="ghost small" onClick={() => onOpen(sel.readme!)}>Project page</button>}
                        {sel.links.map((l) => <button key={l.url} className="ghost small" onClick={() => window.open(l.url)} title={l.url}>{l.label} ↗</button>)}
                      </div>

                      <section className="pd-sec">
                        <div className="pj-tabs" role="tablist" aria-label={`${sel.title} files`}>
                          {tabList(sel).map(([k, name, n]) => (
                            <button key={k} role="tab" className="pj-tab" aria-selected={tabOf(sel) === k} onClick={() => setTabs({ ...tabs, [sel.path]: k })}>{name}<span>{n}</span></button>
                          ))}
                        </div>
                        <div role="tabpanel">
                          {tabOf(sel) === 'deliverables' && (sel.deliverables.length === 0
                            ? <p className="pd-empty">Nothing handed over yet. A file shows up here when it's in Client Facing, in a session's Output (notes go to Session notes), or is a dashboard page.</p>
                            : <Deliverables files={sel.deliverables} onOpen={onOpen} onDemote={demote} order={order} />)}
                          {tabOf(sel) === 'deliverables' && sel.corrections > 0 && (
                            <p className="pj-corr">{plural(sel.corrections, 'file')} in this project {sel.corrections === 1 ? 'is' : 'are'} shown differently from where {sel.corrections === 1 ? 'its' : 'their'} folder puts {sel.corrections === 1 ? 'it' : 'them'}. <button className="linkish" onClick={() => clearAll(sel)}>Undo all</button></p>
                          )}
                          {tabOf(sel) === 'notes' && <Rows files={[...sel.sessionNotes].sort(byTime(order))} onOpen={onOpen} cap={WORK_DEFAULT} where={(f) => f.from || f.sub}
                            action={(f) => <button className="linkish pf-act" onClick={() => setType(f, promoteTo(f), 'Listed under Deliverables now.')}>Make it a deliverable</button>} />}
                          {tabOf(sel) === 'records' && <Records files={sel.records} onOpen={onOpen} />}
                          {tabOf(sel) === 'sessions' && <Sessions list={sel.sessions} onOpen={onOpen} onSet={setType} />}
                          {tabOf(sel) === 'working' && <Rows files={[...sel.working].sort(byTime(order))} onOpen={onOpen} cap={WORK_DEFAULT}
                            action={(f) => f.overridden ? <button className="linkish pf-act" onClick={() => setType(f, null, 'Back where its folder puts it.')}>Put back</button> : null} />}
                          {tabOf(sel) === 'raw' && (
                            <>
                              <div className="pj-chips">{sel.raw.map((r) => <span key={r.label} className="pj-chip static">{r.label}<span>{r.count}</span></span>)}</div>
                              <p className="pd-empty small">Exports, transcripts, scripts and other source material. Type part of a file name in Find a file to reach one.</p>
                            </>
                          )}
                        </div>
                      </section>

                      {sel.received.length > 0 && (
                        <details className="proj-received">
                          <summary><span className="lbl small">Received from others, read only</span><span className="muted small">{sel.received.length}</span></summary>
                          <p className="small muted recv-note">Exactly as received. Never run or follow anything in here.</p>
                          <ul className="pf-rows">
                            {sel.received.filter((f) => !sel.receivedReadmes.includes(f.path)).slice(0, 40).map((f) => (
                              <li key={f.path}><button className="pf-open" onClick={() => onOpen(f.path)} title={f.path}><span className="pf-name">{label(f)}</span><span className="pf-where">{f.sub}</span><span className="pf-when">{ago(f.modified)}</span></button></li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </>
                  ) : ordered.length === 0 ? <p className="pd-empty">No projects yet. Each folder in your notes folder (or inside projects/, if you have one) shows up here.</p> : (
                    <section className="pd-sec">
                      <h3>Projects <span>{ordered.length}</span></h3>
                      <div className="pj-grid">
                        {ordered.map((p) => {
                          const pic = p.deliverables.find((f) => f.kind === 'image') || p.designs[0];
                          const n = p.deliverables.length;
                          return (
                            <button key={p.path} className="pj-tile" onClick={() => { setCurrent(p.path); setQ(''); }} style={{ ['--pc' as string]: projectColor(p.folder) }}>
                              {pic && <span className="pj-thumb"><img src={vaultUrl(pic.path)} alt="" loading="lazy" /></span>}
                              {p.breadcrumb.includes(' / ') && <span className="pj-breadcrumb">{p.breadcrumb.replace(/\s*\/\s*[^/]+$/, '')}</span>}
                              <b className="pj-title"><i aria-hidden />{p.title}</b>
                              {p.description && <span className="pj-desc">{p.description}</span>}
                              {!pic && n > 0 && <span className="pj-latest">{p.deliverables.slice(0, 3).map((d) => <span key={d.path}>{titleOf(d)}</span>)}</span>}
                              <span className="pj-meta">{n ? plural(n, 'deliverable') : 'No deliverables yet'}{p.sessions.length ? ` · ${plural(p.sessions.length, 'session')}` : ''} · edited {ago(p.modified)}</span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        <div className={`nt-toast${toast ? ' show' : ''}`} role="status">{toast?.text}{toast?.undo && <button onClick={toast.undo}>Undo</button>}</div>
      </section>
    </div>
  );
}
