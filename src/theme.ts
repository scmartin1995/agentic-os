// Dark or light look (Settings > Appearance). The choice lives on <html data-theme="..."> so the stylesheet can
// swap its colour variables (see :root in styles.css), and is remembered in this window's storage like the mute
// and wake-word switches. Anything that paints its own colours (the 3D graph) listens for the 'aos-theme' event.
export type Theme = 'dark' | 'light';
const KEY = 'aos-theme';

export const getTheme = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const saved = (): Theme => { try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } };

export function applyTheme(t: Theme = saved()) {
  document.documentElement.dataset.theme = t;
  window.dispatchEvent(new CustomEvent('aos-theme', { detail: t }));
}
export function setTheme(t: Theme) {
  try { localStorage.setItem(KEY, t); } catch {}
  applyTheme(t);
}
