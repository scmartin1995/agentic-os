---
name: lessons-review
description: Look back over a stretch of chat and save what was learned into skills, so the same mistake or correction never has to happen twice. Use when the user says "wrap up" or "what did you learn", and when the app runs its automatic lessons pass.
group: Learning and upkeep
---

# Lessons review

The self-improvement step. Runs on "wrap up", and automatically after every tenth
question in a chat. The automatic pass reviews only those ten questions, works
quietly, and ends with one plain sentence.

## What counts as a lesson (any one is enough)
- **The user corrected you:** tone, length, format, too much detail, wrong approach,
  "give it to me straight", "stop doing X". These matter most.
- **A technique, fix or workaround emerged** that a later chat would want.
- **A skill you used was wrong, missing a step or out of date.** Fix it now.
- **Model choice:** the user changed the model, approved or declined a step-up, a
  cheaper model fell short, or a heavy one was wasted. Add a case to
  `model-selection/references/calibration.md`. If a handoff brief helped or misled,
  add it to `model-selection/references/handoffs.md`.

## Where it goes, in order of preference
1. Patch the skill that was in play, if it covers the lesson.
2. Patch another existing skill for that class of task.
3. Add a `references/<topic>.md` under an existing skill, for depth only sometimes needed.
4. Propose a new skill with learn, only if no skill covers the class. This needs a yes.

Facts about the user, their clients or their projects go in project notes, not
skills. How to do a kind of task, including how the user likes the result to look,
goes in a skill.

## How to write a lesson
- Procedure first. Attach each pitfall to the step it affects.
- A pitfall is a rule plus one clause of why: "Lead with the answer in one sentence -
  long option lists lose the reader."
- No dates, ticket numbers or quotes as content. The rule must stand on its own.
- The same lesson twice is one rule. Search the skill first and sharpen what is there.
- When a skill was wrong, fix the sentence. Do not append "UPDATE: actually...".
- A skill must get sharper, not longer. Keep it under 200 lines: to add a rule, tighten
  or replace one, or move depth into `references/`.
- Always read the current skill file before editing it.
- Never edit a skill marked `pinned: true`.

## Do not save
- Setup problems the user can fix (not signed in, missing access). Save the fix, if any.
- "X does not work" claims. They harden into refusals long after X is fixed.
- One-off task stories.
- Things that never worked. If nothing worked, save nothing.
- Anything confidential about a client. Skills travel; client facts stay in the project.

## Finish
Say in one sentence what changed ("Updated meeting-notes: owners on every action"),
or "Nothing to save". Nothing to save is allowed but should not be the default.
