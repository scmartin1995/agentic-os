// Discord link: the assistant can reach the user by DM when they're away from the PC.
//
// - Approvals: when the assistant asks yes/no and the user hasn't answered for a few minutes (or the PC has
//   been idle), the same card goes to their Discord DMs with Yes / No / Question buttons. Whichever
//   answer comes first wins; the other place is updated.
// - Chat: anything the user DMs the bot runs through the same claude.send(), same tools, same policy.cjs.
// - Only DISCORD_USER_ID is listened to. Everyone else, and every server channel, is ignored.
// - Cards show the plain-words reason (spoken + description), never the raw command.
//
// Setup is in the design notes Config (env or .env, gitignored):
//   DISCORD_BOT_TOKEN, DISCORD_USER_ID, optional DISCORD_DELAY_MIN (default 3).
const fs = require('fs');
const path = require('path');

const MAX = 1900; // Discord's limit is 2000
const IDLE_AWAY_S = 120; // PC idle this long = they're walked away, so don't wait
const RECENT_MS = 15 * 60 * 1000; // they're been chatting in Discord lately, so don't wait

function readConfig(dirs) {
  const cfg = { token: process.env.DISCORD_BOT_TOKEN, userId: process.env.DISCORD_USER_ID, delayMin: process.env.DISCORD_DELAY_MIN };
  for (const dir of dirs) {
    const f = path.join(dir, '.env');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(DISCORD_BOT_TOKEN|DISCORD_USER_ID|DISCORD_DELAY_MIN)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const key = { DISCORD_BOT_TOKEN: 'token', DISCORD_USER_ID: 'userId', DISCORD_DELAY_MIN: 'delayMin' }[m[1]];
      const val = m[2].replace(/^["']|["']$/g, '');
      if (val && !cfg[key]) cfg[key] = val;
    }
  }
  try { const s = require('./settings.cjs'); if (!cfg.token) cfg.token = s.getSecret('discord:token'); if (!cfg.userId) cfg.userId = s.getSecret('discord:userId'); } catch { /* run outside Electron (tests): .env only */ }
  const delay = Number(cfg.delayMin);
  return { token: (cfg.token || '').trim(), userId: (cfg.userId || '').trim(), delayMs: (delay >= 0 && cfg.delayMin !== undefined && cfg.delayMin !== '' ? delay : 3) * 60000 };
}

const clip = (t, n = MAX) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
function chunks(t) {
  const out = [];
  for (let s = String(t).trim(); s.length; ) {
    if (s.length <= MAX) { out.push(s); break; }
    let cut = s.lastIndexOf('\n', MAX);
    if (cut < MAX / 2) cut = s.lastIndexOf(' ', MAX);
    if (cut < MAX / 2) cut = MAX;
    out.push(s.slice(0, cut).trim());
    s = s.slice(cut).trim();
  }
  return out;
}

const button = (label, style, id) => ({ type: 2, style, label, custom_id: id });
const row = (...b) => [{ type: 1, components: b }];
const NO_PING = { parse: [] };

// The logic, kept apart from discord.js and Electron so tests can drive it with a fake client.
function createBridge({ client, userId, approve, stop, run, idleSeconds = () => 0, delayMs = 180000, now = Date.now, log = () => {} }) {
  const waiting = new Map(); // approval id -> { timer, evt, msg, text }
  // Several chats can run at once, so what each is saying is tracked apart (events carry evt.chat).
  const states = new Map();
  const stateFor = (chat) => { const k = chat == null ? '' : chat; if (!states.has(k)) states.set(k, { reply: '', answerNext: false, origin: 'app' }); return states.get(k); };
  let lastTouch = 0; // last time the user did anything in Discord

  async function dm(payload) {
    const user = await client.users.fetch(userId);
    return user.send({ allowedMentions: NO_PING, ...(typeof payload === 'string' ? { content: payload } : payload) });
  }
  async function dmText(text) { for (const c of chunks(text)) await dm(c); }
  const safe = (p) => p.catch((e) => log('discord send failed:', e && e.message ? e.message : e));

  // A short plain-English card: what they wants to do, in plain words, and why. Never the raw command.
  function cardText(evt) {
    const cap = (s) => { s = String(s || '').trim(); return s ? s[0].toUpperCase() + s.slice(1) : s; };
    // request_model puts its reason after the first colon of the summary; everything else brings its own description
    const detail = evt.tool === 'request_model' ? String(evt.summary || '').replace(/^[^:]*:\s*/, '') : String(evt.what || '').trim();
    let t = `🦴 Need a yes/no, boss.${evt.chatTitle ? `\n**Chat:** ${clip(String(evt.chatTitle), 80)}` : ''}\n**Wants to:** ${cap(evt.spoken || evt.summary)}${evt.helper ? ' (one of my helpers)' : ''}`;
    t += detail ? `\n**In plain words:** ${cap(detail).replace(/\s*\n\s*/g, ' ')}` : `\n_No more detail from me. Tap Question if you want it._`;
    if (evt.risky) t += `\n⚠️ Hard to undo.`;
    return clip(t);
  }

  async function sendCard(id) {
    const w = waiting.get(id);
    if (!w || w.msg) return;
    w.text = cardText(w.evt);
    w.msg = true; // claim it so a second timer can't double-send
    try {
      w.msg = await dm({ content: w.text, components: row(button('Yes', 3, `aos:${id}:yes`), button('No', 4, `aos:${id}:no`), button('Question', 2, `aos:${id}:ask`)) });
    } catch (e) { log('discord card failed:', e && e.message ? e.message : e); w.msg = null; }
  }

  // Every event from claude.send() comes through here. origin: 'app' (typed or spoken at the PC) or 'discord'.
  function observe(evt, origin = 'app') {
    if (!evt) return;
    const current = stateFor(evt.chat);
    // Discord only gets: approval cards, replies to what they sends by DM, and answers to a Question they asked.
    // Never progress notes: `current.reply` is just the text since the assistant's last tool call (their commentary
    // between steps is dropped), so a finished chat reply is only their final message.
    if (evt.type === 'start') Object.assign(current, { reply: '', answerNext: false, origin });
    else if (evt.type === 'text') current.reply += evt.text;
    else if (evt.type === 'tool') {
      if (current.answerNext && current.reply.trim()) { safe(dmText(current.reply.trim())); current.answerNext = false; }
      current.reply = '';
    } else if (evt.type === 'approval') {
      const away = origin === 'discord' || now() - lastTouch < RECENT_MS || idleSeconds() >= IDLE_AWAY_S;
      const w = { evt, msg: null, text: '', timer: null };
      w.timer = setTimeout(() => safe(sendCard(evt.id)), away ? 0 : delayMs);
      waiting.set(evt.id, w);
    } else if (evt.type === 'approved') {
      const w = waiting.get(evt.id);
      if (!w) return; // already answered from Discord
      waiting.delete(evt.id);
      clearTimeout(w.timer);
      if (w.msg && w.msg.edit) safe(w.msg.edit({ content: `${w.text}\n\n_Answered at the PC: ${evt.question ? 'asked a question' : evt.yes ? 'yes' : 'no'}._`, components: [], allowedMentions: NO_PING }));
    } else if (evt.type === 'error') {
      if (origin === 'discord') safe(dmText(`⚠️ ${evt.message}`)); // they messaged the assistant and needs to know why there's no answer
    } else if (evt.type === 'done') {
      const reply = current.reply.trim();
      if ((current.origin === 'discord' || current.answerNext) && reply) safe(dmText(reply));
      Object.assign(current, { reply: '', answerNext: false, origin: 'app' });
    }
  }

  function take(id) { // remove a card from "waiting" so the desktop's 'approved' event doesn't edit it twice
    const w = waiting.get(id);
    if (w) { waiting.delete(id); clearTimeout(w.timer); }
    return w;
  }

  async function onInteraction(i) {
    try {
      if (i.user.id !== userId) { if (i.reply) await i.reply({ content: 'Not for you.', ephemeral: true }); return; }
      lastTouch = now();
      const m = /^aos:(\d+):(yes|yes2|no|ask|q)$/.exec(i.customId || '');
      if (!m) return;
      const id = Number(m[1]);
      const act = m[2];
      const w = waiting.get(id);
      if (!w) { await i.update({ content: 'That one was already answered.', components: [] }); return; }
      const base = w.text || cardText(w.evt);
      if (act === 'yes' && w.evt.risky) {
        await i.update({ content: `${base}\n\nThis one is hard to undo. Sure?`, components: row(button('Yes, do it', 4, `aos:${id}:yes2`), button('Cancel', 2, `aos:${id}:no`)) });
      } else if (act === 'yes' || act === 'yes2') {
        take(id); approve(id, true);
        await i.update({ content: `${base}\n\n✅ Approved.`, components: [] });
      } else if (act === 'no') {
        take(id); approve(id, false);
        await i.update({ content: `${base}\n\n❌ Said no.`, components: [] });
      } else if (act === 'ask') {
        await i.showModal({ custom_id: `aos:${id}:q`, title: 'Ask a question first', components: [{ type: 1, components: [{ type: 4, custom_id: 'q', label: 'What do you want to know?', style: 2, required: true, max_length: 500 }] }] });
      } else if (act === 'q') {
        const q = String(i.fields.getTextInputValue('q') || '').trim().slice(0, 500);
        take(id); approve(id, false, q);
        stateFor(w.evt.chat).answerNext = true; // they asked, so the assistant's answer comes back here (and only that)
        await i.update({ content: `${base}\n\n❓ Held back. You asked: ${q}`, components: [] });
      }
    } catch (e) { log('discord interaction failed:', e && e.message ? e.message : e); }
  }

  async function onMessage(m) {
    try {
      if (m.author.bot || m.guild || m.author.id !== userId) return; // DMs from the user only
      const text = String(m.content || '').trim();
      if (!text) return;
      lastTouch = now();
      if (/^(stop|cancel)$/i.test(text)) { stop(); await m.reply({ content: 'Stopping.', allowedMentions: NO_PING }); return; }
      if (m.channel && m.channel.sendTyping) m.channel.sendTyping().catch(() => {});
      await run(text, (evt) => observe(evt, 'discord'));
    } catch (e) { log('discord message failed:', e && e.message ? e.message : e); }
  }

  return { observe, onInteraction, onMessage, waiting };
}

// The real thing: discord.js + Electron. Returns null (and logs why) if it isn't set up.
let bridge = null;
function observe(evt, origin) { if (bridge) bridge.observe(evt, origin); }

function start({ claude, run, dirs, log = () => {} }) {
  const cfg = readConfig(dirs);
  if (!cfg.token || !cfg.userId) { log('discord: not configured (DISCORD_BOT_TOKEN / DISCORD_USER_ID), skipping'); return null; }
  try {
    const { Client, GatewayIntentBits, Partials } = require('discord.js');
    const { powerMonitor } = require('electron');
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages], partials: [Partials.Channel, Partials.Message] });
    bridge = createBridge({
      client, userId: cfg.userId, delayMs: cfg.delayMs, log,
      approve: (...a) => claude.approve(...a), stop: () => claude.stop(), run,
      idleSeconds: () => powerMonitor.getSystemIdleTime(),
    });
    client.on('interactionCreate', (i) => bridge.onInteraction(i));
    client.on('messageCreate', (m) => bridge.onMessage(m));
    client.on('error', (e) => log('discord error:', e && e.message ? e.message : e));
    client.once('clientReady', () => log('discord: connected as', client.user && client.user.tag));
    client.login(cfg.token).catch((e) => log('discord login failed:', e && e.message ? e.message : e));
    return client;
  } catch (e) {
    log('discord: could not start:', e && e.message ? e.message : e);
    return null;
  }
}

module.exports = { start, observe, createBridge, readConfig, chunks };
