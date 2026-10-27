import { useEffect, useRef, useState } from 'react';
import type { OkfMode, OkfResult } from '../types';

// Your files: choose the folder, then choose how Agentic OS should keep your notes (OKF) and why. Agentic OS works out the folder's
// layout itself, from the folder map it is given in every chat, so there is no scan to run first. Used in setup and in Settings.
type Phase = 'pick' | 'review' | 'applying' | 'done';

const CHOICES: { id: OkfMode; label: string; line: string }[] = [
  { id: 'index', label: 'Add an index on top', line: 'Agentic OS adds an index page to each folder that lacks one, plus a log. No note you already have is edited, moved or renamed. Notes Agentic OS writes follow the structure, and it files them for you.' },
  { id: 'tidy', label: 'Help me organise it', line: 'Everything in the choice above, and Agentic OS can suggest bringing older notes into shape, one plain sentence at a time. Nothing is changed, moved or renamed until you say yes.' },
  { id: 'leave', label: 'Leave my notes exactly as they are', line: 'Agentic OS adds only its own folders (skills and rules). It adds nothing to your notes. It finds things by searching, which is slower and uses more of your allowance.' },
];

const n = (x: number) => x.toLocaleString();
const plural = (c: number, one: string, many = one + 's') => `${n(c)} ${c === 1 ? one : many}`;

export default function NotesSetup({ onReady }: { onReady?(ok: boolean, notes: number): void }) {
  const [phase, setPhase] = useState<Phase>('pick');
  const [root, setRoot] = useState('');
  const [exists, setExists] = useState(false);
  const [mode, setMode] = useState<OkfMode | null>(null);
  const [picked, setPicked] = useState<OkfMode>('index');
  const [result, setResult] = useState<OkfResult | null>(null);
  const [err, setErr] = useState('');
  const [notesCount, setNotesCount] = useState(0);
  const ready = useRef(onReady); ready.current = onReady;

  const review = () => { setErr(''); setPhase('review'); };
  useEffect(() => {
    Promise.all([window.aos.vault.info(), window.aos.setup.get()]).then(([i, b]) => {
      setRoot(i.root); setExists(i.exists); setMode(b.okfMode); setNotesCount(i.notes);
      if (i.exists && b.okfMode) { setPhase('done'); ready.current?.(true, i.notes); }
      else if (i.exists) { setPhase('review'); ready.current?.(false, i.notes); }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = async () => {
    const r = await window.aos.setup.pickFolder();
    if (!r) return;
    await window.aos.setup.set({ vaultPath: r.path });
    setRoot(r.path); setExists(true); setMode(null); setResult(null);
    review();
  };
  const starter = async () => {
    const r = await window.aos.setup.starterVault();
    await window.aos.setup.set({ vaultPath: r.path });
    setRoot(r.path); setExists(true); setMode('index'); setResult(null); setPhase('done'); ready.current?.(true, r.notes);
  };
  const apply = async () => {
    setPhase('applying'); setErr('');
    try {
      const r = await window.aos.setup.applyOkf(picked);
      setResult(r); setMode(picked); setPhase('done'); ready.current?.(true, notesCount);
    } catch (e) { setErr(String((e as Error).message || e)); setPhase('review'); }
  };

  if (phase === 'pick') {
    return (
      <div className="ns">
        <div className={`status-line ${exists ? 'good' : 'off'}`}><i className="dot" /><span className="mono" style={{ overflowWrap: 'anywhere' }}>{root || 'no folder chosen'}</span></div>
        <div className="setting-actions">
          <button className="cta" onClick={choose}>Choose a folder…</button>
          <button className="ghost" onClick={starter}>I don't have one: make a starter folder</button>
        </div>
        {err && <p className="ns-err">{err}</p>}
      </div>
    );
  }

  if (phase === 'done') {
    const label = CHOICES.find((c) => c.id === mode)?.label || '';
    return (
      <div className="ns">
        <div className="status-line good"><i className="dot" /><span className="mono" style={{ overflowWrap: 'anywhere' }}>{root}</span></div>
        <div className="ns-card">
          <b>Kept as: {label.toLowerCase()}</b>
          {result
            ? <span>Agentic OS added {plural(result.made.length, 'file')}{result.indexes ? `, ${plural(result.indexes, 'of them index page')}` : ''}{result.kept ? `, and left ${plural(result.kept, 'existing file')} alone` : ''}. {result.skills ? `${plural(result.skills, 'learning skill')} installed. ` : ''}{result.manifest === 'other' ? 'This folder already has a plugin file with another name, so the skills may not load: ask whoever set it up.' : ''}</span>
            : <span>Chosen earlier. You can change the choice at any time.</span>}
        </div>
        <div className="setting-actions">
          <button className="ghost" onClick={review}>Change this</button>
          <button className="ghost" onClick={choose}>Choose another folder…</button>
        </div>
      </div>
    );
  }

  return (
    <div className="ns">
      <div className="status-line good"><i className="dot" /><span className="mono" style={{ overflowWrap: 'anywhere' }}>{root}</span></div>
      <div className="ns-cols">
      <div className="ns-card">
        <b>What is OKF, and why does it matter?</b>
        <span>OKF is a plain way of keeping notes so an assistant can find things fast. Notes are ordinary text files. Each starts with a short header (what it is, its title, a one-line description). Each folder has an index page listing what is inside, and a log records what changed.</span>
        <span>Agentic OS answers by reading the index pages first and opening only the notes they point to. With indexes it reads less, answers faster, uses fewer tokens (so it costs less on your gateway) and misses less. It stays plain text you can open in any editor, so your notes still work without Agentic OS.</span>
      </div>
      </div>

      <div className="ns-pick" role="radiogroup" aria-label="How Agentic OS should keep your notes">
        <b>How should Agentic OS keep your notes?</b>
        {CHOICES.map((c) => (
          <button key={c.id} role="radio" aria-checked={picked === c.id} className={`ns-opt${picked === c.id ? ' on' : ''}`} onClick={() => setPicked(c.id)}>
            <i />
            <span><b>{c.label}{c.id === 'index' ? ' (recommended)' : ''}</b>{c.line}</span>
          </button>
        ))}
      </div>
      <p className="ns-fine">Either way, Agentic OS installs four learning skills in this folder (learn, lessons review, skill tidy and model selection). After every tenth question in a chat it quietly reviews what the chat taught and saves it as a skill. They are plain files you can read or delete. If the folder already has a skills folder, yours are kept and only missing ones are added.</p>
      {err && <p className="ns-err">{err}</p>}
      <div className="setting-actions">
        <button className="cta" onClick={apply} disabled={phase === 'applying'}>{phase === 'applying' ? 'Setting up…' : 'Apply this choice'}</button>
        <button className="ghost" onClick={choose}>Choose another folder…</button>
      </div>
    </div>
  );
}
