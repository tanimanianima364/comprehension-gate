# Comprehension Gate

Comprehension Gate puts a deterministic reminder in front of a coding agent: this is what the branch has changed, and it has to be accounted for. It does not fork or replace the official `learning-output-style` plugin.

The hook interrupts no one. It refuses no tool, holds no turn, blocks no prompt, and shows the user nothing. It derives the branch's change set from git at the start of a session and at every user message, and injects it into the agent's context alongside the instructions for what to record. Whether anything gets recorded is up to the agent; the reminder is the only pressure there is.

That is a deliberate trade, and it replaces an earlier design that held the turn and put a transfer question to the user. Questions that the user could not answer from shared context, and a held turn, cost more than they returned.

## Supported adapters

| Agent | Hook configuration | Context reaches the agent | Verified against a running host |
| --- | --- | --- | --- |
| Claude Code | `hooks/hooks.json` | `SessionStart` and `UserPromptSubmit` | hooks yes, 2.1.258/2.1.259; this behavior change has not been re-run live |
| Codex | the same `hooks/hooks.json` | `SessionStart` | hooks yes, CLI 0.151.0/0.153.1; not re-run live for this change |
| Cursor | Claude compatibility or `adapters/cursor/hooks.json` | `sessionStart` only | hooks yes, `cursor-agent` 2026.09.02; not re-run live for this change |
| Kiro CLI 2.x | `adapters/kiro-2x/hooks.json`, merged into the agent config | `agentSpawn` and `userPromptSubmit` | hooks yes, 2.16.2; not re-run live for this change |
| Kiro CLI 3.x | `adapters/kiro/hooks.json` | `SessionStart` and `UserPromptSubmit` | no |

The last column is the honest one. Every host in it was exercised live under the previous design, which proved that the hooks fire and that injected context arrives. Nothing in this version changes the shape of that context, but no host has been re-run since the interruption was removed.

Cursor's prompt hook carries no context field, so there the change set reaches the agent only at `sessionStart`. A `cursor-agent --resume` turn fires no hooks at all, not even `sessionStart`. Kiro CLI 3.x has not been exercised live; that adapter was written from vendor documentation and is covered by tests that model the documented contract.

The two Kiro adapters differ only in packaging. 3.x reads standalone `.kiro/hooks/*.json` files; 2.x embeds the same triggers in the agent config under `hooks`. Two details of 2.x are worth knowing because its documentation is wrong about them, and both were found by capturing real hook payloads from 2.16.2. The `matcher` is documented as a regex but is not one: only `"*"` or an omitted matcher fires for every tool, while `".*"` — the value the vendor's own example uses — fires for none. And no payload carries a session id.

## How it works

```text
SessionStart    -> inject the instructions, plus the branch's change set if there is one
UserPromptSubmit -> inject the branch's change set; stay silent when the branch is clean
PreToolUse      -> allow
PostToolUse     -> allow
Stop            -> allow
```

The change set is everything this branch has done that its base has not: every path committed since the merge base with the default branch, plus every path `git status --porcelain=v1 -z --untracked-files=all` reports in the working tree. That is the same set a reviewer sees in the pull request, and it is the range a record has to cover.

The base is `refs/remotes/origin/HEAD` when the remote records one, then `origin/main`, `origin/master`, `main`, `master` — the first that **resolves to a commit**. Every candidate is verified, `origin/HEAD` included: it outlives the branch it points at, so renaming a remote default branch and pruning leaves it dangling, and adopting a ref that names no commit would make `merge-base` fail and silently empty the committed half of the change set instead of falling through to a base that does exist.

A repository with no base at all still reports its working tree. Renames name both paths, because a record attached to the old path has to follow — and both status columns are tested for the rename, since `git mv` stages it as `R ` while a plain move plus `git add -N` reports ` R`, and reading only the first column would leave the original path to be parsed as the next entry's status line. Ignored files are in neither half, so a scratch file under a gitignored directory is free. A directory that is not a git repository, or a repository git cannot be asked about, produces no notice rather than a guess.

Only the hook's own working directory is examined — `cwd`, or the first entry of Cursor's `workspace_roots`. Other worktrees of the same repository are not watched. They were, under the previous design, because a held turn invited relocating a change to escape it; with nothing to escape, the branch being worked in is the branch a record belongs to.

Nothing is remembered between hook invocations. There is no state file, no baseline, no session identity, and no notion of a change having been accounted for: the notice is always the branch's current change set. A change accounted for in an earlier turn is still listed while it remains on the branch, and does not need accounting for twice.

`hook_event_name` is matched exactly and case-insensitively against the known events; unrecognized or missing values and unparseable hook input exit non-zero without emitting an allow or a deny.

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

Codex discovers `hooks/hooks.json` from the plugin root after the plugin is installed and trusted. Until they are trusted, Codex skips the plugin's hooks **silently**: no warning on stderr and nothing at `RUST_LOG=trace`, so an untrusted install is indistinguishable from a working one that never fires. `codex exec` cannot grant trust. Run an interactive session, which reports `Hooks need review`, and trust them there; that writes a `trusted_hash` for each hook into `config.toml`. Use `/hooks` to review and trust the exact hook definition.

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

The renderer encodes the absolute entrypoint as a base64url argument and uses a fixed Node bootstrap, so plugin-path bytes are never interpreted as shell syntax. It refuses to overwrite an existing file unless `--force` is explicitly supplied. Prefer merging when a project already has hooks.

## Verification

```bash
npm test
```

The tests cover: the change set for a clean branch, uncommitted edits, additions, deletions, untracked and ignored files, a rename staged and unstaged, a dangling `origin/HEAD` falling through to a base that exists, a path containing a newline staying one path, the change set command agreeing exactly with the hook over a committed rename in a repository with no remote, a plugin path containing `$&` surviving substitution, the rendered POSIX command running in a real shell from a directory whose name holds a space and a quote and the PowerShell form carrying the call operator, the manual skill deferring to that command rather than carrying its own, a path shaped like a line of the reminder being quoted and escaped, commits on a branch alongside uncommitted work, a file both committed and then edited, a call from a subdirectory, a repository with no remote, a clone that has `origin/HEAD`, a non-repository directory, and a repository git cannot read; that no tool is ever refused, on every host, for built-in, MCP, `apply_patch`, and unknown tool names; that a stop over a changed branch holds nothing and writes nothing to stderr on every host; instruction and change-set injection at session start and at a prompt, silence over a clean branch, the notice's ten-path cap, and Cursor's first workspace root; provider-specific context and allow shapes; exact event-name matching; that the instructions contain no placeholder, no transfer question, and no control action; adapter and hook config validity and safe command encoding against shell metacharacters; and, by spawning the real entrypoint, a symlinked plugin root, malformed stdin, and Kiro's now-zero process exit.

## Security boundary

This plugin is a learning workflow guardrail, not a sandbox or authorization boundary. No tool is ever refused and nothing is enforced. It does not try to stop an agent that wants to ignore it, and it accepts every residual that follows: host permissions still apply, and specialized tool paths that do not emit the configured hook event cannot be intercepted by this code. The hook cannot tell the user's own edits from the agent's, so a change the user made themselves is reported alongside the agent's. The host hook runner and the Node executable it uses to start this plugin are part of the trusted bootstrap; adapter bootstrap commands require a trusted launch environment.

Current primary references:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [Kiro CLI hooks](https://kiro.dev/docs/cli/hooks/)
- [Kiro built-in tools](https://kiro.dev/docs/reference/built-in-tools/)
