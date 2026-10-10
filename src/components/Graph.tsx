import { useEffect, useRef } from 'react';
import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import type { GraphData } from '../types';
import { getTheme } from '../theme';
import { groupColor } from '../colors';
import { getGraphShape, type GraphShape } from '../graphShape';
import { growTree, skeleton, treePull, leafTexture, type Pt } from './treeOfLife';

// The node map: every note in the workspace as a dot, linked by the links between notes, coloured by its top folder
// (colors.ts, which the legend uses too).
// Received material (a folder whose README says `received: true`, e.g. a client's live skills): read-only,
// never run or followed. Dark red, whatever the project.
const RECEIVED_COLOR = '#c0504d';
function baseColor(n: { id: string; group: string; received?: boolean }) {
  if (n.received) return RECEIVED_COLOR;
  return groupColor(n.group, false);
}
// Light mode: colors.ts has a deeper set of the same hues for the cream backdrop.
const light = () => getTheme() === 'light';
function colorOf(n: { id: string; group: string; received?: boolean }) {
  if (n.received) return light() ? '#9b2c2c' : RECEIVED_COLOR;
  return light() ? groupColor(n.group, true) : baseColor(n);
}
const ACCENT = '#b7d17e'; // lime, the dark theme's accent
const BONE = '#f2eeeb';
// Active links: a hairline with a soft glow. Pale lime = the assistant is reading along it, amber = it touches a file it edited.
const LINK_BLUE = '#d6e8a8';
const LINK_RED = '#f0a060';

type N = { id: string; name: string; group: string; received?: boolean; x?: number; y?: number; z?: number };
type L = { source: N | string; target: N | string };
const idOf = (v: N | string) => (typeof v === 'string' ? v : v.id);

// Pulls every note inside an ellipsoid (wider than tall, like a brain), so the graph reads as one dense mass.
function brainForce(rx: number, ry: number, rz: number) {
  let nodes: any[] = [];
  const force = (alpha: number) => {
    for (const n of nodes) {
      const r = Math.hypot(n.x / rx, n.y / ry, n.z / rz);
      if (r > 1) { const k = ((r - 1) / r) * alpha * 0.6; n.vx -= n.x * k; n.vy -= n.y * k; n.vz -= n.z * k; }
    }
  };
  force.initialize = (ns: any[]) => { nodes = ns; };
  return force;
}

// ---- Tree of life ----
// The shape itself (how the folders become limbs, roots and leaves) lives in treeOfLife.ts. Here: swapping the forces
// and the drawn branches in and out. In tree mode nothing but the pull acts on the notes, so they settle exactly on it.
function applyShape(g: any, shape: GraphShape, store: { grp?: THREE.Group; targets?: Map<string, Pt> }, nodes: N[]) {
  if (store.grp) {
    g.scene().remove(store.grp);
    store.grp.traverse((o: any) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    store.grp = undefined;
  }
  if (shape === 'tree') {
    const { targets, branches, shift } = growTree(nodes, colorOf, light() ? '#6a6f62' : BONE);
    store.targets = targets;
    g.d3Force('brain', null);
    g.d3Force('tree', treePull(targets));
    g.d3Force('charge').strength(0);
    g.d3Force('link').strength(0);
    g.linkOpacity(light() ? 0.05 : 0.06); // the wiki links fade to a haze; the folder branches carry the shape
    store.grp = skeleton(branches, shift, light());
    g.scene().add(store.grp);
  } else {
    store.targets = undefined;
    g.d3Force('tree', null);
    g.d3Force('brain', brainForce(130, 90, 105));
    g.d3Force('charge').strength(-10).distanceMax(90);
    g.d3Force('link').distance(14).strength(0.5);
    g.linkOpacity(0.4);
  }
}

// A leaf on the tree: a small sphere in the note's colour with a soft glow round it. Materials are shared per colour.
const leafGeo = new THREE.SphereGeometry(1, 10, 10);
const leafMats = new Map<string, { core: THREE.MeshBasicMaterial; glow: THREE.SpriteMaterial }>();
function leaf(n: N) {
  const c = colorOf(n), pale = light();
  let m = leafMats.get(c + pale);
  if (!m) {
    m = { core: new THREE.MeshBasicMaterial({ color: c }), glow: new THREE.SpriteMaterial({ map: leafTexture(), color: c, blending: pale ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: pale ? 0.22 : 0.5 }) };
    leafMats.set(c + pale, m);
  }
  const grp = new THREE.Group();
  const hub = n.name === 'index' || n.name === 'README';
  const core = new THREE.Mesh(leafGeo, m.core);
  core.scale.setScalar(hub ? 1.7 : 1.05);
  const glow = new THREE.Sprite(m.glow);
  glow.scale.set(hub ? 10 : 7, hub ? 10 : 7, 1);
  grp.add(core, glow);
  return grp;
}

// Put the camera where the whole vault fits, ignoring the farthest few notes so strays don't shrink it.
// The tree is framed closer and aimed lower, so the crown sits in the open space above the cards and the roots show.
// `points` lets the caller frame where the notes are heading (the tree's targets) rather than where they are now.
function frameAll(g: any, ms = 0, tree = false, points?: Iterable<Pt>) {
  const ns: Pt[] = points ? [...points] : g.graphData().nodes.filter((n: N) => n.x != null);
  if (!ns.length) return;
  const q = (k: 'x' | 'y' | 'z', p: number) => { const a = ns.map((n) => n[k]!).sort((u, v) => u - v); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
  const lo = { x: q('x', 0.03), y: q('y', 0.03), z: q('z', 0.03) }, hi = { x: q('x', 0.97), y: q('y', 0.97), z: q('z', 0.97) };
  const c = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2, z: (lo.z + hi.z) / 2 };
  const size = Math.max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z);
  const fov = (g.camera().fov * Math.PI) / 180;
  // leave room around the brain for the cards that float over the stage
  const dist = (size / 2) / Math.tan(fov / 2) * (tree ? 1.5 : 1.7);
  const aim = tree ? { ...c, y: c.y - size * 0.08 } : c;
  g.cameraPosition({ x: aim.x, y: aim.y, z: aim.z + dist }, aim, ms);
}

// One soft round glow texture, shared by every highlighted node.
let glowTex: THREE.Texture | null = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  // Hollow centre: the glow sits just outside the node's edge, like a faint outline.
  g.addColorStop(0, 'rgba(183,209,126,0)');
  g.addColorStop(0.36, 'rgba(183,209,126,.55)');
  g.addColorStop(0.5, 'rgba(183,209,126,.22)');
  g.addColorStop(1, 'rgba(183,209,126,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

// The glow around an active link: two faint additive sleeves, one tight and one wide, so it reads as light and not as a tube.
function glowLink(color: string) {
  const blending = light() ? THREE.NormalBlending : THREE.AdditiveBlending; // additive light vanishes on a pale backdrop
  const grp = new THREE.Group();
  for (const [r, o] of [[0.6, 0.22], [1.6, 0.08]]) {
    const geo = new THREE.CylinderGeometry(r, r, 1, 10, 1, true);
    geo.translate(0, 0.5, 0);
    geo.rotateX(Math.PI / 2); // runs along +z from the origin, length 1
    grp.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: light() ? o * 1.6 : o, blending, depthWrite: false })));
  }
  return grp;
}

// A small, quiet glass tag: drawn at high resolution, shown small, so it stays crisp.
function label(text: string, hot: boolean) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  const font = "500 30px 'Geist Variable', Geist, system-ui, sans-serif";
  ctx.font = font;
  const pad = 18, h = 46;
  c.width = Math.ceil(ctx.measureText(text).width) + pad * 2 + 4;
  c.height = h + 4;
  ctx.font = font;
  ctx.beginPath();
  ctx.roundRect(2, 2, c.width - 4, h, 10);
  const pale = light();
  ctx.fillStyle = pale ? 'rgba(246,242,234,.94)' : 'rgba(21,23,22,.7)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = pale ? (hot ? 'rgba(79,98,70,.85)' : 'rgba(37,42,34,.18)') : hot ? 'rgba(183,209,126,.7)' : 'rgba(242,238,235,.12)';
  ctx.stroke();
  ctx.textBaseline = 'middle';
  ctx.fillStyle = pale ? (hot ? '#4f6246' : 'rgba(37,42,34,.92)') : hot ? '#f2eeeb' : 'rgba(242,238,235,.8)';
  ctx.fillText(text, pad + 2, 2 + h / 2 + 1);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false, transparent: true }));
  s.scale.set(c.width / 11, c.height / 11, 1);
  return s;
}

export default function Graph({ data, read, wrote, reading, open, onOpen, paused = false, onLost }: {
  data: GraphData; read: string[]; wrote: string[]; reading: string | null; open: string | null; onOpen(p: string): void;
  paused?: boolean; // hidden behind a tool or file: stop drawing, to spare the graphics card
  onLost?(): void; // the graphics card dropped the 3D drawing; the app builds a fresh graph
}) {
  const el = useRef<HTMLDivElement>(null);
  const fg = useRef<any>(null);
  const lostRef = useRef(onLost); lostRef.current = onLost;
  const shape = useRef<GraphShape>(getGraphShape());
  const branches = useRef<{ grp?: THREE.Group; targets?: Map<string, Pt> }>({});
  const state = useRef({ read: new Set<string>(), wrote: new Set<string>(), reading: null as string | null, open: null as string | null, trail: [] as string[] });

  const onTrail = (l: L) => {
    const t = state.current.trail, i = t.indexOf(idOf(l.source)), j = t.indexOf(idOf(l.target));
    return i >= 0 && j >= 0 && Math.abs(i - j) === 1;
  };
  const trailColor = (l: L) => (state.current.wrote.has(idOf(l.source)) || state.current.wrote.has(idOf(l.target)) ? (light() ? '#b8692a' : LINK_RED) : light() ? '#4f6246' : LINK_BLUE);

  useEffect(() => {
    if (!el.current) return;
    const g = new (ForceGraph3D as any)(el.current, { controlType: 'orbit', rendererConfig: { alpha: true, antialias: true } })
      .backgroundColor('rgba(0,0,0,0)')
      .showNavInfo(false)
      .nodeId('id')
      .nodeRelSize(1.0)
      .nodeOpacity(0.95)
      .nodeResolution(12)
      .nodeLabel((n: N) => n.id)
      .nodeColor((n: N) => colorOf(n))
      .nodeVal((n: N) => (n.name === 'index' || n.name === 'README' ? 2.5 : 1))
      // Highlighted nodes get a glow halo and a name tag; everything else is a plain sphere.
      .nodeThreeObject((n: N) => {
        const s = state.current;
        const hot = n.id === s.reading, on = hot || s.read.has(n.id) || n.id === s.open;
        if (!on) return shape.current === 'tree' ? leaf(n) : null;
        const grp = new THREE.Group();
        const core = new THREE.Mesh(new THREE.SphereGeometry(hot ? 3.4 : 2.6, 16, 16), new THREE.MeshBasicMaterial({ color: light() ? (hot ? '#4f6246' : '#252a22') : hot ? '#ffffff' : BONE }));
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: light() ? '#4f6246' : ACCENT, blending: light() ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: hot ? 0.8 : 0.5 }));
        halo.scale.set(hot ? 18 : 14, hot ? 18 : 14, 1);
        if (hot) halo.userData.breathe = true; // the file being read slowly breathes (see the effect below)
        const tag = label(n.name, hot);
        tag.position.set(0, hot ? 9 : 7, 0);
        grp.add(halo, core, tag);
        return grp;
      })
      .linkColor((l: L) => (onTrail(l) ? trailColor(l) : light() ? 'rgba(106,111,98,0.5)' : 'rgba(159,168,156,0.24)'))
      .linkOpacity(0.4)
      .linkWidth(0) // every link stays a hairline; the links the assistant follows get a glow sleeve instead (no travelling dots)
      .linkThreeObjectExtend((l: L) => onTrail(l))
      .linkThreeObject((l: L) => (onTrail(l) ? glowLink(trailColor(l)) : null))
      .linkPositionUpdate((obj: THREE.Object3D, { start, end }: { start: any; end: any }) => {
        if (!(obj instanceof THREE.Group)) return false;
        obj.position.set(start.x, start.y, start.z);
        obj.lookAt(end.x, end.y, end.z);
        obj.scale.set(1, 1, Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z) || 1);
        return true;
      })
      .onNodeClick((n: N) => onOpen(n.id))
      .warmupTicks(320)
      .cooldownTicks(80)
      .onEngineStop(() => { if (!state.current.reading && !state.current.open) frameAll(g, 800, shape.current === 'tree'); });

    // Tight, brain-like packing: short links, weak repulsion, an ellipsoid boundary.
    g.d3Force('charge').strength(-10).distanceMax(90);
    g.d3Force('link').distance(14).strength(0.5);
    g.d3Force('brain', brainForce(130, 90, 105));
    // Slow orbit while idle.
    const controls = g.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.3; // a slow drift, nothing more
    controls.enableDamping = true;

    fg.current = g;
    (window as any).__aosGraph = g; // for the capture probe
    // A dropped 3D context leaves a dead (blank or white) canvas. Tell the app, which swaps in a new graph.
    const canvas: HTMLCanvasElement | undefined = g.renderer?.()?.domElement;
    const lost = () => lostRef.current?.();
    canvas?.addEventListener('webglcontextlost', lost);
    const fit = () => { if (el.current) g.width(el.current.clientWidth).height(el.current.clientHeight); };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el.current);
    // Dark / light switched in Settings: run every colour accessor again so the graph repaints in the new look.
    const repaint = () => {
      g.nodeColor(g.nodeColor()).nodeThreeObject(g.nodeThreeObject()).linkColor(g.linkColor()).linkThreeObject(g.linkThreeObject());
      if (shape.current === 'tree') { applyShape(g, 'tree', branches.current, g.graphData().nodes); g.nodeThreeObject(g.nodeThreeObject()); } // redraw the branches and leaves in the new colours
    };
    window.addEventListener('aos-theme', repaint);
    // Brain / tree of life switched in Settings: swap the forces and let the notes glide to their new places. Going to
    // the tree, the camera pulls back to where the finished tree will fit (its places are known up front); going back
    // to the brain, it fits once the brain has settled (the engine-stop above).
    const reshape = () => {
      shape.current = getGraphShape();
      applyShape(g, shape.current, branches.current, g.graphData().nodes);
      g.nodeThreeObject(g.nodeThreeObject());
      g.cooldownTicks(160).d3ReheatSimulation();
      if (shape.current === 'tree') frameAll(g, 1400, true, branches.current.targets?.values());
    };
    window.addEventListener('aos-graph-shape', reshape);
    return () => { window.removeEventListener('aos-theme', repaint); window.removeEventListener('aos-graph-shape', reshape); canvas?.removeEventListener('webglcontextlost', lost); ro.disconnect(); g._destructor?.(); };
  }, [onOpen]);

  useEffect(() => {
    const g = fg.current;
    if (!g) return;
    if (paused) g.pauseAnimation?.(); else g.resumeAnimation?.();
  }, [paused]);

  useEffect(() => {
    const g = fg.current;
    if (!g) return;
    // Notes that were already placed keep their spot, so a new note or link settles into the brain that is there
    // instead of the whole layout being thrown away and worked out again (320 ticks, a visible stall and reshuffle).
    const old = new Map<string, N>((g.graphData().nodes as N[]).map((n) => [n.id, n]));
    const nodes: N[] = data.nodes.map((n) => { const o = old.get(n.id); return o && o.x != null ? { ...n, x: o.x, y: o.y, z: o.z } : { ...n }; });
    const settled = nodes.length > 0 && nodes.filter((n) => n.x != null).length >= nodes.length * 0.8;
    g.warmupTicks(settled ? 0 : 320).cooldownTicks(settled ? 40 : 80);
    applyShape(g, shape.current, branches.current, nodes); // before the data, so the first settling already uses this shape
    g.graphData({ nodes, links: data.links.map((l) => ({ ...l })) });
    if (settled) return; // the camera stays where it is
    const t = setTimeout(() => frameAll(g, 0, shape.current === 'tree'), 50);
    return () => clearTimeout(t);
  }, [data]);

  useEffect(() => {
    state.current = { read: new Set(read), wrote: new Set(wrote), reading, open, trail: read };
    const g = fg.current;
    if (!g) return;
    // Re-evaluate the accessor functions against the new highlight state.
    g.nodeThreeObject(g.nodeThreeObject());
    g.linkColor(g.linkColor()).linkThreeObjectExtend(g.linkThreeObjectExtend()).linkThreeObject(g.linkThreeObject());

    // The camera never zooms or flies to a file, whether the assistant reads it or the user opens it (their call, 2026-10-03).
    // Files just light up where they are.
    g.controls().autoRotate = true;

    // While the assistant is looking, the halo on the file they're reading slowly swells and fades: an ethereal glow, no moving dots.
    if (!reading) return;
    let raf = 0;
    const breathe = (t: number) => {
      const k = 0.5 + 0.5 * Math.sin(t / 900);
      g.scene().traverse((o: any) => {
        if (o.userData?.breathe) { o.scale.set(16 + 6 * k, 16 + 6 * k, 1); o.material.opacity = 0.55 + 0.3 * k; }
      });
      raf = requestAnimationFrame(breathe);
    };
    raf = requestAnimationFrame(breathe);
    return () => cancelAnimationFrame(raf);
  }, [read, wrote, reading, open]);

  return <div ref={el} className="graph" aria-label="Vault graph (3D). Drag to rotate, scroll to zoom, click a note to open it." />;
}
