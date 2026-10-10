import type { ProjectFile } from './types';

// Turns a flat list of a project's files into nested folders, for the Projects panel's dropdowns.
// Each file's `sub` is its folder relative to the project. `base` (a folder inside the project) is stripped
// from the front, so the tree starts below it. A folder with no files and exactly one sub-folder is merged
// with that sub-folder ("a/b"), so you never open an empty level.
export interface FileNode { name: string; files: ProjectFile[]; kids: FileNode[] }

export const countOf = (n: FileNode): number => n.files.length + n.kids.reduce((a, k) => a + countOf(k), 0);

const rank = (f: ProjectFile) => (/^(index|readme)\.md$/i.test(f.name) ? 0 : f.name === 'SKILL.md' ? 1 : 2);

export function buildTree(files: ProjectFile[], base = ''): FileNode {
  const root: FileNode = { name: '', files: [], kids: [] };
  const baseParts = base.split('/').filter(Boolean);
  for (const f of files) {
    let parts = f.sub.split('/').filter(Boolean);
    if (baseParts.length && baseParts.every((p, i) => parts[i] === p)) parts = parts.slice(baseParts.length);
    let n = root;
    for (const p of parts) {
      let k = n.kids.find((x) => x.name === p);
      if (!k) { k = { name: p, files: [], kids: [] }; n.kids.push(k); }
      n = k;
    }
    n.files.push(f);
  }
  const tidy = (n: FileNode) => {
    n.kids.forEach(tidy);
    while (n.name !== '' && n.files.length === 0 && n.kids.length === 1) {
      const k = n.kids[0];
      n.name = `${n.name}/${k.name}`; n.files = k.files; n.kids = k.kids;
    }
    n.kids.sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  };
  tidy(root);
  return root;
}
