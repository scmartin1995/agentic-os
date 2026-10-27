// electron/mail.cjs with a stand-in for Outlook and for the models: no mailbox, no tokens.
// Checks what is kept (text only for mail waiting on a reply, gone when it is closed), that bulk mail never reaches a model,
// that "doesn't need a reply" is fed back to the classifier, that a reply made in Outlook closes an item, that a failed model call
// stores nothing, and that the search entries carry no message text.
// Run:  node tools\test-mail.cjs
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.AOS_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-mail-'));
const M = require('../electron/mail.cjs');

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('ok   ', name); } catch (e) { console.log('FAIL ', name, '\n     ', String(e.message).split('\n')[0]); process.exitCode = 1; } };
const msg = (o) => ({ id: 'AA' + Math.random().toString(16).slice(2, 10).toUpperCase(), folder: 'Inbox', subject: 'Hello', from: 'Rose, Kyle', fromAddr: 'kyle@x.com', to: 'MARTIN, STERLING', cc: '', received: new Date().toISOString().slice(0, 19), unread: true, verb: 0, body: 'Can you confirm the date?', ...o });

(async () => {
  const seenByModel = [];
  let failNext = false;
  const prompts = [];
  const oneShot = async ({ prompt, system, model }) => {
    prompts.push({ system, model });
    if (model === 'sonnet') return { text: 'Kyle,\n\nConfirmed for [date].\n\nSterling' };
    if (failNext) { failNext = false; throw new Error('gateway said no'); }
    const ids = [...prompt.matchAll(/^=== id: (\S+)/gm)].map((m) => m[1]);
    seenByModel.push(...ids);
    const own = (id) => (prompt.split(`=== id: ${id}`)[1] || '').split('=== id:')[0]; // this message only, not the ones after it in the batch
    return { out: { items: ids.map((id) => ({ id, summary: `About ${id}.`, atoms: ['ABC-1'], needsReply: /confirm/i.test(own(id)) && !/FYI/.test(own(id)), reason: 'asks a question' })) } };
  };

  await test('bulk rule: only ServiceNow is skipped; everything else, including Jira, no-reply and calendar replies, goes through', () => {
    assert.ok(M.isBulk({ from: 'ServiceNow', fromAddr: 'service-now@lumen.com', subject: 'x' }));
    assert.ok(!M.isBulk({ from: 'Automation for Jira (Jira)', fromAddr: '', subject: 'x' })); // loosened: only ServiceNow is skipped
    assert.ok(!M.isBulk({ from: 'Corp', fromAddr: 'noreply@lumen.com', subject: 'x' }));
    assert.ok(M.isBulk({ from: 'Rose, Kyle', fromAddr: '', subject: 'Your SNOW ticket INC0012 was updated' }));
    assert.ok(!M.isBulk({ from: 'Rose, Kyle', fromAddr: '', subject: 'Accepted: Standup' }));
    assert.ok(!M.isBulk({ from: 'Rose, Kyle', fromAddr: 'kyle@x.com', subject: 'Please confirm cutover date' }));
  });

  const reply = msg({ subject: 'Please confirm cutover date', from: 'Schwaigert, John' });
  const fyi = msg({ subject: 'FYI new runbook', from: 'Hass, Sandy', body: 'FYI the runbook moved.' });
  const jira = msg({ subject: 'Incident INC001 updated', from: 'ServiceNow' }); // named jira from when Jira mail was skipped too
  const mine = msg({ subject: 'note to self', from: 'MARTIN, STERLING' });
  const reader = async () => ({ me: 'MARTIN, STERLING', items: [reply, fyi, jira, mine] });

  await test('a pull sends only real people to the model; bulk and own notes never reach it', async () => {
    const r = await M.pull({ oneShot, reader });
    assert.deepStrictEqual([r.fetched, r.bulk, r.added, r.needReply], [4, 2, 2, 1]);
    assert.ok(!seenByModel.includes(jira.id) && !seenByModel.includes(mine.id));
  });
  await test('mail that needs a reply keeps its text and a draft; the rest keeps a summary only', () => {
    const s = M.state();
    assert.strictEqual(s.open.length, 1);
    assert.ok(s.open[0].body.includes('confirm the date') && s.open[0].draft.includes('[date]'));
    assert.strictEqual(s.info.length, 1);
    assert.ok(!('body' in s.info[0]) && !('draft' in s.info[0]));
  });
  await test('search entries carry summaries and never the message text', () => {
    const e = M.searchEntries();
    assert.strictEqual(e.length, 2);
    assert.ok(e.every((x) => x.kind === 'mail' && x.enriched && !JSON.stringify(x).includes('confirm the date')));
  });
  await test('a second pull does not redo mail it already holds', async () => {
    const before = seenByModel.length;
    const r = await M.pull({ oneShot, reader });
    assert.strictEqual(r.added, 0); assert.strictEqual(seenByModel.length, before);
  });
  await test("'doesn't need a reply' deletes the text and draft and is shown to the classifier next time", async () => {
    assert.ok(M.dismiss(reply.id));
    const s = M.state();
    assert.strictEqual(s.open.length, 0); assert.strictEqual(s.feedback, 1);
    const stored = JSON.parse(fs.readFileSync(path.join(process.env.AOS_USERDATA, 'mail.json'), 'utf8')).items[reply.id];
    assert.ok(!('body' in stored) && !('draft' in stored));
    const next = msg({ subject: 'Another one' });
    prompts.length = 0;
    await M.pull({ oneShot, reader: async () => ({ me: 'MARTIN, STERLING', items: [next] }) });
    assert.match(prompts.find((p) => p.model === 'haiku').system, /NO reply needed: from Schwaigert, John/);
  });
  await test('a reply made in Outlook closes the item on the next pull', async () => {
    const r2 = msg({ subject: 'Please confirm the thing', from: 'Lane, Thomas' });
    await M.pull({ oneShot, reader: async () => ({ me: 'MARTIN, STERLING', items: [r2] }) });
    assert.ok(M.state().open.some((m) => m.id === r2.id));
    const r = await M.pull({ oneShot, reader: async () => ({ me: 'MARTIN, STERLING', items: [{ ...r2, verb: 102 }] }) });
    assert.strictEqual(r.closed, 1);
    assert.ok(!M.state().open.some((m) => m.id === r2.id));
  });
  await test('a failed model call stores nothing, so the next pull tries again', async () => {
    const m = msg({ subject: 'Please confirm retry', from: 'Burrell, Douglas' });
    failNext = true;
    const r = await M.pull({ oneShot, reader: async () => ({ me: 'MARTIN, STERLING', items: [m] }) });
    assert.strictEqual(r.failed, 1); assert.strictEqual(r.added, 0);
    const r2 = await M.pull({ oneShot, reader: async () => ({ me: 'MARTIN, STERLING', items: [m] }) });
    assert.strictEqual(r2.added, 1);
  });
  await test('Outlook not open: the pull reports it and changes nothing', async () => {
    const mailOnly = () => { const { log, health, ...rest } = M.state(); return JSON.stringify(rest); }; // the log is meant to change
    const before = mailOnly();
    const r = await M.pull({ oneShot, reader: async () => { throw new Error('Outlook is not open.'); } });
    assert.match(r.error, /not open/);
    assert.strictEqual(mailOnly(), before);
    assert.match(M.state().log[0].note, /not open/);
    assert.strictEqual(M.state().health.ok, false);
  });
  await test('openInOutlook rejects anything that is not a message id', async () => {
    await assert.rejects(M.openInOutlook("x'; Remove-Item *"), /not a message id/);
  });

  // ---- drafts follow no-ai-slop ----
  await test('slop check: catches dashes, stock phrases, banned words and "not X but Y"; passes a plain reply', () => {
    assert.deepStrictEqual(M.slop('Kyle,\n\nConfirmed for Oct 30. I will send the runbook Friday.\n\nSterling'), []);
    for (const bad of ['Confirmed — Friday.', 'I hope this finds you well.', 'We will leverage the pipeline.', 'Let me know if you have questions.', 'This is not a delay but a reschedule.', 'Great news!', 'Happy to circle back.']) {
      assert.ok(M.slop(bad).length > 0, bad);
    }
  });
  await test('a draft with slop is rewritten once; a clean draft is not', async () => {
    let calls = 0;
    const dirty = async ({ prompt }) => { calls++; return { text: prompt.includes('Your first draft') ? 'Kyle,\n\nConfirmed for Oct 30.\n\nSterling' : 'Kyle,\n\nI hope this finds you well. Confirmed for Oct 30 — happy to help!\n\nSterling' }; };
    const d = await M.draftFor({ from: 'Rose, Kyle', subject: 's', received: 'r', body: 'b' }, dirty);
    assert.strictEqual(calls, 2); assert.deepStrictEqual(M.slop(d), []);
    calls = 0;
    await M.draftFor({ from: 'Rose, Kyle', subject: 's', received: 'r', body: 'b' }, async () => { calls++; return { text: 'Kyle,\n\nConfirmed.\n\nSterling' }; });
    assert.strictEqual(calls, 1);
  });
  await test('if the rewrite is no better, the original is kept (never worse)', async () => {
    const worse = async ({ prompt }) => ({ text: prompt.includes('Your first draft') ? 'Kyle — I hope this finds you well! Happy to help!' : 'Kyle — confirmed.' });
    const d = await M.draftFor({ from: 'Rose, Kyle', subject: 's', received: 'r', body: 'b' }, worse);
    assert.strictEqual(d, 'Kyle — confirmed.');
  });

  // ---- the background pull ----
  await test('background: a pull that finds Outlook closed does not count as a pull, so it is tried again', async () => {
    const before = M.state().lastPull;
    const r = await M.pull({ oneShot, reader: async () => { throw new Error('Outlook is not open. Open classic Outlook.'); } });
    assert.ok(r.error);
    assert.strictEqual(M.state().lastPull, before); // lastPull only moves when a pull finished
  });

  // ---- the watch list ----
  await test('watch: completions, blockers, escalations and migration dates are flagged; ordinary mail, Jira noise and out-of-office are not', () => {
    const k = (subject, summary) => (M.watchOf({ subject, summary }) || {}).kind;
    assert.strictEqual(k('RITM6154218 decommission complete - Azure oracle azeus2loras', 'Decommission completed.'), 'complete');
    assert.strictEqual(k('Cutover', 'The migration of NED01P was successfully completed overnight.'), 'complete');
    assert.strictEqual(k('[JIRA] (CIPDBPE-1) SYSGEN1 | ASL01S', 'Decommission set to App Decommed, status DONE.'), undefined); // Jira mail is ignored entirely [261026]
    assert.strictEqual(k('TSCP', 'The database migration is blocked waiting on firewall rules.'), 'blocker');
    assert.strictEqual(k('URGENT for Bill', 'Needs a Mongo instance.'), 'escalation');
    assert.strictEqual(k('Migration ticket needed by November 15: OFFNETACCESS', 'Asks for the ticket.'), 'date');
    assert.strictEqual(k('[JIRA] (SCPA-1) PRO 2', 'Amber status. Urgent matters go to Bill.'), undefined);
    assert.strictEqual(k('Automatic reply: Migration Sync', 'Away; urgent matters go to Robert.'), undefined);
    assert.strictEqual(k('Lunch', 'Are we still on for Friday?'), undefined);
    assert.strictEqual(k('Approval', 'Your access request was approved.'), undefined);
  });
  await test('watch: shows in state once per thread, only for info mail, and Seen removes it', () => {
    const f = path.join(process.env.AOS_USERDATA, 'mail.json');
    const db = JSON.parse(fs.readFileSync(f, 'utf8'));
    const now = Date.now();
    const at = (ms) => new Date(now - ms).toISOString().slice(0, 19);
    db.items.WATCH1 = { id: 'WATCH1', subject: 'Migration complete: ABC', from: 'Rose, Kyle', received: at(1000), summary: 'Migration of ABC is complete.', atoms: [], status: 'info' };
    db.items.WATCH2 = { id: 'WATCH2', subject: 'RE: Migration complete: ABC', from: 'Lee, Pat', received: at(5000), summary: 'Migration of ABC is complete, thanks.', atoms: [], status: 'info' };
    fs.writeFileSync(f, JSON.stringify(db));
    const w = M.state().watch.filter((e) => /ABC/.test(e.subject));
    assert.strictEqual(w.length, 1); // two messages, one thread
    assert.strictEqual(w[0].watch, 'complete');
    assert.ok(M.unwatch(w[0].id));
    assert.ok(!M.state().watch.some((e) => e.id === w[0].id));
  });

  await test('watch suggestions: each kind says what to do, and a finished mail against an open Jira item says to move it', () => {
    const w = (kind, jira) => M.suggestionOf({ jira }, kind);
    assert.match(w('complete', undefined), /Check Jira/);
    assert.match(w('complete', { confirmed: false }), /No matching CIPDBPE item/);
    assert.match(w('complete', { confirmed: true, key: 'CIPDBPE-1', status: 'Done' }), /already Done/);
    assert.match(w('complete', { confirmed: true, key: 'CIPDBPE-1', status: 'Implementing' }), /still "Implementing".*moving CIPDBPE-1/);
    assert.match(w('blocker'), /action item/);
    assert.match(w('date'), /commit/);
    assert.match(w('escalation'), /today/);
  });
  await test('jira check: a database name matching a CIPDBPE item confirms; no match is unconfirmed; twg unavailable records nothing', async () => {
    const asked = [];
    const q = async (jql) => { asked.push(jql); return /ACVSAUDIT/.test(jql) ? [{ key: 'CIPDBPE-8990', summary: 'SYSGEN787541246 | ACVSAUDIT', status: { name: 'Analyzing' }, url: 'u' }] : []; };
    const yes = await M.jiraCheck({ subject: 'RE: tickets', atoms: ['ACVSAUDIT', 'TASK123', 'Smith, Pat'] }, q);
    assert.strictEqual(yes.confirmed, true);
    assert.strictEqual(yes.key, 'CIPDBPE-8990');
    assert.ok(asked.every((j) => j.includes('project = CIPDBPE') && j.includes('Epic (Feature)'))); // the standing filter is never dropped
    assert.ok(!asked.some((j) => /TASK123|Smith/.test(j))); // ticket numbers and names are not searched as databases
    const no = await M.jiraCheck({ subject: 'RITM1 decommission complete', atoms: ['RITM1', 'azeus2vm1'] }, q);
    assert.strictEqual(no.confirmed, false);
    const sg = await M.jiraCheck({ subject: 'Done', summary: 'Migration of the pricing database (SYSGEN787449398) is complete.', atoms: [] }, async (jql) => (/SYSGEN787449398/.test(jql) ? [{ key: 'CIPDBPE-1', summary: 'SYSGEN787449398 | EIS_PRICING', status: { name: 'Done' } }] : []));
    assert.strictEqual(sg.confirmed, true); // matched on a SYSGEN found in the summary text, with no database name at all
    assert.strictEqual(sg.key, 'CIPDBPE-1');
    const down = await M.jiraCheck({ subject: 'x', atoms: ['ABCDEF'] }, async () => null);
    assert.strictEqual(down, null);
    const fromJira = await M.jiraCheck({ subject: '[JIRA] (CIPDBPE-8990) SYSGEN1 | ACVSAUDIT', atoms: [] }, async () => [{ key: 'CIPDBPE-8990', summary: 's', status: { name: 'Done' } }]);
    assert.strictEqual(fromJira.confirmed, true);
  });

  console.log(`\n${passed} passed`);
})();
