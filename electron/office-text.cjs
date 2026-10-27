// Plain text out of Word (.docx), PowerPoint (.pptx) and Excel (.xlsx) files, for the search index. These are zip
// archives of XML, so Node's own zlib is enough: no extra package. Read-only; nothing is written. Anything unreadable
// (a damaged or password-protected file) gives an empty result instead of an error, so one bad file never stops a build.
const fs = require('fs');
const zlib = require('zlib');

const MAX_FILE = 60_000_000; // bytes; bigger files are skipped
const MAX_ENTRY = 12_000_000; // bytes inflated per part; bigger parts (a sheet of raw data rows) are left out
const MAX_TEXT = 400_000; // characters kept

// The files inside a zip, from its central directory: { name -> { method, csize, offset } }.
function zipEntries(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) return null;
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let n = 0; n < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    out.set(buf.toString('utf8', p + 46, p + 46 + nameLen), { method, csize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
function zipRead(buf, e) {
  if (!e || buf.readUInt32LE(e.offset) !== 0x04034b50) return '';
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const raw = buf.subarray(start, start + e.csize);
  if (e.method === 0) return raw.toString('utf8');
  if (e.method === 8) { try { return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY }).toString('utf8'); } catch { return ''; } } // a part over the limit (a workbook of raw rows) is skipped, not the whole file
  return '';
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
// The words of a run of OOXML: text inside <w:t>/<a:t>/<t>, with a space at each paragraph or cell end.
const runs = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))].map((m) => unxml(m[1])).join(' ');
const numbered = (names, re) => names.filter((n) => re.test(n)).sort((a, b) => parseInt(a.replace(/\D+/g, ''), 10) - parseInt(b.replace(/\D+/g, ''), 10));

function docx(z, buf) {
  const parts = ['word/document.xml', ...numbered([...z.keys()], /^word\/(header|footer|footnotes|endnotes)\d*\.xml$/)];
  return parts.filter((n) => z.has(n)).map((n) => {
    const xml = zipRead(buf, z.get(n));
    return xml.split(/<\/w:p>/).map((par) => runs(par, 'w:t')).filter(Boolean).join('\n');
  }).join('\n');
}
function pptx(z, buf) {
  const slides = numbered([...z.keys()], /^ppt\/slides\/slide\d+\.xml$/);
  const notes = numbered([...z.keys()], /^ppt\/notesSlides\/notesSlide\d+\.xml$/);
  return [...slides, ...notes].map((n, i) => {
    const xml = zipRead(buf, z.get(n));
    return xml.split(/<\/a:p>/).map((par) => runs(par, 'a:t')).filter(Boolean).join('\n');
  }).join('\n\n');
}
function xlsx(z, buf) {
  // Cells hold either a number/text or an index into one shared list of strings.
  const shared = z.has('xl/sharedStrings.xml') ? [...zipRead(buf, z.get('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runs(m[1], 't')) : [];
  const names = [...zipRead(buf, z.get('xl/workbook.xml') || {}).matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => unxml(m[1]));
  const out = [];
  for (const [i, n] of numbered([...z.keys()], /^xl\/worksheets\/sheet\d+\.xml$/).entries()) {
    out.push(`Sheet: ${names[i] || i + 1}`);
    const xml = zipRead(buf, z.get(n));
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const inner = c[2] || '';
        const v = /<v>([^<]*)<\/v>/.exec(inner);
        const val = /\bt="s"/.test(c[1]) ? shared[Number(v && v[1])] : /\bt="inlineStr"/.test(c[1]) ? runs(inner, 't') : v ? unxml(v[1]) : '';
        if (val) cells.push(val);
      }
      if (cells.length) out.push(cells.join(' | '));
    }
    if (out.join('\n').length > MAX_TEXT) break;
  }
  return out.join('\n');
}

// The text of an Office file, or '' if it is not one, is too large, or cannot be read.
function officeText(abs) {
  const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase();
  const read = { '.docx': docx, '.pptx': pptx, '.xlsx': xlsx }[ext];
  if (!read) return '';
  try {
    if (fs.statSync(abs).size > MAX_FILE) return '';
    const buf = fs.readFileSync(abs);
    const z = zipEntries(buf);
    if (!z) return '';
    return read(z, buf).replace(/[ \t]+/g, ' ').slice(0, MAX_TEXT);
  } catch { return ''; }
}

module.exports = { officeText, isOffice: (rel) => /\.(docx|pptx|xlsx)$/i.test(rel) };
