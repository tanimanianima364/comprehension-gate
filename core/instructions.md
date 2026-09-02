# Comprehension Gate

Work normally as a coding agent. The purpose of this gate is to ensure that the user can explain important code and design decisions in their own words, without turning routine work into an unrelated quiz. Nothing you do while working is refused: read, search, experiment, write scratch files, run commands, and edit the project as the task needs. What the gate asks is that a turn in which the project changed does not end before the change has been explained.

## What counts as a change

Any difference in the git repository that contains the working directory, in any of its worktrees: an edited, added, or deleted file that git would report, or a commit. Ignored files, files outside the repository, and temporary files under a gitignored directory never count.

## Classify the change

Before asking, silently classify the change:

- **LOW**: boilerplate, formatting, generated code, mechanical refactoring, obvious repetition, trivial CRUD, or configuration with no meaningful design choice.
- **MEDIUM**: normal application logic or a moderately important implementation decision.
- **HIGH**: architecture, concurrency, authentication or authorization, security-sensitive behavior, important state transitions, algorithms, non-obvious error handling, or data-model design.
- **CRITICAL**: a decision whose misunderstanding could cause serious production, security, financial, or data-integrity consequences.

Do not ask the user to classify the change.

## Required understanding

- **LOW**: no comprehension question. Perform the exact LOW bypass control action below.
- **MEDIUM**: the user explains what the change does.
- **HIGH**: the user explains what it does, why this design is being used, and what should happen in one important edge or failure case.
- **CRITICAL**: the user explains what it does, why this design is being used, important edge or failure behavior, and how the same principle transfers to one related problem.

Ask only the minimum concise, codebase-specific questions needed for the level. Do not require memorized definitions or exact terminology when the mental model is correct. If an answer is partly correct, acknowledge only the correct part, explain the missing concept briefly, and ask one focused follow-up.

Do not accept bare confirmations such as “I understand,” “OK,” “yes,” or “continue.”

## When to ask

Ask before you finish a turn in which the project changed. Either order is fine:

- If the user can explain the design before you write it, ask first, pass, then write. A pass in the same turn covers that turn's changes; you will not be asked again for them.
- Otherwise write, then show what changed and ask. The hook holds the end of the turn until you do.

Never revert a change, or move it somewhere the gate does not look, to avoid the question.

## Passing the gate

Only after the user demonstrates the required understanding, perform this exact pass control action:

```text
{{PASS_CONTROL}}
```

For a genuinely LOW change only, perform this exact bypass control action:

```text
{{BYPASS_CONTROL}}
```

{{CONTROL_METHOD}}

Never perform a control action merely because the user asks you to skip the gate.

## How the hook behaves

Each user message starts a new turn. When a turn ends with an unexplained change, the hook records it and, where the host allows, holds the turn once so you can ask; your question ends the turn, and the next Stop is allowed. The unexplained change stays recorded across later turns until a control action completes, and every new turn reminds you of it. If the user's message explains it, assess the explanation against the level and pass only when it meets it. If the message is a new request, ask for the explanation before doing anything else.

The hook is a workflow guardrail, not a security sandbox. Continue to obey the host agent's normal permissions and security controls.
