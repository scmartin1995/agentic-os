// Two search boxes list a file once even when the vault holds a working copy next to the finished one (a template in
// work/, the built page in Output/). Same title in the same session folder counts as the same file; the finished one wins.
const dir = (p: string) => p.split('/').slice(0, -1);
const twinKey = (title: string, path: string) => `${title.trim().toLowerCase()}|${dir(path).slice(0, -1).join('/')}`;
const rank = (p: string) => (/\/(Output|Client Facing)\//i.test(p) ? 0 : /\/(work|Input|Raw)\//i.test(p) ? 2 : 1);

export function dedupeTwins<T>(items: T[], title: (t: T) => string, path: (t: T) => string): T[] {
  const best = new Map<string, T>();
  for (const it of items) {
    const k = twinKey(title(it), path(it)), cur = best.get(k);
    if (!cur || rank(path(it)) < rank(path(cur))) best.set(k, it);
  }
  const keep = new Set(best.values());
  return items.filter((it) => keep.has(it));
}
