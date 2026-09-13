---
covers:
  - README.md
  - core/changes.mjs
  - core/gate.mjs
  - core/instructions.md
  - core/notes.mjs
  - skills/comprehension-gate/SKILL.md
  - tests/covering.test.mjs
  - tests/notes.test.mjs
---

# A record is surfaced at the file, as a backstop to looking it up

## What this change was for

A note is only worth writing if someone finds it later. Grep answers that only
for a reader who already suspects a note exists, which is exactly not the case
when they do not. So the record had to arrive on its own, at the file.

What "on its own" can mean turned out to be narrower than it first looked. A
host attaches `PreToolUse` context to the *tool's result*, not ahead of the
call, so a hint on an `Edit` reaches the agent only once that edit has run.
Making it arrive first would mean `permissionDecision: "ask"` or a deny — the
blocking this whole design removed. So the hook cannot be the plan; it can only
be the backstop.

## The approach, and what it rejected

**Surfacing.** The notes covering a path are named at `PreToolUse`, with their
titles and with any note a later one replaced marked as superseded, so a reader
is not sent to the stale record first. Only the names and titles are injected,
not the bodies: a path covered by several notes would otherwise push kilobytes
of prose into every edit, and reading one is a single tool call away.

The hint fires on reads as well as writes, which is the answer to the timing.
An agent reads a file before changing it, and context attached to *that*
result arrives before the edit is decided. The instructions were also changed
back to telling the agent to look a file's notes up itself first; that
instruction had been dropped in the first draft of this change on the
assumption the hook would arrive in time, which it does not.

Resolving which tool is about to write is done by matching the tool's name
against a pattern, which the plugin's old control protocol explicitly refused
to do — a name proves nothing across hosts. The difference is what the decision
gates. There, a name decided whether the gate opened, so a wrong guess defeated
it; here it decides whether a hint is offered, so a wrong guess costs a missing
hint or a harmless one. A pattern that catches every host's spelling is the
right trade at that stake; a list that misses a new host's spelling is not.

A shell command carries no path to resolve and gets no hint. Extracting paths
from command strings was rejected: it is unreliable in exactly the cases that
matter, and the change still surfaces in the reminder at the next message.

Cursor is excluded from both tool events. Its `preToolUse` is registered
`failClosed` and its output schema has not been verified to carry context, so
an unrecognized field risks failing every tool call — a much worse outcome than
no hint.

**Not scoped like coverage.** Naming a path's notes deliberately ignores the
change set that coverage is scoped to. The question here is what is on record
about this file, and a note an earlier branch left is exactly what someone
about to edit it should read. It is also what answers for a path already
covered inside this branch, which the reminder has stopped naming.

**Reading a payload, not a command.** A tool's target is taken from its
structured input: the path keys, every entry of Kiro's `operations`, and the
`*** ... File:` headers of a Codex `apply_patch` envelope. That last one is a
format with its own grammar, not a shell command; an ordinary shell command is
still left alone, because guessing which files `sed -i` will touch is exactly
the unreliable parsing this avoids.

## How it is built

`notesCovering(root, path)` returns a path's notes oldest file name first, each
with its title — the first `#` heading in the body — and with `supersededBy`
filled in by scanning every note's `supersedes` list for its id. `uncoveredPaths`
now takes the change set rather than an arbitrary list of paths, and ignores
any note whose file is not in it.

`core/gate.mjs` grew `toolTarget`, which resolves a tool payload to a
repository-relative path and returns null for everything it cannot place. Both
tool events are built on it, so the cost is paid only when a tool looks like it
wrote a file: `PreToolUse` needs one `git rev-parse` and a walk of the notes
tree, `PostToolUse` the same plus the two git calls the prompt notice costs.

`PostToolUse` reports the whole remaining uncovered set rather than just the
path that was written, and it fires for a write to the notes tree as well —
that is precisely when the remaining list changed. The note's own path is never
in the reported set, so writing a note never asks for a note about the note.

The note format gained one rule from using it: the first `#` heading is the
title the hook shows, so the body is headed by a line naming what the change
did, with `##` sections under it. The first two notes in this repository were
written before that rule existed and were reshaped to follow it.
