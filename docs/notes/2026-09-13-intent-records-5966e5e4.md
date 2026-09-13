---
covers:
  - README.md
  - core/gate.mjs
  - core/instructions.md
  - core/notes.mjs
  - skills/comprehension-gate/SKILL.md
  - tests/gate.test.mjs
  - tests/notes.test.mjs
---

# Docstrings and immutable notes replaced the insight and the question

## What this change was for

Having removed the questions, the gate needed something to ask for in their
place. The goal is that a reader — human or agent — can recover from the
repository what the coding agent was trying to achieve and why it built things
this way, without having to reconstruct it from the diff.

Two concerns shaped the design, both raised before any code was written: how
records merge when two pull requests touch the same subject, and how someone
editing a file later finds out that a record about it exists.

## The approach, and what it rejected

The records are split in two because the two concerns pull in opposite
directions.

A **docstring** describes the current state of a file or function. Being
final-state, it merges the way code merges: whoever resolves the conflict
writes what the code now does, and no extra mechanism is needed. That answers
the merge question for everything the code can say about itself.

A **note** describes one change at one moment — the goal, the approach, the
alternative that was rejected. Final-state semantics destroy exactly that: a
living per-module document rewritten on each change loses the history that
makes it worth keeping, and produces prose merge conflicts across pull
requests. So notes are immutable, one file per change, and a later change that
invalidates one writes a new note naming it in `supersedes` rather than
editing it. Two branches then never touch the same note, so the merge is a
union by construction. This is the ADR pattern, adopted rather than invented.

For discovery, grep was rejected as the primary mechanism: it only works when
someone thinks to grep, which is precisely not the case when they do not know
a record exists. Encoding a hash of the covered paths into the note's filename
was also rejected as the source of truth — it is grep-able without the plugin,
but the filename length caps how many paths one note can cover, renames break
it silently, and it costs the readability of `ls`. Front matter carries the
truth instead, and the hook does the noticing. Deriving the index at runtime
rather than committing one is deliberate: a committed index is a shared file
every branch edits, which would reintroduce the merge conflict the immutable
notes were designed to avoid.

Requiring exact repository-relative paths in `covers`, rather than allowing
globs or directories, is the other deliberate constraint. `covers: [core/]`
would silence the reminder for a whole subtree without explaining any of it.

## How it is built

`core/notes.mjs` exposes one function, `uncoveredPaths(root, paths)`. It walks
`docs/notes` for markdown files, reads `covers` out of each one's front
matter, normalizes each entry to a repository-relative POSIX path, and returns
the candidates no note claims. `core/gate.mjs` subtracts that from the branch's
change set before building the notice, so a fully covered branch produces no
notice at all and the plugin goes quiet.

Front matter is parsed by hand rather than with a YAML dependency: exactly one
key has to be machine-read, and it is a list of strings. Both the block list
and the inline `covers: [a, b]` spelling are accepted — not for generality,
but because a note whose list is spelled the other way would silently cover
nothing, and silence is the one failure this design cannot afford.

Everything fails soft, for the same reason. An unreadable note, an
unterminated front matter block, a missing `covers`, an entry that escapes the
repository: each covers nothing and leaves its paths reported. Reporting a
path as uncovered is always recoverable; throwing away the hook is not.

`docs/notes` itself is excluded from the reported set, so writing a note does
not demand a note about the note.

Nothing here judges whether a path deserves a note. That judgment is the
agent's, stated in `core/instructions.md`, and a purely mechanical change is
expected to sit in the reminder uncovered forever. The mechanical check answers
only "is there a record naming this path", which is the part a machine can
actually know.
