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

test("tool names that only collide with the read-only allowlist after stripping characters are denied while pending", () => {
  for (const toolName of ["Read2", "read-2", "@fs/read", "ReadFile.v2", "@web/fetch", "@list/directory"]) {
    const result = handleHook(
      {
        session_id: `collision-${toolName}`,
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: { path: "src/app.js" }
      },
      "compatible",
      createFixture()
    );
    const output = result.stdout ? JSON.parse(result.stdout) : null;
    assert.equal(
      output?.hookSpecificOutput?.permissionDecision,
      "deny",
      `${toolName} must not be treated as a read-only tool`
    );
  }
});

test("canonical read-only tool names still pass through case-insensitively", () => {
  for (const toolName of ["Read", "read_file", "Grep", "WebFetch"]) {
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

function writeTranscript(prompts) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-tx-"));
  const file = path.join(directory, "transcript.jsonl");
  fs.writeFileSync(file, "");
  for (const prompt of prompts) {
    appendHumanPrompt(file, prompt);
  }
  return file;
}

function appendHumanPrompt(file, prompt) {
  fs.appendFileSync(
    file,
    `${JSON.stringify({ type: "user", origin: { kind: "human" }, message: { role: "user", content: prompt } })}\n`
  );
}

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

test("a new human prompt in the transcript invalidates a pass when the prompt reset hook was skipped", () => {
  const fixture = createFixture();
  const transcript = writeTranscript(["first request"]);
  const session = { session_id: "stale-prompt", transcript_path: transcript };

  handleHook({ ...session, hook_event_name: "UserPromptSubmit", prompt: "first request" }, "compatible", fixture);
  passGate(session, fixture);
  const allowed = handleHook(
    { ...session, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(allowed.stdout, "", "same turn stays passed");

  appendHumanPrompt(transcript, "second request");
  const stale = handleHook(
    { ...session, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(
    JSON.parse(stale.stdout).hookSpecificOutput.permissionDecision,
    "deny",
    "the previous turn's pass must not cover a new prompt"
  );

  passGate(session, fixture);
  const recovered = handleHook(
    { ...session, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(recovered.stdout, "", "the new turn can still pass through the control read");
});

test("a prompt whose transcript representation differs from the hook payload can still pass", () => {
  const fixture = createFixture();
  const transcript = writeTranscript(["<command-name>/foo</command-name>"]);
  const session = { session_id: "prompt-shape", transcript_path: transcript };

  handleHook({ ...session, hook_event_name: "UserPromptSubmit", prompt: "/foo" }, "compatible", fixture);
  passGate(session, fixture);
  const allowed = handleHook(
    { ...session, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(allowed.stdout, "");
});

test("the transcript check is skipped when no transcript or turn id is available", () => {
  const fixture = createFixture();
  const session = { session_id: "no-transcript" };
  handleHook({ ...session, hook_event_name: "UserPromptSubmit", prompt: "first request" }, "compatible", fixture);
  passGate(session, fixture);
  const allowed = handleHook(
    { ...session, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(allowed.stdout, "");
});

test("resubmitting the same prompt text starts a new turn that does not inherit the pass", () => {
  const fixture = createFixture();
  const transcript = writeTranscript(["続けて"]);
  const session = { session_id: "same-text", transcript_path: transcript };

  handleHook({ ...session, hook_event_name: "UserPromptSubmit", prompt: "続けて" }, "compatible", fixture);
  passGate(session, fixture);
  assert.equal(
    handleHook({ ...session, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} }, "compatible", fixture).stdout,
    ""
  );

  appendHumanPrompt(transcript, "続けて");
  const stale = handleHook(
    { ...session, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(JSON.parse(stale.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("a satisfied gate whose transcript can no longer be judged returns to pending but can pass again", () => {
  const fixture = createFixture();
  const transcript = writeTranscript(["first request"]);
  const session = { session_id: "unjudgeable", transcript_path: transcript };
  handleHook({ ...session, hook_event_name: "UserPromptSubmit", prompt: "first request" }, "compatible", fixture);
  passGate(session, fixture);

  fs.writeFileSync(transcript, "not json\n");
  const denied = handleHook(
    { ...session, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");

  passGate(session, fixture);
  const allowed = handleHook(
    { ...session, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(allowed.stdout, "", "with no judgeable transcript the re-pass must stick");
});

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
