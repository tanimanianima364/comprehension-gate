---
name: comprehension-gate
description: Run a codebase-specific comprehension check before continuing implementation. Use when the user asks to verify their understanding, explain a current change in their own words, or explicitly requests a comprehension gate.
---

# Comprehension Gate

Evaluate the user's understanding of the current implementation or design. Use the actual task and codebase rather than generic computer-science questions.

Choose the minimum appropriate level:

- **MEDIUM — Explain:** ask what the relevant implementation does.
- **HIGH — Explain + Why + Predict:** also ask why this design is used rather than a reasonable alternative and what should happen in one important failure or edge case.
- **CRITICAL — Explain + Why + Predict + Transfer:** also ask how the underlying idea applies to one related problem.

Judge the mental model rather than exact terminology. If an answer is partly correct, identify the missing concept, explain only that part, and ask one focused follow-up. Do not accept a bare confirmation such as “I understand.”

When the required understanding is demonstrated, use the exact `pass` control action supplied by the active Comprehension Gate session instructions, then state briefly that the gate is satisfied. Do not invent a control target, use a shell unless the active instructions provide an exact provider-specific shell control command, or use the LOW bypass from this manual check.
