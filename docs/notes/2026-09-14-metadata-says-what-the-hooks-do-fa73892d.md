---
covers:
  - .claude-plugin/marketplace.json
  - .claude-plugin/plugin.json
  - .codex-plugin/plugin.json
  - package.json
  - skills/comprehension-gate/agents/openai.yaml
  - tests/config.test.mjs
---

# The metadata describes what the hooks do, and tests keep it that way

## What this change was for

Every description a host shows a user -- three plugin manifests,
`package.json`, and the Codex skill metadata -- still described the plugin
that asked questions and blocked writes until they were answered. That
behaviour was removed a stack of changes ago; its wording outlived it in the
one place a person reads before installing. The user asked for the
descriptions to say what the plugin now does.

## The approach, and what it rejected

One sentence, checked against `core/instructions.md` and repeated
verbatim in every manifest, rather than a paraphrase per file. Two
drafts were wrong in ways worth recording, because each was a natural
way to overstate the design:

- "an immutable note for each change" promised more than the rule. The
  instructions say a purely mechanical change needs no note, so the
  sentence says "for any change that is more than mechanical", and the
  marketplace summary says "where it was more than mechanical". A blurb
  that promises a record for every change teaches the reader the wrong
  rule before they have read the right one.
- "show it the notes before it edits" was wrong twice. The hook names the
  notes covering a path -- their file names and titles -- and does not show
  their contents; and tool-event context arrives with the tool result, so
  nothing is guaranteed before the edit itself. The read that precedes an
  edit is where the hint lands in time, which is what "as it is read or
  edited" says.

The Codex skill metadata follows OpenAI's `openai.yaml` reference rather
than mirroring the manifest prose: `default_prompt` must name the skill as
`$comprehension-gate` for the host to route it, and `short_description` is
a 25-64 character blurb. Naming the skill also puts an explicit request on
the path `SKILL.md` describes, where both records are produced even for a
mechanical change -- the manual path is deliberate, the hook path is not.

Rejected: leaving the wording to review. It had already slipped past three
rounds of it. The constraints are now tests: no user-facing file may carry
the removed workflow's phrases or promise a note for each or every change;
the skill metadata must name the skill and keep its blurb within the
reference's bounds; the four manifests must give one description. These
are rules the code enforces from here on, which is why this note exists:
the wording is metadata, the tests are a constraint.

Also rejected: renaming the plugin, which is in the install commands, the
hook messages and the instructions and is a separate decision; and raising
the version, which a release does in all three manifests together.

## How it is built

The manifests and `openai.yaml` carry the strings. `tests/config.test.mjs`
reads each user-facing file as text -- there is no YAML dependency, so the
two `openai.yaml` fields are taken by regular expression -- and asserts the
constraints above. Written first, the phrase test failed on `openai.yaml`
alone and the per-change test on `marketplace.json` alone: exactly the two
files two rounds of review had found.
