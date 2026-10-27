// The home ring: the vault's files as dots round project bands (RingMap draws it). A legend and four widgets
// (Recent, Mail, Run, Actions) float over it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, Dispatch, PointerEvent as ReactPointerEvent, ReactNode, RefObject, SetStateAction } from 'react';
import { RingMap, type RingArea, type RingFile, type RingProject } from './RingMap';
import type { ActionItem, Deliverable, MailState, ProjectInfo } from '../types';
import { os } from '../aos';

const DAY = 864e5;
const WIDGETS_KEY = 'aos-ring-widgets';
let topZ = 10; // z-index of the front-most widget; stays under the tooltip
const AREA_ORDER = ['Records', 'Sessions', 'Client Facing', 'Tools', 'Input', 'Raw', 'Skills', 'General'];
const AREA_OF = new Map([['Records', 'Records'], ['Sessions', 'Sessions'], ['Client Facing', 'Client Facing'], ['Tools', 'Tools'], ['Input', 'Input'], ['Raw', 'Raw'], ['skills', 'Skills']]);
const RUNS = [
  { skill: 'idc-dashboard-refresh', label: 'IDC dashboard refresh' },
  { skill: 'dba-portal-comparison', label: 'DBA portal comparison' },
];

type WId = 'recent' | 'mail' | 'run' | 'acts' | 'legend';
// Every widget snaps to the nearest corner (c: tl/tr/bl/br) when dropped, and stays anchored there when the window is resized or
// maximized. The centre and edge values are leftovers from an older version, kept so saved layouts load (they move to a corner once).
type Anchor = 'c' | 't' | 'b' | 'l' | 'r' | 'tl' | 'tr' | 'bl' | 'br';
type Slot = { x?: number; y?: number; c?: Anchor; min?: boolean };
type Pos = Partial<Record<WId, Slot>>;
type Props = { covered: boolean; onOpen(path: string): void; onTool(t: 'mail' | 'actions'): void };

const cleanTitle = (d: Deliverable) => d.title || d.name.replace(/\.[a-z0-9]+$/i, '').replace(/^\d+[-_ ]*/, '').replace(/[-_]+/g, ' ');
const edited = (age: number) => (age === 0 ? 'Built today' : age === 1 ? 'Built yesterday' : age < 9999 ? `Built ${age} days ago` : 'No date');
const agoMs = (t: number) => {
  if (!t) return 'never';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
};
// Stamps from the skill log are UTC without the Z; mail and actions carry ISO strings.
const parseStamp = (s: string) => Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z') || 0;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(Math.max(lo, hi), v));

function add(p: RingProject, idx: number, label: string, d: Deliverable, now: number) {
  const raw = d.type === 'raw' || d.auto === 'raw';
  const area = raw ? 'Raw' : AREA_OF.get((d.sub || '').split(/[\\/]/)[0]) || 'General';
  const m = d.created || d.modified || 0, age = m ? Math.max(0, Math.floor((now - m) / DAY)) : 9999;
  const f: RingFile = { path: d.path, name: d.name, title: cleanTitle(d), tip: `${label}, ${area}. ${edited(age)}.`, project: idx, area, m, age, raw };
  p.files.push(f);
  let a: RingArea | undefined = p.areas.find((x) => x.name === area);
  if (!a) { a = { name: area, files: [] }; p.areas.push(a); }
  a.files.push(f);
}

// Splits the vault into projects. The five biggest get a colour each; the rest share "Other".
export function buildRing(ps: ProjectInfo[], now: number): RingProject[] {
  const groups = ps
    .map((p) => ({ name: p.title || p.breadcrumb || p.folder, files: [...new Map(p.search.map((d) => [d.path, d] as const)).values()] }))
    .filter((g) => g.files.length)
    .sort((a, b) => b.files.length - a.files.length);
  const named = groups.slice(0, 5), rest = groups.slice(5);
  const out: RingProject[] = named.map((g, i) => ({ name: g.name, color: i, files: [], areas: [] }));
  named.forEach((g, i) => g.files.forEach((d) => add(out[i], i, g.name, d, now)));
  if (rest.length) {
    out.push({ name: 'Other', color: 5, files: [], areas: [] });
    rest.forEach((g) => g.files.forEach((d) => add(out[5], 5, g.name, d, now)));
  }
  for (const p of out) p.areas.sort((x, y) => (AREA_ORDER.indexOf(x.name) + 1 || 99) - (AREA_ORDER.indexOf(y.name) + 1 || 99));
  return out;
}

// The corner whose quadrant holds the point (cx, cy) inside a stage of w by h.
const nearestCorner = (cx: number, cy: number, w: number, h: number): Anchor => ((cy < h / 2 ? 't' : 'b') + (cx < w / 2 ? 'l' : 'r')) as Anchor;

// One floating widget: drags by its header, folds with the dash. Position and fold are kept in localStorage.
function Panel({ id, cls, title, badge, pos, setPos, box, fixed, children }: {
  id: WId; fixed?: boolean; cls: string; title: string; badge?: number; pos: Pos; setPos: Dispatch<SetStateAction<Pos>>; box: RefObject<HTMLDivElement | null>; children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const s = pos[id] || {};
  const put = (v: Slot) => setPos((p) => ({ ...p, [id]: { ...p[id], ...v } }));
  const drag = (e: ReactPointerEvent<HTMLElement>) => {
    if (fixed || (e.target as HTMLElement).closest('button') || !ref.current || !box.current) return;
    const r = ref.current.getBoundingClientRect(), bx = box.current.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    const move = (ev: PointerEvent) => put({
      x: clamp(ev.clientX - bx.left - ox, 0, bx.width - r.width),
      y: clamp(ev.clientY - bx.top - oy, 0, bx.height - r.height),
    });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const el = ref.current, b = box.current;
      if (!el || !b) return;
      const w = el.getBoundingClientRect(), k = b.getBoundingClientRect();
      put({ c: nearestCorner(w.left + w.width / 2 - k.left, w.top + w.height / 2 - k.top, k.width, k.height), x: undefined, y: undefined });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  // Layouts saved at pixel positions (or at an edge) move to the nearest corner once, so every widget ends up anchored in one.
  useEffect(() => {
    const el = ref.current, b = box.current;
    if (fixed || !el || !b || (s.x == null && (!s.c || s.c.length === 2))) return;
    const r = el.getBoundingClientRect(), k = b.getBoundingClientRect();
    put({ c: nearestCorner(r.left + r.width / 2 - k.left, r.top + r.height / 2 - k.top, k.width, k.height), x: undefined, y: undefined });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A dragged widget keeps absolute coordinates, so shrinking the stage can leave it outside. Pull it back in on every resize.
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    const fit = () => {
      const el = ref.current;
      if (fixed || !el || s.x == null || s.y == null) return;
      const w = el.offsetWidth, h = el.offsetHeight;
      const x = clamp(s.x, 0, Math.max(0, b.clientWidth - w)), y = clamp(s.y, 0, Math.max(0, b.clientHeight - h));
      if (x !== s.x || y !== s.y) put({ x, y });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(b);
    return () => ro.disconnect();
  }, [s.x, s.y, s.min]); // eslint-disable-line react-hooks/exhaustive-deps
  // Folding or opening changes the width. A widget in the right half keeps its right edge, so it grows and shrinks
  // leftwards; one in the left half keeps its left edge.
  const edge = useRef<number | null>(null);
  const toggle = () => {
    const el = ref.current, b = box.current;
    if (el && b && s.x != null) {
      const r = el.getBoundingClientRect(), bx = b.getBoundingClientRect();
      if (r.left + r.width / 2 > bx.left + bx.width / 2) edge.current = r.right - bx.left;
    }
    put({ min: !s.min });
  };
  useLayoutEffect(() => {
    const el = ref.current, b = box.current;
    if (edge.current == null || !el || !b) return;
    const x = clamp(edge.current - el.offsetWidth, 0, b.clientWidth - el.offsetWidth);
    edge.current = null;
    put({ x });
  }, [s.min]); // eslint-disable-line react-hooks/exhaustive-deps
  // Widgets may overlap; the one last touched comes to the front.
  const front = () => { if (ref.current) ref.current.style.zIndex = String(++topZ); };
  const edgeStyle: Record<string, CSSProperties> = {
    c: { left: '50%', top: '50%', right: 'auto', bottom: 'auto', transform: 'translate(-50%, -50%)' },
    t: { left: '50%', top: 16, right: 'auto', bottom: 'auto', transform: 'translateX(-50%)' },
    b: { left: '50%', top: 'auto', right: 'auto', bottom: 16, transform: 'translateX(-50%)' },
    l: { left: 16, top: '50%', right: 'auto', bottom: 'auto', transform: 'translateY(-50%)' },
    r: { left: 'auto', top: '50%', right: 16, bottom: 'auto', transform: 'translateY(-50%)' },
  };
  const style: CSSProperties | undefined = fixed ? undefined : s.x != null && s.y != null ? { left: s.x, top: s.y, right: 'auto', bottom: 'auto', transform: 'none' }
    : s.c && edgeStyle[s.c] ? edgeStyle[s.c]
    : s.c ? { left: s.c[1] === 'l' ? 16 : 'auto', right: s.c[1] === 'r' ? 16 : 'auto', top: s.c[0] === 't' ? 16 : 'auto', bottom: s.c[0] === 'b' ? 16 : 'auto' }
    : undefined;
  return (
    <section ref={ref} className={`ring-w ${cls}${s.min ? ' min' : ''}`} style={style} aria-label={title} onPointerDownCapture={front}>
      <header onPointerDown={drag}>
        <b>{title}</b>
        {badge !== undefined && <span className="ring-badge">{badge}</span>}
        <span className="sp" />
        <button className="fold" onClick={toggle} aria-expanded={!s.min} aria-label={`${s.min ? 'Open' : 'Fold'} ${title}`}>{s.min ? '+' : '–'}</button>
      </header>
      {!s.min && <div className="body">{children}</div>}
    </section>
  );
}

export default function Ring({ covered, onOpen, onTool }: Props) {
  const boxRef = useRef<HTMLDivElement>(null), svgRef = useRef<SVGSVGElement>(null), tipRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<RingMap | null>(null), sigRef = useRef('');
  const openRef = useRef(onOpen);
  const [projects, setProjects] = useState<RingProject[]>([]);
  const [focus, setFocus] = useState<number | null>(null);
  const [pos, setPos] = useState<Pos>(() => { try { return JSON.parse(localStorage.getItem(WIDGETS_KEY) || '{}'); } catch { return {}; } });
  const [acts, setActs] = useState<{ items: ActionItem[]; open: number }>({ items: [], open: 0 });
  const [mail, setMail] = useState<MailState | null>(null);
  const [running, setRunning] = useState<string[]>([]);
  const [last, setLast] = useState<Record<string, { ok: boolean; at: number }>>({});
  openRef.current = onOpen;

  const all = useMemo(() => projects.flatMap((p) => p.files), [projects]);
  const recent = useMemo(() => all.filter((f) => f.age <= 14).sort((a, b) => b.m - a.m).slice(0, 6), [all]);

  const openFile = (p: string) => {
    if (/[.](docx|pptx|xlsx)$/i.test(p)) window.aos.vault.openExternal(p);
    else openRef.current(p);
  };
  const band = (pi: number) => setFocus((f) => (f === pi ? null : pi));
  const reset = () => setFocus(null);

  // The map is built once. Its handlers only call state setters and the latest open function, so they never go stale.
  useEffect(() => {
    const map = new RingMap(svgRef.current!, boxRef.current!, tipRef.current!, {
      onOpen: (f) => openRef.current(f.path),
      onBand: band,
      onHub: reset,
    });
    mapRef.current = map;
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(boxRef.current!);
    return () => { ro.disconnect(); map.destroy(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    mapRef.current?.set({ projects, focus, hits: null });
  }, [projects, focus]);

  useEffect(() => { try { localStorage.setItem(WIDGETS_KEY, JSON.stringify(pos)); } catch { /* private mode */ } }, [pos]);

  const loadProjects = useCallback(() => {
    window.aos.vault.projects().then((ps) => {
      const sig = ps.map((p) => `${p.title}:` + p.search.map((d) => d.path + d.modified).join('|')).join('#');
      if (sig === sigRef.current) return;
      sigRef.current = sig;
      setProjects(buildRing(ps, Date.now()));
    }).catch(() => {});
  }, []);
  const loadActs = useCallback(() => { window.aos.actions.list().then(setActs).catch(() => {}); }, []);
  const loadMail = useCallback(() => { if (os === 'mac') return; window.aos.mail.state().then(setMail).catch(() => {}); }, []);
  const [, tick] = useState(0); // re-renders each minute so "Last pull 5 min ago" keeps counting
  useEffect(() => { const t = setInterval(() => { tick((n) => n + 1); loadMail(); }, 60_000); return () => clearInterval(t); }, [loadMail]);
  const loadRuns = useCallback(() => {
    window.aos.skillRun.state().then((s) => setRunning(s.map((x) => x.skill))).catch(() => {});
    window.aos.skillRun.recent(20).then((rs) => {
      const latest: Record<string, { ok: boolean; at: number }> = {};
      for (const r of rs) if (!latest[r.skill]) latest[r.skill] = { ok: r.ok, at: parseStamp(r.at) };
      setLast(latest);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    loadProjects(); loadActs(); loadMail(); loadRuns();
    const offs = [
      window.aos.vault.onChanged(() => { loadProjects(); loadActs(); }),
      window.aos.mail.onEvent(() => loadMail()),
      window.aos.skillRun.onEvent((e) => {
        if (e.type === 'start') setRunning((r) => (r.includes(e.skill) ? r : [...r, e.skill]));
        else {
          setRunning((r) => r.filter((s) => s !== e.skill));
          setLast((l) => ({ ...l, [e.skill]: { ok: !!e.ok, at: Date.now() } }));
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [loadProjects, loadActs, loadMail, loadRuns]);

  const runSkill = (skill: string) => { window.aos.skillRun.run(skill, 'sonnet').catch(() => {}).finally(loadRuns); };
  const stopSkill = (skill: string) => { window.aos.skillRun.stop(skill).catch(() => {}).finally(loadRuns); };
  const pullMail = () => { window.aos.mail.pull().catch(() => {}).finally(loadMail); };

  const toggleChip = (i: number) => band(i);
  const todo = acts.items.filter((a) => !a.done).slice(0, 3);
  const openMail = mail?.open ?? [];
  const dayLabel = (age: number) => (age === 0 ? 'today' : age === 1 ? 'yesterday' : `${age} days`);

  return (
    <div className="ring" ref={boxRef}>
      <svg ref={svgRef} className="ring-svg" role="img" aria-label="Your files by project, as a ring" />
      <div ref={tipRef} className="ring-tip" />

      {!covered && (
        <>
          <Panel id="legend" cls="ring-w5" title="Projects" fixed pos={pos} setPos={setPos} box={boxRef}>
            <div className="ring-legend">
              {projects.map((p, i) => (
                <button key={`${p.name}-${i}`} className={focus === i ? 'on' : ''} aria-pressed={focus === i} onClick={() => toggleChip(i)}>
                  <i style={{ background: `var(--p${p.color})` }} />{p.name} <span className="n">{p.files.length}</span>
                </button>
              ))}
              <span className="key"><i className="hollow" />raw input</span>
              <span className="key"><i className="wk" />this week</span>
            </div>
          </Panel>

          <Panel id="recent" cls="ring-w1" title="Recent" pos={pos} setPos={setPos} box={boxRef}>
            {recent.length ? recent.map((f) => (
              <button key={f.path} className="ring-row" title={f.path}
                onMouseEnter={() => mapRef.current?.ping(f)} onMouseLeave={() => mapRef.current?.ping(null)} onClick={() => openFile(f.path)}>
                <i style={{ background: `var(--p${projects[f.project].color})` }} />
                <span className="t">{f.title}</span>
                <span className="d">{dayLabel(f.age)}</span>
              </button>
            )) : <p className="ring-none">Nothing new in the last two weeks.</p>}
          </Panel>

          {os !== 'mac' && <Panel id="mail" cls="ring-w2" title="Mail" badge={openMail.length} pos={pos} setPos={setPos} box={boxRef}>
            {!mail && <p className="ring-none">Loading…</p>}
            {mail && openMail.length === 0 && <p className="ring-none">Nothing needs a reply.</p>}
            {openMail.slice(0, 3).map((m) => (
              <button key={m.id} className="ring-row" onClick={() => onTool('mail')} title={m.subject}>
                <span className="t">{m.subject || '(no subject)'}<small>{m.from}</small></span>
                <span className="d">{agoMs(parseStamp(m.received))}</span>
              </button>
            ))}
            <div className="ring-foot">
              <span style={mail && !mail.health.ok ? { color: 'var(--bad, #c0392b)' } : undefined} title={mail?.health.why}>{mail && !mail.health.ok ? 'Mail needs attention' : `Last pull ${mail ? agoMs(mail.lastPull) : ''}`}</span>
              <button className="linkish" onClick={() => onTool('mail')}>Open Mail</button>
            </div>
          </Panel>}

          <Panel id="run" cls="ring-w3" title="Run" pos={pos} setPos={setPos} box={boxRef}>
            {RUNS.map((r) => {
              const busy = running.includes(r.skill), l = last[r.skill];
              return (
                <div className="ring-run" key={r.skill}>
                  <span className="t">{r.label}<small>{busy ? 'Running…' : l ? `${l.ok ? 'Done' : 'Failed'} ${agoMs(l.at)}` : 'Not run yet'}</small></span>
                  <button className="ring-btn" onClick={() => (busy ? stopSkill(r.skill) : runSkill(r.skill))}>{busy ? 'Stop' : 'Run'}</button>
                </div>
              );
            })}
            {os !== 'mac' && <div className="ring-run">
              <span className="t">Pull mail<small>{mail?.running ? 'Pulling…' : `Last pull ${mail ? agoMs(mail.lastPull) : ''}`}</small></span>
              <button className="ring-btn" onClick={pullMail} disabled={!!mail?.running}>Pull</button>
            </div>}
          </Panel>

          <Panel id="acts" cls="ring-w4" title="Actions" badge={acts.open} pos={pos} setPos={setPos} box={boxRef}>
            {todo.length === 0 && <p className="ring-none">No open actions.</p>}
            {todo.map((a) => (
              <button key={a.file + a.raw} className="ring-row" onClick={() => onTool('actions')} title={`${a.project}: ${a.text}`}>
                <span className="t">{a.text}<small>{a.project}</small></span>
                <span className="d">{a.added ? agoMs(parseStamp(a.added)) : ''}</span>
              </button>
            ))}
            <div className="ring-foot">
              <span />
              <button className="linkish" onClick={() => onTool('actions')}>Open Actions</button>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
