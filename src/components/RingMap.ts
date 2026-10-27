// The home ring, drawn into one SVG: project bands (inner), area bands (thin), one dot per file, this week's files in
// their own zone just outside the bands, a hub with the count, and a tooltip. Ported from the approved mockup
// (Skunk Works Testing/Agentic OS/Sessions/261022_HomeScreen_Reorg/Output). Ring.tsx owns the search box, the legend and the
// widgets, and tells this class what is focused and what is lit.

const NS = 'http://www.w3.org/2000/svg';
export const NEW = 7; // files edited within this many days sit in the inner zone
const START = -Math.PI / 2, END = START + Math.PI * 2;
const NEAR = 144; // hover: the nearest dot within 12 px

export type Span = { a0: number; a1: number };
export interface RingFile {
  path: string; name: string; title: string; tip: string;
  project: number; area: string; m: number; age: number; raw: boolean; // m: modified (ms); age: whole days
  c?: SVGCircleElement; x?: number; y?: number;
}
export interface RingArea { name: string; files: RingFile[]; span?: Span }
export interface RingProject { name: string; color: number; files: RingFile[]; areas: RingArea[] }
export interface RingState { projects: RingProject[]; focus: number | null; hits: Set<RingFile> | null }
export interface RingHandlers { onOpen(f: RingFile): void; onBand(pi: number): void; onHub(): void }

const col = (i: number) => `var(--p${i})`;
const dr0 = (R: number) => Math.max(3.2, Math.min(5.4, R / 68)); // dot radius

// Splits an arc between a0 and a1 into slices in proportion to the weights, with a gap between each.
function spans(weights: number[], a0: number, a1: number, gap: number): Span[] {
  const total = weights.reduce((s, w) => s + w, 0), free = a1 - a0 - gap * weights.length;
  let a = a0 + gap / 2;
  return weights.map((w) => { const s = { a0: a, a1: a + (free * w) / total }; a = s.a1 + gap; return s; });
}

interface Layout { pos: [RingFile, number, number][]; ps: Span[]; dr: number; tracks: number[]; rP0: number; rP1: number; rA0: number; rA1: number; rZ1: number; rD0: number }

export class RingMap {
  private files: RingFile[] = [];
  private projects: RingProject[] = [];
  private focus: number | null = null;
  private hits: Set<RingFile> | null = null;
  private W = 0; private H = 0; private R = 0; private cx = 0; private cy = 0;
  private hov: RingFile | null = null;
  private pinged: RingFile | null = null;
  private peeking: { n: number; label: string } | null = null;
  private anim = 0;
  private reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private gBack!: SVGGElement; private gBands!: SVGGElement; private gDots!: SVGGElement; private gHub!: SVGGElement;

  constructor(private svg: SVGSVGElement, private box: HTMLElement, private tip: HTMLElement, private h: RingHandlers) {
    svg.replaceChildren();
    const defs = this.el('defs');
    const filter = this.el('filter', { id: 'rg-soft', x: '-20%', y: '-20%', width: '140%', height: '140%' }, defs);
    this.el('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 2, result: 'b' }, filter);
    const fade = this.el('feComponentTransfer', { in: 'b', result: 'b2' }, filter);
    this.el('feFuncA', { type: 'linear', slope: 0.32 }, fade);
    const merge = this.el('feMerge', {}, filter);
    this.el('feMergeNode', { in: 'b2' }, merge);
    this.el('feMergeNode', { in: 'SourceGraphic' }, merge);
    this.gBack = this.el<SVGGElement>('g');
    this.gBands = this.el<SVGGElement>('g');
    this.gDots = this.el<SVGGElement>('g', { class: 'rg-dots' });
    this.gHub = this.el<SVGGElement>('g', { class: 'rg-hub' });
    svg.addEventListener('mousemove', this.onMove);
    svg.addEventListener('mouseleave', this.onLeave);
    svg.addEventListener('click', this.onClick);
    this.gHub.addEventListener('click', this.onHub);
  }

  // Hands over the latest data from React. A new project list rebuilds the dots (keeping each one's place, so they
  // glide rather than jump); a changed focus re-lays the ring; a changed search only relights the dots.
  set({ projects, focus, hits }: RingState) {
    const fresh = projects !== this.projects;
    if (fresh) this.load(projects);
    const moved = focus !== this.focus;
    this.focus = focus;
    this.hits = hits;
    this.lightHits();
    if (fresh || moved) this.render(true);
  }

  // Marks one dot as pinged (a search result or a recent row is under the pointer).
  ping(f: RingFile | null) {
    this.pinged?.c?.classList.remove('ping');
    this.pinged = f;
    f?.c?.classList.add('ping');
  }

  resize() { this.render(false); }

  destroy() {
    cancelAnimationFrame(this.anim);
    this.svg.removeEventListener('mousemove', this.onMove);
    this.svg.removeEventListener('mouseleave', this.onLeave);
    this.svg.removeEventListener('click', this.onClick);
    this.gHub.removeEventListener('click', this.onHub);
    this.svg.replaceChildren();
  }

  private onMove = (e: MouseEvent) => this.hover(e);
  private onLeave = () => { this.setHov(null); this.hideTip(); };
  private onClick = (e: MouseEvent) => {
    if (!(e.target as Element).closest('.rg-band, .rg-aband, .rg-hub') && this.hov) this.h.onOpen(this.hov);
  };
  private onHub = () => this.h.onHub();

  private el<T extends SVGElement = SVGElement>(name: string, attrs: Record<string, string | number> = {}, parent: Element = this.svg): T {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    parent.appendChild(e);
    return e as T;
  }

  private load(projects: RingProject[]) {
    const prev = new Map(this.files.map((f) => [f.path, f]));
    this.projects = projects;
    this.files = projects.flatMap((p) => p.files);
    for (const f of this.files) { const old = prev.get(f.path); if (old) { f.x = old.x; f.y = old.y; } }
    this.hov = null; this.pinged = null; this.peeking = null;
    this.gDots.replaceChildren();
    for (const f of this.files) {
      const color = col(this.projects[f.project].color);
      f.c = this.el<SVGCircleElement>('circle', {
        class: `rg-dot${f.raw ? ' raw' : ''}${f.age <= NEW ? ' new' : ''}`, r: 3,
        style: `color:${color};fill:${color}${f.raw ? `;stroke:${color}` : ''}`,
      }, this.gDots);
    }
  }

  private lightHits() {
    for (const f of this.files) f.c?.classList.toggle('hit', !!this.hits?.has(f));
    this.svg.classList.toggle('searching', this.hits !== null);
    this.hub();
  }

  private weights() {
    const base = this.projects.map((p) => Math.max(3, Math.pow(p.files.length, 0.62)));
    if (this.focus == null || this.focus >= base.length) return base;
    // the focused project takes five times all the others together, so the rest are small slices at the back
    const others = base.reduce((s, w, i) => s + (i === this.focus ? 0 : w), 0);
    return base.map((w, i) => (i === this.focus ? others * 5 : w));
  }

  private pt(r: number, a: number): [number, number] { return [this.cx + r * Math.cos(a), this.cy + r * Math.sin(a)]; }

  private donut(r0: number, r1: number, a0: number, a1: number) {
    const big = a1 - a0 > Math.PI ? 1 : 0;
    const [x0, y0] = this.pt(r1, a0), [x1, y1] = this.pt(r1, a1), [x2, y2] = this.pt(r0, a1), [x3, y3] = this.pt(r0, a0);
    return `M${x0},${y0}A${r1},${r1} 0 ${big} 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 ${big} 0 ${x3},${y3}Z`;
  }

  private layout(): Layout | null {
    const { R, projects } = this;
    if (!this.files.length) return null;
    const rP0 = R * 0.17, rP1 = R * 0.235, rA0 = R * 0.248, rA1 = R * 0.26;
    const dr = dr0(R), sw = dr * 2.45, rZ0 = rA1 + dr * 3.2;
    const ps = spans(this.weights(), START, END, 0.022);
    // this week's files: their own tracks just outside the bands, inside each project's slice
    const zone: [RingFile, number, number][] = [];
    let zoneTracks = 0;
    projects.forEach((p, pi) => {
      const fresh = p.files.filter((f) => f.age <= NEW).sort((x, y) => y.m - x.m), { a0, a1 } = ps[pi];
      let i = 0, k = 0;
      while (i < fresh.length) {
        const r = rZ0 + k * sw, cap = Math.max(1, Math.floor(((a1 - a0) * r) / sw)), m = Math.min(cap, fresh.length - i);
        const step = Math.min((a1 - a0) / m, (sw * 1.1) / r), start = (a0 + a1) / 2 - (step * (m - 1)) / 2;
        for (let j = 0; j < m; j++, i++) zone.push([fresh[i], r, start + j * step]);
        k++;
      }
      zoneTracks = Math.max(zoneTracks, k);
    });
    const rZ1 = rZ0 + Math.max(zoneTracks - 1, 0) * sw, rD0 = rZ1 + dr * 4.4;
    let s = Math.min(R / 15, (Math.sqrt((Math.PI * (R * R - rD0 * rD0)) / this.files.length)) * 0.95);
    // the rest of each area's files, packed in tracks outside the zone, newest first
    const place = () => {
      let maxR = 0;
      const out: [RingFile, number, number][] = [];
      projects.forEach((p, pi) => {
        const as = spans(p.areas.map((a) => Math.max(1.5, Math.pow(a.files.length, 0.75))), ps[pi].a0, ps[pi].a1, 0.012);
        p.areas.forEach((a, ai) => {
          const { a0, a1 } = as[ai], rest = a.files.filter((f) => f.age > NEW);
          let k = 0, i = 0;
          while (i < rest.length) {
            const r = rD0 + k * s, cap = Math.max(1, Math.floor(((a1 - a0) * r) / s)), m = Math.min(cap, rest.length - i);
            const step = Math.min((a1 - a0) / m, (s * 1.35) / r), start = (a0 + a1) / 2 - (step * (m - 1)) / 2;
            for (let j = 0; j < m; j++, i++) out.push([rest[i], r, start + j * step]);
            maxR = Math.max(maxR, r); k++;
          }
          a.span = as[ai];
        });
      });
      return { maxR, out };
    };
    let res = place();
    while (res.maxR > R && s > dr * 2.3) { s *= 0.94; res = place(); }
    const tracks = [...new Set(res.out.map((o) => Math.round(o[1])))];
    return { pos: res.out.concat(zone), ps, dr, tracks, rP0, rP1, rA0, rA1, rZ1, rD0 };
  }

  private render(animate: boolean) {
    this.W = this.box.clientWidth; this.H = this.box.clientHeight;
    if (this.W < 80 || this.H < 80) return;
    this.svg.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`);
    this.cx = this.W / 2;
    // Fit the ring in the space below the search bar, measured from the page. The widgets float over it.
    const bb = this.box.getBoundingClientRect();
    const search = this.box.querySelector('.ring-search')?.getBoundingClientRect();
    const top = search ? search.bottom - bb.top : 50, bottom = 14;
    const pad = 20, availH = this.H - top - bottom - pad * 2;
    this.R = Math.max(94, (Math.min(this.W - 80, availH) / 2) * 0.85); // 15% zoomed out; the ring stays centred in the same space
    this.cy = top + pad + availH / 2;
    this.gBack.replaceChildren(); this.gBands.replaceChildren();
    const L = this.layout();
    if (L) this.draw(L);
    this.hub();
    if (!L) return;

    const from = new Map<RingFile, [number, number]>(), to = new Map<RingFile, [number, number]>();
    for (const [f, r, a] of L.pos) {
      to.set(f, this.pt(r, a));
      from.set(f, [f.x ?? this.cx, f.y ?? this.cy]);
      f.c?.setAttribute('r', String(L.dr));
    }
    cancelAnimationFrame(this.anim);
    const dur = animate && !this.reduce ? 750 : 0, t0 = performance.now();
    const step = (now: number) => {
      const t = dur ? Math.min(1, (now - t0) / dur) : 1, e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      for (const [f, [x, y]] of to) {
        const [x0, y0] = from.get(f)!;
        f.x = x0 + (x - x0) * e; f.y = y0 + (y - y0) * e;
        f.c?.setAttribute('cx', String(f.x)); f.c?.setAttribute('cy', String(f.y));
      }
      if (t < 1) this.anim = requestAnimationFrame(step);
    };
    if (dur) this.anim = requestAnimationFrame(step); else step(0);
  }

  private draw(L: Layout) {
    const { cx, cy } = this;
    const { ps, rP0, rP1, rA0, rA1, rZ1, rD0, tracks } = L;
    for (const r of tracks) this.el('circle', { class: 'rg-track', cx, cy, r }, this.gBack);
    this.el('circle', { class: 'rg-guide', cx, cy, r: (rZ1 + rD0) / 2 }, this.gBack);
    this.projects.forEach((p, pi) => {
      const b = this.el('path', { class: 'rg-band', d: this.donut(rP0, rP1, ps[pi].a0, ps[pi].a1), style: `fill:${col(p.color)}` }, this.gBands);
      this.bandHover(b, pi, p.name, `${p.files.length} files. Click to ${this.focus === pi ? 'show everything' : 'open it up'}.`);
      for (const a of p.areas) {
        const span = a.span!;
        const ab = this.el('path', { class: 'rg-aband', d: this.donut(rA0, rA1, span.a0, span.a1), style: `fill:${col(p.color)}` }, this.gBands);
        this.bandHover(ab, pi, a.name, `${p.name}, ${a.files.length} files`, a.name);
      }
    });
  }

  // Hovering a band lights its dots and puts its name in the hub, so the ring needs no printed labels.
  private bandHover(b: SVGElement, pi: number, name: string, sub: string, area?: string) {
    b.addEventListener('mouseenter', () => this.peek(pi, area, area ? name : this.projects[pi].name));
    b.addEventListener('mousemove', (e) => this.showTip(e, name, sub));
    b.addEventListener('mouseleave', () => { this.unpeek(); this.hideTip(); });
    if (!area) b.addEventListener('click', () => this.h.onBand(pi));
  }

  private peek(pi: number, area: string | undefined, label: string) {
    let n = 0;
    for (const f of this.files) {
      const on = f.project === pi && (!area || f.area === area);
      f.c?.classList.toggle('peek', on);
      if (on) n++;
    }
    this.svg.classList.add('peeking');
    this.peeking = { n, label };
    this.hub();
  }

  private unpeek() {
    for (const f of this.files) f.c?.classList.remove('peek');
    this.svg.classList.remove('peeking');
    this.peeking = null;
    this.hub();
  }

  // The centre: what is hovered, else the search count, else the focused project, else the total.
  private hub() {
    this.gHub.replaceChildren();
    if (!this.R) return;
    const { cx, cy } = this;
    this.el('circle', { cx, cy, r: this.R * 0.145 }, this.gHub);
    const focused = this.focus != null ? this.projects[this.focus] : undefined;
    const [big, small]: [number, string] = this.peeking ? [this.peeking.n, this.peeking.label]
      : this.hits ? [this.hits.size, this.hits.size === 1 ? 'match' : 'matches']
      : focused ? [focused.files.length, focused.name]
      : [this.files.length, 'files'];
    const t1 = this.el('text', { class: 'rg-big', x: cx, y: cy + 4, 'text-anchor': 'middle' }, this.gHub);
    t1.textContent = String(big);
    const t2 = this.el('text', { class: 'rg-small', x: cx, y: cy + 22, 'text-anchor': 'middle' }, this.gHub);
    t2.textContent = small;
  }

  private setHov(f: RingFile | null) {
    if (f === this.hov) return;
    this.hov?.c?.classList.remove('hover');
    this.hov = f;
    f?.c?.classList.add('hover');
  }

  private nearest(e: MouseEvent) {
    const b = this.svg.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    let best: RingFile | null = null, bd = NEAR;
    for (const f of this.files) {
      if (f.x == null || f.y == null) continue;
      const d = (f.x - x) ** 2 + (f.y - y) ** 2;
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }

  private hover(e: MouseEvent) {
    if ((e.target as Element).closest('.rg-band, .rg-aband, .rg-hub')) { this.setHov(null); this.hideTip(); this.svg.style.cursor = ''; return; }
    const f = this.nearest(e);
    this.setHov(f);
    if (f) {
      this.showTip(e, f.title, f.tip, col(this.projects[f.project].color));
      this.svg.style.cursor = 'pointer';
    } else {
      this.hideTip();
      this.svg.style.cursor = '';
    }
  }

  // Built with DOM nodes, not innerHTML, because file names are not trusted markup.
  private showTip(e: MouseEvent, title: string, sub: string, color?: string) {
    this.tip.replaceChildren();
    const b = document.createElement('b'), s = document.createElement('span');
    if (color) { const dot = document.createElement('i'); dot.style.background = color; b.append(dot); }
    b.append(title);
    s.textContent = sub;
    this.tip.append(b, s);
    this.tip.classList.add('on');
    const bx = this.box.getBoundingClientRect();
    let x = e.clientX - bx.left + 14;
    const y = e.clientY - bx.top + 14;
    if (x + 330 > bx.width) x -= 350;
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${y}px`;
  }

  private hideTip() { this.tip.classList.remove('on'); }
}
