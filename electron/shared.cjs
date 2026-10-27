// State every brain (engine) shares: the yes/no cards waiting on an answer, "yes to all edits", and the list of
// vault files Agentic OS wrote itself (so the file watcher doesn't report its own edits as someone else's).
// In v1 this lived inside claude.cjs; v2 has several engines, and card ids must stay unique across them.
const pending = new Map(); // approval id -> { resolve(answer), chat }
let seq = 0;
let allowEdits = false;
const written = new Map(); // vault path -> time

// Put a yes/no card in front of the user and wait for the answer (or a question about it).
async function ask(emit, signal, chat, { tool, summary, what = '', spoken, risky = false, helper = false }) {
  const id = ++seq;
  // Register the waiting answer before the card goes out, so an instant answer can't slip past it.
  const answered = new Promise((resolve) => {
    pending.set(id, { resolve, chat: chat.id });
    signal?.addEventListener('abort', () => { pending.delete(id); resolve({ yes: false, question: '' }); });
  });
  emit({ type: 'approval', id, tool, summary, what, spoken: spoken || summary, risky, canAll: false, helper, chatTitle: chat.title });
  const { yes, question } = await answered;
  emit({ type: 'approved', id, yes, question });
  return { yes, question };
}

// `question`: the user wants to know more before deciding. The action is held back and Agentic OS answers;
// if it's still the right move it asks again with a fresh card.
function approve(id, yes, all = false, question = '') {
  if (yes && all) allowEdits = true;
  const r = pending.get(id);
  const answer = { yes: !!yes, question: !yes && question ? String(question).slice(0, 2000) : '' };
  if (r) { pending.delete(id); r.resolve(answer); }
  if (yes && all) for (const [pid, pr] of [...pending]) { pending.delete(pid); pr.resolve({ yes: true, question: '' }); }
  return !!r;
}

// Answer "no" to every card a chat is waiting on (or every chat's, with no id): used by Stop.
function cancel(chatId) {
  const all = chatId == null;
  for (const [id, r] of [...pending]) if (all || r.chat === chatId) { pending.delete(id); r.resolve({ yes: false, question: '' }); }
}

function setAllowEdits(v) { allowEdits = !!v; return allowEdits; }
const getAllowEdits = () => allowEdits;

// Also drops the kept answers about the notes folder (fresh.cjs): the app's own panels write notes through here, and the
// file watcher is told about them only after a delay.
function markWritten(rel) { written.set(rel, Date.now()); require('./fresh.cjs').drop(); }
// Did Agentic OS itself write this file in the last few seconds?
function wroteRecently(rel, ms = 8000) { const t = written.get(rel); return t != null && Date.now() - t < ms; }

module.exports = { ask, approve, cancel, setAllowEdits, getAllowEdits, markWritten, wroteRecently };
