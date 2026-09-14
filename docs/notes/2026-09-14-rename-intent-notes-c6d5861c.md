---
covers:
  - .claude-plugin/marketplace.json
  - .claude-plugin/plugin.json
  - .codex-plugin/plugin.json
  - .gitignore
  - README.md
  - core/gate.mjs
  - core/instructions.md
  - package.json
  - skills/intent-notes/SKILL.md
  - skills/intent-notes/agents/openai.yaml
  - tests/config.test.mjs
  - tests/covering.test.mjs
  - tests/entrypoint.test.mjs
  - tests/gate.test.mjs
  - tests/helpers.mjs
---

# The plugin is called Intent Notes, and 0.8.0 is the release that says so

## What this change was for

"Comprehension Gate" named a plugin that asked questions and held the turn
until they were answered. None of that remains: the plugin now asks for
docstrings and an immutable note per non-mechanical change, and names a
path's notes as it is read or edited. A name that promises a gate misleads
the person installing it and the agent reading the hook's messages. The
user chose `intent-notes` from three candidates, and asked for the rename
and the release to land as one change.

## The approach, and what it rejected

Everything a user or a host sees changes at once: the three manifests and
`package.json` (name, author, display name, `$intent-notes` in the default
prompt), the skill directory and its metadata, the prefix on every hook
message, the title of the injected instructions, and the README's install
commands, which now point at `tanimanianima364/intent-notes`. The GitHub
repository is renamed to match when this merges, since GitHub redirects the
old name to the new one and not the reverse -- the README's commands would
otherwise name a repository that does not exist yet.

Left alone: the file names under `core/` (`gate.mjs` is referenced by
`hooks/hooks.json` and is not user-facing), every earlier note (immutable;
they record the name the plugin had when they were written), and the old
plan under `docs/superpowers`, which describes a design that no longer
exists and is not read by anything.

Rejected: renaming in one change and releasing in another. A release is
what makes `plugin update` notice anything -- it compares versions, not
commits -- so a rename without a version bump leaves every installed copy
under the old name and description, and a version bump alone would ship
the old name one more time. 0.8.0 rather than 0.7.2 because the install
command changes: an installed `comprehension-gate@comprehension-gate` is not
updated to this, it is replaced by `intent-notes@intent-notes`.

Two words in the prose changed with the name: the skill "puts no question
to anyone" and the instructions state "the purpose of this plugin", where
both had said "this gate". The `.gitignore` entry for a state directory the
plugin stopped writing several changes ago went too; it was the last thing
carrying the old name.

## How it is built

A mechanical substitution, checked by the suite: the tests that read the
skill files, match the hook messages and the instructions title, and
require `$intent-notes` in the skill metadata all changed with it, and the
grep for the old name outside `docs/` is empty except for the test that
forbids the old workflow's phrases. The three manifests carry `0.8.0`
together, which is what `claude plugin tag` checks before tagging
`intent-notes--v0.8.0`.
