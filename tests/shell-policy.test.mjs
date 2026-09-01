import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleHook } from "../core/gate.mjs";
import { classifyShellCommand } from "../core/shell.mjs";

// Constructs that cannot be broken into independently classifiable commands,
// so they are refused outright rather than reasoned about.
const UNDECOMPOSABLE_COMMANDS = [
  "cat < README.md",
  "cat << EOF",
  "echo hi & rm src/app.js",
  "(cd src)",
  // An unterminated quote means the scan never returned to the unquoted state.
  'cat "README.md',
  "cat 'README.md",
  ""
];

const READ_COMMANDS = [
  "cat README.md",
  "head -n 20 core/gate.mjs",
  "tail -5 core/state.mjs",
  "sed -n 1,40p core/gate.mjs",
  "grep -rn classifyTool core",
  "rg --files",
  "ls -la core",
  "find core -name *.mjs",
  "wc -l core/gate.mjs",
  "git log --oneline -10",
  "git diff",
  "git status",
  "git show HEAD",
  "/usr/bin/cat README.md",
  // Unknown commands pass: this is a denylist, and the residual bypass is an
  // accepted trade for not degrading exploration.
  "jq . package.json"
];

const WRITE_COMMANDS = [
  "rm -rf src",
  "mv core/gate.mjs core/gate.bak",
  "cp README.md README.bak",
  "mkdir newdir",
  "touch src/app.js",
  "tee out.txt",
  "chmod +x scripts/render-adapter.mjs",
  "dd if=/dev/zero of=out.bin",
  "truncate -s 0 README.md",
  "sed -i s/a/b/ README.md",
  "sed --in-place s/a/b/ README.md",
  "sed -ni s/a/b/ README.md",
  "find core -name *.mjs -exec rm {} +",
  "find core -delete",
  "git commit -m wip",
  "git add .",
  "git checkout main",
  "git -C /elsewhere log",
  "npm test",
  "npx tsc",
  "node -e process.exit",
  "python3 script.py",
  "perl -pi script.pl",
  "bash script.sh",
  "sudo rm README.md",
  "xargs rm",
  "curl https://example.com",
  "make build",
  "/bin/rm README.md",
  "RM README.md",
  // An executable extension must not hide a denylisted name; these are
  // reachable from WSL as well as Windows.
  "node.exe -e process.exit",
  "python3.EXE script.py",
  "npm.cmd test",
  "rm.bat README.md"
];

// Separators are decomposed rather than refused: every segment is classified,
// and the whole command is inspection only when all of them are.
const SEPARATED_READ_COMMANDS = [
  "ls -l | grep mjs",
  "grep -rn classifyTool core | sort | uniq -c",
  "git log --oneline | head -20",
  "cat README.md ; cat package.json",
  "cat README.md && cat package.json",
  "cat README.md || cat package.json",
  "cat README.md\ncat package.json",
  "cat README.md;",
  // A pipe inside quotes is data, not a separator, and must not be refused.
  'grep -rn "win32|powershell" core',
  "grep -rn 'a|b' core",
  "grep -c win32\\|powershell core/gate.mjs"
];

const SEPARATED_WRITE_COMMANDS = [
  "ls -l | tee out.txt",
  "cat README.md | npm run seed",
  "cat README.md ; rm -rf src",
  "cat README.md && git commit -m wip",
  "cat README.md\nrm src/app.js",
  "grep -rn foo core | xargs rm"
];

// Redirection is allowed only in forms that cannot name a file to write:
// /dev/null, and file-descriptor duplication.
const REDIRECT_READ_COMMANDS = [
  "find core -name *.mjs 2>/dev/null",
  "find core -name *.mjs 2> /dev/null",
  "grep -rn foo core >/dev/null",
  "grep -rn foo core >>/dev/null",
  "grep -rn foo core &>/dev/null",
  "grep -rn foo core 2>&1",
  "grep -rn foo core 2>&-",
  "ls -l 2>/dev/null | head -5"
];

const REDIRECT_WRITE_COMMANDS = [
  "cat README.md > out.txt",
  "cat README.md >> out.txt",
  "cat README.md 2>out.txt",
  "cat README.md > /dev/nullx",
  "cat README.md >",
  // An ambiguous token boundary must resolve to a refusal, never to an allow.
  "cat file2>out.txt"
];

/*
 * Parameter expansion is allowed because POSIX does not re-parse the result of
 * an expansion for control operators, so `$FOO` cannot introduce a second
 * command. Command substitution does run a command, so its body is classified
 * recursively instead.
 */
const EXPANSION_READ_COMMANDS = [
  "echo $HOME",
  "cat $HOME/.bashrc",
  "cat ${HOME}/.bashrc",
  "grep -rn foo $(pwd)",
  "ls `pwd`",
  'grep -rn foo "$(pwd)"',
  "cat $HOME/x | grep -c foo"
];

const EXPANSION_WRITE_COMMANDS = [
  // An expansion in the command-name position hides the name from the
  // denylist, so the segment cannot be judged.
  "$FOO README.md",
  "$(echo cat) README.md",
  "`echo cat` README.md",
  "${FOO} README.md",
  // The body of a substitution is classified like any other command.
  "grep -rn foo $(rm -rf src)",
  'grep -rn foo "$(git commit -m wip)"',
  "ls `rm -rf src`",
  // Nested substitution inside a parameter expansion is not decomposed.
  "cat ${FOO:-$(rm -rf src)}",
  // An unterminated substitution has no body to classify.
  "cat $(pwd",
  "ls `pwd",
  "cat ${HOME",
  // Unsupported expansion forms stay refused.
  "cat $?",
  "cat $1"
];

/*
 * Commands whose classification reads their arguments use an allowlist of
 * read-only flags, so a flag the scanner cannot see -- an expansion, or simply
 * one nobody has vetted -- falls outside the allowed set instead of slipping
 * past a denylist. This is the same failure direction that already protects
 * `git`, whose subcommands are an allowlist.
 */
const ARGUMENT_SENSITIVE_READ_COMMANDS = [
  "sed -n 1,40p core/gate.mjs",
  "sed -n -e 1p core/gate.mjs",
  "sed --quiet 1p core/gate.mjs",
  "find core -name *.mjs",
  "find . -type f -maxdepth 2",
  "find core -iname x -print",
  "find . -mtime -1",
  "git log --oneline"
];

const ARGUMENT_SENSITIVE_WRITE_COMMANDS = [
  // The reported bypass: an expanded argument is invisible, so a denylist over
  // argument content never matched it.
  "sed $FLAG s/a/b/ README.md",
  "sed ${FLAG} s/a/b/ README.md",
  "sed $(echo -i) s/a/b/ README.md",
  "find core $ACTION",
  "find core $(echo -delete)",
  "git $SUB",
  // Unvetted flags are outside the allowlist rather than absent from a denylist.
  "sed -i s/a/b/ README.md",
  "sed --in-place s/a/b/ README.md",
  "sed --unknown 1p README.md",
  "find core -delete",
  "find core -name *.mjs -exec rm {} +",
  "find core -fprintf out.txt %p"
];

/*
 * The first token is not always the command: POSIX allows leading NAME=VALUE
 * assignments, and several wrappers run their first operand instead. Both
 * would otherwise present a name the tables do not match and classify as
 * inspection.
 */
const PREFIXED_READ_COMMANDS = [
  "LC_ALL=C grep -rn foo core",
  "GIT_PAGER=cat git log --oneline",
  "LC_ALL=C TZ=UTC cat README.md",
  // Assignments with no command after them execute nothing.
  "LC_ALL=C"
];

const PREFIXED_WRITE_COMMANDS = [
  // The assignment prefix does not hide the command it runs.
  "LC_ALL=C rm -rf src",
  "FOO=1 npm test",
  // Assignments that rebind command resolution or shell startup are refused
  // even when the command that follows reads.
  "PATH=/tmp cat README.md",
  "PATH=/tmp rm -rf src",
  "LD_PRELOAD=/tmp/x.so cat README.md",
  "BASH_ENV=/tmp/x cat README.md",
  "IFS=, cat README.md",
  // Wrappers run their operand, so they are refused rather than unwrapped.
  "command rm -rf src",
  "command cat README.md",
  "builtin cd /tmp",
  "nice -n 10 rm -rf src",
  "time npm test",
  "stdbuf -o0 rm README.md",
  "ionice -c3 rm README.md",
  "taskset -c 0 rm README.md"
];

test("a leading assignment or wrapper cannot hide the command that runs", () => {
  for (const command of PREFIXED_READ_COMMANDS) {
    assert.equal(classifyShellCommand(command), "read", command);
  }
  for (const command of PREFIXED_WRITE_COMMANDS) {
    assert.equal(classifyShellCommand(command), "write", command);
  }
});

test("argument-sensitive commands are judged by an allowlist of read-only flags", () => {
  for (const command of ARGUMENT_SENSITIVE_READ_COMMANDS) {
    assert.equal(classifyShellCommand(command), "read", command);
  }
  for (const command of ARGUMENT_SENSITIVE_WRITE_COMMANDS) {
    assert.equal(classifyShellCommand(command), "write", command);
  }
});

test("redirection is allowed only where it cannot name a write target", () => {
  for (const command of REDIRECT_READ_COMMANDS) {
    assert.equal(classifyShellCommand(command), "read", command);
  }
  for (const command of REDIRECT_WRITE_COMMANDS) {
    assert.equal(classifyShellCommand(command), "write", command);
  }
});

test("parameter expansion is allowed and command substitution is classified recursively", () => {
  for (const command of EXPANSION_READ_COMMANDS) {
    assert.equal(classifyShellCommand(command), "read", command);
  }
  for (const command of EXPANSION_WRITE_COMMANDS) {
    assert.equal(classifyShellCommand(command), "write", command);
  }
});

test("shell classification refuses constructs it cannot decompose", () => {
  for (const command of UNDECOMPOSABLE_COMMANDS) {
    assert.equal(classifyShellCommand(command), "write", command);
  }
});

test("shell classification decomposes separators and classifies every segment", () => {
  for (const command of SEPARATED_READ_COMMANDS) {
    assert.equal(classifyShellCommand(command), "read", command);
  }
  for (const command of SEPARATED_WRITE_COMMANDS) {
    assert.equal(classifyShellCommand(command), "write", command);
  }
});

test("quoting cannot hide a denylisted flag from token matching", () => {
  for (const command of ['sed "-i" s/a/b/ README.md', "sed '-i' s/a/b/ README.md"]) {
    assert.equal(classifyShellCommand(command), "write", command);
  }
});

test("shell classification allows plain inspection commands", () => {
  for (const command of READ_COMMANDS) {
    assert.equal(classifyShellCommand(command), "read", command);
  }
});

test("shell classification denies commands that mutate or run project code", () => {
  for (const command of WRITE_COMMANDS) {
    assert.equal(classifyShellCommand(command), "write", command);
  }
});

test("pending gates allow plain inspection through Claude Code's built-in shell", () => {
  for (const command of [...READ_COMMANDS, ...SEPARATED_READ_COMMANDS]) {
    const result = pending("Bash", command);
    assert.equal(result.stdout, "", `${command} should be allowed while pending`);
    assert.equal(result.exitCode, 0, command);
  }
});

test("pending gates still deny mutating shell commands", () => {
  for (const command of [...WRITE_COMMANDS, ...SEPARATED_WRITE_COMMANDS, ...UNDECOMPOSABLE_COMMANDS]) {
    const result = pending("Bash", command);
    const output = result.stdout ? JSON.parse(result.stdout) : null;
    assert.equal(
      output?.hookSpecificOutput?.permissionDecision,
      "deny",
      `${command} must stay denied while pending`
    );
  }
});

test("every shell tool name is classified, not just Claude Code's Bash", () => {
  for (const toolName of ["PowerShell", "Shell", "execute_bash", "execute_command", "control_bash_process"]) {
    assert.equal(pending(toolName, "cat README.md").stdout, "", `${toolName} inspection`);
    const denied = pending(toolName, "rm -rf src");
    assert.equal(
      JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision,
      "deny",
      `${toolName} mutation`
    );
  }
});

/*
 * The classifier reads the command instead of trusting the tool name, so it is
 * not keyed by provider. Codex is included even though an extension there can
 * present a built-in's name: the residual risk is a same-named tool that puts
 * a non-POSIX string in `command`, which the scan would then be reading with
 * the wrong grammar. A tool that carries no `command` string at all fails
 * closed instead, so only that narrow case is accepted.
 */
test("shell classification applies on every provider, including Codex", () => {
  for (const extraEnv of [{}, { PLUGIN_ROOT: "/plugin" }, { CURSOR_VERSION: "1.0" }]) {
    const label = JSON.stringify(extraEnv);
    assert.equal(pending("Bash", "cat README.md", extraEnv).stdout, "", `${label} inspection`);
    const denied = pending("Bash", "git commit -m wip", extraEnv);
    assert.equal(
      JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision,
      "deny",
      `${label} mutation`
    );
  }
});

test("a missing or non-string command is denied rather than treated as inspection", () => {
  for (const toolInput of [{}, { command: null }, { command: 42 }, { command: ["cat", "README.md"] }]) {
    const result = handleHook(
      {
        session_id: "shell-shape",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: toolInput
      },
      "compatible",
      createFixture()
    );
    const output = result.stdout ? JSON.parse(result.stdout) : null;
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny", JSON.stringify(toolInput));
  }
});

function pending(toolName, command, extraEnv = {}) {
  const fixture = createFixture(extraEnv);
  const session = { session_id: `shell-${toolName}-${command}` };
  handleHook({ ...session, hook_event_name: "SessionStart" }, "compatible", fixture);
  return handleHook(
    { ...session, hook_event_name: "PreToolUse", tool_name: toolName, tool_input: { command } },
    "compatible",
    fixture
  );
}

function createFixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-shell-"));
  return { env: { COMPREHENSION_GATE_STATE_DIR: directory, ...extraEnv } };
}
