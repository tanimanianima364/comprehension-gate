# Comprehension Gate

Comprehension Gate puts a deterministic reminder in front of a coding agent: these paths changed on this branch and nothing records why. It does not fork or replace the official `learning-output-style` plugin.

What it asks for is two records. **Docstrings** say what a file or function is for and why it works the way it does; they describe the current state, so they merge like code. **Notes** — markdown files under `docs/notes` — say what one change was trying to achieve and which alternative was rejected; they record a moment, so they are never rewritten, and a later change writes a new note that supersedes the old one instead. Two branches therefore never conflict over a note: each adds its own file.

The hook interrupts no one. It refuses no tool, holds no turn, blocks no prompt, and shows the user nothing. At the start of a session and at every user message it derives the branch's change set from git, subtracts every path some note already covers, and injects what is left. Whether anything gets recorded is up to the agent; the reminder is the only pressure there is.

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
SessionStart     -> inject the instructions, plus any uncovered paths
UserPromptSubmit -> inject the uncovered paths; stay silent when none are left
PreToolUse       -> allow
PostToolUse      -> allow
Stop             -> allow
```

The change set is everything this branch has done that its base has not: every path committed since the merge base with the default branch, plus every path `git status --porcelain=v1 -z --untracked-files=all` reports in the working tree. That is the same set a reviewer sees in the pull request, and it is the range a record has to cover.

The base is `refs/remotes/origin/HEAD` when the remote records one, then `refs/remotes/origin/main`, `refs/remotes/origin/master`, `refs/heads/main`, `refs/heads/master` — the first that **resolves to a commit**. Fully qualified, because git resolves a short name against tags first: a tag named `main` would otherwise become the base, and the branch's own commits would vanish from the change set. Every candidate is verified, `origin/HEAD` included: it outlives the branch it points at, so renaming a remote default branch and pruning leaves it dangling, and adopting a ref that names no commit would make `merge-base` fail and silently empty the committed half of the change set instead of falling through to a base that does exist.

Silence has to mean "nothing changed", so the two halves are collected separately and each says whether it was collected at all. A half that failed is not an empty half: the command answers `{ paths, complete }` rather than a bare array, and the hook speaks even when the paths it did collect are none — a caller handed `[]` cannot tell a clean branch from one whose change set could not be read, and that is the difference that matters most. The one case that is legitimately empty is a repository with no base to compare against, and it takes two separate discriminations to hold on to that. `merge-base` answers 1 both for "these histories are unrelated" and for "a commit could not be read", and only the second says anything on stderr. Resolving the base ref answers 1 both for "there is no such ref" and for "the ref is there but its commit is gone", and stderr is empty for both — so the bare ref is asked for separately, which reads the ref file alone and succeeds even when the object it names is missing. A ref that is not there is ordinary; a ref that is there and unreadable is a failure, and reporting it as "no base" said a branch with commits on it had none. A ref file git cannot read is the same kind of failure and is told apart the same way: it warns, where a missing ref says nothing.

A shallow clone needs the same care for a different reason. It does not hold the commit where two branches meet, and a shallow boundary looks to git like a commit with no parents — so `merge-base` answers exactly as it does for unrelated histories. A repository is asked whether it is shallow before that answer is believed.

The revisions handed to `git diff` are ended with `--`. `HEAD` is a legal file name, and git refuses a command whose argument is both a revision and a path; without the separator an ordinary repository holding a file called `HEAD` could not have its committed half collected at all. Nothing trims git's output beyond the line feed git itself adds — not even a carriage return before it, which on a POSIX filesystem is part of the name. A directory whose name ends in a space or a carriage return is a different directory, and trimming it examined the neighbour and reported *its* change set as this one's — not a failure but a wrong answer, which is worse.

The same distinction runs through every question this file asks git. Only one failure means "there is nothing here": exit 1 with nothing said. A process killed by a signal — which is also how a timeout arrives — reports no exit code and an empty stderr, and reading that as an absence answered every one of those questions with a confident "no": no ref, no default branch, not shallow. Each of those empties the change set, so a git that was killed reported a branch with commits on it as unchanged.

Every git call runs with the environment's own `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and their relatives removed: each of them names a repository, an index or an object store, and git obeys them over the directory it was pointed at — inherited from the host they made the plugin answer about a tree nobody asked about, confidently and completely.

Stdout stays bytes until the last moment, and every path gets one spelling that no other path shares. A file name is bytes, and decoding it as UTF-8 replaces every invalid byte with the same character, so two differently named files became one path and one of them disappeared. Escaping only the names that need it trades one collision for another — the escape of a raw `0xFF` is `%FF`, which is also how an ordinary file called `x%FF.js` spells itself — so the escape character is escaped everywhere: `%` is written `%25` in every path, valid or not. A name that is valid UTF-8 is otherwise left exactly as git spells it, and the same encoding is applied to a path that arrives as text rather than as bytes — an entry in a note, a path in a tool payload — so the two sides meet.

A listing command is not trusted on its exit code alone: `git status` warns on stderr and still exits 0 when it could not open part of the working tree, and the listing it printed is then short of whatever it could not reach. Both halves also pass `--ignore-submodules=none`, because a project's own `.gitmodules` can otherwise ask git to hide a submodule whose bump is the only thing the branch did.

git's output is read with a limit no realistic branch reaches. Node's default is a megabyte — about six thousand paths — and it kills the child and throws past that, so a branch with a large committed diff used to come back empty and report nothing at all, working-tree edits included. A half that still cannot be collected leaves the other one reported, and the notice says the list is short rather than passing it off as complete. A branch with commits and no base ref at all does not have an empty committed half — it has one that was never computed, and it says so. That shape is not exotic: `git clone --single-branch --branch <x>` writes no `origin/HEAD` and fetches no `main`, which is how CI runners, devcontainers and agent sandboxes check out, and any repository whose trunk is called something else is in the same position. A repository with no commits yet is the genuinely empty case. Unrelated histories are a short list too: the branch has every one of its commits and which of them a reviewer would call new cannot be worked out from here. Renames name both paths, because a record attached to the old path has to follow — and both status columns are tested for the rename, since `git mv` stages it as `R ` while a plain move plus `git add -N` reports ` R`, and reading only the first column would leave the original path to be parsed as the next entry's status line. Ignored files are in neither half, so a scratch file under a gitignored directory is free. A directory that is not a git repository, or a repository git cannot be asked about, produces no notice rather than a guess.

Only the hook's own working directory is examined — `cwd`, or the first entry of Cursor's `workspace_roots`. Other worktrees of the same repository are not watched. They were, under the previous design, because a held turn invited relocating a change to escape it; with nothing to escape, the branch being worked in is the branch a record belongs to.

Nothing is remembered between hook invocations. There is no state file, no baseline, no session identity, and no notion of a change having been accounted for: the notice is always the branch's current change set. A change accounted for in an earlier turn is still listed while it remains on the branch, and does not need accounting for twice.

## Notes

A note is a markdown file anywhere under `docs/notes`, with front matter naming the repository-relative paths it accounts for:

```markdown
---
covers:
  - core/gate.mjs
  - core/notes.mjs
supersedes:
  - 2026-01-31-an-earlier-note-0a1b2c3d
---
```

`covers` is the only part read by a machine, and it is read exactly: a path missing from the `covers` of every note in the change set stays in the reminder. The key is a line of its own, and each entry is `  - ` followed by one path taken literally to the end of the line. `supersedes` is for the reader and does not change what is covered — a superseded note still covers its paths, and the record of what was believed at the time is the point of keeping it.

Coverage is scoped to the change being examined: **only a note that is itself part of the change set counts.** A note an earlier branch left about a file records what that change was for, not this one, so a file explained once does not go silent for every branch afterwards — without this the reminder decays into nothing on a repository of any age.

Inside one branch the scoping does not help: once a path is covered, further changes to that file are not reported again. The reminder is a floor rather than a ceiling, and the mechanism for the rest is the hint that names a path's notes before each write, so an edit that contradicts a recorded intent is put in front of the agent even when the reminder has gone quiet. Making coverage expire with the file's content was considered and rejected: it would require each note to carry a per-path content identity the agent computes by hand, and it would return a path to the reminder on every subsequent keystroke, pushing toward one note per edit rather than one note per change — which is the opposite of what the notes are for.

Everything else here fails soft. A note that cannot be read covers nothing, and an unreadable `docs/notes` covers nothing at all: reporting a path as uncovered is always safer than throwing the hook away. Reading the list is the one place where leniency runs the wrong way, so it is strict instead — failing to read a list leaves its paths reported, which someone notices, while reading one loosely silences paths the note never explained, which nobody ever finds out about. Paths under `docs/notes` are never reported, so writing a note does not itself demand one. Nothing decides whether a path deserves a note — that judgment stays with the agent, and a purely mechanical change is expected to stay listed.

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

The tests cover: note coverage for a missing notes tree, a block list, an inline list, notes in subdirectories, several notes together, a note left by an earlier change not covering a later one, a note with no front matter, an unterminated one, and one with no `covers` key, an unclosed inline list, an unterminated quote, a bare scalar and a quoted scalar where a list is required, a comma inside an entry, an inline list, an unclosed one, a scalar or a quoted scalar where a list is required, no space between the key and a value, anything after the key, a dash with no space or nothing after it, a stray line, a continuation line, a comment between entries or after one, a name holding a quote, a comma, a `#`, a bracket, a space or a backslash taken literally, a list voided whole rather than read in part, the next key ending a list, a blank line between entries, a changed path holding a backslash matched as the name git gave, entries that need normalizing or that escape the repository, the notes directory itself, and an unreadable note; the change set for a clean branch, uncommitted edits, additions, deletions, untracked and ignored files, a rename staged and unstaged, a dangling `origin/HEAD` falling through to a base that exists, a path containing a newline staying one path, a committed half too large to collect leaving the working tree reported and saying the list is short, a merge base that cannot be computed and a base ref whose commit cannot be read both counting as failures while a missing ref does not, an empty half-collected change set still speaking, a shallow clone that cannot reach the merge base counting as a failure, a tag sharing a branch's name never becoming the base, a working directory whose name ends in a space being the one examined, a broken ref file counting as a failure rather than a missing ref, a repository git cannot read at all still having no change set, every character PowerShell reads as a single quote being escaped, a path containing a newline staying one path, a committed half too large to collect leaving the working tree reported and saying the list is short, a merge base that cannot be computed and a base ref whose commit cannot be read both counting as failures while a missing ref does not, an empty half-collected change set still speaking, a repository git cannot read at all still having no change set, every character PowerShell reads as a single quote being escaped, a path containing a newline staying one path, a committed half too large to collect leaving the working tree reported and saying the list is short, a repository git cannot read at all still having no change set, every character PowerShell reads as a single quote being escaped, the change set command agreeing exactly with the hook over a committed rename in a repository with no remote, the manual skill deferring to that command rather than carrying its own, commits on a branch alongside uncommitted work, a file both committed and then edited, a call from a subdirectory, a repository with no remote, a clone that has `origin/HEAD`, a non-repository directory, and a repository git cannot read; that no tool is ever refused, on every host, for built-in, MCP, `apply_patch`, and unknown tool names; that a stop over a changed branch holds nothing and writes nothing to stderr on every host; instruction and change-set injection at session start and at a prompt, silence over a clean branch, the notice's ten-path cap, Cursor's first workspace root, and a branch whose every path a note covers; provider-specific context and allow shapes; exact event-name matching; that the instructions contain no placeholder, no transfer question, no control action, and the `covers` key `notes.mjs` reads; adapter and hook config validity and safe command encoding against shell metacharacters; and, by spawning the real entrypoint, a symlinked plugin root, malformed stdin, and Kiro's now-zero process exit.

## Security boundary

This plugin is a learning workflow guardrail, not a sandbox or authorization boundary. No tool is ever refused and nothing is enforced. It does not try to stop an agent that wants to ignore it, and it accepts every residual that follows: host permissions still apply, and specialized tool paths that do not emit the configured hook event cannot be intercepted by this code. The hook cannot tell the user's own edits from the agent's, so a change the user made themselves is reported alongside the agent's. The host hook runner and the Node executable it uses to start this plugin are part of the trusted bootstrap; adapter bootstrap commands require a trusted launch environment.

Current primary references:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [Kiro CLI hooks](https://kiro.dev/docs/cli/hooks/)
- [Kiro built-in tools](https://kiro.dev/docs/reference/built-in-tools/)
