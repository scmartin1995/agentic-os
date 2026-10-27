# Agentic OS: how data is managed

> **v1.0 changes.** Nothing new is stored or sent. Window layout choices (chat width, side-panel width, whether the chat is hidden, light or dark)
> live in the window's local storage on this computer. Token usage is still written to `ledger.json` and `usage.json` as before; no screen shows it
> in v1 (the Tokens screen and meters are hidden until it is known how a gateway reports cost). The Value screen still reads the ledger.

What data exists, where it lives, who can read it, what leaves the computer, how long it is kept, how to remove it. Written from the code of
2026-10-06 (sources: `electron/*.cjs`). Companions: [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md).

**Principles as built:** (1) Agentic OS has no server and no account; everything it keeps is on the user's computer. (2) The only data sent
out is what the Claude engine sends to the connection the user chose. (3) Agentic OS does not collect analytics about its users. (4) The user's
notes stay in the notes folder; the assistant's own bookkeeping lives in a separate app-data folder. (5) Only secrets are encrypted.

---

## 1. Where things live

Two folders matter, plus the engine's own.

| Place | Default location | Owner |
|---|---|---|
| **App-data folder** ("userData") | Windows `%APPDATA%\Agentic OS` (roaming profile) · Mac `~/Library/Application Support/Agentic OS` | Agentic OS |
| **Notes folder** (the "vault") | `Documents\Agentic OS Notes` unless the user picks another | the user; Agentic OS reads it, the engine edits it |
| **Claude Code config folder** | Plan mode: the user's normal one (`~/.claude`). Key/gateway mode: `<app-data>/engine-home` | the Claude Code program |

Chromium also keeps its usual browser-profile files in the app-data folder (cache, local storage); the page stores four small UI flags
there (`aos-theme`, `aos-files`, `aos-wake`, `aos-muted`).

## 2. Inventory

Sensitivity: **H** can contain the user's confidential material or credentials · **M** reveals activity or content summaries · **L** settings or counters.

| Data | File / place | Contents | Written by | Read by | Encrypted | Sens. | Retention |
|---|---|---|---|---|---|---|---|
| Settings | `settings.json` | first name, notes-folder path, connection choice (address, model pins, gateway style/region/flags, certificate path), budgets, onboarded, wake word | `settings.cjs` | main | no | L | until changed or deleted |
| **Secrets** | `secrets.json` | `key:claude` (the key), `headers:claude` (extra gateway headers), legacy `discord:*` | `settings.setSecret` | main only; the page gets "saved" + last 4 characters | **yes** (OS safe storage: DPAPI / Keychain). Plain text if the OS cannot encrypt (SECURITY S-8) | **H** | until replaced, forgotten, or deleted |
| Saved chats | `chats/<id>.json` | what the chat panel showed: the user's messages, the assistant's replies, tool names and the note paths they touched (not tool inputs), file names of attachments (and, for dropped images, the image itself as a data string), approval cards and answers, the lists of notes read and edited, plus the engine session id | page via `chats:save` (throttled during work) | main, page | no | **H** | **until the user removes the chat** (× in the Chats list). Not pruned |
| Token ledger | `ledger.json` | one row per finished question: model, token counts, equivalent cost, skills used, seconds, chat id, reads/edits counts, error flag | `ledger.add` | main (panels) | no | M | 120 days |
| Ledger settings | `ledger-settings.json` | plan price, hourly rate, minutes saved per skill | Value panel | main | no | L | until changed |
| Charge meter | `usage.json` | plan windows (percent used, reset times, plan name), per-day spend (api mode) | `usage.cjs` | main | no | L | spend-per-day entries are **not pruned** |
| Background job log | `jobs.json` | last run time/result/note of Dreams and the lessons pass | `jobs.cjs` | main | no | L | latest only |
| Dreams | `dreams/<day>.json`, `dreams/feedback.json`, Dreams settings | per night: what was read (counts), four cards (dimension, headline, why, evidence, estimated saving, suggested action), status; feedback fingerprints (last 200 headlines) | `dreams.cjs` | main, page | no | M | day files **not pruned**; feedback capped at 200 |
| Connectors | `connectors.json`, `connectors-seen.json`, `connector-logos/` | load mode; names/status of connected apps; downloaded logo SVGs | `connectors.cjs` | main | no | L | logos refreshed; "miss" markers 30 days |
| Voice settings | `voice-settings.json` | speech speed | `voice.cjs` | main | no | L | until changed |
| **Backups** | `backups/<yyyy-mm-dd>/<time>__<path>` | **full copies of files and folders as they were before the model edited, overwrote or deleted them** | `policy.backup/backupAny` | the model is told the folder and can restore; the user | no | **H** | **30 days** (`pruneBackups` on launch) |
| **Attachments** | `attachments/<yyyy-mm-dd>/` | files dropped or pasted into the chat, copied here (25 MB cap each) | `attachments.save` | the engine reads them by path | no | **H** | **30 days** (`prune` on launch) |
| Engine config folder (key/gateway mode) | `engine-home/` | the Claude Code program's own state, including **session logs** `projects/<notes-folder slug>/*.jsonl`: every prompt, reply, and tool result (which includes file contents it read) | the Claude Code program | the engine; `history.cjs` (read-only) | no | **H** | **set by the Claude Code program, not Agentic OS** (it has its own cleanup setting; not verified here) |
| Engine config folder (plan mode) | `~/.claude/` (also holds the user's Claude login, settings and logs from all their Claude Code use) | same, plus the login | Claude Code | the engine; `history.cjs` reads only `projects/<notes-folder slug>` | Claude Code's own | **H** | Claude Code's own |
| Recovery log | `recovery.log` | timestamps and reasons the window fell back | `recovery.cjs` | developer | no | L | grows slowly; not pruned |
| Debug log | `aos-debug.log` in the **app folder**, only when `AOS_DEBUG` is set | test and capture traces | `main.cjs dlog` | developer | no | L | developer-controlled |
| The notes | the notes folder | the user's files | the user, and the engine's `Write/Edit` tools (after the gate) | everything | no | **H** | never touched by the assistant's pruning |
| Skills | `<notes>/skills/<name>/SKILL.md` | instructions (text) | the user, the lessons pass | the engine | no | M | user's |
| Test fixtures | temp folders under the OS temp dir | throwaway | tests | tests | no | — | deleted by the test |

## 3. What leaves the computer, and when

Everything below is sent by the **Claude Code program** to the model connection the user configured, unless stated.

**Every question** (`brain:send`):
- The **question text** and any attached file paths (the model then reads those files through its Read tool, so their contents are sent).
- The **standing instructions**, built once per session: the assistant's persona and method text; the user's first name if one was given; the
  backups folder path; the list of connected app names (Connectors); **every `index.md` page in the notes folder, up to 6000 characters
  each** (the "vault indexes").
- Per question, a short note when something changed: the folder last worked in and a listing of up to 60 names in it; names of notes
  edited outside Agentic OS; names of index pages that changed.
- **Tool results** of anything the model does: file contents it reads, command output, web pages it fetches, connector results. These stay
  in that session's history and are re-sent (cached) with later questions in the same chat.
- Helpers (subagents) get a brief written by the model, and their own tool results.

**Not sent:** the assistant's own bookkeeping files (ledger, chats list, settings), other chats' histories, the user's other files unless the model
reads them, the key beyond the connection it was issued for.

**Other outbound traffic (all listed in SECURITY.md section 5):** web fetch/search directed by the model; Dreams' weekly digest (see 4); connector
logos from `cdn.jsdelivr.net` (connector names only); the connect-screen checks (the key to the address typed, or to `api.anthropic.com`).

**Who holds it after it is sent** is outside Agentic OS: Anthropic (Anthropic API), or the organisation's gateway and its upstream (for the Bedrock
style, an AWS account). From AWS's documentation read on 2026-10-05: Bedrock model providers have no access to customer accounts, and logging of
prompts and replies is off unless the account owner turns it on. Neither point is confirmed for any particular organisation's setup; ask the
gateway's owner about logging, retention and where the data is processed.

## 4. Derived and local-only processing

- **Health / Value / token dashboard** are computed on the PC from the ledger, the engine's session logs and the notes folder. No model call.
- **History** (`history.cjs`) reads the engine's session logs for the current notes folder: prompts, which skills ran, connector tool-call
  names (names only, not contents). It reads both the default Claude Code folder and `engine-home`, so questions asked in the **same
  notes folder** with Claude Code outside Agentic OS also appear in Health, Value and Dreams.
- **Dreams** builds a digest locally (questions of the last week, repeated asks, costs, skills, notes vs chats, project status), then makes
  **one model call** to turn it into four cards. So the **text of recent questions leaves the PC** in that call. Cards whose evidence quotes
  numbers not in the digest are dropped. The web check is **off by default**; when on, the call may use web search. Runs nightly (2 am by
  default) or at the next launch if missed; the user can run or disable the schedule.
- **Voice**: wake word ("Hey computer") and push-to-talk record only while active; the audio goes to whisper.cpp **on the PC** (if installed) and
  nothing else; speech output uses Piper on the PC. Neither program is shipped.

## 5. How the notes folder is handled

- Agentic OS **reads** it (tree, link graph, file previews, skills and project lists) and **watches** it for changes (names of changed files only).
- Agentic OS itself **writes** to it in exactly one case: creating a starter folder during first-run setup (`Agentic OS Notes` with an index, a log, a
  rules page and the four starter skills). Every other change is made by the engine's tools.
- Before the engine **edits, overwrites or deletes** a file, Agentic OS copies the old version to `backups/` (outside the notes folder, so the
  copies do not clutter the map). Backups of folders are whole copies; very large or ambiguous deletes ask the user instead.
- Changes made to the notes by anything other than Agentic OS (the user, a sync tool, another program) are noticed and mentioned to the model
  with the next question, so it does not rely on stale knowledge.
- Notes are **not** encrypted or locked, and not exported or converted. A notes folder is plain files and can be read with any editor.
- Notes can contain instructions that the model may follow, and a notes folder can contain a plugin manifest and hooks that run code
  (SECURITY S-1). Treat a notes folder as trusted code and data.

## 6. Retention, deletion and the user's controls

| Want to | How | Effect |
|---|---|---|
| Delete one conversation | Chats list → × | removes `chats/<id>.json`; the engine's own session log for it stays (engine-home or `~/.claude`) |
| Forget the key | paste a new key, or switch the connection to "My Claude plan" | the saved secret is replaced; `providers.forgetKey` exists in code but is not shown in the current screens |
| Remove all of the assistant's data | quit Agentic OS, delete the app-data folder (`%APPDATA%\Agentic OS`, or `~/Library/Application Support/Agentic OS`) | removes settings, secrets, chats, ledger, backups, attachments, Dreams, engine-home (and with it the engine's session logs for key/gateway mode) |
| Remove the stored key from the OS | Mac: Keychain Access → item "Agentic OS Safe Storage"; Windows: removed with the app-data folder (the key file is encrypted to the user's account) | |
| Remove the engine's logs in plan mode | delete `~/.claude/projects/<notes-folder slug>` (this is Claude Code's folder, shared with the user's other Claude Code use) | Health/Value history for that folder resets |
| Stop Dreams from running or looking at the web | Dreams screen: schedule and "Worth a look" switch | no digest call; no web search |
| Keep connectors out | Connectors screen: "Never" | no connected app is ever loaded |
| Undo a model edit | copy the file from `backups/<day>/` (the model can do it if asked) | |

Automatic pruning: backups 30 days, attachments 30 days, ledger rows 120 days, connector "no logo" markers 30 days, Dreams feedback 200 entries.
**Never pruned automatically:** saved chats, Dreams day files, per-day spend in `usage.json`, `recovery.log`, the engine's logs (Claude Code's own
rules apply), the notes.

## 7. Where the data can be exposed

- **Cloud-synced folders.** The default notes folder is under Documents, which OneDrive or iCloud often sync; backups and chats are in the
  app-data folder, which on a managed Windows profile is the **roaming** folder (`%APPDATA%`) and can follow the user between machines.
- **Other programs and users on the same account** can read every plain file above; the OS file permissions of the user's profile are
  the only barrier. Other OS users cannot read them by default.
- **The key** is in the environment of the Claude Code program while it runs (a same-user process listing may show it).
- **Backups** contain complete earlier versions of deleted or overwritten files for 30 days, including ones the user meant to remove.
- **Screenshots and debug traces** made by developers can contain the user's first name and notes (tests use throwaway data).

## 8. Data model, briefly

```text
settings.json   { onboarded, userName, vaultPath,
                  provider:{ id:'claude', method:'subscription'|'key', baseUrl, models:{light,standard,strong}, keyHeader, price,
                             gateway:{ style, keyVar, skipAuth, region, disableBetas, certFile, extraEnv, modelOverrides } },
                  budgets:{ daily, monthly }, wakeWord }
secrets.json    { "key:claude": {enc|plain}, "headers:claude": {enc|plain}, "discord:*": ... }
chats/<id>.json { id, title, updated, busy, sessionId, read:[note paths], wrote:[note paths],
                  items:[ { role:'you'|'assistant'|'system'|'approval', text, files?:[{name,preview?}], tools?:[{name,label,path}],
                           helpers?, approval?:{id,risky,what?,answer?,asked?} } ] }
ledger.json     [ { t, model, asked, light, kind, skills:[], ms, chat, input, output, cacheRead, cacheWrite, total, fresh, cost, reads, edits, error } ]
usage.json      { planName, plan:{ five_hour:{used,resetsAt}, seven_day:{...} }, days:{ 'yyyy-mm-dd': usd } }
dreams/<day>.json { day, at, ms, reason, read:{...}, dims, dropped, web, cards:[ {id, dimension, headline, why, evidence, saves, action, status} ] }
backups/<day>/<hh-mm-ss>__<path with separators as '__'>      (a copy of the file, or a folder tree)
attachments/<day>/<time>__<sanitised name>
engine-home/    (the Claude Code program's own layout, including projects/<slug>/<session>.jsonl)
```

(Field lists are from the code and may gain fields; readers of old rows treat missing fields as unknown, not zero: see `ledger.cjs`.)

## 9. Gaps and questions to settle

1. **No at-rest encryption** for chats, backups, attachments and logs; a decision is needed if the notes are confidential (full-disk encryption
   is the assumed answer today).
2. **Retention is not uniform**: chats, Dreams and spend history grow forever; the engine's logs follow Claude Code's rules. Consider caps.
3. **Backups of sensitive deleted files** survive 30 days by design; a "remove now" option does not exist.
4. **Gateway-side logging and residency** are unknown and outside Agentic OS: get them in writing from the gateway's owner.
5. **Same-folder history mixing** (other Claude Code sessions in the notes folder show up in the assistant's panels and in Dreams' digest).
6. **Mac**: location, Keychain behaviour and sync exposure above are expected but unverified on a Mac.
