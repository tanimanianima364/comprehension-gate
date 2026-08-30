# Comprehension Gate

Comprehension Gate layers a deterministic write gate on top of an agent's learning behavior. It does not fork or replace the official `learning-output-style` plugin.

The agent still decides whether a change is LOW, MEDIUM, HIGH, or CRITICAL and evaluates the user's explanation. The hook only owns execution control: each submitted user message resets the gate, project mutation is denied while the gate is pending, and an exact provider-specific control action records pass or LOW bypass state for the current session/turn.

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
PreToolUse(any observable local tool, including MCP)
  known read-only tool -> allow
  exact pass or bypass-low control action -> arm and allow it
  shell command -> deny while pending, except Codex's exact pinned control command
  pending + anything else -> deny
PostToolUse(matching successful control action + expected marker)
  -> update session state
  satisfied -> let the host permission model decide
```

State is stored outside the project and keyed by a SHA-256 digest of provider plus `session_id`. Codex `turn_id` is also checked when available. If the first observed lifecycle event is `PreToolUse`, a missing state is initialized to pending before policy evaluation; invalid or unreadable state remains fail-closed. Writes use a temporary file and rename so parallel hook processes never observe partially written JSON. Set `COMPREHENSION_GATE_STATE_DIR` to override the state directory for tests or managed deployments.

Tool handling is fail-closed before mastery: the adapters route every observable `PreToolUse` event through the gate, and only an explicit allowlist of native inspection tools proceeds. Shell commands are denied while pending, including commands that appear read-only, because PATH, functions, aliases, cmdlets, and external executable resolution can change their identity. Unknown tools and MCP tools are also denied while pending. Claude Code, Cursor, and Kiro pass or LOW bypass through native reads of plugin-owned marker files. Codex does not expose a built-in native Read tool on its standard hook path, so Codex pass and LOW bypass use an exact shell command pinned to the current `process.execPath` and the base64url-encoded gate entrypoint; no other shell command is allowed before pass. After pass, the hook stays silent and the host's normal permission model applies.

Use the host's native Read, Search, Glob, and equivalent inspection tools before pass. Shell-based Git, ripgrep, and other command-line inspection becomes available only after the gate is satisfied and remains subject to the host permission model.

The Kiro adapter uses the documented `*` matcher to cover built-in and MCP tools. It handles the configured `SessionStart` event and also accepts Kiro's documented CLI payload name, `agentSpawn`, for compatibility. For control reads, it accepts Kiro 3.x's nested wire format only when `tool_input.operations` contains exactly one operation whose `path` is an exact marker target.

## Development use

Requirements: Node.js 18 or newer.

For Claude Code, install `learning-output-style` separately, then load this repository during development:

```text
/plugin install learning-output-style
```

```bash
claude --plugin-dir /absolute/path/to/comprehension-gate
```

Codex discovers `hooks/hooks.json` from the plugin root after the plugin is installed and trusted. Use `/hooks` to review and trust the exact hook definition. Codex also supplies `CLAUDE_PLUGIN_ROOT` for Claude-compatible plugin hooks. The session instructions will show Codex the exact pinned pass and LOW bypass commands to run after mastery.

Cursor can reuse the Claude hook configuration when third-party plugins/configs are enabled. For a native Cursor configuration, render the template to a new file and merge it into the target project if that file already exists:

```bash
node scripts/render-adapter.mjs cursor --output /project/.cursor/hooks.json
```

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

The renderer encodes the absolute entrypoint as a base64url argument and uses a fixed Node bootstrap, so plugin-path bytes are never interpreted as POSIX, PowerShell, or `cmd.exe` syntax. It refuses to overwrite an existing file unless `--force` is explicitly supplied. Prefer merging when a project already has hooks.

## Verification

```bash
npm test
```

The tests cover state reset/pass/bypass, missing-first-event initialization, invalid/unreadable fail-closed behavior, armed provider control completion, failed provider results, Codex turn isolation and exact pinned pass/bypass controls, all ordinary shell denial before pass, a PATH-shadowed `node` regression, Kiro single-operation `operations[].path` reads and malformed forms, MCP/unknown-tool denial across providers, encoded adapter execution with shell metacharacters, synthetic Windows path round trips, both Kiro start event forms, and provider-specific output shapes.

## Security boundary

This plugin is a learning workflow guardrail, not a sandbox or authorization boundary. Host permissions still apply, and specialized tool paths that do not emit the configured hook event cannot be intercepted by this code. The host hook runner and the Node executable it uses to start this plugin are part of the trusted bootstrap. Codex controls pin that already-running executable by absolute identity; adapter bootstrap commands still require a trusted launch environment.

Current primary references:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [Kiro CLI hooks](https://kiro.dev/docs/cli/hooks/)
- [Kiro built-in tools](https://kiro.dev/docs/reference/built-in-tools/)
