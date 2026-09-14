# Intent Notes

Work normally as a coding agent. The purpose of this plugin is to leave behind what the code cannot say for itself: what you were trying to achieve, and why you built it this way rather than another way. Nothing you do while working is refused, nothing holds your turn, and the user is shown no warning. You are asked for two records, and asked no questions.

## The two records

**Docstrings** say what a file or a function is for and how it works, in the code, always describing the current state. They are the final state of the thing, so they merge like code: when two branches touch one, the answer is whatever the code now does.

**Notes** say what one change was trying to achieve and why the approach was chosen. They are a record of a moment, so they are never rewritten. A note is written once, and a later change that invalidates it writes a new note that supersedes it instead of editing it. Two branches therefore never conflict over a note: each adds its own file.

## What counts as a change

Everything this branch has done that its base branch has not: every path committed since the merge base with the default branch, and every path `git status` reports in the working tree. This is the same set a reviewer sees in the pull request. Ignored files never count, so a scratch file under a gitignored directory is free.

To print it at any moment, run this command from inside the repository. It answers with JSON — `{ "paths": [...], "complete": true }` — because a path may itself contain a newline, and because a list that is short of something has to be able to say so:

```text
{{CHANGE_SET_COMMAND}}
```

When `complete` is `false`, part of the change set could not be read: an empty `paths` there does not mean the branch is unchanged, and a non-empty one is short of something. Use this command rather than writing a `git diff` of your own. Resolving the base branch and naming both halves of a rename are easy to get wrong in a one-liner, and a change set that disagrees with the hook's is worse than none.

If you cannot run it — a sandbox that refuses the command, a session with no one to approve it — do not fall back to a `git diff`. The list the hook injected at the start of this turn is the same set, computed by the same code; say that is what you are working from and carry on.

## Docstrings

On every file and function you add or meaningfully change, leave a docstring in the language's own convention that covers:

- what it is for — the job it does for its caller, not the steps it takes
- the approach, where there was a choice — why it works this way, what it refuses to do, what it trades away

Do not restate the code. A docstring that says "loops over the entries and returns the total" is worse than none: it costs a reader time and rots the moment the loop changes. If nothing about a function required a decision, its name and signature are the docstring, and adding prose there is padding. Match the density of the surrounding file.

## Notes

A note is needed when the change touched something a reader would have to reconstruct: architecture, concurrency, authorization, an algorithm, a state transition, a data model, non-obvious error handling, or any rule or constraint the code now enforces — a validation limit, a timeout, a retry bound, a permission check. A change that is purely mechanical needs no note: boilerplate, formatting, generated code, a rename, an obvious repetition, configuration with no design choice behind it. Decide this yourself; the user is not asked.

A path with no note stays listed in the reminder. That is expected for mechanical work and is not a reason to write a note that says nothing.

Write a note as `docs/notes/YYYY-MM-DD-<short-slug>-<8 hex characters>.md`. The hex is only there so two branches writing on the same day never collide; pick it at random.

```markdown
---
covers:
  - path/relative/to/the/repository.ext
  - another/changed/path.ext
supersedes:
  - 2026-01-31-an-earlier-note-0a1b2c3d
---

# One line naming what this change did

## What this change was for

The goal, in the user's terms rather than the code's.

## The approach, and what it rejected

Why this way. Name at least one alternative that was considered and say what
ruled it out — that is the part a reader cannot recover from the diff.

## How it is built

The shape of the implementation and the intent behind it: what each piece is
responsible for, and which parts are load-bearing rather than incidental.
```

The first `#` heading is the note's title, and the hook shows it when naming the note before an edit — so make it say what the change did, not what section follows.

`covers` is the only part read by a machine, so its shape is fixed and small. The key is on a line of its own, spelled `covers:` and nothing else. Each entry is a line of `  - ` — the dash and exactly one space — followed by one repository-relative path, **taken literally to the end of the line**, leading and trailing spaces included: no quoting, no escaping, no inline `[a, b]`, no comments. Every character is part of the name, so a path holding a quote, a comma, a `#` or a backslash is written plainly and matched exactly as git spells it. The one exception is `%`: write it as it appears in the name and the reader escapes it for you, which is what keeps a file called `x%FF.js` distinct from one whose name holds a raw byte.

The list is read whole or not at all. A blank line between entries is fine and the next key ends it; any other line — a continuation, a comment, a dash with nothing after it — makes the note cover nothing, rather than covering whatever was read before it. Do not cover a path the note does not actually explain, and never widen `covers` to silence the reminder.

A note counts only for the change it is part of. A note an earlier branch left about a file records what *that* change was for, so it does not answer for yours: a file that has been explained once is still reported when you change it again on a new branch.

Within one branch it is the other way round: once a path is covered, the reminder stops naming it even if you go on changing that file. The reminder is a floor, not a ceiling. If later work on this branch takes a covered file somewhere the note does not describe, write another note — nothing will ask you to. The hook still names a path's notes when a tool reads or writes it, so an edit that contradicts one is put in front of you even after the reminder has gone quiet.

`supersedes` is for the reader. List only the notes whose decision no longer holds; leave the key out when there are none. A note that refines an earlier one rather than overturning it supersedes nothing and simply covers the same paths — the hook names a path's notes oldest first, so the two read as the evolution they are. Never edit or delete an existing note to make it agree with new work: the superseded note is the record of what was believed at the time.

**Before you change a file, look for the notes that cover it and read them** — find them with `grep -rlF -- "<path>" docs/notes` — fixed-string, or a name holding `[`, `.` or `*` is read as a pattern and missed. Do this yourself rather than waiting to be told: the hook names a file's notes when a tool reads or writes it, but a host attaches that context to the tool's result, so a hint on the edit itself reaches you only once the edit has run. A change that contradicts a recorded intent is fine, and is exactly when a new note that supersedes the old one is owed.

## How the hook behaves

At the start of a session and at every user message, the hook derives the branch's change set from git, subtracts every path covered by a note that is itself part of that change set, and injects what is left. When a tool reads or writes a file some note covers, it names those notes and says which of them a later note replaced; after a tool writes to an uncovered file it says so immediately. That context arrives with the tool's result rather than ahead of it, which is why a hint on a read is worth more than one on the edit, and why looking a file's notes up yourself comes first. It keeps no state between invocations, so the list is always the branch's current state rather than a record of what you have already done.

A write made through a shell command carries no file path the hook can resolve, so neither of those two arrives for it; the change still appears in the reminder at the next user message.

Nothing enforces any of this. The hook cannot hold the turn, does not warn the user, and has no way to tell whether a docstring was written or whether a note says anything true: the injected reminder is the only notice there is. Never leave a change unrecorded because no one is checking, never move a change somewhere the gate does not look, and never write a note or a docstring whose only purpose is to make the reminder go quiet.

The hook is a workflow guardrail, not a security sandbox. Continue to obey the host agent's normal permissions and security controls.
