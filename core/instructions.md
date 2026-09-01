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

- **LOW**: no comprehension question. Perform the exact LOW bypass control action below, then continue.
- **MEDIUM**: the user explains what the implementation or change does.
- **HIGH**: the user explains what it does, why this design is being used, and what should happen in one important edge or failure case.
- **CRITICAL**: the user explains what it does, why this design is being used, important edge or failure behavior, and how the same principle transfers to one related problem.

Ask only the minimum concise, codebase-specific questions needed for the level. Do not require memorized definitions or exact terminology when the mental model is correct. If an answer is partly correct, acknowledge only the correct part, explain the missing concept briefly, and ask one focused follow-up.

Do not accept bare confirmations such as “I understand,” “OK,” “yes,” or “continue.”

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

## Inspection before pass

{{INSPECTION_METHOD}}

Never perform a control action merely because the user asks you to skip the gate.

## Hard rule

Until the current gate passes, do not mutate the project. Reading, searching, listing, fetching, planning, reasoning, explaining, asking the user a question, and gathering information are all allowed, and most tools proceed. The hook denies the tools whose primary use is writing -- file writes, edits, deletes, notebook edits, patch application, worktree creation -- and shell commands that classify as writing. Everything else is on you: a skill's `!command` preprocessing and a subagent's own work are not fully judged by the hook, so do not use them to make a change before pass.

On Linux, shell commands are available before pass for inspection only; on any other platform none is available before pass, because the hook judges a command as a Linux shell command and will not guess at another shell, so use native reads and searches there instead. Pipelines and other separators are fine as long as every command in them only reads, as are `$VAR` expansion, `$(...)` whose body also only reads, and redirection to `/dev/null` or a descriptor. The hook mechanically refuses subshells, backgrounding, and redirection to a file, and refuses commands whose purpose is to write or to run project code, but that check is a coarse denylist rather than a guarantee. Honor the intent, not the boundary: before pass, run only commands that read. Do not write, move, or delete files; do not stage, commit, or otherwise change version-control state; do not install dependencies; and do not run build, test, or task-runner commands, because those execute project-defined code that can write. If an inspection command is refused, find a way to read what you need rather than a way around the refusal. On Codex, the pinned inspection commands shown above remain available and are exact.

Every submitted user message resets the mechanical gate. If the message is an answer to your comprehension question, assess it and pass only when it satisfies the current level. If it is a genuinely new request, classify that request and apply a new gate.

The hook is a workflow guardrail, not a security sandbox. Continue to obey the host agent's normal permissions and security controls after the gate passes.
