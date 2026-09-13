---
name: comprehension-gate
description: Account for the current change on this branch before continuing implementation. Use when the user asks to account for a current change, or explicitly requests a comprehension gate.
---

# Comprehension Gate

Account for the change this branch has made, at its level. Anchor everything in the actual change; a general engineering principle is welcome as long as the change is a real instance of it.

The change is everything this branch has done that its base has not — committed and uncommitted alike. Print it by running the exact change set command the active Comprehension Gate session instructions supply, which runs the same code the hook runs. Do not write a `git diff` of your own instead: resolving the base branch and naming both halves of a rename are easy to get wrong in a one-liner, and a change set that disagrees with the hook's is worse than none. If no session instructions are present, say so rather than guessing at a command.

Choose the minimum appropriate level. This check was asked for, so it has no LOW: write the insight even for a change the automatic reminder would have let pass in silence.

- **MEDIUM — Insight:** write one short insight covering the convention, pattern, constraint, or principle the change touched, whether the change followed it, extended it, or departed from it and why, and one other place the same rule applies.
- **HIGH — the same, deeper:** say why this approach was chosen over the alternative that was rejected, not only what it does.
- **CRITICAL — the same, strictest:** name what would go wrong if the principle were violated here, concretely.

Ask the user nothing. This gate puts no question to anyone: it is context you supply, not a test you set. State plainly what the change did and what it turned on.

When the insight is written, say briefly that the change is accounted for. There is no control action to perform and nothing is holding the turn.
