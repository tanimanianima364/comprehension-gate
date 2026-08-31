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
  "cat $(printf src)",
  "cat `printf src`",
  "cat README.md > out.txt",
  "cat README.md >> out.txt",
  "cat < README.md",
  "cat README.md 2>&1",
  "echo hi & rm src/app.js",
  "(cd src)",
  // Expansion still happens inside double quotes, so those two characters stay
  // rejected there. Single quotes suppress it and are left alone.
  'cat "$(printf src)"',
  'cat "`printf src`"',
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
