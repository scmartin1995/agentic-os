# Agentic OS

## Windows or Mac?

**This branch (`mac`) is the Mac app.** The Windows app is on the **`main`** branch: on the repo page, open the branch
menu above the file list (it says `mac`), pick `main`, then Code > Download ZIP. Or `git clone <repo address>` with no
branch named. Same features in both; this branch adds the Mac packaging, start script and Mac-only safety rules.

Version 1.1.2. A light desktop workspace for working with Claude: chat, your notes and projects (each project's deliverables
as tiles), and skills that improve with use. Calm paper colours (light, with a warm dark), IBM Plex type, and nothing
moving on screen unless the assistant is working.

Agentic OS is a window around the Claude Code engine (the Claude Agent SDK). Everything you make stays in a notes
folder you choose. Agentic OS has no server and no account of its own.

## Documentation

In `docs/`: **ARCHITECTURE.md** (how the code is organised, written so a person or a language model can review and fix it), **SECURITY.md** (infrastructure and trust map, network and process inventory, findings for a security review) and **DATA.md** (what data Agentic OS keeps, where it goes, how long it lives). They were written with the Mac copy, so some lines mention Mac details.

## Run it

```
npm install
npm start
```

`npm start` builds and opens the window. First launch walks through setup in three steps: your name, the connection, and the notes
folder (Agentic OS looks through it first, then asks how to keep it).

## Connect it

Settings > Brain (or the second setup step). The simplest way is your own Claude subscription:

- **Your own Claude plan:** choose "My Claude plan". Claude Code's own sign-in opens in a terminal window; Agentic OS
  never sees or stores the login, it only asks afterwards whether you are signed in.
- **Anthropic API key:** choose "Gateway or key", leave the address empty and paste the key.
- **A gateway (an address and a key from an organisation):** choose "Gateway or key".
  - If Claude Code is already set up on this PC, press **Use my Claude Code settings**. Agentic OS reads the `env`
    block of `~/.claude/settings.json` (it never changes that file), shows what it found (never the key), and
    takes over the address, the key, extra headers, model pins and switches when you press "Use these".
  - Or paste the gateway address and the key you were given and press "Check and save". Agentic OS works out
    which header the gateway reads the key from and reads the gateway's list of Claude models.
  - **Advanced** (under the key): extra headers if the gateway's owner asked for one, "My gateway rejects some requests"
    (for errors like "Extra inputs are not permitted"), and a certificate file for company networks.
  - If it fails, the message says which of these it is (address not reachable, certificate not trusted, key refused,
    request shape rejected) and what to ask the gateway's owner for.
  - Only gateways that speak Anthropic's own API format are supported.

## What leaves the machine

- Every question, and the parts of files the assistant reads to answer it, go to the connection you set
  (your organisation's gateway, or Anthropic).
- Web pages, when the assistant fetches one for a task.
- Connectors, if you added any in Claude Code.

With a key or a gateway the engine is given a config folder of its own (`%APPDATA%\agentic-os\engine-home`) with no Claude login in
it. Without that, the engine was seen sending a signed-in Claude login to the gateway instead of the gateway's key. The Claude
plan sign-in uses the normal config folder.

The bundled Claude Code engine is started with its usage reports, error reports, surveys, update checks and
marketplace installs switched off (see `authEnv` in `electron/claude.cjs`). This is checked by a test on
the settings passed to the engine. It has not yet been checked by watching the network.

## What is in here

| Part | Where |
|---|---|
| Window and safety gate | `electron/main.cjs`, `electron/policy.cjs` |
| Claude engine, standing instructions, helpers | `electron/claude.cjs` |
| Connection and sign-in | `electron/providers.cjs`, `electron/settings.cjs` |
| Notes folder, graph data | `electron/vault.cjs`; the home ring map is `src/components/Ring.tsx` and `RingMap.ts` |
| Dreams, Value, Health, token ledger | `electron/dreams.cjs`, `insights.cjs`, `ledger.cjs`, `history.cjs` |
| Screens | `src/App.tsx`, `src/components/` |
| Colours and layout | `src/styles/shell.css` (colour tokens, light and dark, at the top), `paper.css` (the layout and the look, loaded last), `panels.css` |
| Starter skills for a new notes folder | `starter/` |
| Notes and Action items (plain markdown, no AI) | `electron/actions.cjs`, `src/components/Notes.tsx`, `Actions.tsx` |
| "Agentic OS discover": a read-only scan of the chosen folder | `electron/discover.cjs` |
| OKF: index pages, the user's choice, the quiet tidy-up of new notes | `electron/okf.cjs`, `src/components/NotesSetup.tsx` |
| Safe saves and the app log | `electron/store.cjs` |

## Your files: choose, then ask (the look is optional)

In setup (and in Settings, Notes folder) Agentic OS can **look** at the chosen folder (`electron/discover.cjs`: file names and the
first lines of notes, nothing written, no AI) and report what it found, including a warning for names that look like
passwords or keys. The look runs only when the user presses "Look through it", and "Skip this" stops waiting for it: on a
work laptop it once kept setup waiting well past its 15 second limit (8 Oct 2026). The same look is a chat tool,
`look_through_folder` ("look through my folder"): the model gets the short report and explains it. Agentic OS explains OKF (a header on each note, an index page per folder, a log) and why (the model reads the
index pages first, so it reads less and costs less), and asks how the notes should be kept:

| Choice | What Agentic OS does |
|---|---|
| Add an index on top (recommended) | Adds `index.md` to each folder that lacks one, plus `log.md`. Never edits, moves or renames an existing file. New notes Agentic OS writes follow the structure, and a quiet tidy-up after each turn gives any it missed a header, an index line and a log line (backing up the index and log first). |
| Help me organise it | The same, and the model may suggest bringing older notes into shape, one sentence at a time, waiting for a yes. |
| Leave my notes exactly as they are | Adds only `skills/`, `.claude-plugin/` and `agent-os/`. Adds nothing to the user's notes. |

The choice is saved as `okfMode` in settings and given to the model as a short standing instruction.

## Tests

```
npm test
```

Runs the safety-gate tests and the app tests against throwaway folders and stand-in servers. No window opens, no real
service is called, no tokens are spent. The recovery checks run on their own:

```
node_modules\.bin\electron tools\test-recovery.cjs
```

Two more run the real thing against stand-ins on this PC, still without spending tokens:

```
npm run test:wire
npm run test:window
```

- `test:wire` starts the real Claude Code engine against a stand-in gateway and checks what it actually sends: the pinned
  model name, the key as a bearer token, no Claude login token.
- `test:window` opens Agentic OS in a hidden window as a Windows computer and as a Mac, and checks where the three window buttons
  sit and that maximise, restore, minimise and close each work.

## Known gaps

- **Only gateways in Anthropic's own API format.** Cloud-provider formats and direct cloud sign-ins are not supported: use
  your Claude plan, an Anthropic key, or an Anthropic-format gateway.
- **Not run against a real gateway.** The gateway sign-in is tested against stand-in servers only (the settings import and each error).
- **Never shown on a visible window.** Every run so far used a hidden window. A real question was asked through the
  Claude plan sign-in in one, and it answered, opened a file and ran an ask-first card. The reporting-off switches are
  checked on the engine's settings, not on the network.
- **Window buttons:** minimise, maximise and close are drawn by the app: flat squares at the right end of the title bar on
  Windows, red, yellow and green dots at the left on a Mac. Both layouts are checked (`npm run test:window`), but only the
  Windows one on a real Windows PC.
- **Mac build, not yet run on a Mac.** Made from the Windows source of 1.1.1 on a Windows PC. The Mac differences are in `electron/platform.cjs` (engine program, Terminal sign-in, voice programs, menu) and the Mac rules in `electron/policy.cjs`; both are checked by tests, but nothing has been run on a Mac. **Left out on a Mac:** Mail (it reads classic Outlook through Windows PowerShell, so the Mail tool, widget, Pull button and background job are hidden) and the microphone button and Space-to-talk (they appear only once whisper.cpp is added in `tools/whisper`). Start with `bash start-mac.sh`; build a .dmg with `npm run dist:mac` (unsigned: right-click, Open the first time).
- **Text only in v1.** The microphone, "Hey computer", spoken answers and the voice settings are out of every screen. The old voice code
  is still in `electron/` (unused) so it can come back later.
- **No usage or cost meters in v1.** How a gateway reports cost is not known yet, so the Tokens screen, the title-bar
  numbers and the spending budget are out. The ledger still records usage in the background; the Value screen is unchanged.
- **Starter skills and the manifest are added to whatever folder is chosen** (setup, step Files), without overwriting
  anything. If the folder already has a `.claude-plugin/plugin.json` with another name, the skills may not load; setup says so.
- **Unsigned.** Packaged builds would show the system's "unknown app" warning.

## What v1 does on screen

- **Home:** the chat in the middle, a side list of tools on the left, and a quiet column on the right (the notes map, what Agentic OS is
  reading, the newest deliverables, open actions, last night's Dreams). The line between the chat and the right-hand panel can be
  dragged, or moved with the arrow keys; "Hide chat" tucks the chat into a strip on the left.
- **Projects:** every project is a tile. A project opens on its deliverables (its `output` folder, any kind of file) as tiles with
  the title and description from each note's header, then its working files as a plain newest-first list. "Show in File Explorer"
  ("Show in Finder" on a Mac) selects a file in its folder; it works only inside the notes folder.
- **Action items** are `projects/<project>/action-items.md` (`<project>/action-items.md` when there is no `projects/` folder) (and `agent-os/inbox/action-items.md`): every `- [ ]` and `- [x]` line in
  that file. A note that starts with "action item:" is added to its project's register.
- **Skills:** the five starter skills (learn, lessons review, skill tidy, model selection, vault health check) are copied into the
  chosen folder at setup and load as the plugin `aos`.

## What changed in 1.1.2

- **Run buttons come from the skill.** A skill whose header says `headless: true` gets the Run button on the home page and the Skills page; the fixed list of two skill names is gone. If a skill used to have a button, add that line to its header.
- **Starter skills** installed into a notes folder are now learn, lessons-review, skill-tidy, model-selection, **okf** (how the notes are kept, with the health check folded in; vault-health-check is no longer a separate skill) and **headless-candidates** (works out which skills can run on their own and marks them).

## What changed in 1.1.0

- **The look through your folder is optional.** Setup and Settings, Notes folder no longer scan on their own: after choosing a
  folder you go straight to the choice of how Agentic OS keeps your notes, with a "Look through it" button, and "Skip this" while it
  runs. 1.0.1 still sat on "Looking through…" well past its 15 second limit on one laptop.
- **"Look through my folder" in chat.** A read-only tool (`look_through_folder`) runs the same scan when asked, for the whole
  folder or one folder inside it, and gives the model a short report to explain. It asks no permission because it only reads.

- **Works with or without a `projects/` folder.** When the notes folder has `projects/`, each folder inside it is a project,
  as before. When it has none, each top-level folder is a project (Projects, Notes, Action items and the map colours), except
  hidden and underscore folders and `skills`, `agent-os`, `logs`, `templates`, `attachments`, `assets`, `archive` and `inbox`.
  Notes then go in `<folder>/input/notes/` and action items in `<folder>/action-items.md`.

## What changed in 1.0.1

- **Settings, Notes folder no longer hangs on a cloud-synced folder.** The look-through used to run on the main thread and open the
  first lines of every note; in a OneDrive (or Dropbox, Google Drive, iCloud, Box) folder a file that cannot be fetched blocked the read
  for good and froze the window. Now the scan runs on a background thread and always answers within 15 seconds; in a cloud-synced
  folder it reads names, sizes and index pages only and does not open notes; elsewhere it opens the start of at most 600 notes. If it
  is cut short it says so, and shows only what it counted. Found on a work laptop; the cause was confirmed by the assistant's own diagnosis
  (a stuck read with no CPU use).
- Index and README pages are no longer listed as deliverables. Borders on inputs and buttons are stronger. Settings no longer mentions the file tree.
