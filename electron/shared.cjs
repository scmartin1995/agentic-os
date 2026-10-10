// State every brain (engine) shares: the yes/no cards waiting on an answer, and the list of vault files the assistant wrote
// themselves (so the file watcher doesn't report their own edits as someone else's).
// In v1 this lived inside claude.cjs; v2 has several engines, and card ids must stay unique across them.
// ("Yes to all edits" was removed 2026-10-07: edits are backed up instead of asked about, so only irreversible
// actions reach a card and each one asks.)
const pending = new Map(); // approval id -> { resolve(answer), chat }
let seq = 0;
const written = new Map(); // vault path -> time

// Put a yes/no card in front of the user and wait for the answer (or a question about it).
async function ask(emit, signal, chat, { tool, summary, what = '', spoken, risky = false, helper = false }) {
  const id = ++seq;
  // Register the waiting answer before the card goes out, so an instant answer can't slip past it.
  const answered = new Promise((resolve) => {
    pending.set(id, { resolve, chat: chat.id });
    signal?.addEventListener('abort', () => { pending.delete(id); resolve({ yes: false, question: '' }); });
  });
  emit({ type: 'approval', id, tool, summary, what, spoken: spoken || summary, risky, helper, chatTitle: chat.title });
  const { yes, question } = await answered;
  emit({ type: 'approved', id, yes, question });
  return { yes, question };
}

// `question`: the user wants to know more before deciding. The action is held back and the assistant answers;
// if it's still the right move they asks again with a fresh card.
function approve(id, yes, question = '') {
  const r = pending.get(id);
  const answer = { yes: !!yes, question: !yes && question ? String(question).slice(0, 2000) : '' };
  if (r) { pending.delete(id); r.resolve(answer); }
  return !!r;
}

// Answer "no" to every card a chat is waiting on (or every chat's, with no id): used by Stop.
function cancel(chatId) {
  const all = chatId == null;
  for (const [id, r] of [...pending]) if (all || r.chat === chatId) { pending.delete(id); r.resolve({ yes: false, question: '' }); }
}

function markWritten(rel) { written.set(rel, Date.now()); }
// Did the assistant themselves write this file in the last few seconds?
function wroteRecently(rel, ms = 8000) { const t = written.get(rel); return t != null && Date.now() - t < ms; }

module.exports = { ask, approve, cancel, markWritten, wroteRecently };
