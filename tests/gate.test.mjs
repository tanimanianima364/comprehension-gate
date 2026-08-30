import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  controlCommand,
  controlCommandSucceeded,
  handleHook,
  isReadOnlyShellCommand,
  malformedInputResult
} from "../core/gate.mjs";

test("compatible flow blocks writes until the exact pass command runs", () => {
  const fixture = createFixture({ PLUGIN_ROOT: "/plugin" });
  const base = { session_id: "session-1", turn_id: "turn-1" };

  const start = handleHook(
    { ...base, hook_event_name: "SessionStart", source: "startup" },
    "compatible",
    fixture
  );
  assert.equal(start.exitCode, 0);
  assert.equal(JSON.parse(start.stdout).hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(start.stdout, /Comprehension Gate/);

  const blocked = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch" } },
    "compatible",
    fixture
  );
  assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, "deny");

  const readOnly = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rg --files" } },
    "compatible",
    fixture
  );
  assert.equal(readOnly.stdout, "");

  const pass = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tool-pass", tool_input: { command: controlCommand("pass") } },
    "compatible",
    fixture
  );
  assert.equal(pass.stdout, "");

  const stillBlocked = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "src/app.js" } },
    "compatible",
    fixture
  );
  assert.equal(JSON.parse(stillBlocked.stdout).hookSpecificOutput.permissionDecision, "deny");

  handleHook(
    {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "tool-pass",
      tool_input: { command: controlCommand("pass") },
      tool_response: {
        stdout: "<!-- comprehension-gate:pass -->\n",
        stderr: "",
        interrupted: false
      }
    },
    "compatible",
    fixture
  );

  const allowed = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "src/app.js" } },
    "compatible",
    fixture
  );
  assert.equal(allowed.stdout, "");

  handleHook(
    { ...base, turn_id: "turn-2", hook_event_name: "UserPromptSubmit", prompt: "another request" },
    "compatible",
    fixture
  );
  const blockedAgain = handleHook(
    { ...base, turn_id: "turn-2", hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(JSON.parse(blockedAgain.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("control commands must be standalone exact matches", () => {
  const fixture = createFixture();
  const base = { session_id: "session-2", hook_event_name: "SessionStart", source: "startup" };
  handleHook(base, "compatible", fixture);

  const result = handleHook(
    {
      session_id: "session-2",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: `${controlCommand("pass")} && touch bypassed` }
    },
    "compatible",
    fixture
  );

  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("a failed Codex control result cannot pass the gate", () => {
  const fixture = createFixture({ PLUGIN_ROOT: "/plugin" });
  const base = {
    session_id: "session-failed-control",
    turn_id: "turn-failed-control",
    hook_event_name: "SessionStart",
    source: "startup"
  };
  handleHook(base, "compatible", fixture);

  handleHook(
    {
      session_id: base.session_id,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "failed-tool",
      tool_input: { command: controlCommand("pass") }
    },
    "compatible",
    fixture
  );

  handleHook(
    {
      session_id: base.session_id,
      turn_id: base.turn_id,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "failed-tool",
      tool_input: { command: controlCommand("pass") },
      tool_response: { exit_code: 1, output: "Process exited with code 1" }
    },
    "compatible",
    fixture
  );

  const write = handleHook(
    { session_id: base.session_id, turn_id: base.turn_id, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(JSON.parse(write.stdout).hookSpecificOutput.permissionDecision, "deny");

  handleHook(
    {
      session_id: base.session_id,
      turn_id: base.turn_id,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "successful-tool",
      tool_input: { command: controlCommand("pass") }
    },
    "compatible",
    fixture
  );
  handleHook(
    {
      session_id: base.session_id,
      turn_id: base.turn_id,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "successful-tool",
      tool_input: { command: controlCommand("pass") },
      tool_response: {
        exit_code: 0,
        output: "<!-- comprehension-gate:pass -->\n"
      }
    },
    "compatible",
    fixture
  );
  const allowed = handleHook(
    { session_id: base.session_id, turn_id: base.turn_id, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(allowed.stdout, "");
});

test("a control completion armed in an earlier turn cannot pass a reset gate", () => {
  const fixture = createFixture({ PLUGIN_ROOT: "/plugin" });
  const first = { session_id: "session-stale", turn_id: "turn-1" };
  handleHook({ ...first, hook_event_name: "SessionStart" }, "compatible", fixture);
  handleHook(
    {
      ...first,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "old-tool",
      tool_input: { command: controlCommand("pass") }
    },
    "compatible",
    fixture
  );

  const second = { session_id: first.session_id, turn_id: "turn-2" };
  handleHook(
    { ...second, hook_event_name: "UserPromptSubmit", prompt: "new request" },
    "compatible",
    fixture
  );
  handleHook(
    {
      ...first,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "old-tool",
      tool_input: { command: controlCommand("pass") },
      tool_response: { exit_code: 0, output: "<!-- comprehension-gate:pass -->" }
    },
    "compatible",
    fixture
  );

  const write = handleHook(
    { ...second, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(JSON.parse(write.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("provider-specific denial shapes are correct", () => {
  const cursor = createFixture();
  handleHook({ session_id: "cursor", hook_event_name: "SessionStart" }, "cursor", cursor);
  const cursorReset = handleHook(
    {
      conversation_id: "cursor",
      generation_id: "generation-1",
      hook_event_name: "beforeSubmitPrompt",
      prompt: "change the code"
    },
    "cursor",
    cursor
  );
  assert.deepEqual(JSON.parse(cursorReset.stdout), { continue: true });
  const cursorDenied = handleHook(
    {
      conversation_id: "cursor",
      generation_id: "generation-1",
      hook_event_name: "preToolUse",
      tool_name: "Write",
      tool_input: {}
    },
    "cursor",
    cursor
  );
  assert.equal(JSON.parse(cursorDenied.stdout).permission, "deny");

  const kiro = createFixture();
  const kiroStart = handleHook(
    { session_id: "kiro", hook_event_name: "agentSpawn" },
    "kiro",
    kiro
  );
  assert.match(kiroStart.stdout, /Comprehension Gate/);
  const kiroDenied = handleHook(
    { session_id: "kiro", hook_event_name: "preToolUse", tool_name: "fs_write", tool_input: {} },
    "kiro",
    kiro
  );
  assert.equal(kiroDenied.exitCode, 2);
  assert.match(kiroDenied.stderr, /not satisfied/);
});

test("Kiro requires success true and the expected marker", () => {
  const fixture = createFixture();
  const base = { session_id: "kiro-control" };
  handleHook({ ...base, hook_event_name: "agentSpawn" }, "kiro", fixture);

  handleHook(
    {
      ...base,
      hook_event_name: "preToolUse",
      tool_name: "execute_bash",
      tool_input: { command: controlCommand("pass") }
    },
    "kiro",
    fixture
  );
  handleHook(
    {
      ...base,
      hook_event_name: "postToolUse",
      tool_name: "execute_bash",
      tool_input: { command: controlCommand("pass") },
      tool_response: {
        success: false,
        result: ["<!-- comprehension-gate:pass -->"]
      }
    },
    "kiro",
    fixture
  );
  assert.equal(
    handleHook(
      { ...base, hook_event_name: "preToolUse", tool_name: "fs_write", tool_input: {} },
      "kiro",
      fixture
    ).exitCode,
    2
  );

  handleHook(
    {
      ...base,
      hook_event_name: "preToolUse",
      tool_name: "execute_bash",
      tool_input: { command: controlCommand("pass") }
    },
    "kiro",
    fixture
  );
  handleHook(
    {
      ...base,
      hook_event_name: "postToolUse",
      tool_name: "execute_bash",
      tool_input: { command: controlCommand("pass") },
      tool_response: {
        success: true,
        result: ["<!-- comprehension-gate:pass -->"]
      }
    },
    "kiro",
    fixture
  );
  assert.equal(
    handleHook(
      { ...base, hook_event_name: "preToolUse", tool_name: "fs_write", tool_input: {} },
      "kiro",
      fixture
    ).exitCode,
    0
  );
});

test("provider result parsing rejects missing markers and explicit failures", () => {
  assert.equal(
    controlCommandSucceeded(
      { tool_response: { exit_code: 0, output: "no marker" } },
      "codex",
      "pass"
    ),
    false
  );
  assert.equal(
    controlCommandSucceeded(
      { tool_output: JSON.stringify({ exitCode: 1, stdout: "<!-- comprehension-gate:pass -->" }) },
      "cursor",
      "pass"
    ),
    false
  );
  assert.equal(
    controlCommandSucceeded(
      { tool_output: JSON.stringify({ exitCode: 0, stdout: "<!-- comprehension-gate:pass -->" }) },
      "cursor",
      "pass"
    ),
    true
  );
});

test("malformed hook input fails closed", () => {
  assert.equal(JSON.parse(malformedInputResult("compatible").stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(malformedInputResult("kiro").exitCode, 2);
});

test("a failed prompt reset blocks submission and invalidates an earlier pass", () => {
  const fixture = createFixture();
  const base = { session_id: "reset-failure" };
  handleHook({ ...base, hook_event_name: "SessionStart" }, "compatible", fixture);
  handleHook(
    {
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "reset-pass",
      tool_input: { command: controlCommand("pass") }
    },
    "compatible",
    fixture
  );
  handleHook(
    {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "reset-pass",
      tool_input: { command: controlCommand("pass") },
      tool_response: { stdout: "<!-- comprehension-gate:pass -->" }
    },
    "compatible",
    fixture
  );

  let failRename = true;
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync" && failRename) {
        return () => {
          failRename = false;
          throw new Error("injected rename failure");
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const reset = handleHook(
    { ...base, hook_event_name: "UserPromptSubmit", prompt: "next request" },
    "compatible",
    { ...fixture, fs: failingFs }
  );
  assert.equal(reset.exitCode, 2);
  assert.match(reset.stderr, /could not reset/);

  const write = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(JSON.parse(write.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("command entrypoint consumes hook JSON over stdin", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-cli-"));
  const input = JSON.stringify({
    session_id: "cli-session",
    hook_event_name: "SessionStart",
    source: "startup"
  });
  const result = spawnSync(process.execPath, [new URL("../core/gate.mjs", import.meta.url).pathname, "compatible"], {
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      COMPREHENSION_GATE_STATE_DIR: directory,
      PLUGIN_ROOT: "/plugin"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, "SessionStart");
});

test("shell policy is conservative", () => {
  const allowed = [
    "pwd",
    "rg --files",
    "git status --short",
    "git diff -- src/app.js",
    "find src -maxdepth 2 -type f",
    "Get-Content README.md"
  ];
  const denied = [
    "touch file",
    "cat source > target",
    "rg --files | xargs rm",
    "find . -delete",
    "git checkout main",
    "git branch new-branch",
    "git branch --edit-description",
    "git branch --set-upstream-to=origin/main",
    "git tag v1.0.0",
    "git diff --output=patch.txt",
    "go env -w GOPATH=/tmp/go",
    "go list -mod=mod ./...",
    "sort --output sorted.txt input.txt",
    "sort /O sorted.txt input.txt",
    "tree -o tree.txt .",
    "uniq input.txt output.txt",
    "node -e \"require('fs').writeFileSync('x','y')\"",
    "echo $(touch bypassed)"
  ];

  for (const command of allowed) {
    assert.equal(isReadOnlyShellCommand(command), true, command);
  }
  for (const command of denied) {
    assert.equal(isReadOnlyShellCommand(command), false, command);
  }
});

test("known output and metadata mutation forms are denied through PreToolUse", () => {
  const fixture = createFixture();
  const base = { session_id: "shell-bypass", hook_event_name: "SessionStart" };
  handleHook(base, "compatible", fixture);
  const commands = [
    "uniq /dev/null src/app.js",
    "tree -o src/app.js .",
    "git branch --set-upstream-to=origin/main",
    "go list -mod=mod ./...",
    "sort /O src/app.js input.txt"
  ];

  for (const command of commands) {
    const result = handleHook(
      {
        session_id: base.session_id,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command }
      },
      "compatible",
      fixture
    );
    assert.equal(
      JSON.parse(result.stdout).hookSpecificOutput.permissionDecision,
      "deny",
      command
    );
  }
});

function createFixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-hook-"));
  return {
    env: {
      COMPREHENSION_GATE_STATE_DIR: directory,
      ...extraEnv
    }
  };
}
