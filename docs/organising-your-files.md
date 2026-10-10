# Organising your files

Agentic OS works out of one folder on your PC, your **workspace**. Everything in it is plain markdown, so
you can edit it in any text editor or in Obsidian, and the app picks up the change straight away. The app never
keeps the only copy of anything: the pages just read and write these files.

A ready-made example ships in [`example-workspace/`](../example-workspace). The welcome steps can copy it to
`Documents\Agentic OS` for you ("make a starter workspace").

## The layout

```
My workspace/
├── README.md                  what this workspace is; the assistant reads it first
├── projects/
│   ├── website-redesign/
│   │   ├── README.md          what the project is and where it stands
│   │   ├── notes.md           dated notes        -> Notes page
│   │   ├── action-items.md    checkbox list      -> Actions page
│   │   └── anything else      drafts, PDFs, images, sub-folders...
│   └── home-move/
│       └── ...
├── inbox/
│   ├── notes.md               notes that don't belong to a project yet
│   └── action-items.md
├── skills/
│   └── weekly-review/
│       └── SKILL.md           how to do a kind of task
└── agent/
    ├── persona.md             the assistant's personality
    └── avatar.png             optional picture for the assistant's card
```

Only two things are fixed: the folder names `projects/`, `inbox/`, `skills/` and `agent/`, and the two file names
`notes.md` and `action-items.md`. Everything else is yours to arrange.

## Projects

**Every folder directly inside `projects/` is a project.** It shows on the Projects page and in the Notes and Actions
pickers. The folder name is the project's name (`website-redesign` shows as "website redesign").

- Folders starting with `_` or `.` are skipped, so `projects/_archive/` is a good place for finished work.
- Sub-folders inside a project are fine; they are just files to the app.
- A `README.md` with a `status:` line in its frontmatter gives the Projects page a one-line status:

```markdown
---
title: Website redesign
description: New look and copy for the company website.
status: In progress. Design approved; copy is next.
---
```

## Action items: `action-items.md`

The Actions page lists every **open checkbox line** from every project's `action-items.md`, plus `inbox/action-items.md`.

```markdown
# Action items: website redesign

## Open

- [ ] Send the copy draft to Sam
- [ ] Pick a hosting plan, waiting on Sam

## Closed

- [x] Approve the home page design
```

- A line counts if it starts with `- [ ]`, `* [ ]` or `+ [ ]` (open) or the same with `[x]` (done). Lines
  anywhere in the file count, under any heading.
- The `## Open` and `## Closed` headings are optional. With both, ticking an item on the Actions page moves it under
  Closed. Without them, the page just changes `[ ]` to `[x]` where the line is.
- End a line with `, waiting on <name>` and the page shows a "waiting on" tag.
- The page adds a small `| added 2026-10-08 10:42` stamp to items it creates, and a `closed` stamp when you tick one.
  Lines you type by hand don't need it.
- The count badge next to Actions in the nav is the number of open items across everything.

## Notes: `notes.md`

The Notes page shows **dated** notes from this week and last, and writes new ones into the project's `notes.md`.

```markdown
# Notes: website redesign

## Thu 2026-10-08

### 14:10
Design approved. Launch moved to the 24th.

### 16:45
action item: send the copy draft to Sam
```

- A `##` heading containing a date (`YYYY-MM-DD`) starts a day. `### HH:MM` under it starts one note.
- Text under a day heading with no time heading counts as one note for that day.
- Text before the first dated heading (an intro, a summary) is fine; it just isn't listed on the page.
- **A note that starts with "action item"** is also added to the same project's `action-items.md`. That's the
  quickest way to capture a to-do while you take notes.
- Older notes stay in the file; the page only lists the last two weeks to stay quick.

## The inbox

`inbox/` works exactly like a project and shows as "Inbox". Use it for anything you haven't filed yet, then move it.

## Skills: `skills/<name>/SKILL.md`

A skill is a written-down way of doing a kind of task, such as a weekly review, writing up a meeting, or drafting an
email. The assistant reads the matching skill before doing that kind of task, so it does it your way every time.

```markdown
---
name: weekly-review
description: Look back over the week across every project and plan next week. Use when the user says "weekly review".
---

# Weekly review

1. For each folder in projects/, read README.md, notes.md and action-items.md.
2. ...
```

- The `description` is what the assistant matches on, so say **when** to use it.
- On the Claude brain, the workspace is also loaded as a Claude Code plugin (the `.claude-plugin/plugin.json` file in
  the example), so skills appear as real Claude Code skills. Keep that file if you copy the layout by hand.
- To group skills on the Skills page, add `skills/index.md` with `## Group name` headings and links to each
  `SKILL.md`. Without it they all show under "Skills".

## The assistant: `agent/`

- `agent/persona.md` is the assistant's personality: how it talks, how long its answers are, what it should never do.
  Edit it like any note; new chats pick up the change. `{user}` and `{assistant}` are replaced with the names from
  Settings. If the file is missing, a plain built-in personality is used.
- `agent/avatar.png` (square works best) replaces the letter on the assistant's card.
- The safety rules (what needs your yes, backups before edits) are **not** in this file. They live in the app, so a
  personality edit can't weaken them.

## The node map

Every `.md` file is a dot; a link from one note to another (`[text](other.md)` or `[[other]]`) is a line. Dots are
coloured by their top folder: projects, inbox, skills, agent, and everything else. Linking notes to each other is what
makes the map useful, so link new pages from the nearest `README.md` or `index.md`.

## Tips

- **Index pages help.** Every `index.md` in the workspace is handed to the assistant when a chat starts, so it knows
  the map before it searches. Keep them short.
- **One topic per chat.** Each question re-reads the chat so far; "+ New" starts fresh.
- **Received material:** a folder whose `README.md` frontmatter says `received: true` is treated as someone else's
  material: shown in its own section and coloured apart on the map.
