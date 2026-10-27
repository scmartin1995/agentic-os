import { useEffect, useState } from 'react';
import type { WireApi, WorkerState, WorkersState } from '../types';

// Settings > Other models: non-Claude workers Agentic OS can hand a job to (electron/workers.cjs). Laid out like the
// Brain page: one shared gateway address, then a key per worker. Keys are saved encrypted and never come back here.
export default function WorkersSetup() {
  const [st, setSt] = useState<WorkersState | null>(null);
  const [base, setBase] = useState('');
  const load = () => window.aos.workers.state().then((s) => { setSt(s); setBase((b) => b || s.baseUrl); });
  useEffect(() => { load(); }, []);
  if (!st) return <span className="muted small">loading…</span>;
  const saveBase = () => { if (base.trim() && base.trim() !== st.baseUrl && st.items[0]) window.aos.workers.save({ id: st.items[0].id, baseUrl: base.trim() }).then(load); };
  return (
    <>
      <label className="lab" style={{ maxWidth: 520 }}>Gateway address for other models
        <input className="field mono" value={base} onChange={(e) => setBase(e.target.value)} onBlur={saveBase} placeholder="https://api.servicesessentials.ibm.com/v1" spellCheck={false} />
        <span className="small muted">Shared by every worker below. The Brain keeps its own address.</span>
      </label>
      {st.items.map((w) => <WorkerCard key={w.id} w={w} base={base.trim() || st.baseUrl} encrypted={st.encrypted} onChanged={load} />)}
    </>
  );
}

function WorkerCard({ w, base, encrypted, onChanged }: { w: WorkerState; base: string; encrypted: boolean; onChanged(): void }) {
  const [key, setKey] = useState('');
  const [model, setModel] = useState(w.model);
  const [wire, setWire] = useState<WireApi>(w.wireApi);
  const [goodFor, setGoodFor] = useState(w.goodFor || w.defaultGoodFor);
  const [models, setModels] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (patch: Parameters<typeof window.aos.workers.save>[0]) => {
    const r = await window.aos.workers.save(patch);
    if (!r.ok) setMsg({ ok: false, text: r.error || 'Could not save.' });
    onChanged();
    return r.ok;
  };
  const test = async () => {
    setBusy(true); setMsg(null);
    const r = await window.aos.workers.test({ id: w.id, key: key.trim(), baseUrl: base });
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: r.error || 'That did not work.' }); setModels(null); return; }
    const list = r.models || [];
    setModels(list);
    if (await save({ id: w.id, key: key.trim() || undefined, baseUrl: base, model, wireApi: wire, goodFor })) {
      setKey('');
      setMsg({ ok: true, text: `The gateway took the key${list.length ? ` and lists ${list.length} model${list.length === 1 ? '' : 's'}` : ''}. Saved.` });
    }
  };
  const forget = async () => { await window.aos.workers.forgetKey(w.id); setMsg({ ok: true, text: 'Key removed from this PC.' }); onChanged(); };

  return (
    <div className="card connect" style={{ marginTop: 16 }}>
      <div className="setting-head">
        <span className="lbl"><i className="dot" style={{ background: w.color, display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 8 }} />{w.name}</span>
        <span className="small muted">{w.kind === 'agent' ? 'Coding agent' : 'Model'}</span>
        <span className="flex" />
        <button className="switch" role="switch" aria-checked={w.enabled} aria-label={`Let Agentic OS use ${w.name}`} onClick={() => save({ id: w.id, enabled: !w.enabled })} />
      </div>
      <p className="small muted" style={{ margin: '4px 0 8px' }}>{w.blurb}</p>
      <div className="way">
        {w.installed
          ? <div className="status-line good"><i className="dot" />Installed on this PC.</div>
          : <div className="status-line off"><i className="dot" />Not installed yet. Ask Agentic OS to install it (it runs <span className="mono">npm install -g {w.pkg}</span> after your yes).</div>}
        <label className="lab">{w.key.saved ? `A key is saved${w.key.tail ? ` (ends in ${w.key.tail})` : ''}. Paste a new one to replace it.` : `Paste the ${w.name} key from the key page`}
          <span className="keyrow">
            <input className="field" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={`the ${w.id} key`} autoComplete="off" spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Enter') test(); }} />
            {w.key.saved && <button className="ghost" onClick={forget}>Forget key</button>}
          </span>
        </label>
        <label className="lab">Good for (Agentic OS reads this when deciding whether to suggest {w.name})
          <textarea className="field" rows={2} value={goodFor} onChange={(e) => setGoodFor(e.target.value)} onBlur={() => goodFor !== w.goodFor && save({ id: w.id, goodFor })} maxLength={400} />
        </label>
        {w.kind === 'agent' && (
          <details className="adv">
            <summary>Advanced: request format</summary>
            <div className="adv-body">
              <label className="lab">What the gateway speaks for {w.name}
                <select className="field" value={wire} onChange={(e) => { const v = e.target.value as WireApi; setWire(v); save({ id: w.id, wireApi: v }); }}>
                  <option value="responses">OpenAI Responses API (Codex's default)</option>
                  <option value="chat">OpenAI Chat Completions</option>
                </select>
                <span className="small muted">Switch only if runs fail with a "not found" or "unsupported endpoint" error.</span>
              </label>
            </div>
          </details>
        )}
        <div className="setting-actions">
          <button className="cta" onClick={test} disabled={busy || (!key.trim() && !w.key.saved)}>{busy ? 'Checking…' : key.trim() || !w.key.saved ? 'Check and save' : 'Check the saved key'}</button>
          <span className="small muted">Checked with a free call, then saved {encrypted ? 'encrypted on this PC' : 'on this PC'}. Only ever sent to the gateway address above, and only to {w.name} for one run at a time.</span>
        </div>
        {msg && <div className={`status-line ${msg.ok ? 'good' : 'off'}`}><i className="dot" />{msg.text}</div>}
      </div>
    </div>
  );
}
