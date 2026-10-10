import { useEffect, useState } from 'react';
import type { AssistantState, Basics } from '../types';
import Assistant from './Assistant';
import BrainSetup from './BrainSetup';
import Icon from '../icons';

// First run (and "Run setup again" in Settings): four short steps, with the assistant's card on the left.
//   1 you        - what the assistant should call you, and what you call it
//   2 brain      - which AI, signed in with your subscription or an API key
//   3 workspace  - the folder it works in (an existing one, or a starter workspace made for you)
//   4 extras     - voice check
const STEPS = ['You', 'Brain', 'Workspace', 'Extras'] as const;
const SAY = [
  "Hello. Let's get set up; it takes a minute.",
  'Pick the AI you already pay for and I will run on that.',
  'Now, where do you keep your notes? That folder is where I work.',
  'Nearly done. A couple of extras, then we are off.',
];
const POSE: AssistantState[] = ['talking', 'thinking', 'replying', 'listening'];

export default function Onboarding({ basics, onDone }: { basics: Basics; onDone(): void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState(basics.userName);
  const [aiName, setAiName] = useState(basics.assistantName || 'Assistant');
  const [brain, setBrain] = useState<{ ok: boolean; label: string }>({ ok: false, label: '' });
  const [vault, setVault] = useState<{ path: string; notes: number | null; exists: boolean }>({ path: basics.vaultPath, notes: null, exists: false });
  const [voice, setVoice] = useState<{ whisper: boolean; piper: boolean; wakeModel: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.aos.vault.info().then((i) => setVault({ path: i.root, notes: i.notes, exists: i.exists }));
    window.aos.setup.voice().then(setVoice);
  }, []);

  const pickFolder = async () => { const r = await window.aos.setup.pickFolder(); if (r) { await window.aos.setup.set({ vaultPath: r.path }); setVault({ path: r.path, notes: r.notes, exists: true }); } };
  const starter = async () => { const r = await window.aos.setup.starterVault(); await window.aos.setup.set({ vaultPath: r.path }); setVault({ path: r.path, notes: r.notes, exists: true }); };

  const can = [name.trim().length > 0, brain.ok, vault.exists, true][step];
  const next = async () => {
    if (step === 0) await window.aos.setup.set({ userName: name.trim(), assistantName: aiName.trim() || 'Assistant' });
    if (step === 2 && !basics.vaultSet) await window.aos.setup.set({ vaultPath: vault.path });
    if (step < STEPS.length - 1) { setStep(step + 1); return; }
    setBusy(true);
    await window.aos.setup.set({ onboarded: true });
    setBusy(false);
    onDone();
  };
  const shown = aiName.trim() || 'Assistant';

  return (
    <div className="onb">
      <div className="onb-drag" />
      <aside className="onb-hero">
        <Assistant name={shown} state={POSE[step]} sub="" voice={null} wake={null} wakeWord="" />
        <div className="onb-say" key={step}>{step === 1 && brain.ok ? `${brain.label} it is.` : step === 2 && vault.exists && vault.notes ? `${vault.notes} notes found. I will read them as I need them.` : SAY[step]}</div>
      </aside>
      <main className="onb-main">
        <div className="onb-scroll">
          {step === 0 && (
            <div className="onb-step">
              <h1>Welcome to <em>Agentic OS</em>.</h1>
              <p>An assistant for this computer. It reads your notes, does the jobs you hand it, and asks before anything that can't be undone.</p>
              <div className="formgrid" style={{ maxWidth: 560 }}>
                <label className="lab" style={{ fontSize: 13 }}>Your name
                  <input className="field" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && can) next(); }} placeholder="Your first name" maxLength={40} />
                </label>
                <label className="lab" style={{ fontSize: 13 }}>Your assistant's name
                  <input className="field" value={aiName} onChange={(e) => setAiName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && can) next(); }} placeholder="Assistant" maxLength={30} />
                </label>
              </div>
              <div className="facts">
                <div className="card fact"><b><Icon name="brain" />Any AI you use</b><span>Claude, ChatGPT, Gemini, a local model, or any OpenAI-style service.</span></div>
                <div className="card fact"><b><Icon name="files" />Your notes, your PC</b><span>It works in a folder you choose. Edits are backed up first.</span></div>
                <div className="card fact"><b><Icon name="phone" />On your phone too</b><span>Pair a phone later from Settings.</span></div>
              </div>
            </div>
          )}
          {step === 1 && (
            <div className="onb-step">
              <h1>Choose the <em>brain</em>.</h1>
              <p>Use the plan you already pay for, or paste an API key. You can change this any time in Settings.</p>
              <BrainSetup onReady={(ok, label) => setBrain({ ok, label })} />
            </div>
          )}
          {step === 2 && (
            <div className="onb-step">
              <h1>Where is your <em>workspace</em>?</h1>
              <p>The assistant works in one folder of notes (an Obsidian vault works as it is). It reads the folder to answer you and writes its work back into it. Projects go in a <span className="mono">projects</span> folder inside it, one folder each; the README explains the layout.</p>
              <div className={`status-line ${vault.exists ? 'good' : 'off'}`}><i className="dot" /><span className="mono" style={{ overflowWrap: 'anywhere' }}>{vault.path}</span><span className="flex" />{vault.exists ? (vault.notes != null ? `${vault.notes} notes` : '') : 'not found'}</div>
              <div className="setting-actions">
                <button className={vault.exists ? 'ghost' : 'cta'} onClick={pickFolder}>Choose a folder…</button>
                {!vault.exists && <button className="ghost" onClick={starter}>I don't have one: make a starter workspace</button>}
              </div>
            </div>
          )}
          {step === 3 && (
            <div className="onb-step">
              <h1>A few <em>extras</em>.</h1>
              <div className="facts">
                <div className="card fact"><b className={voice?.piper ? 'ok' : ''}><Icon name="sound" />Voice</b><span>{!voice ? 'Checking…' : voice.piper ? 'Ready. Spoken questions get spoken answers.' : 'Not installed. Answers come as text.'}</span></div>
                <div className="card fact"><b className={voice?.whisper ? 'ok' : ''}><Icon name="mic" />Talking</b><span>{!voice ? 'Checking…' : voice.whisper ? `Ready. Hold Space${voice.wakeModel ? ', or say "Hey computer"' : ''}.` : 'Not installed. Typing works.'}</span></div>
                <div className="card fact"><b><Icon name="phone" />Phone</b><span>Switch it on later in Settings, then scan a code.</span></div>
              </div>
            </div>
          )}
        </div>
        <footer className="onb-foot">
          <div className="onb-dots" aria-label={`Step ${step + 1} of ${STEPS.length}`}>{STEPS.map((s, i) => <i key={s} className={i === step ? 'on' : i < step ? 'done' : ''} />)}</div>
          <span className="small muted">{STEPS[step]}</span>
          <span className="flex" />
          {step > 0 && <button className="ghost" onClick={() => setStep(step - 1)}>Back</button>}
          <button className="cta" onClick={next} disabled={!can || busy}>{step === STEPS.length - 1 ? (busy ? 'Finishing…' : 'Start') : 'Continue'}</button>
        </footer>
      </main>
    </div>
  );
}
