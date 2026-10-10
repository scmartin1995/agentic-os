// Which shape the workspace graph takes: packed like a brain (default) or grown like the tree of life.
// Kept apart from Graph.tsx so Settings can use it without loading the 3D code.
export type GraphShape = 'brain' | 'tree';
const KEY = 'aos-graph-shape';

export const getGraphShape = (): GraphShape => { try { return localStorage.getItem(KEY) === 'tree' ? 'tree' : 'brain'; } catch { return 'brain'; } };

export function setGraphShape(s: GraphShape) {
  try { localStorage.setItem(KEY, s); } catch { /* not saved */ }
  window.dispatchEvent(new Event('aos-graph-shape'));
}
