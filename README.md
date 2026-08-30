# Comprehension Gate

Comprehension Gate layers a deterministic write gate on top of an agent's learning behavior. It does not fork or replace the official `learning-output-style` plugin.

The agent still decides whether a change is LOW, MEDIUM, HIGH, or CRITICAL and evaluates the user's explanation. The hook only owns execution control: each submitted user message resets the gate, project mutation is denied while the gate is pending, and an exact one-purpose control command records pass or LOW bypass state for the current session/turn.

## Supported adapters

| Agent | Hook configuration | Blocking mechanism |
| --- | --- | --- |
| Claude Code | `hooks/hooks.json` | `PreToolUse.permissionDecision: deny` |
| Codex | the same `hooks/hooks.json` | `PreToolUse.permissionDecision: deny` |
| Cursor | Claude compatibility or `adapters/cursor/hooks.json` | `preToolUse.permission: deny` |
| Kiro CLI 3.x | `adapters/kiro/hooks.json` | non-zero `PreToolUse` command exit |

Kiro CLI 2.x uses a different embedded-hook format and is intentionally unsupported.

## How it works

```text
SessionStart -> inject shared instructions
UserPromptSubmit -> state = pending
PreToolUse(write/mutating shell)
  pending -> deny
  exact pass or bypass-low command -> arm and allow that one command
PostToolUse(matching successful control command + expected marker)
  -> update session state
  satisfied -> let the host permission model decide
```

State is stored outside the project and keyed by a SHA-256 digest of provider plus `session_id`. Codex `turn_id` is also checked when available. Writes use a temporary file and rename so parallel hook processes never observe partially written JSON. Set `COMPREHENSION_GATE_STATE_DIR` to override the state directory for tests or managed deployments.

Shell handling is fail-closed before mastery: only a conservative allowlist of inspection commands is accepted. Use native Read/Search tools when an inspection command is rejected.

The Kiro adapter matches both the short categories and the current 3.x canonical mutation tools (`fs_write`, `str_replace`, `delete_file`, `execute_bash`, and `control_bash_process`). It also accepts Kiro's documented `agentSpawn` input name for a configured `SessionStart` hook.

## Development use

Requirements: Node.js 18 or newer.

For Claude Code, install `learning-output-style` separately, then load this repository during development:

```text
/plugin install learning-output-style
```

```bash
claude --plugin-dir /absolute/path/to/comprehension-gate
```

Codex discovers `hooks/hooks.json` from the plugin root after the plugin is installed and trusted. Use `/hooks` to review and trust the exact hook definition. Codex also supplies `CLAUDE_PLUGIN_ROOT` for Claude-compatible plugin hooks.

Cursor can reuse the Claude hook configuration when third-party plugins/configs are enabled. For a native Cursor configuration, render the template to a new file and merge it into the target project if that file already exists:

```bash
node scripts/render-adapter.mjs cursor --output /project/.cursor/hooks.json
```

For Kiro CLI 3.x:

```bash
node scripts/render-adapter.mjs kiro --output /project/.kiro/hooks/comprehension-gate.json
kiro-cli diagnostic
```

The renderer refuses to overwrite an existing file unless `--force` is explicitly supplied. Prefer merging when a project already has hooks.

## Verification

```bash
npm test
```

The tests cover state reset/pass/bypass, armed control-command completion, failed provider results, Codex turn isolation, strict control-command matching, conservative shell inspection, fail-closed prompt reset, Kiro 3.x canonical tools, and provider-specific output shapes.

## Security boundary

This plugin is a learning workflow guardrail, not a sandbox or authorization boundary. Host permissions still apply, and specialized tool paths that do not emit the configured hook event cannot be intercepted by this code.

Current primary references:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://developers.openai.com/codex/hooks)
- [Cursor third-party hooks](https://cursor.com/docs/reference/third-party-hooks)
- [Kiro hooks](https://kiro.dev/docs/hooks/)
