// A project's colour: the same in the map, Projects, Actions, Notes and Health. Look B's muted set: mid-tone, low
// saturation, readable as dots on both the paper and the charcoal theme. Colours are handed out in alphabetical order
// of the project folders Agentic OS has seen, so no two projects share one until there are more projects than colours.
// Before any project list has arrived, a stable pick from the name is used.
const PALETTE = ['#4a6fb5', '#5f8f6e', '#b0683f', '#a8862f', '#8a5f9e', '#4f8a96', '#a65d6f', '#6f7f3c', '#5d6c9e', '#9a6a3a'];
export const OTHER_COLOR = '#9a948b'; // anything that is not a project (the index, skills, loose notes)
let known: string[] = [];
export function rememberProjects(names: string[]) {
  const next = [...new Set([...known, ...names])].sort((a, b) => a.localeCompare(b));
  const changed = next.length !== known.length;
  known = next;
  return changed;
}
export function projectColor(name: string) {
  const i = known.indexOf(name);
  if (i >= 0) return PALETTE[i % PALETTE.length];
  let h = 2166136261; for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return PALETTE[h % PALETTE.length];
}
