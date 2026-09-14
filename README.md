# Intent Notes

Intent Notes puts a deterministic reminder in front of a coding agent: these paths changed on this branch and nothing records why. It does not fork or replace the official `learning-output-style` plugin.

What it asks for is two records. **Docstrings** say what a file or function is for and why it works the way it does; they describe the current state, so they merge like code. **Notes** — markdown files under `docs/notes` — say what one change was trying to achieve and which alternative was rejected; they record a moment, so they are never rewritten, and a later change writes a new note that supersedes the old one instead. Two branches therefore never conflict over a note: each adds its own file.

The hook interrupts no one. It refuses no tool, holds no turn, blocks no prompt, and shows the user nothing. At the start of a session and at every user message it derives the branch's change set from git, subtracts every path covered by a note that is itself part of that change set, and injects what is left. When a tool reads or writes a file some note covers, it names those notes; after a tool writes to an uncovered one it says so immediately. Whether anything gets recorded is up to the agent; the reminder is the only pressure there is.

That is a deliberate trade, and it replaces an earlier design that held the turn and put a transfer question to the user. Questions that the user could not answer from shared context, and a held turn, cost more than they returned.

## Supported hosts

| Agent | Hook configuration | Context reaches the agent | Verified against a running host |
| --- | --- | --- | --- |
| Claude Code | `hooks/hooks.json` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | yes, 2.1.270: every injection observed reaching the model, in order |
| Codex | the same `hooks/hooks.json` | `SessionStart`, `PreToolUse`, `PostToolUse` | hooks yes, CLI 0.151.0/0.153.1; not re-run live for this design |

Kiro and Cursor were supported and are not any more. Both were dropped once the plugin's entire surface became the context it injects: Cursor's prompt hook carries no context field at all and its `preToolUse` is registered `failClosed`, so the one event that mattered most could not be used there without risking every tool call, and Kiro's rendering of context on a tool event was never verified. Supporting a host the design cannot actually reach costs three adapter templates, a renderer, a mode argument threaded through every result, and a per-host shape for each of them — for a gate that, on those hosts, could not do the thing it now exists to do.

The last column is the honest one. Claude Code has been re-run live against this design on 2.1.270, with the hook instrumented to log every event it received. Over a repository holding one note, the order was:

```text
PreToolUse  Read  src/app.js        <- the hint naming the note fires here
PostToolUse Read  src/app.js
PreToolUse  Read  docs/notes/2026-05-01-row-counting-deadbeef.md
PostToolUse Read  docs/notes/2026-05-01-row-counting-deadbeef.md
PreToolUse  Edit  src/app.js        <- the edit comes after the note was read
```

The agent read the note before editing, said so, and then declined to write a new note for what it judged a mechanical change — noting that the file would stay listed in the reminder, which is the designed outcome. `additionalContext` is in that release's `hookSpecificOutput` schema for `PreToolUse` and `PostToolUse` alike, and this is what it reaching the model looks like. One rough edge showed up: in a sandboxed session the change set command needs approval like any other command, so an agent that is refused falls back to reading rather than running it.

Codex discovers the same `hooks/hooks.json` and supplies `CLAUDE_PLUGIN_ROOT`; its hooks were exercised live under the previous design, but whether it renders context on a tool event has not been verified.

## How it works

```text
SessionStart     -> inject the instructions, plus any uncovered paths
UserPromptSubmit -> inject the uncovered paths; stay silent when none are left
PreToolUse       -> allow; reading or writing a covered path also names the notes covering it
PostToolUse      -> allow; a write that landed on an uncovered path is reported at once
Stop             -> allow
```

**On timing.** A host attaches `PreToolUse` context to the *tool's result*, so a hint on an `Edit` reaches the agent only after that edit has run. That is why the hint fires on reads as well as writes — the read that precedes an edit is where it still arrives in time — and why the instructions tell the agent to look a file's notes up itself before changing it rather than waiting to be told. The hook is the backstop, not the plan. Making it arrive first would mean `permissionDecision: "ask"` or a deny, which is the blocking this design removed.

A tool event resolves a path when the tool's name looks like it writes (`/write|edit|patch|create|update|append|insert|delete|remove|move|rename/i`) or, for the hint only, reads (`/read|view|open|cat|inspect|grep|search/i`), and when its input carries one: `file_path`, `filePath`, `path`, `notebook_path`, or the `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:` headers of a Codex `apply_patch` envelope — read as the structured format it is, never as a shell command to be parsed. The *directory* resolves through the same real path the repository root resolves through, so a working directory reached by a symlink does not put every file in it outside the repository. A symlinked file answers to two names and both are looked up: git tracks the link under its own name, which is what a deletion touches and where its notes are filed, while a write through the link changes the target, which is the file git will report as changed. A path's notes are looked up for the whole list at once, so the notes tree is read once per hook invocation rather than once per path. A name proves nothing across hosts, which is why the plugin's old control protocol refused to trust one; that decision gated the gate, while this one only decides whether to offer a hint, so a pattern that catches every host's spelling beats a list that misses new ones. A write made through an ordinary shell command carries no path to resolve and gets neither event; it still appears in the reminder at the next user message.

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

Only the hook's own working directory is examined. Other worktrees of the same repository are not watched. They were, under the previous design, because a held turn invited relocating a change to escape it; with nothing to escape, the branch being worked in is the branch a record belongs to.

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

The first `#` heading in the body is the note's title, and it is what the hook shows when naming the note before an edit — so it should say what the change did, not what section follows.

Coverage is scoped to the change being examined: only a note inside the change set counts. A note an earlier branch left about a file records what that change was for, not this one, so a file that has been explained once does not go silent forever afterwards — changing it again reports it again. This is also why the check is worth anything on a long-lived repository.

`covers` is the only part read by a machine, and it is read exactly: a path missing from the `covers` of every note in the change set stays in the reminder. Only the block list above is read; a list spelled any other way covers nothing, and its paths stay in the reminder. `supersedes` does not change what is covered — a superseded note still covers its paths, and the record of what was believed at the time is the point of keeping it. It is used when notes are named before an edit, so a path covered by two notes does not send a reader to the stale one first.

Coverage is scoped to the change being examined: **only a note that is itself part of the change set counts.** A note an earlier branch left about a file records what that change was for, not this one, so a file explained once does not go silent for every branch afterwards — without this the reminder decays into nothing on a repository of any age. Naming a path's notes before a write is *not* scoped that way: the question there is what is on record about this file, and a note from an earlier branch is exactly what someone about to edit it should read.

Inside one branch the scoping does not help: once a path is covered, further changes to that file are not reported again. The reminder is a floor rather than a ceiling, and the pre-write hint is the mechanism for the rest, putting an edit that contradicts a recorded intent in front of the agent even after the reminder has gone quiet. Making coverage expire with the file's content was considered and rejected: it would need each note to carry a per-path content identity computed by hand, and it would return a path to the reminder on every subsequent keystroke, pushing toward one note per edit rather than one note per change — the opposite of what notes are for.

Everything else fails soft. A note that cannot be read covers nothing, and an unreadable `docs/notes` covers nothing at all: reporting a path as uncovered is always safer than throwing the hook away. Reading the list is the one place where leniency runs the wrong way, so it is strict instead — failing to read a list leaves its paths reported, which someone notices, while reading one loosely silences paths the note never explained, which nobody ever finds out about.

The grammar it accepts is deliberately smaller than YAML's rather than an approximation of it. There is nothing in an entry to decode: no quoting, no escaping, no inline form, no comments. An entry is indentation, a dash, **exactly one space**, and then the name verbatim to the end of the line — leading and trailing spaces included, since a file name may begin or end with one, and eating a leading space once made a note that named ` app.js` cover `app.js` instead. A blank line between entries is fine and the next key ends the list; **any other line voids the whole list** rather than covering what was read before it, because a line this reader cannot read is a line whose meaning it would be guessing at. A note that is not valid UTF-8 is not read at all: decoding it anyway turns each bad byte into U+FFFD, and an entry that then reads as `src\uFFFD.js` covers a real file of that name the note never meant. A path from git is a name, not a path expression — it is compared exactly as git spelled it, and a backslash stays a character, since it is legal in a POSIX file name and rewriting it as a separator once made a changed file look as though it sat under `docs/notes` and vanish from the reminder. The one rewrite is the escape character, and it is the reader's, not the writer's: a `covers` entry, the note's own file name and a path from git are compared with every `%` spelled `%25`, so an entry naming `x%FF.js` is written exactly that way — `x%25FF.js` would be escaped again and match nothing — and a note called `n%.md` is found in the change set under the spelling git gives it, never mistaken for a base note called `n%25.md`. The hook names a note by its real path, since that is the file to read. Paths under `docs/notes` are never reported, so writing a note does not itself demand one. Nothing decides whether a path deserves a note — that judgment stays with the agent, and a purely mechanical change is expected to stay listed.

`hook_event_name` is matched exactly and case-insensitively against the known events; unrecognized or missing values and unparseable hook input exit non-zero without emitting an allow or a deny.

## Development use

Requirements: Node.js 18 or newer.

For Claude Code, install `learning-output-style` separately, then install this plugin. The repository is its own marketplace:

```text
/plugin install learning-output-style
```

```bash
claude plugin marketplace add /absolute/path/to/intent-notes   # or: tanimanianima364/intent-notes
claude plugin install intent-notes@intent-notes
```

The hooks take effect in the next session. After pulling changes, refresh the installed copy with `claude plugin marketplace update intent-notes` followed by `claude plugin update intent-notes@intent-notes`.

**Upgrading from 0.7.x, when the plugin was called `comprehension-gate`.** Neither `marketplace update` nor `plugin update` can carry an installed copy across the rename: the marketplace's own `name` changed, so the name a 0.7.x install knows (`comprehension-gate`) no longer refers to anything to update to, and the plugin id changed with it. Remove the old marketplace — which also uninstalls the plugin that came from it — then add the new one **from the same source you used before** and install:

```bash
claude plugin marketplace remove comprehension-gate
claude plugin marketplace add tanimanianima364/intent-notes   # or the exact same local path you registered before
claude plugin install intent-notes@intent-notes
```

A local path keeps working after pulling: renaming the repository does not rename a clone, and only the marketplace and plugin names change (the old repository name redirects to the new one).

Two scopes are involved, and they are independent. The marketplace declaration has one (`marketplace add --scope`, default `user`), and the plugin installation has its own (`plugin install --scope`, default `user`); a marketplace declared in `user` with the plugin installed in `project` is a legitimate setup. Keep each where it was: pass the marketplace's old scope to `marketplace remove` and `marketplace add`, and the plugin's old scope to `plugin install`. Without `--scope`, `marketplace remove` removes the declaration from every scope it can edit, and `marketplace add` and `plugin install` both write to `user`, so a plugin that lived in `project` would come back in `user`.

`plugin update` compares the version in `.claude-plugin/plugin.json`, not the commit, so a release that does not raise it reports "already at the latest version" and the installed copy silently stays behind. Raise the version in `package.json`, `.claude-plugin/plugin.json`, and `.codex-plugin/plugin.json` together in the same change, and `claude plugin tag` will check that the manifests and the marketplace entry agree before tagging the release.

To load the working tree directly during development instead:

```bash
claude --plugin-dir /absolute/path/to/intent-notes
```

Updating changes the hook command definitions, and Codex will not run a hook whose definition changed until it is approved again: after an update, open an interactive session and re-approve with `/hooks`.

Codex discovers `hooks/hooks.json` from the plugin root after the plugin is installed and trusted. Until they are trusted, Codex skips the plugin's hooks **silently**: no warning on stderr and nothing at `RUST_LOG=trace`, so an untrusted install is indistinguishable from a working one that never fires. `codex exec` cannot grant trust. Run an interactive session, which reports `Hooks need review`, and trust them there; that writes a `trusted_hash` for each hook into `config.toml`. Use `/hooks` to review and trust the exact hook definition.

## Verification

```bash
npm test
```



## Scope

Linux only, and in practice WSL: that is where the plugin is run and where its tests are run, and CI is Ubuntu. No other operating system is tested, and none is claimed. The plugin renders one shell command — the one that prints the change set — and quotes it POSIX style; it compares repository paths as git spells them, with no separator translation. Windows is out of scope: supporting it would mean a second quoting rule for a shell nobody here can run a test against, and a separator conversion that, on a POSIX host, turns a legal character in a file name into a path separator. Both were carried for a while and both are gone.

## Security boundary

This plugin is a learning workflow guardrail, not a sandbox or authorization boundary. No tool is ever refused and nothing is enforced. It does not try to stop an agent that wants to ignore it, and it accepts every residual that follows: host permissions still apply, and specialized tool paths that do not emit the configured hook event cannot be intercepted by this code. The hook cannot tell the user's own edits from the agent's, so a change the user made themselves is reported alongside the agent's. The host hook runner and the Node executable it uses to start this plugin are part of the trusted bootstrap.

Current primary references:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
