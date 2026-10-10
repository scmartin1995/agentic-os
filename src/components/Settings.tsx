import { useEffect, useRef, useState } from 'react';
import { getTheme, setTheme, type Theme } from '../theme';
import { getGraphShape, setGraphShape, type GraphShape } from '../graphShape';
import type { Basics, PhoneState } from '../types';
import { onPhone } from '../aos';
import BrainSetup from './BrainSetup';
import Icon from '../icons';

// Settings: look and voice, the brain, the workspace folder, the phone link, the Discord link and start-up, each on
// its own page. Everything saves as you change it.
// Speed is relative to Piper's natural pace (1.0); it is used from the next sentence the assistant says.
const pace = (v: number) => {
  const pct = Math.round((v - 1) * 100);
  return pct === 0 ? 'natural pace' : `${Math.abs(pct)}% ${pct < 0 ? 'slower' : 'faster'} than natural`;
};
type Page = 'look' | 'brain' | 'notes' | 'phone' | 'discord' | 'app';
const PAGES: { id: Page; label: string; icon: string; desktop?: boolean }[] = [
  { id: 'look', label: 'Look and voice', icon: 'sun' },
  { id: 'brain', label: 'Brain', icon: 'brain', desktop: true },
  { id: 'notes', label: 'Workspace', icon: 'files', desktop: true },
  { id: 'phone', label: 'Phone', icon: 'phone', desktop: true },
  { id: 'discord', label: 'Discord', icon: 'discord', desktop: true },
  { id: 'app', label: 'This app', icon: 'power', desktop: true },
];

export default function Settings({ onClose, onSetup, start }: { onClose(): void; onSetup(): void; start?: Page }) {
  const [page, setPage] = useState<Page>(start || 'look');
  const pages = PAGES.filter((p) => !onPhone || !p.desktop);
  return (
    <div className="viewer-wrap tool" onClick={onClose}>
      <section className="panel viewer settings" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <span className="lbl strong">Settings</span>
          <span className="flex" />
          <button className="ghost small" onClick={onClose} aria-label="Close settings">✕</button>
        </div>
        <div className="viewer-body">
          <div className="set">
            <nav className="set-nav" aria-label="Settings pages">
              {pages.map((p) => <button key={p.id} className={page === p.id ? 'on' : ''} onClick={() => setPage(p.id)}><Icon name={p.icon} size={16} />{p.label}</button>)}
            </nav>
            <div className="set-body" key={page}>
              {page === 'look' && <Look />}
              {page === 'brain' && <><h2>Brain</h2><p>The AI the assistant thinks with. Sign in with a plan you already have, or use an API key. Switching takes effect on the next question; open chats start fresh on the new brain.</p><BrainSetup compact /><Budgets /></>}
              {page === 'notes' && <Notes />}
              {page === 'phone' && <Phone />}
              {page === 'discord' && <Discord />}
              {page === 'app' && <AppPage onSetup={onSetup} />}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function Look() {
  const [v, setV] = useState<{ speed: number; defaultSpeed: number; min: number; max: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [noVoice, setNoVoice] = useState(false);
  const el = useRef<HTMLAudioElement | null>(null);
  const [theme, setLook] = useState<Theme>(getTheme);
  const look = (t: Theme) => { setLook(t); setTheme(t); };
  const [shape, setShape] = useState<GraphShape>(getGraphShape);
  const pickShape = (s: GraphShape) => { setShape(s); setGraphShape(s); };
  const [sens, setSens] = useState<string>(() => { try { return localStorage.getItem('aos-wake-sens') || 'strict'; } catch { return 'strict'; } });
  const pickSens = (s: string) => { setSens(s); try { localStorage.setItem('aos-wake-sens', s); } catch { /* not saved */ } };
  useEffect(() => { window.aos.voice.settings().then(setV); return () => { el.current?.pause(); }; }, []);
  const change = (speed: number) => { setV((s) => (s ? { ...s, speed } : s)); window.aos.voice.setSpeed(speed); };
  const preview = async () => {
    el.current?.pause();
    setPlaying(true);
    const data = await window.aos.voice.preview();
    if (!data) { setPlaying(false); setNoVoice(true); return; }
    const a = new Audio('data:audio/wav;base64,' + data);
    el.current = a;
    const done = () => setPlaying(false);
    a.onended = done; a.onerror = done;
    a.play().catch(done);
  };
  return (
    <>
      <h2>Look and voice</h2>
      <div className="setting">
        <div className="setting-head"><span className="lbl">Appearance</span><span className="mono small">{theme} mode</span></div>
        <div className="cn-seg theme-seg" role="radiogroup" aria-label="Appearance" style={{ alignSelf: 'flex-start' }}>
          <button role="radio" aria-checked={theme === 'dark'} className={theme === 'dark' ? 'on' : ''} onClick={() => look('dark')}><span aria-hidden>☾</span> Dark</button>
          <button role="radio" aria-checked={theme === 'light'} className={theme === 'light' ? 'on' : ''} onClick={() => look('light')}><span aria-hidden>☀</span> Light</button>
        </div>
        <p className="muted small">Changes straight away and is remembered. Same colours, set for each.</p>
      </div>
      <div className="setting">
        <div className="setting-head"><span className="lbl">Graph shape</span><span className="mono small">{shape === 'tree' ? 'tree of life' : 'brain'}</span></div>
        <div className="cn-seg theme-seg" role="radiogroup" aria-label="Graph shape" style={{ alignSelf: 'flex-start' }}>
          <button role="radio" aria-checked={shape === 'brain'} className={shape === 'brain' ? 'on' : ''} onClick={() => pickShape('brain')}>Brain</button>
          <button role="radio" aria-checked={shape === 'tree'} className={shape === 'tree' ? 'on' : ''} onClick={() => pickShape('tree')}>Tree of life</button>
        </div>
        <p className="muted small">Tree of life: projects and legacy grow up as the crown, agent-os, skills and notes sit below as the roots. The notes glide into place.</p>
      </div>
      {!v ? <span className="muted small">loading…</span> : (
        <div className="setting">
          <div className="setting-head"><span className="lbl">Talking speed</span><span className="mono small">{v.speed.toFixed(2)}× · {pace(v.speed)}</span></div>
          <input type="range" min={v.min} max={v.max} step={0.01} value={v.speed} onChange={(e) => change(Number(e.target.value))} aria-label="Talking speed" />
          <div className="setting-scale mono small muted" style={{ position: 'relative', height: 16 }}>
            <span style={{ position: 'absolute', left: 0 }}>slower</span>
            <span style={{ position: 'absolute', left: `${((1 - v.min) / (v.max - v.min)) * 100}%`, transform: 'translateX(-50%)' }}>natural</span>
            <span style={{ position: 'absolute', right: 0 }}>faster</span>
          </div>
          <div className="setting-actions">
            <button className="pill" onClick={preview} disabled={playing}>{playing ? 'Talking…' : 'Hear it'}</button>
            {v.speed !== v.defaultSpeed && <button className="pill" onClick={() => change(v.defaultSpeed)}>Back to default ({pace(v.defaultSpeed)})</button>}
          </div>
          <p className="muted small">Saved straight away and used from the next sentence the assistant says. No restart needed.{noVoice ? ' The voice is switched off or not installed, so there is nothing to hear.' : ''}</p>
        </div>
      )}
      <div className="setting">
        <div className="setting-head"><span className="lbl">"Hey computer" sensitivity</span></div>
        <div className="setting-actions">
          {(['strict', 'normal', 'loose'] as const).map((s) => (
            <button key={s} className={`pill${sens === s ? ' on' : ''}`} onClick={() => pickSens(s)}>{s[0].toUpperCase() + s.slice(1)}</button>
          ))}
        </div>
        <p className="muted small">Strict ignores stray phrases but may miss a mumbled "Hey computer". Loose catches more but starts chats by mistake. Used straight away.</p>
      </div>
    </>
  );
}

// Only matters on an API key: the charge meter fills against these.
function Budgets() {
  const [b, setB] = useState<Basics | null>(null);
  useEffect(() => { window.aos.setup.get().then(setB); }, []);
  if (!b) return null;
  const save = (k: 'daily' | 'monthly', v: string) => { const budgets = { ...b.budgets, [k]: Math.max(0, Number(v) || 0) }; setB({ ...b, budgets }); window.aos.setup.set({ budgets }); };
  return (
    <div className="setting">
      <div className="setting-head"><span className="lbl">Spending meter</span><span className="small muted">API keys only</span></div>
      <div className="formgrid">
        <label>Daily budget, $<input className="field" inputMode="decimal" defaultValue={b.budgets.daily} onBlur={(e) => save('daily', e.target.value)} /></label>
        <label>Monthly budget, $<input className="field" inputMode="decimal" defaultValue={b.budgets.monthly} onBlur={(e) => save('monthly', e.target.value)} /></label>
      </div>
      <p className="muted small">On an API key the charge bars show spend against these. They are a gauge, not a cap: nothing is blocked when one is reached. Costs are only known for Claude; other providers show tokens.</p>
    </div>
  );
}

function Notes() {
  const [info, setInfo] = useState<{ root: string; exists: boolean; notes: number } | null>(null);
  const load = () => window.aos.vault.info().then(setInfo);
  useEffect(() => { load(); }, []);
  const pick = async () => { const r = await window.aos.setup.pickFolder(); if (r) { await window.aos.setup.set({ vaultPath: r.path }); load(); } };
  return (
    <>
      <h2>Notes folder</h2>
      <p>The folder the assistant reads and writes. The node map, the file tree, Projects, Notes, Actions and Skills all come from it.</p>
      {info && <div className={`status-line ${info.exists ? 'good' : 'off'}`}><i className="dot" /><span className="mono" style={{ overflowWrap: 'anywhere' }}>{info.root}</span><span className="flex" />{info.exists ? `${info.notes} notes` : 'not found'}</div>}
      <div className="setting-actions"><button className="ghost" onClick={pick}>Choose another folder…</button></div>
      <p className="muted small">Changing it takes effect at once. Chats already open keep the instructions they started with, so start a new chat afterwards.</p>
    </>
  );
}

function Phone() {
  const [s, setS] = useState<PhoneState | null>(null);
  const [base, setBase] = useState('');
  const [custom, setCustom] = useState<{ url: string; qr: string } | null>(null);
  useEffect(() => { window.aos.phone.get().then(setS); }, []);
  useEffect(() => { if (!s?.running) return; const t = setInterval(() => window.aos.phone.get().then(setS), 5000); return () => clearInterval(t); }, [s?.running]);
  if (!s) return <span className="muted small">loading…</span>;
  const toggle = () => window.aos.phone.set({ enabled: !s.enabled }).then(setS);
  const make = async () => setCustom(await window.aos.phone.qr(base));
  return (
    <>
      <h2>Phone</h2>
      <p>Open the app on your phone: the same chats, voice, tools and approvals, in a layout made for a small screen. The thinking still happens on this PC, so it has to be on.</p>
      <div className="card opt">
        <div><b>Phone link</b><p>{s.enabled ? (s.running ? `On. ${s.phones ? `${s.phones} phone${s.phones === 1 ? '' : 's'} connected.` : 'No phone connected right now.'}` : 'Switched on, but not running.') : 'Off. Nothing is listening.'} While it is on, closing the window tucks the app into the tray so your phone stays connected.</p></div>
        <button className="switch" role="switch" aria-checked={s.enabled} aria-label="Phone link" onClick={toggle} />
      </div>
      {s.error && <div className="notice">{s.error}</div>}
      {s.enabled && s.running && (
        <>
          <div className="setting">
            <div className="setting-head"><span className="lbl">Pair a phone</span><span className="small muted">scan with the phone's camera</span></div>
            {s.links.length === 0 ? <div className="notice">This PC has no network address right now. Connect it to Wi-Fi (or start Tailscale), then come back.</div> : (
              <div className="qr-row">
                {s.links.map((l) => (
                  <div className="card qr" key={l.url}>
                    <span className={`tagchip${l.kind === 'tailscale' ? '' : ' warm'}`}>{l.kind === 'tailscale' ? 'Tailscale: anywhere' : 'Home Wi-Fi only'}</span>
                    <img src={l.qr} alt={`Pairing code for ${l.address}`} />
                    <code>http://{l.address}:{s.port}</code>
                  </div>
                ))}
                {custom && <div className="card qr"><span className="tagchip">Your address</span><img src={custom.qr} alt="Pairing code" /><code>{custom.url.split('/pair')[0]}</code></div>}
              </div>
            )}
            <ol className="steps-list">
              <li>Put the phone on the same Wi-Fi as this PC (or run Tailscale on both), then scan a code.</li>
              <li>The first time, Windows may ask whether to let Agentic OS through the firewall. Allow it on private networks.</li>
              <li>In the phone's browser menu choose "Add to Home Screen" and it opens like an app.</li>
            </ol>
          </div>
          <div className="notice info"><b>Talking from the phone.</b> Phones only allow the microphone on a secure (https) address. Typing, spoken answers, files and approvals work on any of the codes above. For the microphone, give the PC an https name with Tailscale (<span className="mono">tailscale serve --bg {s.port}</span>), type that name below, and pair with the code it makes.</div>
          <div className="setting">
            <label className="lab">An address you set up yourself (optional)
              <span className="keyrow"><input className="field mono" value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://my-pc.tailnet-name.ts.net" spellCheck={false} /><button className="ghost" onClick={make} disabled={!base.trim()}>Make code</button></span>
            </label>
          </div>
          <div className="card opt">
            <div><b>Unpair every phone</b><p>Makes a new secret code. Phones paired before stop working until they scan again.</p></div>
            <button className="ghost" onClick={() => window.aos.phone.unpair().then((n) => { setS(n); setCustom(null); })}>Unpair all</button>
          </div>
          <p className="muted small">The link is plain http on your own network, protected by the secret in the code. Use it on networks you trust; Tailscale keeps it private when you are out. Keys, sign-ins and folder choices can't be changed from a phone.</p>
        </>
      )}
    </>
  );
}

function Discord() {
  const [d, setD] = useState<{ configured: boolean; token: { saved: boolean; tail: string }; userId: string } | null>(null);
  const [token, setToken] = useState('');
  const [user, setUser] = useState('');
  const [saved, setSaved] = useState(false);
  const load = () => window.aos.discord.get().then((x) => { setD(x); setUser(x.userId); });
  useEffect(() => { load(); }, []);
  if (!d) return <span className="muted small">loading…</span>;
  const save = async () => { await window.aos.discord.set({ token: token.trim() || undefined, userId: user.trim() }); setToken(''); setSaved(true); load(); };
  return (
    <>
      <h2>Discord</h2>
      <p>When a yes/no card sits unanswered for three minutes (or the PC is idle), the app sends the same card to your Discord DMs with Yes, No and Question buttons. You can also chat with him there.</p>
      <div className={`status-line ${d.configured ? 'good' : 'off'}`}><i className="dot" />{d.configured ? 'Set up. It connects when the app starts.' : 'Not set up.'}</div>
      <div className="formgrid">
        <label>Bot token{d.token.saved ? ` (saved${d.token.tail ? `, ends in ${d.token.tail}` : ''})` : ''}<input className="field mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={d.token.saved ? 'paste to replace' : 'from the Discord developer portal'} autoComplete="off" /></label>
        <label>Your Discord user ID<input className="field mono" value={user} onChange={(e) => setUser(e.target.value)} placeholder="18-digit number" /></label>
      </div>
      <div className="setting-actions">
        <button className="cta" onClick={save} disabled={!token.trim() && user.trim() === d.userId}>Save</button>
        {d.configured && <button className="ghost" onClick={() => window.aos.discord.clear().then(load)}>Remove</button>}
        {saved && <span className="small muted">Saved. Restart the app to connect.</span>}
      </div>
      <p className="muted small">The token is saved encrypted on this PC. Only your user ID is listened to. Use a bot of your own; two apps on one bot both answer., or both will answer.</p>
    </>
  );
}

function AppPage({ onSetup }: { onSetup(): void }) {
  const [b, setB] = useState<Basics | null>(null);
  const [name, setName] = useState('');
  const [aiName, setAiName] = useState('');
  useEffect(() => { window.aos.setup.get().then((x) => { setB(x); setName(x.userName); setAiName(x.assistantName); }); }, []);
  if (!b) return <span className="muted small">loading…</span>;
  const set = (patch: Partial<Basics>) => window.aos.setup.set(patch).then(setB);
  return (
    <>
      <h2>This app</h2>
      <div className="formgrid" style={{ maxWidth: 560 }}>
        <label className="lab">Your name<input className="field" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && set({ userName: name.trim() })} maxLength={40} /></label>
        <label className="lab">The assistant's name<input className="field" value={aiName} onChange={(e) => setAiName(e.target.value)} onBlur={() => set({ assistantName: aiName.trim() || 'Assistant' })} maxLength={30} /></label>
      </div>
      <p className="muted small">Names are used from the next new chat. The assistant's personality is the file agent/persona.md in your workspace; edit it like any note.</p>
      <div className="card opt">
        <div><b>Start with Windows</b><p>Opens Agentic OS when you sign in to this PC. Handy with the phone link.</p></div>
        <button className="switch" role="switch" aria-checked={b.openAtLogin} aria-label="Start with Windows" onClick={() => set({ openAtLogin: !b.openAtLogin })} />
      </div>
      <div className="card opt">
        <div><b>Run setup again</b><p>Walk through the welcome steps: names, brain, workspace, extras.</p></div>
        <button className="ghost" onClick={onSetup}>Open setup</button>
      </div>
      <p className="muted small mono">Agentic OS v{b.version}</p>
    </>
  );
}
