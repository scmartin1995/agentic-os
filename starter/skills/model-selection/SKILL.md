---
name: model-selection
description: Pick the cheapest model that can do the job, and know when to step up to a stronger one. Use at the start of a task, when a task feels too hard for the current model, or when choosing a model for a helper.
group: Learning and upkeep
---

# Model selection

Match the model to the task and never use a stronger one than needed. This skill is
judgment. The app does the actual switching.

## The tiers
| Tier | Good for |
|---|---|
| Quick | Lookups, "what does this note say", yes/no follow-ups, formatting, small note edits |
| Everyday | Most work: answering from several files, drafting and editing, meeting notes, routine changes |
| Deep | Client-ready documents, changes across many files, problems with no obvious cause, design trade-offs, anything where a wrong answer is expensive |

The app maps each tier to a model in the user's account. Judge by what is being
asked, not by keywords.

**Quick is only for the start of a chat.** Each model keeps its own cached copy of a
chat, so dropping to a cheaper model part-way makes the whole chat be read again at
full price. A short follow-up in an Everyday chat stays on Everyday.

## Procedure
1. **Start at the lowest tier that plausibly works.** Unsure between two? Take the
   lower and let step 3 catch it.
2. **Stay put across a thread.** Re-check only when the task changes shape.
3. **Notice when you have outgrown the tier.** Signs: the second attempt at the same
   fix, guessing at a cause, a plan that spans many files, contradicting your own
   earlier answer, a question that needs real trade-off reasoning.
4. **Stepping up.** Under the user's auto limit the app steps up and says so. Over
   it, ask in one plain line: what the task needs and why the current model falls
   short. Always attach a handoff brief.
5. **On a no,** carry on at the current tier and say plainly where you may fall short.
   Do not find another way round.
6. **Helpers:** give each the lowest tier that fits its piece. Searching and
   summarising is Quick. Only the part that needs deep reasoning is Deep.

## Handoff brief
A few lines, not the whole history:
- **Goal:** what the user actually wants, in their terms.
- **Tried:** what you did and what happened, including what failed.
- **Where:** the files or notes involved.
- **Stuck on:** the specific thing you could not resolve, and what you suspect.

Label guesses as guesses. The receiver should check them, not inherit them. Say what
is already done, so it is not redone. Read `references/handoffs.md` before writing one.

## Pitfalls
- Do not ask on every borderline turn. Once per task, with a clear reason.
- Do not stay on Deep "just in case". Say when the heavy part is done.
- Do not pick Quick for anything that edits a client document or changes structure,
  unless the change is trivial. A wrong edit costs more than the saving.

## How this skill learns
`references/calibration.md` holds real cases, one line each: task, tier used, what
happened, what it teaches. lessons-review adds them. When three cases agree, move the
rule into this file and trim the cases. Real cases only. Never invent examples.
