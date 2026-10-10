# Building your own on it

This repo is meant to be a starting frame. The usual things people change, and where they live:

| To change | Where |
|---|---|
| The assistant's name, your name | Settings > This app (saved in the app's data folder) |
| The assistant's personality | `agent/persona.md` in the workspace |
| The assistant's picture | `agent/avatar.png` in the workspace |
| What it may do without asking | `electron/policy.cjs` (the ask-first gate and the backups) |
| How it answers, the rules it always follows | `METHOD` and `PERSONA_REST` in `electron/claude.cjs` |
| Which Claude model it picks | `pickModel()` in `electron/claude.cjs` |
| Colours, both themes | the two variable blocks at the top of `src/styles/shell.css` |
| Map colours and legend | `src/colors.ts` |
| Pages in the nav | `TOOLS` in `src/components/Nav.tsx`, and the matching `tool === ...` lines in `src/App.tsx` |
| The Notes / Actions file rules | `electron/actions.cjs` (with tests in `tools/test-actions.cjs`) |
| The starter workspace | `example-workspace/` (copied by "make a starter workspace") |
| The wake word | `GRAMMAR` and `isWake` in `src/listen.ts` |
| The voice | `VOICE` in `electron/voice.cjs` (see [voice.md](voice.md)) |

## How it fits together

| Path | What |
|---|---|
| `electron/main.cjs` | Window, tray, and every call the screen can make (`api.handle`) |
| `electron/api.cjs` | One handler list for the window and a paired phone |
| `electron/engine.cjs` | Picks the brain: `claude.cjs`, `universal.cjs` (any OpenAI-style API) or `cli-engine.cjs` |
| `electron/claude.cjs` | The Claude brain, through the Claude Agent SDK (Claude Code) |
| `electron/policy.cjs`, `shared.cjs` | The ask-first gate and backups; yes/no cards shared by all brains |
| `electron/vault.cjs` | Reads the workspace: file tree, link graph, file contents |
| `electron/actions.cjs` | Notes and action items (plain markdown, no AI) |
| `electron/connectors.cjs` | Connected apps (Gmail, Drive, GitHub...), loaded only when a task needs them |
| `electron/dreams.cjs` | The nightly review |
| `electron/remote.cjs` | The phone link: a small web server, pairing, events |
| `electron/discord.cjs` | Optional Discord DMs for approvals and chat |
| `src/App.tsx`, `src/components/` | The screen: nav, chat, node map, pages |
| `src/aos.ts` | `window.aos`, the same on the desktop and a phone |

## Checking your changes

```bash
npm run typecheck
npm test                 # unit tests and the app suite (stand-in AI servers; no tokens used)
npm run capture          # builds, renders the window hidden, saves capture.png, quits
```

Useful when capturing: `AOS_USERDATA=<folder>` (a throwaway data folder), `AGENTIC_OS_VAULT=<folder>` (a workspace),
`AOS_SIZE=1440x900`, `AOS_CLICK="Actions"` (click a button by its text), `AOS_WAIT=<ms>`, `AOS_DEBUG=1`
(writes `aos-debug.log`).

## Safety notes for builders

- The gate runs in the app, not in the model. Keep it that way: rules in a prompt can be talked around; code can't.
- Every edit, delete and overwrite the assistant makes is copied to the app data folder's `backups/` first (30 days).
- API keys and tokens are encrypted with Windows' per-user encryption (`electron/settings.cjs`) and never reach the
  window or a phone.
- Signing in with a Claude plan uses Anthropic's own sign-in through Claude Code; the app never sees the login. Check
  Anthropic's terms for what plan logins may be used for before you share a build with others.
