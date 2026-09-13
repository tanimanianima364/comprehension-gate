---
covers:
  - README.md
  - core/instructions.md
  - core/notes.mjs
  - tests/covering.test.mjs
  - tests/gate.test.mjs
  - tests/notes.test.mjs
---

# The note reader is held to the same spelling rules as the change set

## What this change was for

Review of the merged stack found three ways `core/notes.mjs` still let a
note cover a file it never named, and one test that only passed for a
non-root user. All three coverage defects are the same error the previous
rounds kept finding, pointed at a different string: something that looked
like tidying quietly changed which file was being talked about.

- The note's own path was compared to the change set *unencoded*. The change
  set spells `%` as `%25`, so a branch note called `n%.md` was never found in
  the set and covered nothing -- while a base note that happened to be called
  `n%25.md` was found, and covered this change with a record that had never
  been about it. Reproduced end to end: `src.js` changed, `uncovered: []`,
  hook silent.
- The entry pattern allowed any run of blanks after the dash, so the fixed
  prefix swallowed a leading space that belonged to the name. A note for
  ` app.js` covered `app.js` instead.
- The note file was read as UTF-8, which turns each invalid byte into U+FFFD
  rather than failing. An entry spelled with a raw `0xFF` then read as
  `src�.js` and covered a real file of that name.

## The approach, and what it rejected

Each fix is one rule, applied where it was missing rather than reinvented.

The note's path is compared to the change set under the same `encodePath`
spelling the change set and the tool payloads already use. That was the
design ("the same encoding has to be applied to a path that arrives as text")
-- this was simply the one text path it had not reached. But the spelling is a
matching key, not a file name. The first version of this fix encoded the path
itself, and the pre-edit hint then sent the reader to `n%25.md`: a file that
does not exist, or a different note that happens to be called that. So the
encoding is applied at the one comparison that needs it, and the path the
reader is handed -- in the hint and in `supersededBy` -- is the path on disk.

The entry prefix is `- ` with exactly one space, and the rest of the line is
the name, verbatim. Allowing `[ \t]+` after the dash and requiring `\S` at the
start of the name were both leniency in the direction that hides things. A tab
after the dash is now not an entry, which voids the list -- the safe side.

A note that does not round-trip through UTF-8 is not read. The alternative --
decode it and match whatever comes out -- is exactly what produced the U+FFFD
collision. Refusing the note leaves its paths reported, which someone notices;
reading it loosely silences a path nobody learns was missed.

Rejected: a lossless byte-level reader for notes. A note is a UTF-8 text file
by definition; one that is not is a broken note, and the right answer to a
broken note is to refuse it, not to invent a reading.

## How it is built

`coveredPaths` tests `inChangeSet.has(encodePath(note.file))`; `note.file`
itself is `path.relative(root, target)`, unencoded, and is what `notesCovering`
returns.
`ENTRY_LINE` is `/^\s+- (.*)$/` and an empty capture voids the list.
`readNotes` reads bytes, checks `Buffer.from(bytes.toString("utf8"), "utf8")`
equals the bytes, and skips the note otherwise. The half-collected-set hook
test gets the same root skip its sibling already had, since `chmod 000` does
not stop root from reading.

The README paragraph describing the note grammar had regressed to the
quoted-and-escaped dialect during the stack's squash merges, and a sentence
two paragraphs earlier still said an inline list was accepted; both now
describe the one grammar the parser has, and say that `%25` is the reader's
spelling, never the writer's. A test writes the README's and the
instructions' own samples as notes and asserts the paths they list come back
covered, so the documentation is no longer the one place nothing tested.
