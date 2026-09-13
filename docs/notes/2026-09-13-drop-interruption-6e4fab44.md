---
covers:
  - .gitattributes
  - core/command.mjs
  - core/changes.mjs
  - core/control/pass
  - core/control/bypass-low
  - core/snapshot.mjs
  - core/state.mjs
  - tests/changes.test.mjs
  - tests/codex.test.mjs
  - tests/config.test.mjs
  - tests/entrypoint.test.mjs
  - tests/fail-closed.test.mjs
  - tests/helpers.mjs
  - tests/kiro.test.mjs
  - tests/snapshot.test.mjs
  - tests/state.test.mjs
  - tests/stop.test.mjs
  - tests/tool-policy.test.mjs
---

# What this change was for

The gate used to stop the user. At MEDIUM it wanted an insight; at HIGH and
CRITICAL it put a transfer question and held the turn until the user answered
one. In practice the questions landed without enough shared context to be
answerable, were often too narrow to teach anything, and the held turn
interrupted work to ask them. The user asked for all of it to go: the
questions, the turn hold, and the warning that replaced the hold on hosts that
could not hold.

# The approach, and what it rejected

Removing only the question was the obvious smaller change, and it was rejected
because it leaves the machinery without a job it can do. The pass and LOW
bypass control actions existed for one reason: an insight is not machine
checkable, so the agent had to attest to having written one by reading a
plugin-owned marker file whose read the hook could confirm. A gate that
refuses nothing and holds nothing has nothing to unlock. Keeping the controls
would have meant keeping `core/control`, the arm/complete protocol, Cursor's
byte-count read evidence, and Codex's pinned shell bridge — all of it
live-verified and hard-won, and all of it now guarding a door with no lock.

The second rejected option was to keep the per-session baseline snapshot and
simply stop acting on it. That would have preserved a subtler problem: the
baseline made "changed" mean "changed since the last time the gate looked",
which only matters when something is being held. What a record actually has to
cover is the branch — the same set a reviewer sees in the pull request. So
change detection became the branch's diff from its merge base plus the working
tree, derived fresh from git on every call.

Deriving it fresh is what removes the state. With no baseline to retake there
is no session identity to key it by, no turn identity to bind a control to, no
`outstanding` flag to clear, and no failure mode where a snapshot that could
not be taken leaves a record that can never be cleared. `core/state.mjs` (395
lines) and `core/snapshot.mjs` (192 lines) became `core/changes.mjs` (120).

# How it is built

`core/changes.mjs` is the whole of change detection. `changedPaths` resolves
the repository, picks a base ref (`refs/remotes/origin/HEAD`, then
`origin/main`, `origin/master`, `main`, `master` — the first that exists),
and unions two halves: `git diff --name-only --no-renames <merge-base> HEAD`
and `git status --porcelain=v1 -z --untracked-files=all`. `--no-renames` and
the porcelain rename fields both name the old path as well as the new one,
because a record attached to the old path has to follow.

Every failure returns `null` rather than throwing or guessing, and `null`
produces no notice at all. That is the load-bearing choice in the file: the
reminder is the only signal the plugin has, and a hook that crashed would
remove it silently.

`core/gate.mjs` keeps only the per-host output shapes, which are the part that
was expensive to learn and is unchanged. Cross-worktree watching was dropped
along with the rest: it existed because a held turn invited relocating a
change to escape it, and with nothing to escape, the branch being worked in is
the branch a record belongs to.

The hook registrations in `hooks/hooks.json` and the three adapters were
deliberately left untouched even though `PreToolUse`, `PostToolUse`, and
`Stop` now only allow. That wiring is the live-verified part, and it is about
to be given a real job.
