import { useState } from 'react';
import type { Basics, OrbState } from '../types';
import Orb from './Orb';
import BrainSetup from './BrainSetup';
import NotesSetup from './NotesSetup';
import Icon from '../icons';

// First run (and "Run setup again" in Settings): three short steps, with Agentic OS on the left reacting as you go.
//   1 you      - what it should call you
//   2 brain    - which AI, signed in with your subscription or an API key
//   3 files    - the folder it lives in, what Agentic OS finds there, and how it should keep the notes
// (Agentic OS is text only at launch, so the old voice-check step is gone.)
const STEPS = ['You', 'Brain', 'Files'] as const;
const SAY = [
  "I'm Agentic OS. Setup takes about a minute.",
  "Connect me to Claude: paste the gateway address and key you were given.",
  "Show me where your notes are. I'll look, tell you what I find, and then you choose.",
];
const POSE: OrbState[] = ['replying', 'thinking', 'replying'];

export default function Onboarding({ basics, windowBtns, onDone }: { basics: Basics; windowBtns: React.ReactNode; onDone(): void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState(basics.userName);
  const [brain, setBrain] = useState<{ ok: boolean; label: string }>({ ok: false, label: '' });
  const [notesReady, setNotesReady] = useState<{ ok: boolean; notes: number | null }>({ ok: false, notes: null });
  const [busy, setBusy] = useState(false);

  const can = [name.trim().length > 0, brain.ok, notesReady.ok][step];
  const next = async () => {
    if (step === 0) await window.aos.setup.set({ userName: name.trim() });
    if (step < STEPS.length - 1) { setStep(step + 1); return; }
    setBusy(true);
    await window.aos.setup.set({ onboarded: true });
    setBusy(false);
    onDone();
  };

  return (
    <div className="onb">
      <div className="backdrop"><i /></div>
      <div className="onb-drag" />
      {windowBtns}
      <aside className="onb-hero">
        <Orb state={POSE[step]} sub="" voice={null} wake={null} />
        <div className="onb-say" key={step}>{step === 1 && brain.ok ? `Connected: ${brain.label}.` : step === 2 && notesReady.ok && notesReady.notes ? `${notesReady.notes} notes found.` : SAY[step]}</div>
      </aside>
      <main className="onb-main">
        <div className="onb-scroll">
          {step === 0 && (
            <div className="onb-step">
              <h1>Meet <em>Agentic OS</em>.</h1>
              <p>Your assistant for this computer. It reads your notes, does the jobs you hand it, and asks before anything that can't be undone.</p>
              <label className="lab" style={{ maxWidth: 360, fontSize: 13 }}>What should it call you?
                <input className="field" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && can) next(); }} placeholder="Your first name" maxLength={40} />
              </label>
              <div className="facts">
                <div className="card fact"><b><Icon name="brain" />Claude, your way in</b><span>Your organisation's gateway, an API key, or a Claude plan.</span></div>
                <div className="card fact"><b><Icon name="files" />Your notes, your PC</b><span>It works in a folder you choose. Edits are backed up first.</span></div>
              </div>
            </div>
          )}
          {step === 1 && (
            <div className="onb-step">
              <h1>Choose its <em>brain</em>.</h1>
              <p>Use the plan you already pay for, or paste an API key. You can change this any time in Settings.</p>
              <BrainSetup onReady={(ok, label) => setBrain({ ok, label })} />
            </div>
          )}
          {step === 2 && (
            <div className="onb-step">
              <h1>Where are your <em>files</em>?</h1>
              <p>Agentic OS works in one folder (an Obsidian vault works as it is). It reads the folder to answer you and writes its work back there. Choose it, then say how Agentic OS should keep your notes. It can look through the folder first if you want.</p>
              <NotesSetup onReady={(ok, notes) => setNotesReady({ ok, notes })} />
            </div>
          )}
        </div>
        <footer className="onb-foot">
          <div className="onb-dots" aria-label={`Step ${step + 1} of ${STEPS.length}`}>{STEPS.map((s, i) => <i key={s} className={i === step ? 'on' : i < step ? 'done' : ''} />)}</div>
          <span className="small muted">{STEPS[step]}</span>
          <span className="flex" />
          {step > 0 && <button className="ghost" onClick={() => setStep(step - 1)}>Back</button>}
          <button className="cta" onClick={next} disabled={!can || busy}>{step === STEPS.length - 1 ? (busy ? 'Finishing…' : 'Start using Agentic OS') : 'Continue'}</button>
        </footer>
      </main>
    </div>
  );
}
