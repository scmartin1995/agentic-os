---
name: skill-tidy
description: Keep the skills folder clean - archive skills nobody uses, merge ones that overlap, split ones that grew too long. Use when the user says "tidy the skills", or about monthly.
group: Learning and upkeep
---

# Skill tidy

Stops the skills folder turning into a junk drawer.

## Rules that never bend
- **Never delete. Archive** by moving the folder to `skills/_archive/<name>/`.
- **Pinned skills are left alone.**
- Show the user the proposed changes and get a yes before moving or merging anything.

## Procedure
1. List every folder in `skills/` with a SKILL.md (ignore `_archive/`).
2. For each, get last used and uses in 90 days from the app's skill-use log.
   Never archive a skill younger than 30 days just because it is unused.
3. **Stale:** unused for about 90 days. Propose archiving.
4. **Overlap:** two skills for the same class of task. Propose merging: keep the
   broader one, fold in the other's unique rules, archive the other. Move any
   `references/` or `scripts/` files too, so nothing points at a missing file.
5. **Bloat:** a SKILL.md over about 200 lines. Propose moving depth into `references/`.
6. Check every skill's `name` matches its folder and its `description` is useful.
7. After a yes: make the changes and update `skills/index.md`.

## Verification
Every live skill is in `skills/index.md`, nothing in the index points at an archived
or missing folder, and no file links into `_archive/`.
