---
name: comprehension-gate
description: Record why the current change was made — a note under docs/notes plus the docstrings on what changed. Use when the user asks to account for a current change, to write the note for it, or explicitly requests a comprehension gate.
---

# Comprehension Gate

Record the change this branch has made. The change is everything this branch has done that its base has not — committed and uncommitted alike. Print it by running the exact change set command the active Comprehension Gate session instructions supply, which runs the same code the hook runs. Do not write a `git diff` of your own instead: resolving the base branch and naming both halves of a rename are easy to get wrong in a one-liner, and a change set that disagrees with the hook's is worse than none. If no session instructions are present, say so rather than guessing at a command.

This check was asked for, so it does not get skipped as mechanical. Produce both records.

**The docstrings.** On every file and function the branch added or meaningfully changed, leave a docstring in the language's own convention saying what it is for and, where there was a choice, why it works this way. Do not restate the code: a docstring that narrates the steps costs a reader time and rots as soon as the code moves. Match the density of the surrounding file.

**The note.** Write `docs/notes/YYYY-MM-DD-<short-slug>-<8 random hex characters>.md` with front matter listing, under `covers`, every repository-relative path it accounts for, and under `supersedes`, any earlier note this change invalidates. Cover three things in the body: what the change was for in the user's terms, the approach and at least one alternative that was rejected and why, and how it is built — which pieces are load-bearing and which are incidental.

Never edit or delete an existing note to make it agree with new work. A note records what was believed when it was written; a change that contradicts one writes a new note that supersedes it.

`covers` is the only part a machine reads, so keep it exact, and never widen it to a path the note does not actually explain.

Ask the user nothing. This gate puts no question to anyone: it is a record you leave, not a test you set. When both records are written, say briefly what you recorded and where.
