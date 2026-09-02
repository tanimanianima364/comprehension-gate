# Diff gate: explain the change before the turn ends

Date: 2026-09-02
Status: approved in discussion, awaiting spec review
Supersedes: the pre-write deny gate shipped through 0.5.0

## Goal

Keep the user able to explain, in their own words, the code an agent writes into
their project, without limiting anything the agent does while it works.

The gate shipped through 0.5.0 denied writes until the user explained the
planned change. That cost exploration in ways that turned out to be structural
rather than fixable case by case: any write, including a scratch file, a
`node -e` experiment, or a script run, was refused; an agent whose hypothesis
needed a file to test it would silently drop the hypothesis instead of asking
a question it could not yet formulate; and this user's harness routes edits
through the shell in auto mode, so a rule that stopped only the named write
tools would have guarded nothing.

The new gate never refuses a tool. It records what the project looked like the
last time its state was explained, and when the agent tries to end a turn in
which the project changed without an explanation, it holds the turn open on
hosts that allow it and asks the agent to put the question to the user.

## Non-goals

- Sandboxing. The gate guards a cooperative agent. It does not try to stop an
  agent that wants to evade it, and it accepts every residual that follows.
- Judging what a change means. The hook detects that the project changed; the
  agent still classifies the change (LOW, MEDIUM, HIGH, CRITICAL) and judges
  the explanation, exactly as before.
- Projects that are not git repositories. The gate is inactive there and says
  so at session start.

## What "the project changed" means

**Project.** The git repository that contains the hook's working directory
(`cwd`; on Cursor, each entry of `workspace_roots`). It is identified by
`git rev-parse --git-common-dir`, and every worktree of that repository from
`git worktree list --porcelain` is part of it. A worktree created anywhere is
inside the project, so working in a worktree does not slip past the gate.

**Snapshot.** For each worktree: the HEAD commit id, and for every path that
`git status --porcelain=v1 -z --untracked-files=all` reports, a content hash
(a marker for a deleted path). A commit shows up as a HEAD change, so a turn
that edits and commits is still a change; an edit, an added file, and a deleted
file show up as path entries. Ignored files are never listed, so anything
under a gitignored directory, in `/tmp`, or in the host's scratchpad is free.

**Baseline.** The snapshot of the last state that was explained. It is taken
at `SessionStart`, and retaken whenever a control action (pass or LOW bypass)
completes. `UserPromptSubmit` retakes it only when nothing unexplained is
outstanding, so edits the user made between turns are theirs and are not put
to them as a question; while a change is outstanding the baseline stays where
it was, so changing the subject does not make the change go away.

**Difference.** Two snapshots differ when any worktree's HEAD differs or any
path's hash differs, appears, or disappears. The paths involved are reported
to the agent in the hold reason.

Cost is one `git status` per worktree plus hashing the listed files, tens of
milliseconds on an ordinary repository. The Stop hook timeout is raised from
5 seconds to 20.

## State

Per session, as now keyed by provider and `session_id`:

- `baseline`: the snapshot described above (per worktree: HEAD, path -> hash).
- `outstanding`: true once a Stop found an unexplained change and until a
  control action completes.
- `passedTurn`: the turn id in which the last control action completed, or
  null. Turn id is `prompt_id` (Claude Code), `generation_id` (Cursor), or the
  session's `requestSequence` counter when the host supplies none (Kiro).
- `requestSequence`, control arming records, and the workspace pin as now.

The transcript fallback for hosts without a turn id is removed. It existed for
Claude Code releases before `prompt_id`; the README states the minimum
supported release (2.1.196) instead.

## Events

- `SessionStart`: inject the instructions; take the baseline (or record that the
  directory is not a git repository and say so in the injected context).
- `UserPromptSubmit`: increment `requestSequence`; if `outstanding` is false,
  retake the baseline; if true, inject "an unexplained change is outstanding:
  ask for the explanation before doing anything else".
- `PreToolUse`: always allow. Its only remaining job is arming a control
  marker when a native read targets the pass or bypass-low file.
- `PostToolUse`: complete an armed control as now; on completion, retake the
  baseline, clear `outstanding`, set `passedTurn`.
- `Stop`: take the current snapshot and compare with the baseline.
  - No difference: allow.
  - Difference and `passedTurn` equals this turn: retake the baseline, allow.
    This is what makes a pass given before the writes cover them, so the
    agent is not asked twice.
  - Difference and no pass this turn: set `outstanding`, then act per host.

## Per-host behavior on an unexplained change at Stop

| Host | What the hook does | Verified against a live host |
| --- | --- | --- |
| Claude Code | First Stop of the turn (`stop_hook_active` false): return `decision: block` with the hold reason, so the agent asks its question instead of finishing. The agent's question ends the turn, so the second Stop (`stop_hook_active` true) allows and returns a `systemMessage` telling the user an unexplained change remains. One hold per turn. | to verify during implementation |
| Codex | Same payload as Claude Code through the shared `hooks/hooks.json`. | no; Stop support in Codex is unverified |
| Cursor | `status` other than `completed`, or `loop_count` above 0: return `{}`. Otherwise return the hold reason as `followup_message`, with `loop_limit: 1` in the adapter. | no |
| Kiro 2.x / 3.x | Cannot hold or continue the turn. Exit non-zero with the hold reason on stderr, which the host shows as a warning; the next `userPromptSubmit` injects the outstanding notice. | trigger `stop` exists in 2.16.2; per-turn firing to verify |

The hold reason names the changed paths and says: classify the change, ask the
user to explain it at the required level, and do not undo or move the change to
avoid the question.

`SubagentStop` is not hooked; a subagent's writes are part of the diff the main
Stop sees. Whether Stop fires in headless (`-p`) mode is unverified; if it does
not, a headless run ends without a notice.

## Instructions (`core/instructions.md`)

Keep: the four levels and what each requires; the rule that bare confirmations
do not count; acknowledging the correct part of a partial answer and asking one
focused follow-up; the exact control actions; never performing a control action
merely because the user asks to skip the gate.

Change the premise: the agent works normally, explores, experiments, and writes.
Before ending a turn in which the project changed, it classifies the change and
asks the user to explain it. The explanation may come before the writes (the
user describes the design and the agent passes first) or after (the agent
shows what it wrote and asks); a pass in the same turn covers that turn's
changes either way. One new prohibition: do not revert a change, or move it
somewhere the gate does not look, to avoid the question.

Remove: the shell read/write rules, the "no build or test before pass" rule,
the Codex inspection commands, and the non-Linux note.

## Removals

- `core/shell.mjs`, `tests/shell-policy.test.mjs`.
- `core/inspection.mjs`, `tests/inspection.test.mjs`,
  `tests/inspection-cwd.test.mjs`, and the pinned inspection command builder in
  `core/command.mjs` (`adapterCommand` stays; adapters still need it).
- In `core/gate.mjs`: `WRITE_TOOLS`, `SHELL_TOOLS`, the deny path, the
  non-Linux shell guard, the Codex inspection branch.
- `core/transcript.mjs`, `tests/transcript.test.mjs`, and the transcript
  fallback in `core/state.mjs`.
- The deny-based parts of `tests/codex.test.mjs` and `tests/tool-policy.test.mjs`.

## Additions

- `core/snapshot.mjs`: repository identification, worktree enumeration,
  snapshot capture, and comparison. Tests build a temporary repository and
  cover an edit, an added file, a deleted file, a commit with a clean tree, a
  second worktree, an ignored file, a rename, and a directory that is not a
  repository.
- Stop handling and baseline maintenance in `core/gate.mjs`. Tests cover: no
  change; change with a pass in the same turn; change with a pass in an earlier
  turn (still held); `stop_hook_active` true; the outstanding flag carried
  across a `UserPromptSubmit`; Cursor `status` and `loop_count`; Kiro exit code
  and stderr; a non-repository session.
- `Stop` in `hooks/hooks.json`; `stop` in `adapters/cursor/hooks.json` and
  `adapters/kiro-2x/hooks.json`; `Stop` in `adapters/kiro/hooks.json`.
- README: rewrite "How it works" and the adapter table (add a column for whether
  the host can hold the turn); keep the security-boundary section and state
  that no tool is ever refused.

## Live verification before release

1. Claude Code: a turn that edits a file is held once, the agent asks, the
   second Stop allows with the user-facing message; a pass then clears it.
2. Kiro CLI 2.16.2: capture the `stop` payload to confirm it fires per turn and
   carries `cwd`, using the same payload-capture approach as the 2.x adapter
   work.

## Versioning

Release as 0.6.0. The semantics change, so the release notes say plainly that
the gate no longer refuses any tool and holds the turn instead.

## Open questions

- Whether Claude Code accepts `systemMessage` alongside `decision: block`, or
  only with an allow. Resolved by the live check.
- Whether Kiro 2.x `stop` fires per turn or only at session end. If only at
  session end, Kiro degrades to the `userPromptSubmit` notice alone.
