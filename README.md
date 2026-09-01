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
  exact pass or bypass-low control action -> arm and allow it
  Codex exact pinned inspection command -> allow without changing gate state
  named write tool -> deny while pending
  shell command -> classify; plain inspection allows, write or unparseable denies
  pending + anything else -> allow
PostToolUse(matching successful control action + expected marker)
  -> update session state
  satisfied -> let the host permission model decide
```

State is stored outside the project and keyed by a SHA-256 digest of provider plus `session_id`. The turn identity is Codex `turn_id`, Cursor `generation_id`, or Claude Code `prompt_id` (2.1.196+). A pending state seeded by an event without a turn id adopts the first turn id it sees so that turn can still pass, and a `PreToolUse` that carries a turn id the state has never seen resets the gate to pending, so a skipped or timed-out prompt hook cannot leak the previous turn's pass. Only for hosts that provide no turn id at all does the gate fall back to the transcript: each reset records the identity (`uuid`, or byte offset plus record digest) of the latest human prompt record in the tail of `transcript_path`, and every `PreToolUse` compares it with the current latest record. Because Claude Code writes the transcript asynchronously, this fallback is weaker than `prompt_id`. If the transcript cannot be judged while the gate is satisfied, the gate returns to pending; a pass granted while nothing was judgeable is reset again as soon as a record becomes visible. If the first observed lifecycle event is `PreToolUse`, a missing state is initialized to pending before policy evaluation; invalid or unreadable state remains fail-closed. Writes use a temporary file and rename so parallel hook processes never observe partially written JSON, and each armed control is recorded in its own per-tool-use file (per-action when the host omits `tool_use_id`, in which case a failed control does not clear the shared record) bound to the current request sequence, so concurrent control reads cannot overwrite each other; the first successful completion wins and later ones are no-ops. `hook_event_name` is matched exactly and case-insensitively against the known events; unrecognized or missing values, unparseable hook input, and `SessionStart` failures exit non-zero rather than emitting an allow or a `PreToolUse`-shaped payload. Set `COMPREHENSION_GATE_STATE_DIR` to override the state directory for tests or managed deployments.

Tool handling allows by default and denies a named set. A tool is on that set when writing is its primary use, or when it offers no way to read at all -- not merely because some path through it could write, which would deny `Bash` and every tool that happens to have a write mode.

The asymmetry decides the default. A tool missing from the deny list means one change reaches the project without a comprehension check, with the user present and the session instructions still telling the agent not to mutate. A tool wrongly denied costs capability in every session, silently, until somebody trips over it: the earlier allowlist denied `ToolSearch` and plan mode while those same instructions promised that gathering information and planning were allowed, and nobody noticed for months. The common mutation paths -- `Write`, `Edit`, `NotebookEdit`, `apply_patch`, `str_replace`, the delete tools, entering and leaving a worktree, and shell commands that classify as writing -- are named; the long tail is accepted, exactly as it already is for shell command names.

The write list is not keyed by provider, because matching more names only denies more, which is the safe direction here. It also matches a namespaced tool's last segment, so an MCP `write_file` is caught as `mcp__filesystem__write_file`, `@filesystem/write_file`, or `MCP:filesystem.write_file`. The read list is separate and still matches exactly, because its only job is deciding which native local file read may arm a control marker, where `Read2` must not stand in for `Read`. Nothing joins it merely for being harmless: `WebFetch` and `WebSearch` run while pending but are not on it, since a fetch carrying a `path` that names the marker and a body containing it would otherwise satisfy the gate without ever reading the file.

MCP tools that do not name a write proceed while pending, as do tools nobody has enumerated. `Skill` and `Agent`/`Task` proceed too: a skill can run `!command` preprocessing and a subagent can create a worktree before its first gated tool call, but writing is neither tool's primary use and both have ordinary read uses, so their delegated writes join the accepted long tail.

A network read is a read, so Claude Code's `WebFetch` and `WebSearch` proceed. HTTP can change a remote resource, but a remote resource is not this project, and the hook allows these tools the moment the gate passes -- it never protected one.

Shell commands are classified rather than denied outright, on every shell tool name and every provider. This one list is deliberately not provider-keyed: the lists above trust a name to mean "read-only", whereas the classifier (`core/shell.mjs`) trusts nothing about the name and reads the command itself, and a tool carrying no `command` string fails closed there. The command is scanned once while tracking POSIX quoting state and split on unquoted separators (`|` `||` `;` `&&` and newline) into segments, each classified on its own; the whole command is inspection only when every segment is. The scan decides where one command ends and the next begins rather than reimplementing shell grammar as an authorization boundary, and every ambiguity resolves to a refusal, so a misreading can only cost a false denial. Three constructs get more than lexical treatment. Redirection is allowed only where it cannot name a file to write -- a `/dev/null` target, or descriptor duplication such as `2>&1` -- and any other target refuses. Parameter expansion (`$VAR`, `${VAR}`) is allowed, because POSIX does not re-parse the result of an expansion for control operators, so an expanded value becomes argument text and cannot introduce a second command. Command substitution (`$(...)`, backticks) does run a command, so its body is classified recursively; an expansion of either kind in the command-name position refuses, since the name is what the denylist matches on. Single quotes suppress expansion and are left alone. What remains undecomposable is refused outright: subshells and input redirection (`(` `)` `<`), a lone backgrounding `&`, an unmodeled expansion form, and an unterminated quote or substitution. Segment classification is a denylist over the command name. Leading `NAME=VALUE` assignments are stepped over first so the name that actually runs is the one matched, and an assignment to a variable that rebinds command resolution or shell startup (`PATH`, `LD_PRELOAD`, `BASH_ENV`, `IFS`, and the like) refuses outright, because PATH shadowing is an accepted residual only where the scan cannot see it. Wrappers that run their first operand (`command`, `nice`, `time`, `stdbuf`, and similar) are refused rather than unwrapped, matching how `env`, `sudo`, `xargs`, `timeout`, and `nohup` are already handled. Directory, case, and an executable extension are stripped before matching, so `/bin/RM` and `node.exe` still reach their listed name. The list refuses commands that write, apply patches, run an interpreter, run build/test/package tooling, or transfer over the network. Commands whose classification instead depends on their arguments -- `git`, `sed`, `find` -- are judged by an allowlist of read-only subcommands and flags, so a flag the scan cannot see, whether an expansion or simply one nobody has vetted, falls outside the allowed set rather than slipping past a denylist. A `sed` script body can still write through `w`, which is part of the accepted trade rather than something the flag list claims to cover. Tokens are unquoted before matching, so `sed "-i"` cannot hide a denylisted flag. Anything unrecognized is treated as inspection. That leaves a deliberate residual bypass -- an unlisted mutating command, or an inspection name rebound through PATH, a shell function, an alias, or a cmdlet -- which is accepted because the gate guards a cooperative agent rather than an evasive one, and closing it would cost the exploration the gate exists to preserve. One further case is accepted on Codex specifically, where an extension can present a built-in's name: a same-named tool that puts a non-POSIX string in `command` would have it read with the wrong grammar. Codex keeps the pinned `inspect-read`/`inspect-search` bridge as a sound alternative. The session instructions carry the finer rule that the hook does not enforce. Claude Code, Cursor, and Kiro pass or LOW bypass through native reads of plugin-owned marker files. Codex does not expose a built-in native local file reader on its standard hook path, so it uses plugin-owned `inspect-read` and literal `inspect-search` bridges before pass. These commands pin the current `process.execPath` and gate entrypoint, bind an encoded canonical workspace from the hook's `cwd`, and accept only canonical base64url data arguments. The hook `cwd` must also lie inside the canonical workspace recorded by the last `SessionStart` or prompt reset (realpath-resolved, compared with `path.relative`, so symlinks and trailing separators are canonical-equal and a descendant only narrows the readable tree). Only those lifecycle events may record the workspace: a reset triggered from `PreToolUse` (a new turn id, or a stale transcript record) keeps the previously recorded value, and inspection is denied until a workspace has been recorded, so a per-call cwd can never become the pin on its own. The hook reconstructs the whole command and requires a byte-exact match. The Node bridge launches no child processes, rejects workspace escapes, and does not follow search-tree symlinks. Inspection never arms or satisfies the gate, even if inspected text contains a PASS marker.

Codex pass and LOW bypass use the same pinned transport. After pass, the hook stays silent and the host's normal permission model applies.

Use the host's native Read, Search, Glob, and equivalent inspection tools before pass. In Codex, use only the rendered `inspect-read` and `inspect-search` commands. Arguments are unpadded base64url encodings of UTF-8 values; the rendered instructions include copyable examples, and search results include a `read-token` for each matching file. Read is limited to regular UTF-8 files of at most 256 KiB. Search is literal and bounded by file, byte, result, and output limits; it skips binary/invalid UTF-8 content, symlinks, VCS metadata, and `node_modules`. On Claude Code, shell-based Git, ripgrep, and other command-line inspection is also available before pass through the classifier described above; every shell command remains subject to the host permission model, and mutating forms stay denied until the gate is satisfied.

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

The tests cover state reset/pass/bypass, missing-first-event initialization, invalid/unreadable fail-closed behavior, armed provider control completion, concurrent control arming, symlinked plugin-root execution, unrecognized-event and `SessionStart` failure handling, write-list near-miss and namespaced-verb matching, Cursor turn-id adoption, transcript-based stale-pass invalidation, failed provider results, Codex turn isolation and exact pinned pass/bypass controls, Codex inspection production flow and grammar rejection, canonical workspace/workdir binding, traversal and symlink escapes, UTF-8 and size/result bounds, PASS-marker state isolation, allow-by-default tool handling with named write denial, unenumerated and MCP tools proceeding, an allowed non-read failing to arm a control, network reads proceeding, shell inspection classification covering quote-aware separator decomposition, redirection targets and descriptor duplication, parameter expansion and recursive command substitution, expansion in the command-name position, undecomposable constructs, quoted-flag and executable-extension evasion, write commands, assignment prefixes and command wrappers, the unsupported-platform refusal reaching the Codex exceptions and ending at pass, and every shell tool name and provider, the accepted PATH-shadow trade-off, a PATH-shadowed `node` regression, Kiro single-operation `operations[].path` reads and malformed forms, namespaced MCP write denial across providers, encoded adapter execution with shell metacharacters, both Kiro start event forms, and provider-specific output shapes.

## Security boundary

This plugin is a learning workflow guardrail, not a sandbox or authorization boundary. Host permissions still apply, and specialized tool paths that do not emit the configured hook event cannot be intercepted by this code. The host hook runner and the Node executable it uses to start this plugin are part of the trusted bootstrap. Codex controls pin that already-running executable by absolute identity; adapter bootstrap commands still require a trusted launch environment.

## Known limitations

The plugin is developed and tested on Linux, including WSL, and judges shell commands only there. Anywhere else the gate refuses every shell tool **while it is pending**: the classifier's rules read a command as a POSIX shell command, and applying them to another shell would let a PowerShell cmdlet such as `Remove-Item` through as inspection, since it matches no name in the table. Rather than guess at a shell it does not model, the gate declines.

The refusal ends at pass, like every other rule here. After pass the hook goes silent and the host's permission model is the authority on every platform, so the shell comes back; carrying the refusal further would leave it permanently unusable rather than merely unjudged. While pending the refusal only restricts, and native reads and searches are untouched, so Claude Code, Cursor, and Kiro still inspect and still pass through a native read. Codex, whose controls and inspection bridge are themselves shell commands, is Linux-only in practice.

It sits in `handleHook` ahead of the Codex control and inspection exceptions rather than inside the classifier, because those match a command exactly and return before the classifier is consulted, and it keys on the tool kind rather than the provider, because excluding by provider would deny Cursor and Kiro the native reads they pass through.

Calling a Windows binary from WSL is a different case and is covered by the command table, not by this guard: `powershell.exe`, `pwsh`, and `cmd` are denylisted interpreters, and the executable extension is stripped before matching.

Current primary references:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex shell dispatch source](https://github.com/openai/codex/blob/main/codex-rs/core/src/shell.rs)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [Kiro CLI hooks](https://kiro.dev/docs/cli/hooks/)
- [Kiro built-in tools](https://kiro.dev/docs/reference/built-in-tools/)
