---
name: headless-candidates
description: Work out which skills in this folder can run on their own, with no chat and nobody to answer questions, and mark them so they get a Run button on the home page and the Skills page. Use when the user says "which skills can run by themselves", "add a run button", "run this in the background", or after new skills are added.
group: Learning and upkeep
---

# Headless candidates

Agentic OS can run a skill without a chat: press Run on the home page or the Skills page and the skill is carried out
start to finish by the model, with the same safety gate as a chat, except that nothing can ask the user a question.
Anything that would need a yes/no card is refused and reported. The result is one line under Recent runs.

Only some skills suit that. This skill finds them and marks them.

## What makes a skill runnable on its own

A skill is a candidate when all of these hold:

1. **It needs nothing from the user once started.** No "ask which", no choices that depend on taste, no "wait for a yes".
2. **It repeats.** The same job, done again and again (a refresh, a comparison, a report, a tidy), not a one-off.
3. **Its inputs are fixed.** It knows which files or sources to read without being told each time.
4. **It stays inside the safe tools.** Reading, searching and writing notes inside the notes folder. Nothing that deletes,
   sends, publishes, installs or reaches outside the folder: those are refused in an unattended run anyway.
5. **A wrong run is cheap.** If the model gets it wrong, the damage is a note to fix, not a message sent or a file gone.

A skill that fails one of these can still be run from a chat; it just should not have a Run button.

## How

1. Read `skills/index.md` and every `skills/<name>/SKILL.md`.
2. For each skill, test it against the five points above and write one line: name, yes or no, and the point that decides it.
3. Show the user the list. For each "yes", say in one plain sentence what a run would do and what it would write.
4. On the user's yes, add `headless: true` to that skill's header (the YAML block at the top of `SKILL.md`), under
   `description`. That is the only change; the app reads the flag and shows the Run button.
5. Add a line to `log.md` naming the skills marked.

## Taking a Run button away

Remove the `headless: true` line from the skill's header. Say so in `log.md`.

## Writing a skill so it can run headless

- Say exactly which files it reads and writes, by path or by rule.
- Say what to do when something is missing or unclear: the sensible default, not a question.
- End with the two or three plain lines the run should report: what was done, what changed, what needs the user.
