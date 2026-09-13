---
covers:
  - core/changes.mjs
  - core/gate.mjs
  - core/notes.mjs
  - tests/changes.test.mjs
  - tests/gate.test.mjs
  - tests/notes.test.mjs
---

# One rule for every question asked of git: only silence means nothing is there

## What this change was for

Twenty-odd rounds of review had all found the same shape of defect, one
instance at a time: the change set comes back empty or short, the hook says
nothing, and under a design whose only output is injected text, nobody ever
learns a change went unrecorded. Each round fixed the instance. None of them
fixed the reason there was always another one.

So the code was audited as a whole rather than patched again — eight
independent lenses over `core/`, every finding reproduced by hand before it
was believed, each one then put to three adversarial verifiers. Nine defects
survived that. They are not nine unrelated bugs.

## The approach, and what it rejected

Eight of the nine are the same mistake: **a question git could not answer was
read as a question answered "no".**

- No base ref resolved → "the committed half is empty", when it had never been
  computed. The shape that produces it is `git clone --single-branch --branch
  <x>`, which writes no `origin/HEAD` and fetches no `main` — how CI runners,
  devcontainers and agent sandboxes check out, and how any repository whose
  trunk is not called main or master always looks.
- No merge base with the base ref → "empty", when the branch has every one of
  its commits and which of them a reviewer would call new is simply unknowable
  from here.
- `git status` warned on stderr and exited 0 → "this is the whole tree", when
  git had just said it could not open part of it.
- A file name decoded as UTF-8 too early → two files became one path, and one
  of them left the change set without a trace.
- Both halves failing returned `null`, which is also how a directory that is
  not a repository answers → the hook went silent over a branch it could not
  read at all.

The fix is one rule rather than five patches: **only one failure means "there
is nothing here" — git exited 1 and said nothing.** Everything else is a
question that could not be answered, and an unanswered question makes the list
short and says so. That rule already existed for signals and timeouts; it now
covers the absence of a ref, the absence of a merge base, a warning on a
successful exit, and a repository nothing could be read from.

Rejected: widening the base-ref candidate list to guess at `develop`, `trunk`
and friends, and falling back to the branch's own `@{upstream}`. Both look
helpful and are worse than the honest answer. The upstream of a
`--single-branch` clone is the branch itself, so adopting it would report the
committed half as empty **and mark it complete** — turning a list that admits
it is short into one that lies. Guessing at trunk names fails the same way the
moment the guess is wrong.

The ninth defect is different in kind and worth naming separately: two of the
three places that ask "is this path inside the repository" treated `..` as a
prefix rather than as a path segment, so a file called `..hidden.js` was
ruled outside — and `covers` entries were trimmed, so a note naming `app.js `
silenced `app.js`, a path it had never mentioned. Both are the same error as
the rest, pointed at names instead of at git: a string operation that looks
like tidying, quietly changing which file is being talked about.

## How it is built

`core/changes.mjs` runs git through `spawnSync` rather than `execFileSync`,
because stderr on a *successful* exit is the thing that has to be read. Three
callers sit on it: `run` for any question, `ask` for one whose answer is
required, and `listing` for a command that prints a list — which demands
silence as well as a clean exit. `isAbsence` is the single place that turns a
failure into "nothing here", and it requires exit 1, no signal, no spawn
error, and an empty stderr.

Stdout stays a `Buffer` until the last moment. Fields are split on NUL at the
byte level and decoded per path: UTF-8 when the bytes round-trip, and a
byte-by-byte percent escape when they do not, so two names that differ only in
an invalid byte stay two paths.

Every call runs with `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and their
relatives stripped from the environment. Each of them names a repository, an
index or an object store, and git obeys them over the directory it was pointed
at; inherited from the host they made the plugin answer about a tree nobody
asked about, confidently and completely. One consequence worth knowing: a test
can no longer break a half by pointing `GIT_INDEX_FILE` somewhere useless, and
makes the index itself unreadable instead.

`null` from `changedPaths` now means one thing only — this is not a
repository. A repository nothing could be read from returns an empty set that
admits why it is empty.

## What was found and deliberately not changed

Recorded here so it is not rediscovered as new:

- **A note covers a path for the rest of the branch.** Once a path is covered,
  further changes to that file are not reported again. Scoping coverage to the
  change set fixed this across branches; inside one branch it stands, and the
  pre-write hint is what answers for it.
- **The git range is also the coverage scope.** On a stacked branch, a note
  explaining an earlier, unmerged change covers paths this change rewrote.
  Same mechanism as above, seen from a different angle.
- **An uncommitted note is in the working-tree half forever**, so it covers its
  paths for as long as it goes uncommitted.
- **A conflicted rebase** drops the not-yet-replayed commits out of the change
  set. The list is short and says so only if a half actually failed; here it
  does not.

Each of these is a consequence of coverage being decided per path rather than
per change, which is the trade the note format was chosen for. They are
limitations, not accidents, and the README says so.
