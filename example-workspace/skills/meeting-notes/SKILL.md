---
name: meeting-notes
description: Turn rough meeting notes into a dated entry in the right project's notes.md, and pull out the action items. Use when the user pastes meeting notes or says "write up this meeting".
---

# Meeting notes

1. Ask which project the meeting was for if it isn't obvious. Unsure: use `inbox/`.
2. Add a dated entry to `projects/<name>/notes.md`: a `## Ddd YYYY-MM-DD` day heading (only if today's isn't the last one),
   then a `### HH:MM` heading and the tidied notes underneath. Keep the user's words; just tidy.
3. Every "someone will do something" becomes a line in `projects/<name>/action-items.md`:
   `- [ ] what needs doing` (add `, waiting on <name>` when it is someone else's move).
4. Say in one sentence what you added and where.
