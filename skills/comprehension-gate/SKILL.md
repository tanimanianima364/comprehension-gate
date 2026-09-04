---
name: comprehension-gate
description: Run a comprehension check on the current change before continuing implementation. Use when the user asks to verify their understanding, account for a current change, or explicitly requests a comprehension gate.
---

# Comprehension Gate

Account for the current change at its level. Anchor everything in the actual change; a general engineering principle is welcome as long as the change is a real instance of it.

Choose the minimum appropriate level. This check was asked for, so it has no LOW: a change too mechanical to carry a level is not one someone requests a gate on, and the automatic gate is where LOW is decided.

- **MEDIUM — Insight:** write one short insight covering the convention, pattern, constraint, or principle the change touched, whether the change followed it, extended it, or departed from it and why, and one other place the same rule applies. Ask the user nothing.
- **HIGH — Insight + Transfer:** also ask one question about where the principle reaches beyond this change, reaching a situation neither the change nor the insight has named.
- **CRITICAL — Insight + Transfer:** the same, with a harder question and no benefit of the doubt on a vague answer.

Never ask a question the change already answers: if the user could answer by reading the diff, it measures reading rather than understanding. Never ask for a definition. Judge the mental model rather than exact terminology. If an answer is partly correct, identify the missing concept, explain only that part, and ask one focused follow-up. Do not accept a bare confirmation such as “I understand.”

When the level's requirement is met, use the exact `pass` control action supplied by the active Comprehension Gate session instructions, then state briefly that the gate is satisfied. Do not invent a control target, use a shell unless the active instructions provide an exact provider-specific shell control command, or use the LOW bypass from this manual check.
