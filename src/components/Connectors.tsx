import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import type { ConnectorInfo, ConnectorMode, ConnectorPolicy, ConnectorRow, ConnectorsSummary } from '../types';

// Connectors: everything the assistant can reach, grouped by where it comes from (design 27, 2026-10-07; built 2026-10-08).
// What is connected is asked of Claude Code at launch and on Refresh; how often each is used is read from the session
// logs (names only). No Claude calls, no tokens. Each row's chip overrides the switch at the top.
const DAY = 24 * 3600 * 1000;
const ago = (t: number) => { const d = Math.floor((Date.now() - t) / DAY); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));
const HEAVY = 40; // tools; each tool's name rides in every chat that loads the connector
const STATUS: Record<string, string> = {
  connected: 'Connected', 'needs-auth': 'Needs sign-in', failed: 'Failed to connect', pending: 'Connecting',
  disabled: 'Disabled', builtin: 'Built in', removed: 'No longer connected', unknown: 'Not checked yet',
};
const POL: Record<ConnectorMode | 'hidden', string> = { ondemand: 'On demand', always: 'Every chat', never: 'Never', hidden: 'Hidden' };
const MODE_TEXT: Record<ConnectorMode, string> = {
  ondemand: 'Chats start light. When you ask for something that needs one of these, the assistant loads just that one for the task and the next few questions, then it drops out again. A row set to "Every chat" or "Never" overrides this.',
  always: 'Every chat loads every connector from the start. Nothing to wait for, but it adds up.',
  never: "The assistant never loads them. Cheapest, but it can't reach email, Drive, GitHub, Chrome or the others; it will tell you so.",
};

const ICON: Record<string, ReactElement> = {
  users: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" /><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /><path d="M21 21v-2a4 4 0 0 0 -3 -3.85" /></svg>,
  ear: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 10a7 7 0 0 1 13 -3a7 7 0 0 1 0 6c-.3 1.5-1.3 2.3-2.3 3.4c-1 1-1.2 2.4-1.2 3.6a2.5 2.5 0 0 1 -5 0" /><path d="M10 10a3 3 0 0 1 5 -2a3 3 0 0 1 0 4c-.3.3-.5.6-.6 1" /></svg>,
  phone: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 5a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z" /><path d="M11 4h2" /><path d="M12 17v.01" /></svg>,
  core: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 9l3 3l-3 3" /><path d="M13 15l3 0" /><path d="M3 4m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z" /></svg>,
};
const ICON_FOR: Record<string, string> = { helpers: 'users', vosk: 'ear', phone: 'phone' };

// Logo: a bundled file (public/connectors/<id>.svg), else one fetched once by the app, else a lettered badge.
function Logo({ c }: { c: ConnectorInfo }) {
  const icon = c.icon || ICON_FOR[c.id];
  const [src, setSrc] = useState<string | null>(`./connectors/${c.id}.svg`);
  const [tried, setTried] = useState(false);
  useEffect(() => { setSrc(`./connectors/${c.id}.svg`); setTried(false); }, [c.id]);
  if (icon && ICON[icon]) return <span className="cn-logo cn-icon">{ICON[icon]}</span>;
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

function Spark({ days }: { days: number[] }) {
  const m = Math.max(1, ...days);
  const sum = days.reduce((a, b) => a + b, 0);
  return (
    <span className="cn-spark" title={`${sum} call${sum === 1 ? '' : 's'} in 14 days`} aria-label={`${sum} calls in 14 days`}>
      {days.map((n, i) => <i key={i} className={n ? '' : 'z'} style={{ height: `${n ? Math.max(14, Math.round((n / m) * 100)) : 8}%` }} />)}
    </span>
  );
}

function Row({ c, perTool, onPolicy }: { c: ConnectorRow; perTool: number; onPolicy(c: ConnectorRow, p: ConnectorPolicy): void }) {
  const heavy = c.tools != null && c.tools >= HEAVY;
  const dim = c.status !== 'connected' && c.status !== 'builtin';
  const top = c.topTools.map((t) => `${t.name} ×${t.n}`).join('\n');
  return (
    <div className={`cn-row${dim ? ' cn-dim' : ''}`} title={top || undefined}>
      <span className="cn-name">
        <Logo c={c} />
        <span className="cn-t">
          <b>{c.name}
            {c.loaded === 'chat' && <span className="cn-tag">In this chat</span>}
            {c.loaded === 'every' && <span className="cn-tag warm">In every chat</span>}
          </b>
          {c.note && <span className="cn-note">{c.note}</span>}
          <span className="cn-meta">
            <span className={`cn-st ${c.status}`}><i />{c.statusText || STATUS[c.status] || c.status}</span>
            {c.tools != null && <> · {c.tools} tools{heavy ? ' (heavy)' : ''}, about {fmt(c.tools * perTool)} tokens</>}
            {c.status !== 'builtin' || c.total ? <> · {c.d30} calls in 30 days · {c.last ? ago(c.last) : 'never used'}</> : null}
          </span>
        </span>
      </span>
      <span className={`cn-st ${c.status}`}><i />{c.statusText || STATUS[c.status] || c.status}</span>
      <span className="cn-tl">
        {c.tools != null ? <>{c.tools} tools{heavy && <span className="cn-heavy"> heavy</span>}<small>about {fmt(c.tools * perTool)} tokens</small></> : <small>no tool list</small>}
      </span>
      <Spark days={c.days} />
      <span className="mono muted cn-num">{c.d30}</span>
      <span className="muted cn-ago">{c.last ? ago(c.last) : 'never'}</span>
      {c.fixed || !c.policy ? <span className="cn-pol fixed">{c.fixed || '–'}</span> : (
        <select className={`cn-pol ${c.policy}${c.own ? ' own' : ''}`} value={c.policy} aria-label={`How ${c.name} loads`}
          title={c.own ? 'Set on this row; it overrides the switch above' : 'Following the switch above'}
          onChange={(e) => onPolicy(c, e.target.value as ConnectorPolicy)}>
          {(['ondemand', 'always', 'never', 'hidden'] as const).map((p) => <option key={p} value={p}>{POL[p]}</option>)}
        </select>
      )}
    </div>
  );
}

function Section({ title, about, children }: { title: string; about: string; children: ReactNode }) {
  return (
    <section className="cn-sec">
      <div className="cn-sechead"><h3 className="lbl">{title}</h3><span className="cn-about">{about}</span></div>
      <div className="cn-rows">{children}</div>
    </section>
  );
}

export default function Connectors({ onClose, chatId, onBrain }: { onClose(): void; chatId: string; onBrain(): void }) {
  const [s, setS] = useState<ConnectorsSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => window.aos.connectors.summary(chatId).then(setS);
  useEffect(() => { load(); }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (m: ConnectorMode) => { window.aos.connectors.setMode(m).then(load); };
  const setPolicy = (c: { key: string; name: string }, p: ConnectorPolicy) => { window.aos.connectors.setPolicy(c.key, c.name, p).then(load); };
  const refresh = () => { setBusy(true); window.aos.connectors.refresh(chatId).then(setS).finally(() => setBusy(false)); };

  const rows = s ? [...s.apps, ...s.yours, ...s.browser] : [];
  const connected = rows.filter((r) => r.status === 'connected');
  const tools = connected.reduce((a, r) => a + (r.tools || 0), 0);
  const inChat = rows.filter((r) => r.loaded).length;
  const calls30 = s ? [...rows, ...s.own].reduce((a, r) => a + r.d30, 0) : 0;
  const checked = s?.checkedAt ? new Date(s.checkedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  const head = (
    <div className="cn-row head" aria-hidden="true">
      <span>Connector</span><span>Status</span><span>Tools · tokens</span><span>Last 14 days</span><span>30 d</span><span>Last used</span><span style={{ textAlign: 'right' }}>Loads</span>
    </div>
  );
  const list = (xs: ConnectorRow[], empty: string) => (xs.length ? <>{head}{xs.map((c) => <Row key={c.key} c={c} perTool={s!.tokensPerTool} onPolicy={setPolicy} />)}</> : <span className="muted small">{empty}</span>);

  return (
    <div className="viewer-wrap tool" onClick={onClose}>
      <section className="panel viewer" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <span className="lbl strong">Connectors</span>
          <span className="small ix-sub">Everything the assistant can reach, grouped by where it comes from</span>
          <span className="flex" />
          <button className="ghost small" onClick={refresh} disabled={busy} title="Ask Claude Code again what is connected (a few seconds, no tokens)">{busy ? 'Checking…' : 'Refresh'}</button>
          <button className="ghost small" onClick={onClose} aria-label="Close Connectors">✕</button>
        </div>
        <div className="viewer-body">
          {!s ? <span className="muted small">reading your history…</span> : (
            <div className="ix cn">
              <p className="cn-status" aria-live="polite">
                <b>{connected.length}</b> connected <span className="cn-sep">·</span> <b>{tools}</b> tools <span className="cn-sep">·</span> about <b>{fmt(tools * s.tokensPerTool)}</b> tokens if all were loaded <span className="cn-sep">·</span> <b>{inChat}</b> in this chat <span className="cn-sep">·</span> <b>{calls30}</b> calls in 30 days <span className="cn-sep">·</span> {checked ? `checked ${checked}` : 'not checked yet, it runs at launch'}
              </p>

              <div className="panelcard cn-switch">
                <div>
                  <b>When the assistant loads your connected apps</b>
                  <div className="small muted">{MODE_TEXT[s.mode]}{s.mode === 'always' && ` About ${fmt(tools * s.tokensPerTool)} tokens a chat with today's set.`}</div>
                </div>
                <div className="cn-seg" role="radiogroup" aria-label="When connectors load">
                  {([['ondemand', 'Only when needed'], ['always', 'Every chat'], ['never', 'Never']] as const).map(([m, label]) => (
                    <button key={m} role="radio" aria-checked={s.mode === m} className={s.mode === m ? 'on' : ''} onClick={() => pick(m)}>{label}</button>
                  ))}
                </div>
              </div>

              <Section title="Brain" about="Who answers. Changed in Settings > Brain.">
                <div className="cn-row cn-brain">
                  <span className="cn-name"><Logo c={s.brain} /><span className="cn-t"><b>{s.brain.name}</b><span className="cn-note">{s.brain.note}</span></span></span>
                  <span className="cn-st connected"><i />Signed in</span>
                  <span className="cn-detail">{s.brain.detail}</span>
                  <button className="ghost small" onClick={onBrain}>Change</button>
                </div>
              </Section>

              <Section title="Connected apps" about="Linked to your Claude account on claude.ai. They come with the login.">
                {list(s.apps, 'None found yet. Restart the app, or press Refresh.')}
              </Section>

              <Section title="Added by you" about="Tool servers you added to Claude Code yourself (claude mcp add). The app reads your config and passes them in.">
                {list(s.yours, 'None. Add one in a terminal with "claude mcp add --scope user", then press Refresh.')}
              </Section>

              <Section title="Browser" about="Your own signed-in Chrome, through the Claude extension. Looking runs unasked; clicking, typing and forms ask first.">
                {list(s.browser, 'Hidden. Show it again below.')}
              </Section>

              <Section title="The app's own tools" about="Built by the app for every question. Always there, no sign-in.">
                {list(s.own, '')}
              </Section>

              <Section title="On this PC" about="Local services the app runs or calls. Not tool calls, so nothing is counted.">
                <div className="cn-tiles">
                  {s.pc.map((t) => (
                    <div className={`cn-tile${t.on ? '' : ' off'}`} key={t.id}><Logo c={t} /><span><b>{t.name}</b><br /><span className="small muted">{t.kind}</span></span></div>
                  ))}
                </div>
              </Section>

              <Section title="Always on" about="Claude Code's own tools, in every chat. Not connectors; listed so nothing is missing.">
                <div className="cn-line">{ICON.core}<span>Files (Read, Write, Edit, Glob, Grep) · Shell (Bash, PowerShell) · Web (search, fetch) · Skill · Agent · Monitor · DesignSync · workspace skills plugin{s.skills != null ? ` (${s.skills} skills)` : ''}</span></div>
              </Section>

              {s.hidden.length > 0 && (
                <div className="small muted cn-hidden">
                  Hidden: {s.hidden.map((h, i) => (
                    <span key={h.key}>{i ? ', ' : ''}{h.name} <button className="linkish" onClick={() => setPolicy(h, 'shown')}>show</button></span>
                  ))}
                </div>
              )}

              <p className="small muted cn-foot">
                Counts are read from Claude Code's session logs on this PC, by tool name only, never what was sent or returned. "About n tokens" is tools × {s.tokensPerTool}, the measured cost of listing a tool's name in a chat (4 October). A row's own setting overrides the switch above; "Hidden" keeps an app off this list and out of the assistant's hands without disconnecting it. "Heavy" means {HEAVY}+ tools. Hover a row for its busiest tools.
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
