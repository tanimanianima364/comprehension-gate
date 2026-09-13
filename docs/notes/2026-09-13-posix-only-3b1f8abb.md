---
covers:
  - README.md
  - core/gate.mjs
  - core/instructions.md
  - core/notes.mjs
  - tests/changes.test.mjs
---

# Windows went out of scope, and the portability it bought went with it

## What this change was for

The rendered change set command was spelled for two shells, and repository
paths were translated between two separator conventions. Both existed for a
host nobody here runs and nobody here can test against.

The two-shell rendering arrived from review: PowerShell needs the call
operator before a quoted executable, and it recognizes four more characters as
single quotes than the ASCII one. The observation was correct. What was not
checked — by me, before implementing it — was whether either supported host
actually runs this command through PowerShell on Windows. It was added on an
assumption, and the user has since said Windows is not wanted.

## The approach, and what it rejected

Keeping it "just in case" was the alternative. It was rejected on the same
ground the Kiro and Cursor adapters were: an untestable accommodation for a
host nobody exercises is a claim the README cannot honestly make, and it has a
running cost. Here the cost is not only the second quoting rule.

The separator translation is the sharper half. Converting `\` to `/` is right
on a host whose separator is a backslash and wrong on one where a backslash is
an ordinary character in a file name — and this plugin had already shipped
exactly that bug once, in the other direction, where rewriting a git path's
backslash made a changed file look as though it sat under `docs/notes` and
vanish from the reminder. Carrying a conditional for Windows means carrying
the shape of that mistake next to code that must not make it.

Failure here is also loud rather than silent, which made the decision easier:
a command a shell cannot run produces an error the agent sees, and it falls
back to reading. That is not the class of failure this design is built to
avoid.

This does not supersede the note that introduced the two-shell rendering. The
three change set fidelity fixes it records still hold; only its last paragraph
about spelling the command for PowerShell is overturned, which is a refinement
rather than a replacement — the hook names a path's notes oldest first, so the
two read in order.

## How it is built

`renderInstructions` substitutes one command, single-quoted POSIX style, and
`powerShellQuote` is gone. `repositoryPath` and `repositoryRelative` return
what `path.relative` gives them, with no separator rewriting: on POSIX that is
already the spelling git uses. The README says POSIX only, in its own section,
rather than leaving it to be inferred.
