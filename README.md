# Comprehension Gate

Comprehension Gate layers a deterministic explanation gate on top of an agent's learning behavior. It does not fork or replace the official `learning-output-style` plugin.

The hook never refuses a tool. It records the last explained state of the repository, and when the agent tries to end a turn in which the repository changed without an explanation, it holds the turn open on hosts that allow it and asks the agent to put the question to the user. The agent still decides whether a change is LOW, MEDIUM, HIGH, or CRITICAL and evaluates the user's explanation; the hook only owns turn control.

## Supported adapters

| Agent | Hook configuration | Holds the turn | Verified against a running host |
| --- | --- | --- | --- |
| Claude Code | `hooks/hooks.json` | yes | yes, 2.1.258: `decision: "block"` holds once, and `systemMessage` is shown to the user on both the blocking Stop and the second (allowed) Stop |
| Codex | the same `hooks/hooks.json` | unverified | no: whether Codex fires `Stop` at all is unverified |
| Cursor | Claude compatibility or `adapters/cursor/hooks.json` | follow-up message (cannot hold) | no |
| Kiro CLI 2.x | `adapters/kiro-2x/hooks.json`, merged into the agent config | warning only | yes, 2.16.2: `stop` fires once per turn (not only at session end) and carries `cwd` |
| Kiro CLI 3.x | `adapters/kiro/hooks.json` | warning only | no |

The last column is the honest one. Only Claude Code and Kiro CLI 2.x have been exercised against a running host; the other adapters were written from each vendor's documentation and are covered by tests that model the documented contract, not by a live run. Kiro CLI 3.x in particular is still early access at the time of writing, reached with `kiro-cli --v3`, so 2.x is what most installations have.

The two Kiro adapters differ only in packaging. 3.x reads standalone `.kiro/hooks/*.json` files; 2.x embeds the same triggers in the agent config under `hooks`. Payloads, tool names, and the exit-code-2 block are the same, so both render for the same entrypoint mode.

Two details of 2.x are worth knowing because its documentation is wrong about them, and both were found by capturing real hook payloads from 2.16.2 rather than by reading. The `matcher` is documented as a regex but is not one: only `"*"` or an omitted matcher fires for every tool, while `".*"` -- the value the vendor's own example uses -- fires for none, which would leave the gate silently absent rather than merely narrow. And no payload carries a session id; the hook process receives `KIRO_SESSION_ID` in its environment instead, which is where the gate reads it from.

## How it works

```text
SessionStart -> inject instructions, take the baseline snapshot
UserPromptSubmit -> new turn; retake the baseline unless a change is outstanding
PreToolUse -> always allow; a native read of a control target arms it
PostToolUse -> a completed control marks the turn passed and retakes the baseline
Stop -> compare the repository (every worktree, ignored files excluded) with the baseline
  no difference, or passed this turn -> allow
  otherwise -> record the change; Claude Code holds once, Cursor injects a follow-up, Kiro warns
```

A snapshot covers every worktree of the git repository that contains the hook's working directory (identified by `git rev-parse --git-common-dir` plus `git worktree list --porcelain`, so a worktree created anywhere is still inside the project). For each worktree it records the HEAD commit id and, for every path `git status --porcelain=v1 -z --untracked-files=all` reports, a content hash; a commit shows up as a HEAD change, so a turn that edits and commits still counts. Ignored files are never listed, so anything under a gitignored directory, in `/tmp`, or in the host's scratchpad is free. `git status` never descends into a nested repository or a submodule, reporting it as a single entry, so such an entry is hashed from the path, size and modification time of every file beneath it; that walk stops after 2000 files, and changes beyond the first 2000 files of a nested repository are not seen. The baseline is the snapshot of the last explained state: it is taken at `SessionStart`, retaken whenever a control action (pass or LOW bypass) completes, and retaken at `UserPromptSubmit` only when nothing unexplained is outstanding, so edits the user made between turns are theirs and are never put to them as a question. A directory that is not a git repository, or a snapshot that fails to capture (a corrupt index, for example), leaves the gate inactive for that session; it never blocks a prompt.

At `Stop` the hook compares the current snapshot with the baseline. With no difference, or when the same turn already completed a pass, it allows and (in the pass case) retakes the baseline. Otherwise it records the changed paths and acts per host. On Claude Code, the first Stop of a turn (`stop_hook_active` false) returns `decision: "block"` with the changed paths, so the agent asks its question instead of finishing; the agent's question ends the turn, and the second Stop (`stop_hook_active` true) allows and returns a `systemMessage` telling the user an unexplained change remains. This holds the turn once, never twice. Cursor cannot hold the turn; when `status` is `"completed"` and `loop_count` is `0` it returns the hold reason as a `followup_message` (`loop_limit: 1` in the adapter), and returns `{}` otherwise, including after an aborted turn. Cursor's prompt hook carries no context field, so on Cursor the outstanding notice reaches the agent only through the stop follow-up message. Kiro CLI, on both 2.x and 3.x, can only warn: the hook exits non-zero with the hold reason on stderr, which the host shows as a warning, and the next `UserPromptSubmit` injects the outstanding notice into context. `SubagentStop` is not hooked; a subagent's writes are part of the diff the main `Stop` sees.

Turn identity is `prompt_id` (Claude Code), `generation_id` (Cursor), or `turn_id`. A host that supplies none (Kiro) has its gate reset at every prompt, so there a turn is whatever lies between two prompts. A `Stop` payload that carries no turn id is treated as belonging to the current turn, so a host that omits it can still be held or warned correctly.

State is stored outside the project, keyed by a SHA-256 digest of provider plus `session_id`. Per session it holds `baseline` (per worktree: HEAD and each path's content hash), `outstanding` (true once a `Stop` found an unexplained change, until a control action completes), `turnId` (the current turn's id), `status`, `requestSequence`, and the list of changed paths, capped at 50. "Passed this turn" is derived from those two: `status` is `passed` or `bypassed-low` and `turnId` matches the hook payload. There is no transcript fallback: the minimum supported Claude Code release is 2.1.196, the first to send `prompt_id` on every hook payload. If the first observed lifecycle event is `PreToolUse`, a missing state is initialized before policy evaluation; an invalid or unreadable state allows the tool at `PreToolUse` and allows the turn at `Stop` with a message saying the project could not be checked. Writes use a temporary file and rename so parallel hook processes never observe partially written JSON, and each armed control is recorded in its own per-tool-use file (per-action when the host omits `tool_use_id`) bound to the current request sequence, so concurrent control reads cannot overwrite each other; the first successful completion wins and later ones are no-ops. `hook_event_name` is matched exactly and case-insensitively against the known events; unrecognized or missing values, unparseable hook input, and `SessionStart` failures exit non-zero rather than emitting an allow. Set `COMPREHENSION_GATE_STATE_DIR` to override the state directory for tests or managed deployments.

Pass and LOW bypass are still an exact, provider-specific control action, and performing one is the only way the baseline is retaken early (a `PreToolUse` never denies anything, so arming a control costs nothing to try). On Claude Code, Cursor, and Kiro, the agent reads a plugin-owned marker file with the host's native file-reading tool; `PreToolUse` arms the control when the read target matches exactly, and the matching `PostToolUse` completes it, clears `outstanding`, and retakes the baseline. Codex has no native local file reader on its standard hook path, so its control action is instead an exact `Bash` command built by `buildPinnedEntrypointCommand`: it pins the current `process.execPath` and this plugin's entrypoint, and the hook requires a byte-exact match against the rendered command, so a wrapped, re-quoted, or argument-altered form does not arm it. Reading a marker through any other means, or a `command` string that merely contains PASS-marker text, never arms or satisfies the gate.

The Kiro adapter uses the documented `*` matcher to cover built-in and MCP tools. It handles the configured `SessionStart` event and also accepts Kiro's documented CLI payload name, `agentSpawn`, for compatibility. For control reads, it accepts Kiro 3.x's nested wire format only when `tool_input.operations` contains exactly one operation whose `path` is an exact marker target.

## Development use

Requirements: Node.js 18 or newer.

For Claude Code, install `learning-output-style` separately, then install this plugin. The repository is its own marketplace:

```text
/plugin install learning-output-style
```

```bash
claude plugin marketplace add /absolute/path/to/comprehension-gate   # or: tanimanianima364/comprehension-gate
claude plugin install comprehension-gate@comprehension-gate
```

The hooks take effect in the next session. After pulling changes, refresh the installed copy with `claude plugin marketplace update comprehension-gate` followed by `claude plugin update comprehension-gate@comprehension-gate`.

`plugin update` compares the version in `.claude-plugin/plugin.json`, not the commit, so a release that does not raise it reports "already at the latest version" and the installed copy silently stays behind. Raise the version in `package.json`, `.claude-plugin/plugin.json`, and `.codex-plugin/plugin.json` together in the same change, and `claude plugin tag` will check that the manifests and the marketplace entry agree before tagging the release.

To load the working tree directly during development instead:

```bash
claude --plugin-dir /absolute/path/to/comprehension-gate
```

Codex discovers `hooks/hooks.json` from the plugin root after the plugin is installed and trusted. Use `/hooks` to review and trust the exact hook definition. Codex also supplies `CLAUDE_PLUGIN_ROOT` for Claude-compatible plugin hooks. The session instructions will show Codex the exact pinned pass and LOW bypass commands to run after mastery.

Cursor can reuse the Claude hook configuration when third-party plugins/configs are enabled. For a native Cursor configuration, render the template to a new file and merge it into the target project if that file already exists:

```bash
node scripts/render-adapter.mjs cursor --output /project/.cursor/hooks.json
```

For Kiro CLI 2.x, render the fragment and merge its `hooks` object into the agent config the session runs with, whether that is a global agent in `~/.kiro/agents/<name>.json` or a workspace one:

```bash
node scripts/render-adapter.mjs kiro-2x
kiro-cli agent validate --path ~/.kiro/agents/<name>.json
```

Merge rather than overwrite: an agent config holds far more than hooks, and an existing `hooks` object may already carry entries of its own. Keep the `"matcher": "*"` on every trigger.

For Kiro CLI 3.x:

```bash
node scripts/render-adapter.mjs kiro --output /project/.kiro/hooks/comprehension-gate.json
kiro-cli diagnostic
```

Kiro trusts file reads inside the current working directory. If the plugin lives outside the project workspace, it may ask before reading the plugin-owned marker files. Add only the plugin control directory to the active Kiro agent configuration's read `allowedPaths` if you want pass and LOW bypass reads to proceed without an extra approval prompt:

```json
{
  "toolsSettings": {
    "read": {
      "allowedPaths": [
        "/absolute/path/to/comprehension-gate/core/control"
      ]
    }
  }
}
```

The directory contains only the two static control markers. Do not broaden this entry to the entire plugin or an unrelated parent directory.

The renderer encodes the absolute entrypoint as a base64url argument and uses a fixed Node bootstrap, so plugin-path bytes are never interpreted as shell syntax. It refuses to overwrite an existing file unless `--force` is explicitly supplied. Prefer merging when a project already has hooks.

## Verification

```bash
npm test
```

The tests cover: no tool is ever refused while a change is outstanding, and only an exact native read of a control target arms a control; state reset, pass, and LOW bypass across turns, missing-first-event initialization, an invalid or unreadable state allowing the tool at `PreToolUse` and allowing the turn at `Stop` with a message, concurrent and idempotent control completion, and turn-id adoption and isolation across Claude Code, Cursor, and Kiro; snapshot capture and comparison for a clean tree, an edit, an added file, a deleted file, a rename, a symlink, a commit, a second worktree, a second change inside a nested repository, a file larger than one read chunk, ignored files, and a non-repository directory; Stop handling for no change, a change with a pass in the same turn, a `Stop` payload without a turn id, a state with no baseline, an outstanding change carried across `UserPromptSubmit`, a corrupt git index (never fails closed), an unreadable state file, the hold reason's ten-path cap, Cursor's `status`/`loop_count` gating, a change in a Cursor workspace root after the first, and Kiro's non-blocking stderr warning; Codex's exact pinned pass/bypass Bash control, including PATH-shadowed `node`; the Kiro 2.x adapter's matcher and `KIRO_SESSION_ID` identity, and Kiro's single-`operations[].path` control reads; adapter and hook config validity, placeholder rendering, and safe command encoding against shell metacharacters; and, by spawning the real entrypoint, a symlinked plugin root and Kiro's non-zero process exit with the reason on stderr.

## Security boundary

This plugin is a learning workflow guardrail, not a sandbox or authorization boundary. No tool is ever refused. It does not try to stop an agent that wants to evade it, and it accepts every residual that follows: host permissions still apply, and specialized tool paths that do not emit the configured hook event cannot be intercepted by this code. A change made in a turn the user interrupted is adopted at the next prompt, because Stop does not fire on an interrupt and the hook cannot tell the user's own edits from the agent's. The host hook runner and the Node executable it uses to start this plugin are part of the trusted bootstrap. Codex's control command pins that already-running executable by absolute identity; adapter bootstrap commands still require a trusted launch environment.

Current primary references:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [Kiro CLI hooks](https://kiro.dev/docs/cli/hooks/)
- [Kiro built-in tools](https://kiro.dev/docs/reference/built-in-tools/)
