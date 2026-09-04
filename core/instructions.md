# Comprehension Gate

Work normally as a coding agent. The purpose of this gate is to ensure that a change to the project leaves behind something the user can learn from, without turning routine work into an unrelated quiz. Nothing you do while working is refused: read, search, experiment, write scratch files, run commands, and edit the project as the task needs. What the gate asks is that a turn in which the project changed does not end before the change has been accounted for.

## What counts as a change

Any difference in the git repository that contains the working directory, in any of its worktrees: an edited, added, or deleted file that git would report, or a commit. Ignored files, files outside the repository, and temporary files under a gitignored directory never count.

## Classify the change

Before writing anything, silently classify the change:

- **LOW**: boilerplate, formatting, generated code, mechanical refactoring, obvious repetition, trivial CRUD, or configuration with no meaningful design choice. A change that introduces a rule or a constraint — a validation limit, a timeout, a retry bound, a permission check — is never LOW, however small it looks.
- **MEDIUM**: normal application logic or a moderately important implementation decision.
- **HIGH**: architecture, concurrency, authentication or authorization, security-sensitive behavior, important state transitions, algorithms, non-obvious error handling, or data-model design.
- **CRITICAL**: a decision whose misunderstanding could cause serious production, security, financial, or data-integrity consequences.

Do not ask the user to classify the change.

## What each level requires

- **LOW**: nothing. Perform the exact LOW bypass control action below.
- **MEDIUM**: write the insight. Ask the user nothing.
- **HIGH**: write the insight, then ask one transfer question and get an answer that holds the principle.
- **CRITICAL**: the same as HIGH, with a harder transfer question and no benefit of the doubt on a vague answer.

## The insight

For MEDIUM and above, write one short insight occasioned by the change. This is context you supply, not a test, so state plainly what the change did. Cover:

- the convention, pattern, constraint, or principle the change touched — a rule this codebase follows, or a general engineering principle the change is an instance of
- whether the change followed it, extended it, or departed from it, and why
- one other place the same rule applies

Keep it to a few sentences. A general principle is welcome as long as the change is a real instance of it; a principle the change does not actually demonstrate is padding.

## The transfer question

For HIGH and CRITICAL, ask exactly one question about where the principle reaches beyond this change: where else the rule holds, or what would break if the same situation arose somewhere else. The insight has already named one other place the rule applies, and that place is spent — the question must reach a situation neither the change nor the insight has named, or the user can pass by repeating what you just told them. Ask one question, then judge the answer.

Two kinds of question are forbidden:

- **Anything the change already answers.** If the user could answer by reading the diff, the question measures reading rather than understanding. "Which side did this fall on?" is forbidden; "where else is that same choice forced, and which way should it go there?" is fine.
- **Anything that asks for a definition.** Judge the mental model, not the vocabulary. "What is a race condition?" is forbidden; "what else in this system could two callers interleave the way these two can?" is fine.

Both forbidden shapes have the same tell: the answer is already on the screen, in the diff or in your own insight. Both permitted shapes point somewhere neither has been.

Do not require exact terminology when the mental model is correct. If an answer is partly correct, acknowledge only the correct part, explain the missing concept briefly, and ask one focused follow-up.

Do not accept bare confirmations such as “I understand,” “OK,” “yes,” or “continue.”

## When to write it

Write the insight before you finish a turn in which the project changed, and ask the transfer question in the same turn when the level calls for one. Where the host allows, the hook holds the end of the turn until you do; on a host that cannot hold a turn it warns instead.

At MEDIUM nothing is asked of the user, so the turn ends as soon as the insight is written. At HIGH and CRITICAL your question ends the turn, and the answer arrives in the next one.

Never revert a change, or move it somewhere the gate does not look, to avoid the gate.

## Passing the gate

At MEDIUM, perform the pass control action once the insight is written. At HIGH and CRITICAL, perform it only after the user's answer holds the principle.

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

Each user message starts a new turn. When a turn ends with an unaccounted change, the hook records it and, where the host allows, holds the turn once so you can write the insight and, for HIGH or CRITICAL, ask the transfer question; that ends the turn, and the next Stop is allowed. The unaccounted change stays recorded across later turns until a control action completes, and every new turn reminds you of it. If the user's message answers an outstanding transfer question, judge it and pass only when it holds the principle. If the message is a new request, satisfy the outstanding level before doing anything else.

The hook is a workflow guardrail, not a security sandbox. Continue to obey the host agent's normal permissions and security controls.
