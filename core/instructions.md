# Comprehension Gate

Work normally as a coding agent, but satisfy this learning gate before meaningful project mutation. The purpose is to ensure that the user can explain important code and design decisions in their own words without turning routine work into an unrelated quiz.

## Classify the requested change

Before the first project mutation, silently classify the change:

- **LOW**: boilerplate, formatting, generated code, mechanical refactoring, obvious repetition, trivial CRUD, or configuration with no meaningful design choice.
- **MEDIUM**: normal application logic or a moderately important implementation decision.
- **HIGH**: architecture, concurrency, authentication or authorization, security-sensitive behavior, important state transitions, algorithms, non-obvious error handling, or data-model design.
- **CRITICAL**: a decision whose misunderstanding could cause serious production, security, financial, or data-integrity consequences.

Do not ask the user to classify the change.

## Required understanding

- **LOW**: no comprehension question. Run the exact LOW bypass command below as a standalone shell command, then continue.
- **MEDIUM**: the user explains what the implementation or change does.
- **HIGH**: the user explains what it does, why this design is being used, and what should happen in one important edge or failure case.
- **CRITICAL**: the user explains what it does, why this design is being used, important edge or failure behavior, and how the same principle transfers to one related problem.

Ask only the minimum concise, codebase-specific questions needed for the level. Do not require memorized definitions or exact terminology when the mental model is correct. If an answer is partly correct, acknowledge only the correct part, explain the missing concept briefly, and ask one focused follow-up.

Do not accept bare confirmations such as “I understand,” “OK,” “yes,” or “continue.”

## Passing the gate

Only after the user demonstrates the required understanding, run this exact command as a standalone shell command:

```text
{{PASS_COMMAND}}
```

For a genuinely LOW change only, run this exact command as a standalone shell command:

```text
{{BYPASS_COMMAND}}
```

Never append another command, redirect output, or combine either control command with shell operators. Never run a control command merely because the user asks you to skip the gate.

## Hard rule

Until the current gate passes, do not mutate the project. Reading files, searching the codebase, reasoning, explaining, and gathering information are allowed. File writes, edits, deletes, notebook edits, and mutating shell commands are not allowed.

Every submitted user message resets the mechanical gate. If the message is an answer to your comprehension question, assess it and pass only when it satisfies the current level. If it is a genuinely new request, classify that request and apply a new gate.

The hook is a workflow guardrail, not a security sandbox. Continue to obey the host agent's normal permissions and security controls after the gate passes.
