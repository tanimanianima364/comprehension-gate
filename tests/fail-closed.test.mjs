import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { controlTarget, handleHook } from "../core/gate.mjs";

test("a missing hook_event_name is rejected instead of allowing the tool", () => {
  for (const mode of ["compatible", "cursor", "kiro"]) {
    const result = handleHook(
      {
        session_id: "no-event",
        tool_name: "Write",
        tool_input: { file_path: "src/app.js" }
      },
      mode,
      createFixture()
    );
    assert.equal(result.exitCode, 2, `${mode}: unknown event must exit non-zero`);
    assert.equal(result.stdout, "", `${mode}: unknown event must not emit an allow`);
    assert.match(result.stderr, /unrecognized hook event/i, mode);
  }
});

test("an unrecognized hook_event_name is rejected", () => {
  const result = handleHook(
    { session_id: "odd-event", hook_event_name: "SomethingElse", tool_name: "Write", tool_input: {} },
    "compatible",
    createFixture()
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
});

test("a SessionStart failure exits non-zero instead of emitting a PreToolUse deny", () => {
  const fixture = createFixture();
  const stateDirectory = fixture.env.COMPREHENSION_GATE_STATE_DIR;
  // Make the state directory path unusable: its parent becomes a regular file.
  fs.rmSync(stateDirectory, { recursive: true, force: true });
  fs.writeFileSync(stateDirectory, "not a directory\n");

  for (const mode of ["compatible", "cursor", "kiro"]) {
    const result = handleHook(
      { session_id: "start-failure", hook_event_name: "SessionStart", source: "startup" },
      mode,
      fixture
    );
    assert.equal(result.exitCode, 2, `${mode}: SessionStart failure must be visible`);
    assert.equal(result.stdout, "", `${mode}: no PreToolUse-shaped payload on SessionStart`);
    assert.match(result.stderr, /Comprehension Gate could not initialize/, mode);
  }
});

function createFixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-fc-"));
  return { env: { COMPREHENSION_GATE_STATE_DIR: directory, ...extraEnv } };
}

test("a near-miss on the write list is allowed, and a namespaced write verb is not", () => {
  /*
   * Under a deny list the failure direction inverts. A name that merely
   * resembles a write tool is a different tool and is allowed -- part of the
   * accepted long tail -- while a namespaced write verb is matched through its
   * last segment, because denying more is the safe direction here.
   */
  for (const toolName of ["Read2", "read-2", "@fs/read", "ReadFile.v2", "@web/fetch", "Writer", "unwrite"]) {
    const result = pendingTool(toolName);
    assert.equal(result.stdout, "", `${toolName} is not a named write tool`);
  }

  for (const toolName of ["Write", "WRITE", "fs_write", "mcp__filesystem__write_file", "@filesystem/write_file", "MCP:filesystem.write_file"]) {
    const result = pendingTool(toolName);
    const output = result.stdout ? JSON.parse(result.stdout) : null;
    assert.equal(
      output?.hookSpecificOutput?.permissionDecision,
      "deny",
      `${toolName} must be denied while pending`
    );
  }
});

function pendingTool(toolName) {
  return handleHook(
    {
      session_id: `collision-${toolName}`,
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: { path: "src/app.js" }
    },
    "compatible",
    createFixture()
  );
}

test("canonical read-only tool names still pass through case-insensitively", () => {
  for (const toolName of ["Read", "Grep", "Glob"]) {
    const result = handleHook(
      {
        session_id: `canonical-${toolName}`,
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: { path: "src/app.js" }
      },
      "compatible",
      createFixture()
    );
    assert.equal(result.stdout, "", `${toolName} should be allowed while pending`);
  }
});

test("a pending state seeded without a turn id adopts the first turn id it sees", () => {
  const fixture = createFixture();
  const session = { conversation_id: "cursor-null-turn" };
  handleHook({ ...session, hook_event_name: "sessionStart" }, "cursor", fixture);

  const turn = { ...session, generation_id: "generation-1" };
  const arm = handleHook(
    {
      ...turn,
      hook_event_name: "preToolUse",
      tool_name: "Read",
      tool_use_id: "cursor-pass",
      tool_input: { path: controlTarget("pass") }
    },
    "cursor",
    fixture
  );
  assert.equal(arm.stdout, "", "control read must be allowed after adopting the turn");

  handleHook(
    {
      ...turn,
      hook_event_name: "postToolUse",
      tool_name: "Read",
      tool_use_id: "cursor-pass",
      tool_input: { path: controlTarget("pass") },
      tool_output: JSON.stringify({ exitCode: 0, stdout: "<!-- comprehension-gate:pass -->" })
    },
    "cursor",
    fixture
  );

  const write = handleHook(
    { ...turn, hook_event_name: "preToolUse", tool_name: "Write", tool_input: {} },
    "cursor",
    fixture
  );
  assert.equal(write.stdout, "", "pass must satisfy the adopted turn");

  const otherTurn = handleHook(
    { ...session, generation_id: "generation-2", hook_event_name: "preToolUse", tool_name: "Write", tool_input: {} },
    "cursor",
    fixture
  );
  assert.equal(JSON.parse(otherTurn.stdout).permission, "deny", "a later turn must not inherit the pass");
});

test("a passed state without a turn id does not adopt a new turn id", () => {
  const fixture = createFixture();
  const session = { session_id: "passed-null-turn" };
  handleHook({ ...session, hook_event_name: "SessionStart" }, "compatible", fixture);
  handleHook(
    { ...session, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "p", tool_input: { file_path: controlTarget("pass") } },
    "compatible",
    fixture
  );
  handleHook(
    {
      ...session,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_use_id: "p",
      tool_input: { file_path: controlTarget("pass") },
      tool_response: { stdout: "<!-- comprehension-gate:pass -->" }
    },
    "compatible",
    fixture
  );

  const write = handleHook(
    { ...session, turn_id: "turn-later", hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(JSON.parse(write.stdout).hookSpecificOutput.permissionDecision, "deny");
});

function passGate(session, fixture) {
  handleHook(
    { ...session, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "pass", tool_input: { file_path: controlTarget("pass") } },
    "compatible",
    fixture
  );
  handleHook(
    {
      ...session,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_use_id: "pass",
      tool_input: { file_path: controlTarget("pass") },
      tool_response: { stdout: "<!-- comprehension-gate:pass -->" }
    },
    "compatible",
    fixture
  );
}

test("a second concurrent control completion is an idempotent no-op after the first passes", () => {
  const fixture = createFixture();
  const session = { session_id: "double-complete" };
  handleHook({ ...session, hook_event_name: "SessionStart" }, "compatible", fixture);
  const control = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: controlTarget("pass") } };
  handleHook({ ...session, ...control, tool_use_id: "a" }, "compatible", fixture);
  handleHook({ ...session, ...control, tool_use_id: "b" }, "compatible", fixture);

  const post = id => handleHook(
    {
      ...session,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_use_id: id,
      tool_input: { file_path: controlTarget("pass") },
      tool_response: { stdout: "<!-- comprehension-gate:pass -->" }
    },
    "compatible",
    fixture
  );
  assert.equal(post("a").stdout, "");
  const second = post("b");
  assert.equal(second.stdout, "", `second completion must not report a pending gate: ${second.stdout}`);
  assert.equal(
    handleHook({ ...session, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} }, "compatible", fixture).stdout,
    ""
  );
});

test("controls armed without a tool_use_id are keyed by action so different actions cannot clobber each other", () => {
  const fixture = createFixture();
  const session = { session_id: "no-tool-use-id" };
  handleHook({ ...session, hook_event_name: "SessionStart" }, "compatible", fixture);
  handleHook(
    { ...session, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: controlTarget("pass") } },
    "compatible",
    fixture
  );
  handleHook(
    { ...session, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: controlTarget("bypass-low") } },
    "compatible",
    fixture
  );
  const completed = handleHook(
    {
      ...session,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: controlTarget("pass") },
      tool_response: { stdout: "<!-- comprehension-gate:pass -->" }
    },
    "compatible",
    fixture
  );
  assert.equal(completed.stdout, "", completed.stdout);
  assert.equal(
    handleHook({ ...session, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} }, "compatible", fixture).stdout,
    ""
  );
});

test("Claude Code prompt_id is the turn identity: a new prompt_id without a prompt reset denies, then passes", () => {
  const fixture = createFixture();
  const session = { session_id: "prompt-id" };
  handleHook({ ...session, hook_event_name: "SessionStart" }, "compatible", fixture);
  const turnA = { ...session, prompt_id: "prompt-a" };
  handleHook({ ...turnA, hook_event_name: "UserPromptSubmit", prompt: "first" }, "compatible", fixture);
  passGate(turnA, fixture);
  assert.equal(
    handleHook({ ...turnA, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} }, "compatible", fixture).stdout,
    ""
  );

  // Turn B's UserPromptSubmit hook timed out; the transcript has not caught up either.
  const turnB = { ...session, prompt_id: "prompt-b" };
  const stale = handleHook(
    { ...turnB, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(JSON.parse(stale.stdout).hookSpecificOutput.permissionDecision, "deny");

  passGate(turnB, fixture);
  assert.equal(
    handleHook({ ...turnB, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} }, "compatible", fixture).stdout,
    "",
    "turn B can pass after the automatic reset"
  );
  const oldTurn = handleHook(
    { ...turnA, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(JSON.parse(oldTurn.stdout).hookSpecificOutput.permissionDecision, "deny", "turn A cannot reuse turn B's pass");
});

test("hook_event_name must match a known event exactly", () => {
  const fixture = createFixture();
  const session = { session_id: "event-exact" };
  handleHook({ ...session, hook_event_name: "SessionStart" }, "compatible", fixture);
  passGate(session, fixture);

  for (const event of ["PreToolUse2", "Pre-Tool-Use", "PreToolUse!", "pre_tool_use"]) {
    const result = handleHook(
      { ...session, hook_event_name: event, tool_name: "Write", tool_input: {} },
      "compatible",
      fixture
    );
    assert.equal(result.exitCode, 2, `${event} must be rejected as unrecognized`);
    assert.equal(result.stdout, "", event);
  }
  assert.equal(
    handleHook({ ...session, hook_event_name: "pretooluse", tool_name: "Write", tool_input: {} }, "compatible", fixture).stdout,
    "",
    "case-insensitive exact match still works"
  );
});

test("a failed same-action control without tool_use_id does not clear a parallel successful one", () => {
  const fixture = createFixture();
  const session = { session_id: "no-id-parallel" };
  handleHook({ ...session, hook_event_name: "SessionStart" }, "compatible", fixture);
  const control = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: controlTarget("pass") } };
  handleHook({ ...session, ...control }, "compatible", fixture);
  handleHook({ ...session, ...control }, "compatible", fixture);

  const post = tool_response => handleHook(
    { ...session, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: controlTarget("pass") }, tool_response },
    "compatible",
    fixture
  );
  post({ is_error: true, stdout: "" });
  const completed = post({ stdout: "<!-- comprehension-gate:pass -->" });
  assert.equal(completed.stdout, "", completed.stdout);
  assert.equal(
    handleHook({ ...session, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} }, "compatible", fixture).stdout,
    ""
  );
});
