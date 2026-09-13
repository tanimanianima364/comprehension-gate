---
covers:
  - README.md
  - core/changes.mjs
  - core/gate.mjs
  - core/instructions.md
  - skills/comprehension-gate/SKILL.md
  - tests/changes.test.mjs
  - tests/config.test.mjs
---

# The change set has to be exactly right, because nothing else is watching

## What this change was for

Review found three ways the change set silently lost paths it was supposed to
report. All three were reproduced before anything was changed.

1. An unstaged rename — a plain move plus `git add -N` — reported ` R`, with
   the R in git's working-tree column rather than its index column. Only the
   index column was tested, so the original path was read as the next entry's
   status line: `old.js` vanished and `.js` was reported in its place.
2. `origin/HEAD` was adopted without being resolved. Renaming a remote default
   branch and pruning leaves it pointing at a branch that no longer exists;
   `merge-base` then failed, the committed half of the change set came back
   empty, and a commit on the branch was never reported at all.
3. The manual skill carried its own `git merge-base HEAD origin/HEAD`
   one-liner. In a repository with no remote that resolved nothing, the outer
   `git diff` succeeded with empty output, and the skill saw no change
   whatsoever; over a committed rename it named only the new path where the
   hook names both.

## The approach, and what it rejected

The first two are ordinary bugs with ordinary fixes: test both status columns,
and resolve every base candidate — `origin/HEAD` included — to a commit before
adopting it, falling through to `origin/main` when it dangles.

What they have in common is what made them worth a note. This plugin removed
every form of enforcement: nothing holds a turn, nothing warns the user,
nothing blocks. The injected reminder is the entire mechanism. A gate that
refuses things fails loudly when its detection is wrong, because someone is
stopped who should not have been; this one fails *silently* — the reminder
simply does not mention a path, and no one ever learns it was missed. So the
fail-soft policy the code already followed has a sharp edge: soft failure is
right when git cannot answer at all, and wrong when git can answer and the
answer is misread. Both fixes push cases out of the second category.

The third is a design fault rather than a bug, and the fix is structural. The
skill was rewritten to run the plugin's own code instead of prose describing
what the code does. Two alternatives were rejected: writing a more careful git
one-liner in the skill, which only moves the divergence a little further away
and has to be kept in step by hand forever; and having the skill read the
hook's last injected reminder, which is the *uncovered* set rather than the
change set, and is stale by the time a mid-turn skill invocation reads it.

Passing the command through the instructions, rather than hard-coding a path
in the skill, is the same indirection the plugin's deleted control actions used
— the one part of that design worth keeping. It is the only way the skill can
name an absolute path it cannot know, and it works on every host because the
instructions are injected at session start. Both the runtime and the script
path are single-quoted, because a plugin installed under a directory with a
space or a quote in its name would otherwise become shell syntax.

## What "collected" has to mean

The same principle reached the notice itself, one round later. Reporting a
partial change set is right, but only if the partiality is said out loud:
silence has to mean "everything is recorded", and a half that could not be read
is not an empty half. Three places were dropping that distinction --
`committedPaths` swallowed a failed `merge-base` into an empty list, the command
printed a bare array, and the notice returned early on an empty or fully
covered set before looking at whether it had been collected whole.

The subtle one is `merge-base`. A repository with no common ancestor is
legitimately empty on that half, and git answers 1 for that and for a commit it
could not read. Only the second writes to stderr, so stderr is what separates
them, and it is captured for that reason rather than discarded.

## How it is built

`workingTreePaths` tests `field[0]` and `field[1]` through one
`isRenameOrCopy` helper, so the original path is consumed whichever column
carries the rename. `resolveBase` iterates `[originHead(root),
...BASE_CANDIDATES]` and verifies each with `rev-parse --verify
<ref>^{commit}`, which collapses what used to be two different code paths —
an unverified symbolic-ref and a verified candidate list — into one rule:
nothing is adopted that does not name a commit.

`core/changes.mjs` is now runnable as well as importable, printing the change
set one path per line, and `renderInstructions` substitutes the quoted command
into the instructions. The regression test for the third fault asserts the
command's output is *identical* to `changedPaths`, in a fixture built from the
exact cases where the old one-liner diverged: a repository with no remote, and
a committed rename. That equality is the property worth keeping, so the test
asserts equality rather than re-describing the expected list.
