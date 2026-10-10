// Small helpers the Notes and Action items panels share (the files themselves are read and written by
// electron/actions.cjs; this is only what the screen needs to show them).

// The same rule as actions.cjs: "action item" in any capitals, then a colon, a dash or just a space.
export const PREFIX = /^\s*action item\b\s*[:\-–—]?\s*/i;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const p2 = (n: number) => String(n).padStart(2, '0');
export const hhmm = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
export const ymd = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const dayLong = (d: Date) => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
export const fromYmd = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const mondayOf = (d: Date) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
export const pretty = (p: string) => p.replace(/[_-]/g, ' ');

// Whole days between an item's "added" date and today (0 = today).
export const ageDays = (added: string | null) => (added ? Math.max(0, Math.round((fromYmd(ymd(new Date())).getTime() - fromYmd(added.slice(0, 10)).getTime()) / 864e5)) : null);

// "call the dealer, waiting on Sam" -> ["call the dealer", "Sam"]
export function splitWaiting(text: string): [string, string | null] {
  const m = text.match(/[,;]?\s*\(?waiting on ([^()]+?)\)?\s*$/i);
  return m && m.index! > 0 ? [text.slice(0, m.index).trim(), m[1].trim()] : [text, null];
}

// Errors thrown in the app arrive as "Error invoking remote method 'x': Error: the real message".
export const errText = (e: unknown) => String((e as Error)?.message || e).replace(/^.*?Error: /, '');
