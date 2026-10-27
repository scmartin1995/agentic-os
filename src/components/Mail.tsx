import { useEffect, useState } from 'react';
import type { MailItem, MailState } from '../types';
import aos from '../aos';

// Mail, from the side list: the last week of Outlook (read from classic Outlook on this PC, never changed), with the
// messages that need a reply on top, each with its draft. Marking one "doesn't need a reply" teaches the classifier.
// Everything else is a one-line summary; the message text is only held for the ones waiting on a reply.
const when = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };

export default function Mail({ onClose }: { onClose(): void }) {
  const [s, setS] = useState<MailState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [prog, setProg] = useState('');
  const [openBody, setOpenBody] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState('');
  const [watchMin, setWatchMinState] = useState(() => { try { return localStorage.getItem('aos-mail-watch-min') === '1'; } catch { return false; } });
  const setWatchMin = (v: boolean) => { setWatchMinState(v); try { localStorage.setItem('aos-mail-watch-min', v ? '1' : '0'); } catch { /* private mode */ } };
  const [copied, setCopied] = useState<string | null>(null);
  const load = () => aos.mail.state().then(setS).catch(() => {});
  useEffect(() => {
    load();
    return aos.mail.onEvent((e) => {
      if (e.type === 'progress') setProg(`${e.done ?? 0} of ${e.total ?? '?'}`);
      if (e.type === 'done' || e.type === 'error') { setProg(''); load(); }
    });
  }, []);

  const pull = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await aos.mail.pull();
      if (r.already) setMsg('A pull is already running.');
      else if (r.error && !r.added) setMsg(r.error);
      else setMsg(`Read ${r.fetched} messages from the last week. Skipped ${r.bulk} ServiceNow or your own. Added ${r.added}; ${r.needReply} need a reply${r.closed ? `, ${r.closed} closed because you replied` : ''}${r.failed ? `; ${r.failed} could not be read this time` : ''}.${r.error && r.added ? ` (${r.error})` : ''}`);
    } catch (e) { setMsg(String((e as Error)?.message || e)); }
    setBusy(false); load();
  };
  const checkJira = async () => {
    setChecking(true); setCheckMsg('');
    try {
      const r = await aos.mail.checkWatch();
      setCheckMsg(r.down ? 'Could not reach Jira through the twg CLI. Check that you are signed in to twg, then try again.'
        : r.total === 0 ? 'Nothing to check: no Complete items on the list, or all are already confirmed in Jira.'
        : `Checked ${r.checked} of ${r.total}: ${r.confirmed} found in Jira, ${r.unconfirmed} with no matching database.`);
    } catch (e) { setCheckMsg(String((e as Error)?.message || e)); }
    setChecking(false); load();
  };
  const act = async (fn: () => Promise<boolean>) => { await fn(); load(); };
  const copy = (m: MailItem) => { navigator.clipboard?.writeText(m.draft || ''); setCopied(m.id); setTimeout(() => setCopied(null), 1500); };
  const last = s?.lastPull ? new Date(s.lastPull).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';

  return (
    <div className="viewer-wrap tool" onClick={onClose}>
      <section className="panel viewer list-tool" onClick={(e) => e.stopPropagation()}>
        <div className="viewer-head">
          <span className="lbl strong">Mail</span>
          {s && <span className="mono small muted">last pulled {last}</span>}
          <span className="flex" />
          <button className="ghost small" onClick={pull} disabled={busy} title="Reads the last 7 days from classic Outlook, which must be open. Nothing in Outlook is changed.">{busy ? `Reading…${prog ? ' ' + prog : ''}` : 'Pull mail'}</button>
          <button className="ghost small" onClick={onClose} aria-label="Close mail">✕</button>
        </div>
        <div className="viewer-body">
          <p className="muted small intro">The last 7 days from classic Outlook, read-only. ServiceNow messages and mail from you are skipped; everything else is read. Mail that needs a reply from you is listed first with a draft; the message text is kept only until you close it. Anything under "Doesn't need a reply" teaches Agentic OS what to leave out.</p>
          {msg && <p className="small mono">{msg}</p>}
          {s && !s.health.ok && <p className="small mono" style={{ color: 'var(--bad, #c0392b)' }}>Mail needs attention: {s.health.why}</p>}
          {!s ? <span className="muted small">loading…</span> : (
            <>
              <div className="tool-group">
                <h3>Needs a reply ({s.open.length})</h3>
                {s.open.length === 0 && <p className="muted small">{s.lastPull ? 'Nothing waiting on you.' : 'Pull mail to see what needs a reply.'}</p>}
                {s.open.map((m) => (
                  <div key={m.id} className="tool-card" style={{ cursor: 'default', width: '100%', minWidth: 0, boxSizing: 'border-box', overflowWrap: 'anywhere', marginBottom: 12 }}>
                    <span className="tool-card-head"><b>{m.subject || '(no subject)'}</b></span>
                    <span className="mono small acc">{m.from} · {when(m.received)}</span>
                    <span className="small desc">{m.summary}</span>
                    {m.reason && <span className="small muted">Why: {m.reason}</span>}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button className="ghost small" onClick={() => setOpenBody(openBody === m.id ? null : m.id)}>{openBody === m.id ? 'Hide email' : 'Show email'}</button>
                      <button className="ghost small" onClick={() => aos.mail.openInOutlook(m.id).catch((e) => setMsg(String(e?.message || e)))}>Open in Outlook</button>
                      <button className="ghost small" onClick={() => act(() => aos.mail.done(m.id))} title="You've replied or handled it">Done</button>
                      <button className="ghost small" onClick={() => act(() => aos.mail.dismiss(m.id))} title="Removes it, and teaches Agentic OS that mail like this needs no reply">Doesn't need a reply</button>
                    </div>
                    {openBody === m.id && <pre className="small" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', width: '100%', minWidth: 0, boxSizing: 'border-box', maxHeight: 260, overflow: 'auto', margin: '6px 0', padding: 10, background: 'rgba(var(--ink),.04)', borderRadius: 6 }}>{m.body}</pre>}
                    <div style={{ width: '100%' }}>
                      <span className="lbl">Draft reply</span>
                      {m.draft
                        ? <><pre className="small" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', width: '100%', minWidth: 0, boxSizing: 'border-box', margin: '4px 0', padding: 10, background: 'rgba(var(--ink),.06)', borderRadius: 6 }}>{m.draft}</pre>
                            <button className="ghost small" onClick={() => copy(m)}>{copied === m.id ? 'Copied' : 'Copy draft'}</button> <span className="small muted">Paste it into Outlook's reply. Text in [brackets] is for you to fill in.</span></>
                        : <p className="small muted">No draft was made{m.draftError ? `: ${m.draftError}` : '.'}</p>}
                    </div>
                  </div>
                ))}
              </div>
              {s.watch.length > 0 && (
                <div className="tool-group">
                  <h3 style={{ cursor: 'pointer' }} onClick={() => setWatchMin(!watchMin)} title={watchMin ? 'Show the watch list' : 'Minimise the watch list'}>Watch ({s.watch.length}) {watchMin ? '▸' : '▾'} {!watchMin && <button className="ghost small" disabled={checking} onClick={(e) => { e.stopPropagation(); checkJira(); }} title="Looks up each Complete flag in Jira (read-only) and suggests what to change">{checking ? 'Checking…' : 'Check Jira'}</button>}</h3>
                  {!watchMin && checkMsg && <p className="small mono">{checkMsg}</p>}
                  {!watchMin && <p className="muted small">Not replies: finished migrations, dates people want, blockers and escalations, picked out of the last 7 days by wording. Jira notices are ignored.</p>}
                  {!watchMin && s.watch.map((m) => (
                    <div key={m.id} className="small" style={{ padding: '6px 0', borderBottom: '1px solid rgba(var(--ink),.06)', overflowWrap: 'anywhere' }}>
                      <span className="mono acc">{m.watchLabel}</span> <b>{m.subject || '(no subject)'}</b> <span className="muted">· {m.from} · {when(m.received)}</span><br />
                      <span className="muted">{m.summary}</span><br />
                      {m.watch === 'complete' && (m.jira
                        ? m.jira.confirmed
                          ? <span className="small"><b>Database confirmed in Jira:</b> {m.jira.key} {m.jira.summary ? '· ' + m.jira.summary : ''}{m.jira.status ? ' · ' + m.jira.status : ''}<br /></span>
                          : <span className="small muted">No matching database in Jira. Possibly an application or server, not a database.<br /></span>
                        : <span className="small muted">Jira not checked yet.<br /></span>)}
                      {m.suggestion && <span className="small"><b>Suggested:</b> {m.suggestion}<br /></span>}
                      {m.jira?.confirmed && m.jira.url && <><a className="small" href={m.jira.url} target="_blank" rel="noreferrer">Open {m.jira.key} in Jira</a>{' '}</>}
                      <button className="ghost small" onClick={() => aos.mail.openInOutlook(m.id).catch((e) => setMsg(String(e?.message || e)))}>Open in Outlook</button>{' '}
                      <button className="ghost small" onClick={() => act(() => aos.mail.unwatch(m.id))} title="Removes it from Watch">Seen</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="tool-group">
                <h3 style={{ cursor: 'pointer' }} onClick={() => setShowInfo(!showInfo)}>Everything else ({s.info.length}) {showInfo ? '▾' : '▸'}</h3>
                {showInfo && s.info.map((m) => (
                  <div key={m.id} className="small" style={{ padding: '5px 0', borderBottom: '1px solid rgba(var(--ink),.06)' }}>
                    <b>{m.subject || '(no subject)'}</b> <span className="muted">· {m.from} · {when(m.received)}</span><br />
                    <span className="muted">{m.summary}</span>
                  </div>
                ))}
              </div>
              <p className="small muted">{s.closed} closed so far · {s.feedback} judgements remembered</p>
              <details className="small">
                <summary className="muted">Activity log ({s.log.length})</summary>
                {s.log.length === 0 && <p className="muted small">Nothing logged yet. Every pull, skip and failure is written here.</p>}
                {s.log.map((e, i) => (
                  <div key={i} className="mono small muted">{new Date(e.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {e.kind} · {e.note}{e.n && e.n > 1 ? ` (×${e.n}, latest shown)` : ''}</div>
                ))}
              </details>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
