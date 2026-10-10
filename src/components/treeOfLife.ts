import * as THREE from 'three';

// The vault grown as one tree, lit from within: a bone-white trunk, the projects and legacy as the limbs of the crown
// (each in its own colour), agent-os, skills and notes as the roots underneath. Folders branch off their parent
// partway along it, as real branches do, thinner and shorter at every level, and a folder's notes hang as glowing
// leaves along the outer half of its branch. Everything comes from the folder structure and the file names, so the
// same vault always grows the same tree.
//
// Shapes borrowed from procedural tree generators (dgreenheck's tree-js, space-colonisation trees): children start a
// fraction of the way along the parent, stagger round the stem by the golden angle, taper per level, and curve toward
// the light (crown) or the ground (roots).

export type TreeNode = { id: string; name: string; group: string; received?: boolean };
export type Pt = { x: number; y: number; z: number };
type Folder = { name: string; path: string; folders: Map<string, Folder>; files: TreeNode[]; leaves: number; sample: TreeNode };
type Branch = { curve: THREE.CubicBezierCurve3; r0: number; r1: number; a: THREE.Color; b: THREE.Color; depth: number };

const ROOT_GROUPS = new Set(['agent', 'agent-os', 'skills', 'notes', 'logs', '_templates', 'inbox', 'attachments', 'assets', 'archive']);
const UP = new THREE.Vector3(0, 1, 0);
const GOLD = Math.PI * (3 - Math.sqrt(5)); // the golden angle: how leaves and branches stagger round a stem
const TRUNK_BASE = new THREE.Vector3(0, -16, 0), TRUNK_TOP = new THREE.Vector3(0, 36, 0);
const isHub = (n: TreeNode) => n.name === 'index' || n.name === 'README';

// A steady 0..1 number from a name, so the same note always lands in the same place.
function hash01(s: string) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return ((x >>> 0) % 100000) / 100000;
}

function folderTree(nodes: TreeNode[]) {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [], leaves: 0, sample: nodes[0] };
  for (const n of nodes) {
    const parts = n.id.split('/');
    let f = root;
    f.leaves++;
    for (let i = 0; i < parts.length - 1; i++) {
      let c = f.folders.get(parts[i]);
      if (!c) { c = { name: parts[i], path: parts.slice(0, i + 1).join('/'), folders: new Map(), files: [], leaves: 0, sample: n }; f.folders.set(parts[i], c); }
      f = c;
      f.leaves++;
      if (n.received) f.sample = n; // a received folder colours its whole branch dark red
    }
    f.files.push(n);
  }
  return root;
}

// Two directions at right angles to `t`, for placing things round a stem.
function frame(t: THREE.Vector3) {
  const n = new THREE.Vector3().crossVectors(t, Math.abs(t.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0)).normalize();
  return { n, b: new THREE.Vector3().crossVectors(t, n).normalize() };
}

export function growTree(nodes: TreeNode[], color: (n: TreeNode) => string, trunkColor: string) {
  const targets = new Map<string, Pt>();
  const branches: Branch[] = [];
  const bone = new THREE.Color(trunkColor);
  const folderColor = (f: Folder) => new THREE.Color(color(f.sample.received ? f.sample : { ...f.sample, id: f.path + '/_', group: f.path.split('/')[0] }));

  // One branch: a curve from `start` heading `dir`, its sub-folders growing off it, its notes hung as leaves.
  // side 1 grows up toward the light, -1 is a root reaching down and out.
  const grow = (f: Folder, start: THREE.Vector3, dir: THREE.Vector3, len: number, r0: number, depth: number, side: 1 | -1, parentColor: THREE.Color) => {
    const own = folderColor(f);
    const lift = UP.clone().multiplyScalar(side * len * 0.16); // the outer half bends toward the light (or the ground)
    const c1 = start.clone().addScaledVector(dir, len * 0.35);
    const c2 = start.clone().addScaledVector(dir, len * 0.72).addScaledVector(lift, 0.45);
    const end = start.clone().addScaledVector(dir, len).add(lift);
    const curve = new THREE.CubicBezierCurve3(start, c1, c2, end);
    const r1 = Math.max(0.12, r0 * 0.3);
    const radiusAt = (t: number) => r0 + (r1 - r0) * t;
    branches.push({ curve, r0, r1, a: parentColor, b: own, depth });

    // Sub-folders: the biggest lowest on the branch, like real limbs; each staggered round the stem by the golden angle.
    const kids = [...f.folders.values()].sort((p, q) => q.leaves - p.leaves);
    const span = Math.log(f.leaves + 1);
    kids.forEach((c, i) => {
      const t = kids.length === 1 ? 0.62 : 0.3 + 0.62 * ((i + 0.5) / kids.length);
      const p = curve.getPoint(t), tan = curve.getTangent(t), { n, b } = frame(tan);
      const phi = i * GOLD + hash01(c.path) * Math.PI * 2, theta = 0.6 + 0.4 * hash01(c.path + '~');
      const d = tan.clone().multiplyScalar(Math.cos(theta)).addScaledVector(n, Math.sin(theta) * Math.cos(phi)).addScaledVector(b, Math.sin(theta) * Math.sin(phi));
      d.addScaledVector(UP, side * 0.2).normalize(); // phototropism: branches reach up, roots reach down
      const size = Math.log(c.leaves + 1) / span; // this sub-folder's share of the notes, 0..1
      grow(c, p, d, Math.max(7, len * (side === 1 ? 0.42 + 0.4 * size : 0.36 + 0.3 * size)), Math.max(0.18, radiusAt(t) * (0.45 + 0.35 * size)), depth + 1, side, own);
    });

    // Leaves: the folder's notes, hung round the outer part of the branch. Big folders make fuller, wider clusters.
    const leaves = f.files.filter((n) => !isHub(n)), fullness = 1 + Math.min(2.2, leaves.length / 25);
    for (const n of leaves) {
      const t = 0.38 + 0.66 * hash01(n.id), p = curve.getPoint(Math.min(1, t)), { n: nn, b } = frame(curve.getTangent(Math.min(1, t)));
      const rho = (2 + 4.5 * hash01(n.id + 'r')) * fullness, a = hash01(n.id + 'a') * Math.PI * 2;
      const q = p.addScaledVector(nn, Math.cos(a) * rho).addScaledVector(b, Math.sin(a) * rho).addScaledVector(UP, side * rho * 0.35);
      if (t > 1) q.addScaledVector(curve.getTangent(1), (t - 1) * len * 0.8); // the last few reach past the tip
      targets.set(n.id, { x: q.x, y: q.y, z: q.z });
    }
    // The folder's own index / README sits at the fork, where the branch leaves its parent.
    for (const n of f.files.filter(isHub)) { const p = curve.getPoint(0.1); targets.set(n.id, { x: p.x + hash01(n.id) * 2, y: p.y + side * 2.2, z: p.z + hash01(n.id + 'z') * 2 }); }
  };

  const root = folderTree(nodes);
  // With a projects/ folder each project is a limb of its own; everything else at the top level is one limb or root.
  const crown: Folder[] = [], roots: Folder[] = [];
  for (const [k, f] of root.folders) {
    if (k === 'projects') { crown.push(...f.folders.values()); root.files.push(...f.files); }
    else (ROOT_GROUPS.has(k) || k.startsWith('.') ? roots : crown).push(f);
  }

  // The trunk: a slight S-bend so it reads as grown, not drawn.
  const trunk = new THREE.CubicBezierCurve3(TRUNK_BASE, new THREE.Vector3(2.5, 0, 1.5), new THREE.Vector3(-2.5, 22, -1.5), TRUNK_TOP);
  branches.push({ curve: trunk, r0: 4.4, r1: 2.6, a: bone, b: bone, depth: 0 });
  for (const n of root.files) { // notes at the top of the workspace cling to the trunk
    const t = 0.28 + 0.3 * hash01(n.id), p = trunk.getPoint(t), a = hash01(n.id + 'a') * Math.PI * 2;
    targets.set(n.id, { x: p.x + Math.cos(a) * 6.5, y: p.y, z: p.z + Math.sin(a) * 6.5 });
  }
  // Limbs leave the top third of the trunk, the biggest lowest; roots leave the bottom and spread wide and shallow.
  for (const [side, groups] of [[1, crown], [-1, roots]] as const) {
    const sorted = [...groups].sort((p, q) => q.leaves - p.leaves);
    const biggest = Math.log((sorted[0]?.leaves || 1) + 1);
    sorted.forEach((f, i) => {
      const size = Math.log(f.leaves + 1) / biggest;
      const t = side === 1 ? 0.6 + 0.4 * ((i + 0.5) / sorted.length) : 0.16 - 0.14 * ((i + 0.5) / sorted.length);
      const p = trunk.getPoint(t);
      // Limbs leave at 45-70 degrees from vertical, so the crown spreads wider than it is tall; roots flatter still.
      const phi = i * GOLD + hash01(f.path) * 0.6, theta = side === 1 ? 0.8 + 0.42 * hash01(f.path + '~') : 1.05 + 0.35 * hash01(f.path + '~');
      const d = new THREE.Vector3(Math.cos(phi) * Math.sin(theta), side * Math.cos(theta), Math.sin(phi) * Math.sin(theta));
      const len = side === 1 ? 30 + 42 * size : 14 + 18 * size; // roots are shallow and wide, the way real ones are
      grow(f, p, d, len, side === 1 ? 1.3 + 1.7 * size : 1.1 + 1.3 * size, 1, side, bone);
    });
  }

  // The layout engine keeps the notes' centre of mass at the origin, so shift the whole tree to match.
  const c = new THREE.Vector3();
  for (const t of targets.values()) c.add(new THREE.Vector3(t.x, t.y, t.z));
  c.divideScalar(targets.size || 1);
  for (const [k, t] of targets) targets.set(k, { x: t.x - c.x, y: t.y - c.y, z: t.z - c.z });
  return { targets, branches, shift: c.clone().negate() };
}

// All the branches as one tapered, vertex-coloured mesh (one draw call), plus a wide faint sleeve round the trunk and
// limbs so they seem to give off light. In light mode there is no sleeve: additive light vanishes on a pale backdrop.
export function skeleton(branches: Branch[], shift: THREE.Vector3, light: boolean) {
  const grp = new THREE.Group();
  const build = (sel: Branch[], scale: number, segs: number, sides: number) => {
    const pos: number[] = [], col: number[] = [], idx: number[] = [];
    for (const br of sel) {
      const frames = br.curve.computeFrenetFrames(segs, false), base = pos.length / 3;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs, p = br.curve.getPoint(t), r = (br.r0 + (br.r1 - br.r0) * t) * scale;
        const c = br.a.clone().lerp(br.b, Math.min(1, t * 1.6)), N = frames.normals[i], B = frames.binormals[i];
        for (let j = 0; j < sides; j++) {
          const a = (j / sides) * Math.PI * 2;
          pos.push(p.x + (N.x * Math.cos(a) + B.x * Math.sin(a)) * r, p.y + (N.y * Math.cos(a) + B.y * Math.sin(a)) * r, p.z + (N.z * Math.cos(a) + B.z * Math.sin(a)) * r);
          col.push(c.r, c.g, c.b);
        }
      }
      for (let i = 0; i < segs; i++) for (let j = 0; j < sides; j++) {
        const a = base + i * sides + j, b = base + i * sides + ((j + 1) % sides), c2 = a + sides, d = b + sides;
        idx.push(a, b, c2, b, d, c2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    return geo;
  };
  grp.add(new THREE.Mesh(build(branches, 1, 18, 8), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: light ? 0.75 : 0.62, depthWrite: false })));
  if (!light) {
    const thick = branches.filter((b) => b.depth <= 1);
    grp.add(new THREE.Mesh(build(thick, 2.6, 12, 8), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false })));
  }
  grp.position.copy(shift);
  return grp;
}

// Pulls every note to its place on the tree. Nothing else acts on the notes in tree mode, so they settle exactly there.
export function treePull(targets: Map<string, Pt>) {
  let nodes: any[] = [];
  const force = (alpha: number) => {
    const k = Math.min(0.32, alpha * 1.2);
    for (const n of nodes) {
      const t = targets.get(n.id);
      if (!t) continue;
      n.vx += (t.x - n.x) * k; n.vy += (t.y - n.y) * k; n.vz += (t.z - n.z) * k;
    }
  };
  force.initialize = (ns: any[]) => { nodes = ns; };
  return force;
}

// A soft filled glow, shared by every leaf; tinted per note by the sprite's colour.
let leafTex: THREE.Texture | null = null;
export function leafTexture() {
  if (leafTex) return leafTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,.9)');
  g.addColorStop(0.25, 'rgba(255,255,255,.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  leafTex = new THREE.CanvasTexture(c);
  return leafTex;
}
