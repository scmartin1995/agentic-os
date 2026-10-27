import { useEffect, useState } from 'react';
import type { ConnectorInfo, ConnectorMode, ConnectorRow, ConnectorsSummary, ToolRow, ToolsSummary } from '../types';

// Connectors & Tools: everything Agentic OS can reach. Connectors (Gmail, Drive...) are apps linked to your
// Claude.ai account, found by asking Claude Code what is connected (at launch and on Refresh) — Agentic OS
// only shows and toggles them. Tools are CLI programs Agentic OS itself installed (TWG CLI and the like); Agentic OS
// can disconnect or fully remove those. Usage for both comes from the session logs, no Claude calls.
const DAY = 24 * 3600 * 1000;
const ago = (t: number) => { const d = Math.floor((Date.now() - t) / DAY); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
const HEAVY = 40; // tools; each tool's name and description rides in every chat that loads the connector
const STATUS: Record<string, string> = {
  connected: 'Connected', 'needs-auth': 'Needs sign-in', failed: 'Failed to connect', pending: 'Connecting',
  disabled: 'Disabled', builtin: 'Built into the app', removed: 'No longer connected', unknown: 'Not checked yet',
};

// Logo: a bundled file (public/connectors/<id>.svg), else one fetched once by the app, else a lettered badge.
function Logo({ c }: { c: ConnectorInfo }) {
  const [src, setSrc] = useState<string | null>(`./connectors/${c.id}.svg`);
  const [tried, setTried] = useState(false);
  useEffect(() => { setSrc(`./connectors/${c.id}.svg`); setTried(false); }, [c.id]);
  const miss = () => {
    if (tried) { setSrc(null); return; }
    setTried(true);
    window.aos.connectors.logo(c.name).then(setSrc).catch(() => setSrc(null));
  };
  return (
    <span className="cn-logo" style={{ ['--cc' as string]: c.color }}>
      {src ? <img src={src} alt="" onError={miss} /> : <b>{c.name[0]}</b>}
    </span>
  );
}

// A tool has no fetched logo (no connector catalogue to ask) — always the lettered badge.
function ToolLogo({ t }: { t: ToolRow }) {
  return <span className="cn-logo" style={{ ['--cc' as string]: t.color }}><b>{t.name[0]}</b></span>;
}

function Row({ c, max }: { c: ConnectorRow; max: number }) {
  const dm = Math.max(1, ...c.days);
  const heavy = c.tools != null && c.tools >= HEAVY;
  const dim = c.status === 'removed' || c.status === 'needs-auth' || c.status === 'failed';
  return (
    <div className={`srow cn-row${dim ? ' cn-dim' : ''}`} title={c.topTools.map((t) => `${t.name} ×${t.n}`).join('\n')}>
      <span className="cn-name">
        <Logo c={c} />
        <span>
          <b>{c.name}</b><br />
          <span className="small muted">{STATUS[c.status] || c.status}{c.tools != null && c.status === 'connected' ? ' · ' : ''}
            {c.tools != null && c.status === 'connected' && <span style={heavy ? { color: 'var(--orange-soft)' } : undefined}>{c.tools} tools{heavy ? ', heavy' : ''}</span>}
          </span>
        </span>
      </span>
      <span className="cn-spark" style={{ ['--cc' as string]: c.color }}>{c.days.map((n, i) => <i key={i} style={{ height: `${n ? Math.max(12, (n / dm) * 100) : 4}%`, opacity: n ? 1 : .25 }} />)}</span>
      <span className="fresh"><i style={{ width: `${c.d30 ? Math.max(4, (c.d30 / max) * 100) : 0}%`, background: c.color }} /></span>
      <span className="mono muted">{c.total}</span>
      <span className="muted">{c.last ? ago(c.last) : 'never'}</span>
    </div>
  );
}

type ToolAction = { kind: 'disconnect' | 'remove'; t: ToolRow };

function ToolLine({ t, max, busy, onAct }: { t: ToolRow; max: number; busy: boolean; onAct(a: ToolAction): void }) {
  const dm = Math.max(1, ...t.days);
  return (
    <div className={`srow cn-row tool-row${t.active ? '' : ' cn-dim'}`}>
      <span className="cn-name">
        <ToolLogo t={t} />
        <span>
          <b>{t.name}</b><br />
          <span className="small muted">{t.worker
            ? `${t.active ? 'On' : 'Switched off'} · ${t.kind === 'agent' ? 'coding agent' : 'model'}`
            : `${t.active ? 'Active' : 'Disconnected'} · ${t.skills.length} skill${t.skills.length === 1 ? '' : 's'}`}</span>
        </span>
      </span>
      <span className="cn-spark" style={{ ['--cc' as string]: t.color }}>{t.days.map((n, i) => <i key={i} style={{ height: `${n ? Math.max(12, (n / dm) * 100) : 4}%`, opacity: n ? 1 : .25 }} />)}</span>
      <span className="fresh"><i style={{ width: `${t.d30 ? Math.max(4, (t.d30 / max) * 100) : 0}%`, background: t.color }} /></span>
      <span className="mono muted">{t.total}</span>
      <span className="muted">{t.last ? ago(t.last) : 'never'}</span>
      <span className="tool-actions">
        {t.worker ? <span className="small muted">Settings › Other models</span> : t.active ? (
          <>
            <button className="ghost small" disabled={busy} onClick={() => onAct({ kind: 'disconnect', t })}>Disconnect</button>
            <button className="ghost small" disabled={busy} onClick={() => onAct({ kind: 'remove', t })}>Remove completely</button>
          </>
        ) : (
          <button className="ghost small" disabled={busy} onClick={() => onAct({ kind: 'disconnect', t })}>Reconnect</button>
        )}
      </span>
    </div>
  );
}

// Shared confirm overlay for Disconnect/Reconnect/Remove completely — a real decision, not a chat turn,
// so it gets its own small dialog rather than the chat's approval card.
function Confirm({ title, danger, confirmLabel, busy, onConfirm, onCancel, children }: {
  title: string; danger?: boolean; confirmLabel: string; busy: boolean; onConfirm(): void; onCancel(): void; children: React.ReactNode;
}) {
  return (
    <div className="viewer-wrap tool" onClick={onCancel}>
      <section className="panel" style={{ maxWidth: 440, padding: '18px 20px' }} onClick={(e) => e.stopPropagation()}>
        <b style={{ fontSize: 14.5 }}>{title}</b>
        <div className="small muted" style={{ marginTop: 10, lineHeight: 1.6 }}>{children}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className={danger ? 'cta warm' : 'cta'} disabled={busy} onClick={onConfirm}>{busy ? 'Working…' : confirmLabel}</button>
          <button className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </section>
    </div>
  );
}

export default function Connectors({ onClose }: { onClose(): void }) {
  const [s, setS] = useState<ConnectorsSummary | null>(null);
  const [t, setT] = useState<ToolsSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [toolBusy, setToolBusy] = useState(false);
  const [confirm, setConfirm] = useState<ToolAction | null>(null);
  const loadTools = () => window.aos.tools.summary().then(setT);
  useEffect(() => { window.aos.connectors.summary().then(setS); loadTools(); }, []);
  const pick = (m: ConnectorMode) => { if (s) window.aos.connectors.setMode(m).then((mode) => setS({ ...s, mode })); };
  const refresh = () => { setBusy(true); loadTools(); window.aos.connectors.refresh().then(setS).finally(() => setBusy(false)); };
  const max = s ? Math.max(1, ...s.items.map((c) => c.d30)) : 1;
  const cli = t ? t.items.filter((x) => !x.worker) : [];
  const others = t ? t.items.filter((x) => x.worker) : [];
  const toolMax = Math.max(1, ...cli.map((x) => x.d30));
  const otherMax = Math.max(1, ...others.map((x) => x.d30));
  const since = s?.since ? new Date(s.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null;
  const checked = s?.checkedAt ? new Date(s.checkedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;

  const runConfirm = () => {
    if (!confirm) return;
    setToolBusy(true);
    const call = confirm.kind === 'remove' ? window.aos.tools.removeCompletely(confirm.t.id)
      : confirm.t.active ? window.aos.tools.disconnect(confirm.t.id) : window.aos.tools.reconnect(confirm.t.id);
    call.then(() => loadTools()).finally(() => { setToolBusy(false); setConfirm(null); });
  };

  return (
    <>
      <div className="viewer-wrap tool" onClick={onClose}>
        <section className="panel viewer" onClick={(e) => e.stopPropagation()}>
          <div className="viewer-head">
            <span className="lbl strong">Connectors &amp; Tools</span>
            <span className="small ix-sub">What Agentic OS can reach, and how often it uses each</span>
            <span className="flex" />
            <button className="ghost small" onClick={onClose} aria-label="Close Connectors & Tools">✕</button>
          </div>
          <div className="viewer-body">
            {!s || !t ? <span className="muted small">reading your history…</span> : (
              <div className="ix">
                <div className="panelcard cn-switch">
                  <div>
                    <b>When Agentic OS can use your connected apps</b>
                    <div className="small muted">
                      {{
                        ondemand: 'Chats start light. When you ask for something that needs one of your connected apps, Agentic OS loads just that app for the task and the next few questions, then it drops out again.',
                        always: 'Every chat lists every connector, about 4k tokens a chat on Sonnet (measured 2026-10-04). Nothing to wait for, but it adds up.',
                        never: "Agentic OS never loads them. Cheapest, but it can't reach email, Drive or the other apps.",
                      }[s.mode]}
                    </div>
                  </div>
                  <div className="cn-seg" role="radiogroup" aria-label="When connectors load">
                    {([['ondemand', 'Only when needed'], ['always', 'Every chat'], ['never', 'Never']] as const).map(([m, label]) => (
                      <button key={m} role="radio" aria-checked={s.mode === m} className={s.mode === m ? 'on' : ''} onClick={() => pick(m)}>{label}</button>
                    ))}
                  </div>
                </div>

                <div className="ix-sec">
                  <div className="ix-sechead">
                    <h3 className="lbl">Connected apps</h3>
                    <span className="small ix-sub">{checked ? `checked ${checked}, at launch` : 'not checked yet, it runs at launch'}{since ? ` · counts since ${since}` : ''}</span>
                    <span className="flex" />
                    <button className="ghost small" onClick={refresh} disabled={busy}>{busy ? 'Checking…' : 'Refresh'}</button>
                  </div>
                  {!s.items.length ? <span className="muted small">Nothing found yet. Restart the app, or press Refresh.</span> : (
                    <div className="cn-list">
                      <div className="srow head cn-row"><span>Connector</span><span>Last 14 days</span><span>30 days</span><span>All time</span><span>Last used</span></div>
                      {s.items.map((c) => <Row key={c.key} c={c} max={max} />)}
                    </div>
                  )}
                  <span className="small muted" style={{ marginTop: 10 }}>
                    New connectors appear here by themselves. "Heavy" means {HEAVY}+ tools: every tool's name is listed in each chat that loads the connector, so a heavy connector you don't use is worth disconnecting in your Claude settings.
                    Hover a row for its busiest tools. Only call names are read from the logs, never what was in them.
                  </span>
                </div>

                <div className="ix-sec">
                  <div className="ix-sechead">
                    <h3 className="lbl">Tools</h3>
                    <span className="small ix-sub">CLI tools Agentic OS installed, with their skill files</span>
                  </div>
                  {!cli.length ? (
                    <span className="muted small">None yet. To add one, paste the vendor's setup instructions into a chat — Agentic OS will review what it's about to do before running anything.</span>
                  ) : (
                    <div className="cn-list">
                      <div className="srow head cn-row tool-row"><span>Tool</span><span>Last 14 days</span><span>30 days</span><span>All time</span><span>Last used</span><span></span></div>
                      {cli.map((x) => <ToolLine key={x.id} t={x} max={toolMax} busy={toolBusy} onAct={setConfirm} />)}
                    </div>
                  )}
                  <span className="small muted" style={{ marginTop: 10 }}>
                    A tool's skill files live in this vault's <span className="mono">skills/</span> folder. Disconnect
                    moves them to <span className="mono">skills/_archive/</span> and stops Agentic OS using them — the
                    installed program and any sign-in stay untouched. Remove completely goes further: uninstalls the
                    program, signs it out, and deletes the skill files outright.
                  </span>
                </div>

                <div className="ix-sec">
                  <div className="ix-sechead">
                    <h3 className="lbl">Other models</h3>
                    <span className="small ix-sub">workers Agentic OS hands jobs to through the company gateway; counted per job</span>
                  </div>
                  {!others.length ? (
                    <span className="muted small">None set up yet. Add a key in Settings › Other models.</span>
                  ) : (
                    <div className="cn-list">
                      <div className="srow head cn-row tool-row"><span>Worker</span><span>Last 14 days</span><span>30 days</span><span>All time</span><span>Last used</span><span></span></div>
                      {others.map((x) => <ToolLine key={x.id} t={x} max={otherMax} busy={toolBusy} onAct={setConfirm} />)}
                    </div>
                  )}
                </div>

                <div className="ix-sec">
                  <div className="ix-sechead"><h3 className="lbl">Built into the app</h3><span className="small ix-sub">set up on this PC; not connector calls, so not counted</span></div>
                  <div className="cn-tiles">
                    {s.builtIn.map((c) => (
                      <div className="cn-tile" key={c.id}><Logo c={c} /><span><b>{c.name}</b><br /><span className="small muted">{c.kind}</span></span></div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      {confirm && confirm.kind === 'disconnect' && confirm.t.active && (
        <Confirm title={`Disconnect ${confirm.t.name}?`} confirmLabel="Disconnect" busy={toolBusy} onConfirm={runConfirm} onCancel={() => setConfirm(null)}>
          <p>Agentic OS will stop offering and using it. Its {confirm.t.skills.length} skill file{confirm.t.skills.length === 1 ? '' : 's'} move to <span className="mono">skills/_archive/</span>.</p>
          <p>Left untouched: the installed program, and any sign-in. Neither is the assistant's to remove.</p>
          <p>You can reconnect later — nothing is deleted, just moved.</p>
        </Confirm>
      )}
      {confirm && confirm.kind === 'disconnect' && !confirm.t.active && (
        <Confirm title={`Reconnect ${confirm.t.name}?`} confirmLabel="Reconnect" busy={toolBusy} onConfirm={runConfirm} onCancel={() => setConfirm(null)}>
          <p>Restores its archived skill files and lets Agentic OS use it again.</p>
        </Confirm>
      )}
      {confirm && confirm.kind === 'remove' && (
        <Confirm title={`Remove ${confirm.t.name} completely?`} danger confirmLabel="Yes, remove everything" busy={toolBusy} onConfirm={runConfirm} onCancel={() => setConfirm(null)}>
          <p>This goes further than Disconnect: it uninstalls the program, signs it out, and deletes its skill files outright rather than archiving them.</p>
          <p>To use it again later you'd re-install and sign in from scratch — there's nothing left here to simply restore.</p>
        </Confirm>
      )}
    </>
  );
}
