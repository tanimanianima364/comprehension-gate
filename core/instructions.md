# Comprehension Gate

Work normally as a coding agent. The purpose of this gate is to ensure that a change to the project leaves behind something the user can learn from, without turning routine work into an unrelated quiz. Nothing you do while working is refused, nothing holds your turn, and the user is shown no warning: read, search, experiment, write scratch files, run commands, and edit the project as the task needs. What the gate asks is that a change to the project does not go unaccounted for.

## What counts as a change

Everything this branch has done that its base branch has not: every path committed since the merge base with the default branch, and every path `git status` reports in the working tree. This is the same set a reviewer sees in the pull request. Ignored files never count, so a scratch file under a gitignored directory is free.

To print it at any moment, run the line for your shell from inside the repository. It answers with a JSON array of paths, because a path may itself contain a newline:

```text
{{CHANGE_SET_COMMAND}}
```

Use it rather than writing a `git diff` of your own. Resolving the base branch and naming both halves of a rename are easy to get wrong in a one-liner, and a change set that disagrees with the hook's is worse than none.

## Classify the change

Before writing anything, silently classify the change:

- **LOW**: boilerplate, formatting, generated code, mechanical refactoring, obvious repetition, trivial CRUD, or configuration with no meaningful design choice. A change that introduces a rule or a constraint — a validation limit, a timeout, a retry bound, a permission check — is never LOW, however small it looks.
- **MEDIUM**: normal application logic or a moderately important implementation decision.
- **HIGH**: architecture, concurrency, authentication or authorization, security-sensitive behavior, important state transitions, algorithms, non-obvious error handling, or data-model design.
- **CRITICAL**: a decision whose misunderstanding could cause serious production, security, financial, or data-integrity consequences.

Do not ask the user to classify the change, and do not ask the user anything else about it either. This gate puts no question to the user.

## What each level requires

- **LOW**: nothing.
- **MEDIUM and above**: write the insight. The higher the level, the more the insight has to say about why the approach was chosen rather than what it does.

## The insight

For MEDIUM and above, write one short insight occasioned by the change. This is context you supply, not a test, so state plainly what the change did. Cover:

- the convention, pattern, constraint, or principle the change touched — a rule this codebase follows, or a general engineering principle the change is an instance of
- whether the change followed it, extended it, or departed from it, and why
- one other place the same rule applies

Keep it to a few sentences. A general principle is welcome as long as the change is a real instance of it; a principle the change does not actually demonstrate is padding.

## When to write it

Write the insight before you finish a turn in which the project changed.

Nothing enforces this. The hook cannot hold the turn, does not warn the user, and has no way to tell whether you wrote anything: the reminder injected at the start of each turn is the only notice there is, and a change left unaccounted for simply stays unaccounted for. Never leave a change out of the account because no one is checking, and never move a change somewhere the gate does not look.

## How the hook behaves

At the start of a session and at every user message, the hook derives the branch's change set from git and injects it into your context. It keeps no state between invocations, so the list is always the branch's current set rather than a record of what you have already accounted for; a change you accounted for in an earlier turn is still listed while it remains on the branch, and does not need accounting for twice.

The hook is a workflow guardrail, not a security sandbox. Continue to obey the host agent's normal permissions and security controls.
