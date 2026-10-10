import { useEffect, useRef, useState } from 'react';
import type { CliStatus, Method, Models, ProviderDef, ProvidersState } from '../types';

// Choosing and signing in to the assistant's brain. Used by onboarding and by Settings > Brain.
// Two ways in, whichever the provider offers:
//   - your subscription: the provider's own sign-in opens in a terminal window; this app never sees the login,
//     it only asks afterwards whether you are signed in
//   - an API key: checked with a free "list models" call, then saved encrypted on this PC
// onReady tells the caller whether a working brain is now saved.
const METHOD_LABEL: Record<Method, string> = { subscription: 'My subscription', key: 'An API key', local: 'On this PC' };

export default function BrainSetup({ onReady, compact = false }: { onReady?(ok: boolean, label: string): void; compact?: boolean }) {
  const [st, setSt] = useState<ProvidersState | null>(null);
  const [id, setId] = useState('claude');
  const [method, setMethod] = useState<Method>('subscription');
  const load = () => window.aos.providers.state().then((s) => { setSt(s); return s; });
  useEffect(() => { load().then((s) => { setId(s.current.id); setMethod(s.current.method); }); }, []);
  const def = st?.catalog.find((p) => p.id === id);
  const pick = (p: ProviderDef) => { setId(p.id); setMethod(st && st.current.id === p.id ? st.current.method : p.methods[0]); };
  if (!st || !def) return <span className="muted small">loading…</span>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="prov-grid" role="radiogroup" aria-label="Which AI">
        {st.catalog.map((p) => (
          <button key={p.id} role="radio" aria-checked={p.id === id} className={`prov${p.id === id ? ' on' : ''}`} style={{ ['--pc' as string]: p.color }} onClick={() => pick(p)}>
            <span className="logo"><i style={{ WebkitMaskImage: `url(./brains/${p.id}.svg)`, maskImage: `url(./brains/${p.id}.svg)` }} /></span>
            <b>{p.name}</b>
            <span className="by">{p.by}</span>
            {p.level === 'full' && <span className="tagchip">Everything</span>}
            {st.current.id === p.id && <span className="cur">● in use</span>}
          </button>
        ))}
      </div>
      <div className="card connect" key={def.id} style={{ ['--pc' as string]: def.color }}>
        <h3>
          {def.name}
          {def.methods.length > 1 && (
            <span className="cn-seg" role="radiogroup" aria-label="How to sign in">
              {def.methods.map((m) => <button key={m} role="radio" aria-checked={method === m} className={method === m ? 'on' : ''} onClick={() => setMethod(m)}>{METHOD_LABEL[m]}</button>)}
            </span>
          )}
        </h3>
        {!compact && <p>{def.blurb}{def.level === 'core' ? ' Connected apps and helper agents are Claude-only.' : ''}</p>}
        {method === 'subscription' ? <Subscription def={def} current={st.current.id === def.id && st.current.method === 'subscription'} onSaved={(label) => { load(); onReady?.(true, label); }} onNotReady={() => onReady?.(false, '')} />
          : <KeyOrLocal def={def} method={method} st={st} onSaved={(label) => { load(); onReady?.(true, label); }} onNotReady={() => onReady?.(false, '')} />}
      </div>
    </div>
  );
}

// ---- your own plan, through the provider's own app ----
function Subscription({ def, current, onSaved, onNotReady }: { def: ProviderDef; current: boolean; onSaved(label: string): void; onNotReady(): void }) {
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [waiting, setWaiting] = useState(false);
  const alive = useRef(true);
  const saved = useRef(false);
  const label = (s: CliStatus | null) => `${def.name}${s?.plan ? ` ${s.plan[0].toUpperCase()}${s.plan.slice(1)}` : ''} plan`;
  const use = async () => {
    const r = await window.aos.providers.save({ id: def.id, method: 'subscription' });
    if (r.ok) { saved.current = true; onSaved(label(cli)); } else setErr(r.error || '');
  };
  const check = async (quiet = false) => {
    if (!quiet) setBusy('check');
    const s = await window.aos.providers.cliStatus(def.id).catch(() => null);
    if (!alive.current) return null;
    setCli(s); setBusy('');
    if (s?.signedIn) {
      setWaiting(false);
      if (current || saved.current) { saved.current = true; onSaved(label(s)); } else onNotReady();
    } else onNotReady();
    return s;
  };
  useEffect(() => { alive.current = true; saved.current = false; check(); return () => { alive.current = false; }; }, [def.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // After the sign-in window opens, look again every few seconds until it is done.
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => check(true), 4000);
    return () => clearInterval(t);
  }, [waiting]); // eslint-disable-line react-hooks/exhaustive-deps
  const signIn = async () => {
    setErr('');
    const r = await window.aos.providers.openLogin(def.id);
    if (r.ok) setWaiting(true); else setErr(r.error || 'Could not open the sign-in.');
  };
  const install = async () => {
    setErr(''); setBusy('install');
    const r = await window.aos.providers.cliInstall(def.id);
    setBusy('');
    if (!r.ok) setErr(r.error || 'The install did not finish.');
    check();
  };
  const app = def.cli?.name || 'Claude Code';

  return (
    <div className="way">
      <p>{def.subscription} The sign-in happens in {def.id === 'claude' ? "Anthropic's" : def.id === 'openai' ? "OpenAI's" : "Google's"} own window. The app never sees or stores your login.</p>
      {!cli ? <div className="status-line wait"><i className="dot" />Checking…</div>
        : cli.signedIn ? <div className="status-line good"><i className="dot" />Signed in{cli.who ? ` as ${cli.who}` : ''}{cli.plan ? ` · ${cli.plan[0].toUpperCase()}${cli.plan.slice(1)} plan` : ''}.{current || saved.current ? ' In use now.' : ''}</div>
        : !cli.installed ? <div className="status-line off"><i className="dot" />{app} is not on this PC yet.</div>
        : waiting ? <div className="status-line wait"><i className="dot" />Waiting for you to finish signing in…</div>
        : <div className="status-line off"><i className="dot" />Not signed in yet{cli.error ? ` (${cli.error})` : ''}.</div>}
      {cli?.signedIn && !current && !saved.current && <div className="setting-actions"><button className="cta" onClick={use}>Use {def.name}</button></div>}
      {cli && !cli.signedIn && (
        <div className="setting-actions">
          {!cli.installed && def.cli && <button className="cta" onClick={install} disabled={busy === 'install'}>{busy === 'install' ? 'Installing…' : `Install ${app}`}</button>}
          {cli.installed && <button className="cta" onClick={signIn}>{waiting ? 'Open sign-in again' : `Sign in with ${def.name}`}</button>}
          <button className="ghost" onClick={() => check()} disabled={busy === 'check'}>{busy === 'check' ? 'Checking…' : 'Check again'}</button>
        </div>
      )}
      {cli && !cli.signedIn && cli.installed && (
        <ol className="steps-list">
          {def.id === 'claude' ? <><li>A terminal window opens with Claude Code's sign-in. If it only shows a prompt, type <span className="mono">/login</span>.</li><li>Finish in your browser, then close that window.</li></>
            : def.id === 'openai' ? <><li>A terminal window opens and sends you to ChatGPT's sign-in in your browser.</li><li>Finish there, then close the terminal window.</li></>
            : <><li>A terminal window opens Antigravity. Sign in with your Google account and finish in your browser.</li><li>Type <span className="mono">/quit</span>, then close the window.</li></>}
        </ol>
      )}
      {!cli?.installed && def.cli && <p className="small">Install runs <span className="mono">{def.cli.install ? def.cli.install.split(' -e')[0] : `npm install -g ${def.cli.pkg}`}</span>, the provider's official app.</p>}
      {def.level === 'core' && <div className="notice">On a {def.name} subscription, {app} does the work inside its own sandbox (it can edit files in your notes folder only). The app's ask-first cards and edit backups can't reach inside it. {def.id === 'antigravity' ? 'Chat, reading and writing notes were tried against the real Antigravity CLI; the ask-first cards were not.' : `This route has not been tested against the real ${app} yet; an API key is the tested way to use ${def.name}.`}</div>}
      {err && <div className="notice">{err}</div>}
    </div>
  );
}

// ---- an API key, or a model server on this PC ----
function KeyOrLocal({ def, method, st, onSaved, onNotReady }: { def: ProviderDef; method: Method; st: ProvidersState; onSaved(label: string): void; onNotReady(): void }) {
  const cur = st.current.id === def.id ? st.current : null;
  const [key, setKey] = useState('');
  const [base, setBase] = useState(cur?.baseUrl || def.baseUrl || '');
  const [models, setModels] = useState<string[] | null>(null);
  const [pick, setPick] = useState<Models>(cur?.models || { light: '', standard: '', strong: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const hasSaved = !!cur?.key.saved && method === 'key';
  const isClaude = def.id === 'claude';
  useEffect(() => { if (!(cur && cur.method === method && (isClaude || cur.models.standard) && (method === 'local' || cur.key.saved))) onNotReady(); }, [def.id, method]); // eslint-disable-line react-hooks/exhaustive-deps

  const test = async () => {
    setBusy(true); setMsg(null);
    const r = await window.aos.providers.test({ id: def.id, key: key.trim(), baseUrl: base.trim() });
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: r.error || 'That did not work.' }); setModels(null); return; }
    const list = r.models || [];
    setModels(list);
    const sug = r.suggested || { light: '', standard: '', strong: '' };
    const next = { light: list.includes(pick.light) ? pick.light : sug.light, standard: list.includes(pick.standard) ? pick.standard : sug.standard, strong: list.includes(pick.strong) ? pick.strong : sug.strong };
    setPick(next);
    await save(next, list.length);
  };
  const save = async (m: Models, count?: number) => {
    const r = await window.aos.providers.save({ id: def.id, method, key: key.trim() || undefined, baseUrl: base.trim(), models: m });
    if (!r.ok) { setMsg({ ok: false, text: r.error || 'Could not save.' }); return; }
    setKey('');
    setMsg({ ok: true, text: isClaude ? 'Key works and is saved. The app picks the Claude model for each question.' : `Connected${count != null ? `: ${count} models found` : ''}. Saved.` });
    if (isClaude || m.standard) onSaved(`${def.name}${method === 'local' ? '' : ' API key'}`); else onNotReady();
  };
  const choose = (tier: keyof Models, v: string) => { const m = { ...pick, [tier]: v }; setPick(m); save(m); };

  return (
    <div className="way">
      {(def.id === 'custom' || def.id === 'local') && (
        <label className="lab">Address of the service
          <input className="field mono" value={base} onChange={(e) => setBase(e.target.value)} placeholder={def.id === 'local' ? 'http://localhost:11434/v1' : 'https://…/v1'} spellCheck={false} />
          {def.presets && <span className="setting-actions" style={{ marginTop: 4 }}>{def.presets.map((p) => <button key={p.name} className="pill" onClick={() => setBase(p.url)}>{p.name}</button>)}</span>}
        </label>
      )}
      {method === 'key' && (
        <label className="lab">{hasSaved ? `A key is saved${cur?.key.tail ? ` (ends in ${cur.key.tail})` : ''}. Paste a new one to replace it.` : 'Paste your API key'}
          <span className="keyrow">
            <input className="field" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={def.keyLooks || 'key'} autoComplete="off" spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Enter') test(); }} />
            {def.keyUrl && <button className="ghost" onClick={() => window.aos.providers.openKeyPage(def.id)} title="Opens the provider's key page in your browser">Get a key</button>}
          </span>
        </label>
      )}
      <div className="setting-actions">
        <button className="cta" onClick={test} disabled={busy || (method === 'key' && !key.trim() && !hasSaved)}>{busy ? 'Checking…' : method === 'local' ? 'Find my models' : key.trim() || !hasSaved ? 'Check and save' : 'Check the saved key'}</button>
        <span className="small muted">{method === 'key' ? `Checked with a free call, then saved ${st.encrypted ? 'encrypted on this PC' : 'on this PC'}. It is only ever sent to ${def.id === 'custom' ? 'that address' : def.by}.` : 'Nothing leaves this computer.'}</span>
      </div>
      {msg && <div className={`status-line ${msg.ok ? 'good' : 'off'}`}><i className="dot" />{msg.text}</div>}
      {!isClaude && (models || cur?.models.standard) && (
        <div className="formgrid">
          {([['standard', 'Everyday model'], ['light', 'Quick questions'], ['strong', 'Hard problems (asks first)']] as const).map(([tier, label]) => (
            <label key={tier}>{label}
              {models ? (
                <select className="field" value={pick[tier]} onChange={(e) => choose(tier, e.target.value)}>
                  {tier !== 'standard' && <option value="">{tier === 'light' ? 'Same as everyday' : 'None'}</option>}
                  {models.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              ) : <input className="field mono" value={pick[tier]} onChange={(e) => setPick({ ...pick, [tier]: e.target.value })} onBlur={() => save(pick)} spellCheck={false} />}
            </label>
          ))}
        </div>
      )}
      {def.id === 'local' && <p className="small">Start Ollama (or LM Studio's local server) first. Pick a model that can use tools, or the assistant can only chat.</p>}
    </div>
  );
}
