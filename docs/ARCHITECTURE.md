# Agentic OS: architecture, for reviewing code and fixing bugs

> **v1.0 changes (read these first; the rest of this file describes the code as it stood before them).**
> - **Layout and look:** the window is now a side list (`Nav.tsx` `Rail`), the chat, and a right-hand column (`.stage`). The look is
>   `src/styles/paper.css`, loaded last; colour tokens (light and dark) are at the top of `shell.css`. `colors.ts` hands each project
>   its own colour. `Ring.tsx` draws the home map on a hex-line background.
> - **Projects:** `vault.cjs projects()` now also returns `deliverables` (the project's `output/` files, newest first, with title and
>   description from each note's header) and `working`. `Projects.tsx` shows tiles and flat lists; there is no file tree and `Files.tsx`
>   is no longer used.
> - **New IPC channel:** `vault:reveal` (`main.cjs`, `aos.ts`): selects a path in File Explorer or Finder, only inside the notes folder.
> - **Taken out of the screens, code left in place and unused:** voice (`listen.ts`, `audio.ts`, `voice.cjs`, `stt.cjs`, the mic, wake word and
>   speaking-speed UI; the window tells the app to stay muted), and the usage meters (`Charge.tsx`, `Dashboard.tsx`, `usage:` IPC, the spending
>   budget). The ledger (`ledger.cjs`) still records every question for Value, Health and Dreams. Setup is three steps (no voice step).
> - **Layout state kept in the window's localStorage:** `aos-col`, `aos-aside`, `aos-chat-min`, `aos-theme` (light unless set to dark).

Written for a language model (or a person) who has been handed this repository cold and has to find and fix a problem without
guessing. It describes what is in the code today, says where each behaviour lives, lists the rules that must not be broken, and
maps symptoms to files. Two companion documents: [SECURITY.md](SECURITY.md) (infrastructure and trust map) and
[DATA.md](DATA.md) (what data exists, where it goes, how long it lives).

How to use it: read sections 1 to 4 once; then jump to the module table (section 5), the symptom table (section 13) or the
invariants (section 12). Facts here were checked against the code on 2026-10-06; where something was **not** verified, it says so.

---

## 1. What Agentic OS is

A desktop app (Electron, Windows today, Mac prepared) that is a window around the **Claude Code engine** (the Claude Agent SDK).
The user chats with Claude, which can read and edit a **notes folder** (the "vault") with the engine's own tools. Around the chat
sit: a 3D map of the notes, a file viewer, a Projects list, Skills (instructions stored in the vault), Dreams (a nightly "things worth
doing" pass), Health and Value panels, a token dashboard, Connectors, and Settings.

Agentic OS has **no server, no account and no listening network port** of its own. Everything it keeps is in the user's app-data folder
and in the notes folder. The only network traffic is what the Claude engine sends to the connection the user configured (Anthropic,
or the organisation's gateway in Anthropic's API format), plus a few small, listed exceptions (see SECURITY.md).

Not a goal: any AI other than Claude (removed), a phone link (removed), Discord (stand-in only), Mac packaging done by hand.

## 2. Repository map

```
electron/            main process (Node). Every file here is CommonJS (.cjs)
  main.cjs           entry: window, IPC handlers, protocols, startup sequence, capture/test hooks
  preload.cjs        the only bridge from the page to the main process (contextBridge: window.aosBridge)
  api.cjs            handle() registers IPC handlers; broadcast() sends events to the window
  engine.cjs         thin facade over claude.cjs (one set of calls for main.cjs)
  claude.cjs         THE ENGINE: chats, model choice, prompts, tools, helpers, approvals, events, auth environment
  providers.cjs      connection settings: test, save, import from Claude Code settings, sign-in status
  gateway.cjs        gateway rules: reading ~/.claude/settings.json, the engine's environment, plain error text
  platform.cjs       everything that differs Windows vs Mac (engine program path, sign-in window, menu, voice program names)
  policy.cjs         the SAFETY GATE: what asks the user, what runs, what is backed up first
  shared.cjs         approval cards waiting for an answer, "yes to all edits", files Agentic OS wrote itself
  settings.cjs       settings.json and secrets.json (safeStorage), .env override reading
  vault.cjs          notes folder: tree, link graph, file read, skills list, projects list, file watcher, path guard
  fresh.cjs          answers about the notes folder (tree, graph, projects, action items) kept until the folder changes
  chats.cjs          saved conversations (one JSON file each)
  ledger.cjs         token ledger (one row per finished question) and Value settings
  usage.cjs          charge meter data (plan windows or spend against budget)
  history.cjs        reads Claude Code's own session logs for the vault (questions, skills used, connector use)
  insights.cjs       numbers for the Health and Value panels (computed locally)
  dreams.cjs         the nightly "Dreams" pass (one model call, no tools unless the web check is on)
  connectors.cjs     the Connectors panel (what is connected, how often used, logos)
  attachments.cjs    files dropped or pasted into the chat
  jobs.cjs           last run of Dreams and the lessons pass (jobs.json)
  recovery.cjs/.html keeps the window from ever sitting black (falls back to dist-prev or a waiting page)
  window.cjs         lets the model move/resize the assistant's own window (the "window" tool)
  voice.cjs, stt.cjs optional local text-to-speech (Piper) and speech-to-text (whisper.cpp); not shipped
  paths.cjs          where the optional voice tools live
  discord.cjs, import-v1.cjs   STAND-INS that do nothing (callers in main.cjs stay simple). Dead code on purpose.
src/                 renderer (the page): React 19 + TypeScript, built by Vite into dist/
  main.tsx           mounts <App/>, applies the theme before first paint, error boundary
  App.tsx            the whole window: chat state store, brain event handling, panels, title bar, voice, shortcuts
  aos.ts             builds window.aos (typed wrapper over the bridge); exports quiet and os
  types.ts           shared types, incl. ClaudeEvent (the event stream) and ProvidersState
  components/        Chat, Viewer, Files, Ring, Projects, Skills, Dreams, Health, Value, Dashboard, Connectors,
                     Settings, BrainSetup (connect screen), Onboarding, Palette (Ctrl/Cmd+K), Orb, Charge, Nav, WindowButtons
  styles/panels.css, shell.css   shell.css loads LAST; its final blocks are overrides with !important (see 12)
  listen.ts, audio.ts            microphone / wake word / push-to-talk; audio playback (voice is optional)
starter/             a starter notes folder: .claude-plugin/plugin.json + skills/ (learn, lessons-review, skill-tidy, model-selection)
public/              icons, connector logos
build/icon.png       app icon (made by tools/make-icon.cjs)
tools/               build.cjs, login.cjs, make-icon.cjs, and the test scripts (section 11)
docs/                this file, SECURITY.md, DATA.md
.github/workflows/mac.yml   build+test on real Macs (only runs once the project is in a GitHub repo)
start-mac.sh         runs the app from source on a Mac
```

## 3. Process model

A picture of the same layout, with trust boundaries and the network, is in `docs/img/architecture.png` (see SECURITY.md section 2).

```
                    ┌────────────────────────── Electron main process (Node) ──────────────────────────┐
 user ── window ──► │ main.cjs  ── api.cjs ── IPC handlers ──► vault / settings / providers / engine ...  │
                    │    │                                              │                                 │
   renderer page    │    └── protocols vault:// and models:// (file reads, guarded)                       │
   (sandboxed)  ◄───┤                                              ▼                                     │
   React app        │                          claude.cjs ──► @anthropic-ai/claude-agent-sdk             │
   window.aos       │                                              │ spawns                              │
                    └──────────────────────────────────────────────┼─────────────────────────────────────┘
                                                                   ▼
                                    Claude Code program (claude / claude.exe, from node_modules)
                                    runs tools, talks to the model connection (Anthropic or the gateway)
```

- **Main process** owns all files, secrets, network checks and the engine. **The page has no Node.** It is created with
  `contextIsolation: true, nodeIntegration: false, sandbox: true`, a Content-Security-Policy in `index.html`, and `frame: false`
  (the app draws its own title bar and window buttons).
- **Bridge:** `preload.cjs` exposes `window.aosBridge = { kind, os, quiet, invoke(channel, ...args), on(channel, fn) }`. Channel
  names must match `^[a-z]+:[A-Za-z0-9]+$`. `src/aos.ts` wraps it as `window.aos.<area>.<call>()`. There is **one list of IPC
  handlers**: the `h('area:action', ...)` calls in `main.cjs` (section 6).
- **Events** flow main to page with `api.broadcast(channel, payload)` (e.g. `brain:event`, `vault:changed`, `dreams:event`,
  `window:state`).
- **Engine process:** the SDK starts the Claude Code program as a child process per query. Agentic OS passes the exact program path
  (`platform.claudeExe()`), so a packaged app (where the program sits in `app.asar.unpacked`) works.

## 4. Life of a question (the most important flow)

1. The user types in `Chat.tsx`; `App.tsx` calls `window.aos.brain.send(text, speak, files, chatId)` (`aos.ts` → `brain:send`).
2. `main.cjs` `brain:send` calls `engine.send(chatId, text, emit, files)`. Every event the engine emits is passed through
   `recordUsage()` (ledger and charge meter) and `api.broadcast('brain:event', {chat, ...evt})`.
3. `claude.cjs send()`:
   - one state object per chat (`chatFor(id)`): session id, abort controller, step-up model, loaded connectors, helper budget,
     standing instructions snapshot, what the model was last told. Max `AOS_MAX_CHATS` (default 3) run at once.
   - idle for 30 minutes → fresh conversation (history stops riding along).
   - **Model choice** `pickModel()`: forced by `AOS_MODEL`; else a granted step-up (4 turns); else "yes/ok" keeps the last model; else
     a short lookup question starts on Haiku, anything else Sonnet; a chat never moves up by itself (the model asks with
     `request_model`; the user answers yes/no).
   - **Model name given to the engine** `engineModel()`: with a key/plan, the exact version (e.g. `claude-sonnet-5-5`); through a
     **gateway** the plain names `haiku` / `sonnet` / `opus`, so the model names pinned in Settings apply (see 8). A tier with nothing
     pinned falls back to `sonnet`.
   - **Standing instructions** `systemAppend()` (persona + method + backups folder + connector note + every vault `index.md`, 6000
     chars each) are built **once per session** and then reused unchanged so the engine's prompt cache stays valid. Anything that
     changes mid-chat (folder last used, notes edited elsewhere, stale index pages) goes in as `questionContext()` through a
     `UserPromptSubmit` hook instead. Changing `systemAppend` mid-session is a cost bug (whole chat re-read at full price).
   - builds the in-process MCP server `aos` with tools `window`, `open_file`, `use_connectors`, `request_model`, `request_helpers`.
   - calls `query({ prompt, options })` with: `cwd: vault.ROOT`, `pathToClaudeCodeExecutable`, `model: engineModel(model)`,
     `resume` (session id), `systemPrompt: claude_code preset + append`, `allowedTools` (`Read, Grep, Glob, WebSearch, WebFetch, TodoWrite` and the five `mcp__aos__*` tools; **these skip the
     gate entirely**, including the two web tools), `canUseTool` (the gate), `hooks` (UserPromptSubmit context; PreToolUse gate for the Agent tool), `agents: helperDefs()`,
     `plugins: [{type:'local', path: vault.ROOT}]` and `skills:'all'` (the vault is a plugin named `aos`), `settingSources: []`
     (no user/project settings files are read), `settings: engineSettings(...)`, `env: authEnv()`,
     `additionalDirectories: [backups, attachments]`, `permissionMode: 'default'`.
4. **Every tool call not in `allowedTools`** (Bash, PowerShell, Write, Edit, MultiEdit, NotebookEdit, any connector tool, Agent) goes
   through `canUseTool` → `policy.check(tool, input)`:
   - ordinary edits/deletes/overwrites run unasked; the old file is copied to the backup folder first (`policy.backup`/`backupAny`).
   - catastrophic things (format a disk, throw away git work, delete registry/accounts, send data off the PC by command, publish/delete
     online, `rm -rf /`, `sudo`, `diskutil erase`, system folders...) return `ask: true`. `shared.ask()` emits an `approval` event; the
     page shows a card (Yes / No / Ask first). The call waits. A yes runs it; a no tells the model to drop it and not try another
     way; "ask first" holds the action and passes the user's question to the model.
5. Stream: `text`, `tool` (with the vault path touched, which lights the graph), `helper`, `approval`/`approved`, `session`,
   `limits`, `error`, `note`, `open` (open a file in the viewer), `result` (tokens and cost), `done`.
6. After `result`: `recordUsage` adds a ledger row; in "api" mode the spend is added to the charge meter; plan windows come from
   `limits` events.
7. Carry-on: `use_connectors` or an approved `request_model` end the turn and `send()` is called again by itself (`resumed`) with a
   short bracketed note. Every 10th question a quiet background "lessons pass" runs (`AUTO_WRAP_EVERY`); it is dropped if the user
   asks something.

Event types (see `ClaudeEvent` in `src/types.ts`): `start, text, tool, helper, result, limits, audio, approval, autoApproved, approved,
session, error, note, open, done`, plus `brainChanged` from settings changes.

## 5. Module reference (main process)

| Module | Responsibility | State it owns / files it touches | Called by |
|---|---|---|---|
| `main.cjs` | window creation (`createWindow`), all IPC handlers, `vault://` and `models://` protocols, mic permission, startup, capture/test hooks (`capture()`) | `userData` path override (`AOS_USERDATA`) | Electron |
| `claude.cjs` | the engine: see section 4; `authEnv()`, `gatewayCfg()`, `engineSettings()`, `engineModel()`, `helperDefs()`, `engineHome()`; `oneShot()` (Dreams), `account()` (sign-in status), `refreshStartup()`/`refreshConnectors()` (plan limits and connector discovery, no tokens) | in-memory `chats` map; `userData/engine-home/` | `engine.cjs`, `dreams.cjs`, `providers.cjs` |
| `providers.cjs` | catalog (one entry: Claude); `state()` for the window (never the key); `test()`/`testGateway()` (probe the address/key); `save()`; `importSettings()`/`applyImport()`; `cliStatus()`, `openLogin()`, `active()` | `settings.provider`, secrets `key:claude`, `headers:claude` | `main.cjs`, `claude.cjs` |
| `gateway.cjs` | `readClaudeSettings()` (read-only), `describeImport()` (what the window may see), `applyToEnv()` (engine env for a gateway), `ROUTING_VARS` (scrubbed from the engine env), `EXTRA_ENV` (allowlist), `friendlyError()` | none (pure) | `providers.cjs`, `claude.cjs` |
| `platform.cjs` | `claudeExe`, `loginSpawn`, `piperName`, `whisperPath`, `menuTemplate`; all take the platform as an argument for testing | none (pure) | many |
| `policy.cjs` | `check()`, `backup()`, `backupAny()`, `moveToBackup()` (a folder the app is discarding: one rename into the backups, not a copy), `pruneBackups()` / `pruneBackupsSoon()` (the same, removing a day at a time); `_setPlatform()` (tests only) | `userData/backups/<day>/` | `claude.cjs`, `workers.cjs`, `main.cjs` |
| `shared.cjs` | pending approval cards; `allowEdits`; `markWritten/wroteRecently` (`markWritten` also drops `fresh.cjs`' kept answers) | in memory | `claude.cjs`, `main.cjs` |
| `fresh.cjs` | `get(name, make)`, `drop()`: the tree, link graph, note count, projects and action items are worked out once after a change and handed to every caller; dropped on a watcher event, an app write, a panel correction, or after 60 s | in memory | `main.cjs`, `vault.cjs`, `shared.cjs` |
| `settings.cjs` | `get/set`, `getSecret/setSecret/hint`, `envOr` | `userData/settings.json`, `secrets.json` | everywhere |
| `vault.cjs` | `resolveInside` (the path guard), `tree`, `graph`, `read`, `skills`, `projects`, `watch`, `setRoot` | the notes folder (read-only here; edits are made by the engine) | `main.cjs`, `claude.cjs` |
| `chats.cjs` | list/load/save/remove saved chats | `userData/chats/<id>.json` | `main.cjs` |
| `ledger.cjs` | `add()` one row per question, `summary()`, `migrate()`, plan price / hourly rate / skill minutes | `ledger.json` (120-day keep), `ledger-settings.json` | `main.cjs`, `insights.cjs` |
| `usage.cjs` | plan windows and budgets | `usage.json` | `main.cjs` |
| `history.cjs` | parse Claude Code session logs: prompts, skills, connector calls | reads `<config dir>/projects/<vault slug>/*.jsonl` (default `~/.claude`, and the assistant's `engine-home`) | `insights`, `dreams`, `connectors` |
| `insights.cjs` | Health and Value numbers | none | `main.cjs` |
| `dreams.cjs` | nightly pass: digest → one model call → 4 cards | `userData/dreams/<day>.json`, `dreams/feedback.json`, settings | `main.cjs` |
| `connectors.cjs` | Connectors panel data | `connectors.json` (mode), `connectors-seen.json`, `connector-logos/` | `main.cjs` |
| `attachments.cjs` | save dropped files (25 MB cap), `isMine()`, `prune()` (30 days; async, a day at a time) | `userData/attachments/<day>/` | `main.cjs` |
| `recovery.cjs` | window never black | `userData/recovery.log` | `main.cjs` |

## 6. IPC channel catalog (the whole attack and test surface between page and main)

`window:` state minimize maximize close · `vault:` info tree graph read skills projects openExternal · `usage:` get ledger setPlanPrice
· `connectors:` summary refresh logo setMode · `insights:` health value setHourlyRate setSkillMinutes · `dreams:` state run mark
setSettings · `stt:` status transcribe · `voice:` status mute settings setSpeed preview · `attach:` save · `brain:` status send stop
openChat approve allowEdits · `chats:` list load save remove · `setup:` get set pickFolder starterVault voice (+ `v1`, `importV1`
stand-ins) · `providers:` state test save importSettings applyImport forgetKey cliStatus openLogin openKeyPage · `discord:` get set
clear (dead; stand-ins behind them) · `debug:fakeMic` (sync; returns audio only in a test capture).

Rules: a new feature adds an `h(...)` in `main.cjs` **and** a wrapper in `src/aos.ts` (+ types). Handlers must validate their input
(the page is trusted, but see SECURITY.md); paths go through `vault.resolveInside`.

## 7. The notes folder (vault) and the map

- `vault.ROOT` is a live getter (`AOS_VAULT` env, else the saved `vaultPath`, else `Documents/Agentic OS Notes`). `setRoot` moves the
  watcher with it. `resolveInside(rel)` is the **only** path guard: `path.resolve(ROOT, rel)` must equal ROOT or start with
  `ROOT + sep`. It does not resolve symlinks (see SECURITY.md).
- Hidden entries (names starting with `.`) and `.obsidian .git node_modules .trash` are skipped everywhere.
- `graph()` = every `.md` file as a node (`group` = first folder), links from `[text](relative.md)` and `[[wikilinks]]` (matched by file
  name); cached per note by mtime+size. Folders whose README has `received: true` are flagged read-only "received material".
- `read(rel)` returns text for md/text/csv/html up to 2 MB, else kind+size. `vault://files/<path>` serves files to images/iframes.
- Watcher: `fs.watch(recursive)`, reported 600 ms after the last change in a burst but never more than 3 s after the first (a steady
  trickle used to push the report back each time); a `change` only counts if mtime moved (Windows lazily updates access time). Each
  change also drops `fresh.cjs`' kept answers. The folder path must be the long form: libuv aborts the process on a Windows 8.3 short name.
  Edits not made by Agentic OS (`shared.wroteRecently`) are passed to the model with its next question.
- `projects()` keeps each note's header until the note's modified time changes (`headOf`), as `graph()` does for links.
- Housekeeping (backups 30 days, worker scratch folders a week, attachments 30 days) runs 15 s after the window is up, not before it,
  and not in test captures. Old scratch folders are moved into the backups folder, not copied.
- Skills = `skills/<name>/SKILL.md` with frontmatter; the same folder is loaded by the engine as the plugin `aos` (needs
  `.claude-plugin/plugin.json`, which `starter/` provides). A skill folder dropped in appears on the Skills screen and in the engine.

## 8. Connection modes (the area most likely to need fixes)

Settings > Brain. Saved in `settings.provider`: `{ id:'claude', method:'subscription'|'key', baseUrl, models:{light,standard,strong}, keyHeader, gateway:{ disableBetas, certFile } }`. Secrets: `key:claude`, `headers:claude`.

| Mode | When | Engine environment (`claude.authEnv()`) |
|---|---|---|
| Claude plan | `method:'subscription'` | normal config folder (the user's Claude login); routing variables scrubbed; `mode()` = `plan`; plan windows via `limits` |
| Anthropic key | `method:'key'`, no address | `ANTHROPIC_API_KEY`; `CLAUDE_CONFIG_DIR` = the assistant's empty `engine-home`; `mode()` = `api` |
| Gateway (Anthropic API format) | `method:'key'` + address | `ANTHROPIC_BASE_URL`, key as `ANTHROPIC_AUTH_TOKEN` (bearer) or `ANTHROPIC_API_KEY` (`x-api-key`) chosen by the probe, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, model pins, headers, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, `NODE_EXTRA_CA_CERTS`; empty `engine-home` |

Always (every mode): `DISABLE_AUTOUPDATER, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, DISABLE_TELEMETRY, DISABLE_ERROR_REPORTING,
DISABLE_FEEDBACK_COMMAND, CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY, CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL`; settings
`skipWebFetchPreflight: true`.

Facts established by running the real engine against a stand-in gateway (`tools/test-wire.cjs`), keep them true:
1. With a Claude login on the machine, the engine sends **that login's token** to an Anthropic-format gateway instead of the gateway
   key. Hence `CLAUDE_CONFIG_DIR` = `engine-home` whenever a key or gateway is used.
2. Asking for an exact version (`claude-sonnet-5-5`) ignores the model names pinned via `ANTHROPIC_DEFAULT_*_MODEL`. Hence
   `engineModel()` hands over `haiku|sonnet|opus`.
3. Settings `skipWebFetchPreflight` stops a web fetch from first calling Anthropic.

Connect-screen checks (`providers.test`/`testGateway`): use Chromium's network stack (`net.fetch`) so the PC's certificates and proxy
apply; they try `GET /v1/models` with bearer then `x-api-key`, falling back to a one-token `POST /v1/messages`. Outcomes are one of: unreachable, cert, refused, shape, notGateway, other
(`gateway.TEXT` holds the user-facing wording; `friendlyError()` maps engine errors to the same words).

Import: `providers.importSettings()` reads `~/.claude/settings.json` (never writes), keeps secrets in main-process memory
(`pendingImport`), returns only a description; `applyImport()` saves after the user confirms.

## 9. Safety gate details (`policy.cjs`)

- `check(tool, input)` returns `{ask, risky, summary, spoken, backups}`. Edits/writes ask only for system folders (Windows system
  folders and a Mac's `/System /Library /usr /bin /sbin /etc /applications ...`).
- Shell commands (`Bash`/`PowerShell`): a list of catastrophic patterns asks; deletes (`rm del erase rmdir rd Remove-Item ...`) run
  unasked **only** if they are one plain delete of full paths inside the user's home, not the vault root, not the backup folder, not a
  whole top-level folder, no wildcards or shell tricks (`| ; & $ * ? ~ ...`), small enough (300 MB / 20 000 files), no symlinks —
  and the targets are copied to the backup folder first. Anything unclear asks. `> file` overwrites are backed up.
- `_setPlatform(plat, home)` lets tests apply Mac rules on Windows; only tests call it.
- Approval ids come from `shared.cjs` and are unique across chats; Stop cancels all waiting cards as "no".
- Helpers (subagents `scout` Haiku read-only, `worker` Sonnet) go through the same `canUseTool` (the call carries `agentID`). The
  `Agent` tool itself is gated by a `PreToolUse` hook: only helpers the user approved with `request_helpers`, only these two kinds, no
  model or permission overrides, forced to run in the foreground.

## 10. The page (renderer)

- `App.tsx` holds a **store of chats** (`items`, read trail, `busy`, `sessionId`, `unread`); events carry a chat id and are filed into
  it. The chat on screen is `currentChat`. Panels are one `tool` state (`projects|skills|dreams|value|health|connectors|dashboard|settings`);
  a file open in the viewer sits on top. `covered = tool || openFile` pauses the graph.
- Chats are checkpointed to disk while they work (`saveChat`, throttled; `busy:true` marks one cut off by a crash).
- Theme: `data-theme` on `<html>`, set before first paint in `main.tsx`; `aos-theme` window event; the graph repaints on it.
- Body classes: `windowed`/`fullscreen` (from `window:state`), `mac` (from `os`). The title bar is the drag region (`-webkit-app-region`);
  buttons/inputs inside it are `no-drag`. `WindowButtons.tsx` draws minimise/maximise/close (Windows: right, squares; Mac: left, dots).
- `Ring.tsx` + `RingMap.ts` draw the home map: an inline SVG ring of the vault's files by project, with search, a legend and four floating widgets (Recent, Mail, Run, Actions). One size; no animation loop when idle.
- Markdown is rendered with `marked` then `DOMPurify`; `.html` vault files render in an `<iframe sandbox="allow-scripts">` over `vault://`.
- Styles: `panels.css` then `shell.css`. `shell.css` ends with "Agentic OS" override blocks (`!important`) that flatten the older look:
  **later rules win; to restyle something, find the override at the end of `shell.css` first.** `--r: 0px` and a global
  `border-radius: 0 !important` (with explicit round exceptions for orbs and dots).

## 11. Build, run, tests

- `npm start` = `npm run build` then `electron .`. **Never run bare `vite build`**: `npm run build` (`tools/build.cjs`) builds into
  `dist-next-<pid>/` and swaps it into `dist/` only if it succeeds, keeping the previous build as `dist-prev/` (what the recovery
  logic falls back to).
- Tests (all use throwaway data and notes folders and stand-in servers; none spend tokens or touch real data):

| Command | Covers |
|---|---|
| `npm test` | `tools/test-policy.cjs` (safety gate, incl. pretend-Mac cases), `tools/test-platform.cjs` (Windows/Mac differences), `tools/test-v2.cjs` (settings, secrets, gateway, settings import, plain errors, model aliases, vault switching) |
| `node_modules/.bin/electron tools/test-recovery.cjs` | the window never stays black |
| `npm run test:wire` | the REAL engine against a stand-in gateway: pinned model name, key header, no login token sent |
| `npm run test:window` | window buttons for a Windows and a Mac layout; maximise/restore/minimise/close |

- Not covered by any test: the Claude chat loop end-to-end (needs tokens), the approval card through the real engine, edits/backups
  through the engine, voice, a Mac.
- Capture harness for hidden-window screenshots (`main.cjs capture()`): `electron . --disable-gpu --capture=out.png` with env
  `AOS_USERDATA`, `AOS_VAULT`, `AOS_SIZE=1440x900`, `AOS_CLICK="Settings>Brain"` (click buttons by text), `AOS_JS=file.js`
  (script run before the shot), `AOS_WAIT`, `AOS_ASK="question"` + `AOS_APPROVE=yes|no` (asks a **real** question), `AOS_FAKE_EVENTS=file.json`,
  `AOS_STEPS=file.json` (ordered `{js}|{events}|{wait}` steps; results to `aos-debug.log` with `AOS_DEBUG=1`), `AOS_FAKE_OS=mac`.
  `aos-debug.log` is written into the app folder (ROOT) only when `AOS_DEBUG` is set.
- Env reference: `AOS_VAULT, AOS_USERDATA, AOS_BACKUP_DIR, AOS_TOOLS_DIR, AOS_DIST, AOS_MODEL, AOS_MAX_CHATS, AOS_VOICE,
  AOS_CLAUDE_SETTINGS (tests: fake ~/.claude/settings.json), AOS_DAILY_BUDGET, AOS_MONTHLY_BUDGET, AOS_PLAN_PRICE, VITE_DEV_URL,
  AOS_BLANK_MS, AOS_SETTLE`.
- Packaging (Mac, unverified): `npm run dist:mac` (electron-builder, only runs on a Mac); `asarUnpack` keeps the Claude program outside
  the archive; `platform.claudeExe()` rewrites `app.asar` to `app.asar.unpacked`.

## 12. Invariants: do not break these

1. **The gate is the only door for risky tools.** `canUseTool` → `policy.check`. `allowedTools` skips the gate, so it may only hold
   tools that cannot change anything on the PC (note `WebFetch`/`WebSearch` are there: see SECURITY.md S-2). Helpers must keep going through the same gate.
2. **Key/gateway means an isolated engine config** (`CLAUDE_CONFIG_DIR=engine-home`) and a scrubbed environment (`ROUTING_VARS`).
3. **Model names through a gateway are the plain tiers** (`engineModel`), with `sonnet` as the fallback.
5. **`systemAppend` is stable within a session**; changing content goes through `questionContext`.
6. **No secret reaches the page.** `providers.state()`, import descriptions and `settings.hint` return only "saved" and last 4
   characters; header values and the key stay in the main process. Test output must never print credentials (`test-wire.cjs` masks them).
7. **Paths from the page or the model go through `vault.resolveInside`** (or `attachments.isMine`).
8. **Nothing listens on a network port; nothing reports out.** The telemetry/update/survey switches in `authEnv` stay on.
9. **Idle means still:** no animation loops while nothing happens (graph, orb, polling).
10. **Never write to the real user data from tests;** use `AOS_USERDATA`, `AOS_VAULT`, `AOS_BACKUP_DIR`.
11. **Do not touch the Windows-only and Mac-only assumptions outside `platform.cjs`/`policy.cjs`** without adding a platform argument and a test.
12. **No personal names, personal vault paths, project names or other AI brands anywhere in the repository** (a text search for them is part of the checks).

## 13. Symptom → where to look

| Symptom | Start here |
|---|---|
| Answers fail through a gateway with a 400 mentioning "Extra inputs" / "context_management" | `gateway.friendlyError`, Settings > Advanced "rejects some requests" → `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` in `applyToEnv` |
| Wrong or unavailable model name | `engineModel`, `helperDefs`, `gatewayCfg().models`, pins in `providers.save`; `test-wire.cjs` |
| 401/403 from the gateway | key header choice (`providers.testGateway`, `settings.provider.keyHeader`), extra headers secret |
| Certificate error | `NODE_EXTRA_CA_CERTS` (`gateway.certFile`); probe uses Chromium trust, the engine uses its own |
| A card never appears / action runs without asking | `claude.cjs canUseTool`, `policy.check`, `allowedTools`, `shared.ask` |
| A delete asks every time (or does not ask) | `policy.deleteCheck`, `absPath`, platform flavour, `REGENERATED` |
| Edits not backed up | `policy.backup`, `AOS_BACKUP_DIR`, `claude.cjs canUseTool` (EDIT_TOOLS) |
| Chat re-reads everything / cost spike | `systemAppend` changed mid-session; `pickModel` model switches (cache is per model) |
| Chat stuck "working" after a crash | `saveChat`/`busy` flag in `App.tsx`; `chats.cjs` `interrupted` |
| Window black / blank | `recovery.cjs`, `dist-prev/`, `userData/recovery.log` |
| Health/Value/Dreams empty | `history.cjs` log folder (`~/.claude/projects/<slug>` and `engine-home/projects/<slug>`), ledger rows |
| Plan meter wrong | `usage.cjs`, `limits` events in `claude.cjs`, `ledger` cost de-duplication (`fresh`/`total`) |
| Sign-in window does not open | `platform.loginSpawn`, `providers.openLogin`, `claudeExe()` |
| "Claude Code not found" | `platform.claudeExe` (package name from platform+arch; asar rewrite); `npm install` for the chip |
| Mac-only: copy/paste dead, no Dock icon | `platform.menuTemplate`, `main.cjs` menu/dock block |
| Voice does nothing | optional tools not installed (`paths.toolsDir`, `stt.available`, `voice.available`) |
| New IPC call returns undefined | missing `h()` in `main.cjs` or wrapper in `src/aos.ts`; channel regex in `preload.cjs` |
| Style change has no effect | an `!important` override near the end of `shell.css` |

## 14. Known weak spots and tech debt (as of 2026-10-06)

- `claude.cjs` is large (781 lines) and mixes prompts, tools, helpers, models and auth; a split into prompts / tools / models /
  auth would help reviews. `App.tsx` (584 lines) similarly.
- `zod` and `@modelcontextprotocol/sdk` are peer dependencies of the Agent SDK, now declared in `package.json` so a packaged app includes them.
- Dead stand-ins: `discord.cjs`, `import-v1.cjs`, the `discord:*` and `setup:v1/importV1` IPC handlers and their callers in `main.cjs`.
- `connectors.cjs logo()` fetches an icon from `cdn.jsdelivr.net` (see SECURITY.md finding S-3).
- A notes folder with a plugin manifest can run code through hooks (SECURITY.md finding S-1, verified).
- No test covers the live chat path; one real question is the only end-to-end check and costs tokens.
- Dreams files, `usage.json` day entries and `chats/` are never pruned automatically (DATA.md).
- Mac: written but never run on a Mac. Packaging via electron-builder, signing and notarisation not done.
- The wake word library (`vosk-browser`) carries an `npm audit` advisory (`uuid`) with no fix available; it only loads if voice tools exist.
- Windows' Git Bash path handling (`/c/...`) exists only in the Windows rules of `policy.absPath`.
