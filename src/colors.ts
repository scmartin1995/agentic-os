// Colours that the node map, its legend and the panels share. Kept apart from Graph.tsx so panels (and the phone) don't
// pull in the 3D library just for a colour.
//
// Notes are coloured by their top folder. Dark theme: bright on deep green. Light theme: deeper versions for cream.
const GROUP: Record<string, [string, string]> = {
  projects: ['#b7d17e', '#4f6246'],
  inbox: ['#f0a060', '#b8692a'],
  skills: ['#f2eeeb', '#8a8272'],
  agent: ['#9fb0b5', '#5d747b'],
};
const OTHER: [string, string] = ['#7d8b90', '#6a6f62'];
export const groupColor = (group: string, light: boolean) => (GROUP[group] || OTHER)[light ? 1 : 0];
// The legend under the node map, in this order; everything else is "Other".
export const LEGEND: { group: string; label: string }[] = [
  { group: 'projects', label: 'Projects' }, { group: 'inbox', label: 'Inbox' }, { group: 'skills', label: 'Skills' }, { group: 'agent', label: 'Agent' },
];

// A project's own hue, for the Actions, Notes and Health panels: picked from a muted set by its name, so it stays the
// same from one launch to the next.
const SPARE = ['#b7d17e', '#9fb0b5', '#d9c38c', '#8fbf9f', '#c7a6c9', '#e09f7d'];
export function projectColor(p: string) {
  let h = 0; for (const c of p) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return SPARE[h % SPARE.length];
}
