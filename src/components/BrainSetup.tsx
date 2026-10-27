import { useEffect, useRef, useState } from 'react';
import type { CliStatus, ImportFound, Method, Models, ProvidersState } from '../types';

// Connecting Agentic OS to Claude. Used by onboarding and by Settings > Brain. Two ways in:
//   - your Claude plan: Claude Code's own sign-in opens in a terminal window; this app never sees the login, it only
//     asks afterwards whether you are signed in
//   - a gateway or key: an address and a key from your organisation (or an Anthropic key with no address), checked
//     with a free call, then saved encrypted on this PC. "Use my Claude Code settings" takes over what Claude Code
//     already has.
// onReady tells the caller whether a working connection is now saved.
const METHOD_LABEL: Record<Method, string> = { subscription: 'My Claude plan', key: 'Gateway or key' };

export default function BrainSetup({ onReady, compact = false }: { onReady?(ok: boolean, label: string): void; compact?: boolean }) {
  const [st, setSt] = useState<ProvidersState | null>(null);
  const [method, setMethod] = useState<Method>('subscription');
  const [rev, setRev] = useState(0); // bumps to redraw the connect form after a settings import
  const load = () => window.aos.providers.state().then((s) => { setSt(s); return s; });
  useEffect(() => { load().then((s) => { setMethod(s.current.method); }); }, []);
  const def = st?.catalog[0];
  if (!st || !def) return <span className="muted small">loading…</span>;
  const methods = def.methods;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="card connect">
        <h3>
          {def.name}
          <span className="cn-seg" role="radiogroup" aria-label="How to connect">
            {methods.map((m) => <button key={m} role="radio" aria-checked={method === m} className={method === m ? 'on' : ''} onClick={() => setMethod(m)}>{METHOD_LABEL[m]}</button>)}
          </span>
        </h3>
        {!compact && <p>{def.blurb}</p>}
        {method === 'subscription' ? <Subscription current={st.current.method === 'subscription'} onSaved={(label) => { load(); onReady?.(true, label); }} onNotReady={() => onReady?.(false, '')} />
          : <>
            <ImportPanel onApplied={(label) => { load().then(() => setRev((r) => r + 1)); onReady?.(true, label); }} />
            <GatewayOrKey key={rev} st={st} onSaved={(label) => { load(); onReady?.(true, label); }} onNotReady={() => onReady?.(false, '')} />
          </>}
      </div>
    </div>
  );
}

// ---- your own Claude plan, through Claude Code ----
function Subscription({ current, onSaved, onNotReady }: { current: boolean; onSaved(label: string): void; onNotReady(): void }) {
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [waiting, setWaiting] = useState(false);
  const alive = useRef(true);
  const saved = useRef(false);
  const label = (s: CliStatus | null) => `Claude${s?.plan ? ` ${s.plan[0].toUpperCase()}${s.plan.slice(1)}` : ''} plan`;
  const use = async () => {
    const r = await window.aos.providers.save({ id: 'claude', method: 'subscription' });
    if (r.ok) { saved.current = true; onSaved(label(cli)); } else setErr(r.error || '');
  };
  const check = async (quiet = false) => {
    if (!quiet) setBusy('check');
    const s = await window.aos.providers.cliStatus().catch(() => null);
    if (!alive.current) return null;
    setCli(s); setBusy('');
    if (s?.signedIn) {
      setWaiting(false);
      if (current || saved.current) { saved.current = true; onSaved(label(s)); } else onNotReady();
    } else onNotReady();
    return s;
  };
  useEffect(() => { alive.current = true; saved.current = false; check(); return () => { alive.current = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // After the sign-in window opens, look again every few seconds until it is done.
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => check(true), 4000);
    return () => clearInterval(t);
  }, [waiting]); // eslint-disable-line react-hooks/exhaustive-deps
  const signIn = async () => {
    setErr('');
    const r = await window.aos.providers.openLogin();
    if (r.ok) setWaiting(true); else setErr(r.error || 'Could not open the sign-in.');
  };

  return (
    <div className="way">
      <p>Your own Claude plan, through Claude Code. The sign-in happens in Anthropic's own window. Agentic OS never sees or stores your login.</p>
      {!cli ? <div className="status-line wait"><i className="dot" />Checking…</div>
        : cli.signedIn ? <div className="status-line good"><i className="dot" />Signed in{cli.who ? ` as ${cli.who}` : ''}{cli.plan ? ` · ${cli.plan[0].toUpperCase()}${cli.plan.slice(1)} plan` : ''}.{current || saved.current ? ' Agentic OS is using this.' : ''}</div>
        : !cli.installed ? <div className="status-line off"><i className="dot" />The bundled Claude Code was not found. Run npm install in the app folder.</div>
        : waiting ? <div className="status-line wait"><i className="dot" />Waiting for you to finish signing in…</div>
        : <div className="status-line off"><i className="dot" />Not signed in yet{cli.error ? ` (${cli.error})` : ''}.</div>}
      {cli?.signedIn && !current && !saved.current && <div className="setting-actions"><button className="cta" onClick={use}>Use my Claude plan</button></div>}
      {cli && !cli.signedIn && (
        <div className="setting-actions">
          {cli.installed && <button className="cta" onClick={signIn}>{waiting ? 'Open sign-in again' : 'Sign in with Claude'}</button>}
          <button className="ghost" onClick={() => check()} disabled={busy === 'check'}>{busy === 'check' ? 'Checking…' : 'Check again'}</button>
        </div>
      )}
      {cli && !cli.signedIn && cli.installed && (
        <ol className="steps-list">
          <li>A terminal window opens with Claude Code's sign-in. If it only shows a prompt, type <span className="mono">/login</span>.</li>
          <li>Finish in your browser, then close that window.</li>
        </ol>
      )}
      {err && <div className="notice">{err}</div>}
    </div>
  );
}

// ---- a gateway address and key, or an Anthropic key ----
function GatewayOrKey({ st, onSaved, onNotReady }: { st: ProvidersState; onSaved(label: string): void; onNotReady(): void }) {
  const cur = st.current;
  const [key, setKey] = useState('');
  const [base, setBase] = useState(cur.baseUrl || '');
  // The three model names are not asked for here any more (the model is chosen per chat, under the input box). Whatever was saved
  // before is kept and passed back untouched, and the gateway's own suggestions only fill gaps, so Auto keeps working.
  const [pick, setPick] = useState<Models>(cur.models || { light: '', standard: '', strong: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const hasSaved = cur.key.saved && cur.method === 'key';
  // Gateway extras: extra headers, a switch for gateways that reject some requests, a certificate file.
  const [headers, setHeaders] = useState('');
  const [betas, setBetas] = useState(!!cur.gateway.disableBetas);
  const [cert, setCert] = useState(cur.gateway.certFile || '');
  const [open, setOpen] = useState(!!(cur.gateway.headerNames.length || cur.gateway.disableBetas || cur.gateway.certFile));
  const gwOpts = { gateway: { disableBetas: betas, certFile: cert.trim(), ...(headers.trim() ? { headers } : {}) } };
  useEffect(() => { if (!(cur.method === 'key' && cur.key.saved)) onNotReady(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const test = async () => {
    setBusy(true); setMsg(null);
    const r = await window.aos.providers.test({ id: 'claude', key: key.trim(), baseUrl: base.trim(), disableBetas: betas, model: pick.standard || pick.light || pick.strong || undefined, ...(headers.trim() ? { headers } : {}) });
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: r.error || 'That did not work.' }); return; }
    const list = r.models || [];
    const sug = r.suggested || { light: '', standard: '', strong: '' };
    const next = { light: list.includes(pick.light) ? pick.light : sug.light, standard: list.includes(pick.standard) ? pick.standard : sug.standard, strong: list.includes(pick.strong) ? pick.strong : sug.strong };
    setPick(next);
    await save(next);
  };
  const save = async (m: Models) => {
    const r = await window.aos.providers.save({ id: 'claude', method: 'key', key: key.trim() || undefined, baseUrl: base.trim(), models: m, ...gwOpts });
    if (!r.ok) { setMsg({ ok: false, text: r.error || 'Could not save.' }); return; }
    setKey(''); setHeaders('');
    setMsg({ ok: true, text: base.trim() ? 'The gateway answered and the settings are saved.' : 'Key works and is saved. Agentic OS picks the Claude model for each question itself.' });
    onSaved(base.trim() ? 'Claude gateway' : 'Claude API key');
  };

  return (
    <div className="way">
      <label className="lab">Gateway address (leave empty if you have an Anthropic key)
        <input className="field mono" value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://your-gateway.example.com" spellCheck={false} />
      </label>
      <label className="lab">{hasSaved ? `A key is saved${cur.key.tail ? ` (ends in ${cur.key.tail})` : ''}. Paste a new one to replace it.` : 'Paste your key'}
        <span className="keyrow">
          <input className="field" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="the key you were given" autoComplete="off" spellCheck={false}
            onKeyDown={(e) => { if (e.key === 'Enter') test(); }} />
          {!base.trim() && <button className="ghost" onClick={() => window.aos.providers.openKeyPage()} title="Opens Anthropic's key page in your browser">Get a key</button>}
        </span>
      </label>
      <details className="adv" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Advanced: extra headers, certificate</summary>
        <div className="adv-body">
          <label className="lab">Extra headers{cur.gateway.headerNames.length ? ` (saved: ${cur.gateway.headerNames.join(', ')}; type here to replace them)` : ''}
            <textarea className="field mono" rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder={'X-Org-Route: prod'} spellCheck={false} />
            <span className="small muted">One per line, as Name: Value. Only if the gateway's owner asked for one. Not for the key.</span>
            {!!cur.gateway.headerNames.length && <button className="pill" onClick={async () => { await window.aos.providers.save({ id: 'claude', method: 'key', baseUrl: base.trim(), gateway: { headers: '' } }); onSaved('Claude gateway'); }}>Remove saved headers</button>}
          </label>
          <label className="check"><input type="checkbox" checked={betas} onChange={(e) => setBetas(e.target.checked)} />My gateway rejects some requests
            <span className="small muted">Turn on if answers fail with "Extra inputs are not permitted" or similar. Switches off Claude Code's newest request fields.</span>
          </label>
          <label className="lab">Certificate file (company networks)
            <input className="field mono" value={cert} onChange={(e) => setCert(e.target.value)} placeholder="C:\certs\company-root.pem" spellCheck={false} />
            <span className="small muted">Only if answers fail with a certificate error. The file is the company root certificate, from the gateway's owner.</span>
          </label>
        </div>
      </details>
      <div className="setting-actions">
        <button className="cta" onClick={test} disabled={busy || (!key.trim() && !hasSaved)}>{busy ? 'Checking…' : key.trim() || !hasSaved ? 'Check and save' : 'Check the saved key'}</button>
        <span className="small muted">Checked with a free call, then saved {st.encrypted ? 'encrypted on this PC' : 'on this PC'}. It is only ever sent to {base.trim() ? 'that address' : 'Anthropic'}.</span>
      </div>
      {msg && <div className={`status-line ${msg.ok ? 'good' : 'off'}`}><i className="dot" />{msg.text}</div>}
      {/* No model boxes here: the model is chosen in the picker under the chat input, where any name can be typed. */}
    </div>
  );
}

// ---- take over what Claude Code on this PC is already set up with ----
// Reads ~/.claude/settings.json (read only), shows what was found without the key, and saves it when the user confirms.
function ImportPanel({ onApplied }: { onApplied(label: string): void }) {
  const [found, setFound] = useState<ImportFound | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const look = async () => {
    setBusy('look'); setMsg(null);
    const r = await window.aos.providers.importSettings();
    setBusy('');
    if (r.ok && r.found) setFound(r.found); else { setFound(null); setMsg({ ok: false, text: r.error || 'Nothing found.' }); }
  };
  const use = async () => {
    setBusy('use');
    const r = await window.aos.providers.applyImport();
    setBusy(''); setFound(null);
    if (!r.ok) { setMsg({ ok: false, text: r.error || 'Could not save that.' }); return; }
    if (r.check && !r.check.ok) setMsg({ ok: false, text: `Taken over and saved, but the check failed. ${r.check.error}` });
    else setMsg({ ok: true, text: r.check ? `Taken over and the gateway answered${r.check.models.length ? `: ${r.check.models.length} Claude models found` : ''}.` : 'Taken over.' });
    onApplied('Claude gateway');
  };
  return (
    <div className="way">
      <div className="setting-actions">
        <button className="cta" onClick={look} disabled={busy !== ''}>{busy === 'look' ? 'Reading…' : 'Use my Claude Code settings'}</button>
        <span className="small muted">Reads the setup Claude Code already has on this PC. It changes nothing there.</span>
      </div>
      {found && (
        <div className="found">
          <b>Found in your Claude Code settings</b>
          <ul>
            <li>Address: <span className="mono">{found.baseUrl || '(none: Anthropic directly)'}</span></li>
            <li>Key: {found.keyFrom ? `found in ${found.keyFrom} (not shown)` : 'none found'}</li>
            {found.headerNames.length > 0 && <li>Extra headers: {found.headerNames.join(', ')}</li>}
            {(found.models.light || found.models.standard || found.models.strong) && <li>Models: {[found.models.light && `quick ${found.models.light}`, found.models.standard && `everyday ${found.models.standard}`, found.models.strong && `hard ${found.models.strong}`].filter(Boolean).join(' · ')}</li>}
            {found.switches.length > 0 && <li>Switches: {found.switches.join(', ')}</li>}
          </ul>
          {found.notes.map((n) => <div key={n} className="notice">{n}</div>)}
          <div className="setting-actions">
            <button className="cta" onClick={use} disabled={busy !== ''}>{busy === 'use' ? 'Saving…' : 'Use these'}</button>
            <button className="ghost" onClick={() => setFound(null)} disabled={busy !== ''}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <div className={`status-line ${msg.ok ? 'good' : 'off'}`}><i className="dot" />{msg.text}</div>}
    </div>
  );
}
