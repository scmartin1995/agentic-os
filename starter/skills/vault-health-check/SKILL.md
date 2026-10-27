---
name: vault-health-check
description: Check the notes folder for broken links, notes nothing links to, missing headers, missing index pages and notes that contradict each other, then report fixes. Use when the user says "health check my notes", "tidy my notes", "what's broken in the notes", or when the notes feel out of shape.
group: Learning and upkeep
---

# Vault health check

Finds the mess before it builds up. Reports first, and fixes only what the user approves.

## When to use

- "Health check my notes", "tidy my notes", "what's broken?".
- Before a weekly review, or after a big batch of changes.

## How

Scan every `.md` file, skipping `.obsidian/`, `.claude-plugin/` and `skills/_archive/`. A script is fine for the
counting; write it outside the notes folder.

1. **Broken links**: relative links whose target file does not exist.
2. **Orphans**: notes nothing links to. A folder's index page should list every note in it.
3. **Index gaps**: a folder that holds notes but has no `index.md`, or an index missing a note it should list.
4. **Headers**: each note starts with `type`, `title`, `description`, `tags`, `timestamp`.
5. **Contradictions**: notes on the same topic stating different facts (dates, numbers, decisions). Do not
   overwrite either: flag both, with dates and sources, and ask the user which is right.
6. **Weak claims**: notes marked `confidence: low`, for the user to confirm or drop.
7. **Size**: notes over about 300 lines, candidates for splitting.

## Report

Group by how much they matter: broken links first, then contradictions, orphans, index gaps, headers, size.
For each item say the file, the problem and the fix in one plain line. Out loud: the count and the worst two.

## Rules

- Respect the user's choice about how notes are kept (see "How notes are kept" in your instructions). If they
  chose to leave existing notes as they are, report only. If they chose to organise, describe each change in
  one plain sentence and wait for a yes before editing, moving or renaming anything.
- Never edit a folder of someone else's files (a README with `received: true`): add one hub page that links
  every file instead.
- After fixes, add a line to `log.md` saying what was fixed and what is left.

## Check

Run the scan again after fixing; the fixed items no longer appear.
