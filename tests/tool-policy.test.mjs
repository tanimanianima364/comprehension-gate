import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleHook } from "../core/gate.mjs";

const HARNESS_TOOLS = ["AskUserQuestion", "LS", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"];
const DELEGATING_TOOLS = ["Skill", "Agent", "Task"];
const NETWORK_TOOLS = ["WebFetch", "WebSearch"];

test("pending gates allow harness tools that cannot mutate the project", () => {
  for (const toolName of HARNESS_TOOLS) {
    const result = pending(toolName, createFixture());
    assert.equal(result.stdout, "", `${toolName} should be allowed while pending`);
    assert.equal(result.exitCode, 0, toolName);
  }
});

test("pending gates deny tools that delegate execution (skill preprocessing, subagent worktrees)", () => {
  for (const toolName of DELEGATING_TOOLS) {
    const result = pending(toolName, createFixture());
    const output = result.stdout ? JSON.parse(result.stdout) : null;
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny", `${toolName} must be denied while pending`);
  }
});

test("the harness allowlist is provider-specific: Claude Code names are not trusted on other providers", () => {
  for (const toolName of HARNESS_TOOLS) {
    const result = pending(toolName, createFixture({ PLUGIN_ROOT: "/plugin" }));
    const output = result.stdout ? JSON.parse(result.stdout) : null;
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny", `${toolName} must be denied on Codex`);
  }
  for (const mode of ["cursor", "kiro"]) {
    const result = pending("AskUserQuestion", createFixture(), mode);
    const denied = mode === "kiro" ? result.exitCode === 2 : JSON.parse(result.stdout).permission === "deny";
    assert.ok(denied, `${mode}: AskUserQuestion must be denied`);
  }
});

test("the read-only allowlist is provider-specific: generic read names are not trusted on Codex", () => {
  // Codex has no name-based read allowlist at all: even built-in names such as
  // view_image can be taken over by an extension when the built-in is disabled.
  for (const toolName of ["read_file", "read", "search_files", "semantic_search", "Read", "Grep", "view_image"]) {
    const result = pending(toolName, createFixture({ PLUGIN_ROOT: "/plugin" }));
    const output = result.stdout ? JSON.parse(result.stdout) : null;
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny", `${toolName} must be denied on Codex while pending`);
  }
});

test("Cursor Glob is not a supported Cursor hook tool and is denied while pending", () => {
  const result = pending("Glob", createFixture(), "cursor");
  assert.equal(JSON.parse(result.stdout).permission, "deny");
});

/*
 * A network read is a read. The gate protects this project from mutation
 * before understanding, and neither of these tools can mutate it. Denying them
 * cost the agent its research and bought nothing the gate ever promised: a
 * remote resource is not the project, and the hook allows these tools the
 * moment the gate passes, so it never protected one.
 */
test("pending gates allow the provider's built-in network reads", () => {
  for (const toolName of NETWORK_TOOLS) {
    const result = pending(toolName, createFixture());
    assert.equal(result.stdout, "", `${toolName} should be allowed while pending`);
    assert.equal(result.exitCode, 0, toolName);
  }
});

test("the network allowlist is provider-specific: generic names are not trusted on other providers", () => {
  for (const toolName of ["web_search", "web_fetch", "WebFetch"]) {
    const result = pending(toolName, createFixture({ PLUGIN_ROOT: "/plugin" }));
    const output = result.stdout ? JSON.parse(result.stdout) : null;
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny", `${toolName} must be denied on Codex`);
  }
  for (const mode of ["cursor", "kiro"]) {
    const result = pending("WebFetch", createFixture(), mode);
    const denied = mode === "kiro" ? result.exitCode === 2 : JSON.parse(result.stdout).permission === "deny";
    assert.ok(denied, `${mode}: WebFetch must be denied`);
  }
});

function pending(toolName, fixture, mode = "compatible") {
  const session = { session_id: `policy-${toolName}` };
  handleHook({ ...session, hook_event_name: "SessionStart" }, mode, fixture);
  return handleHook(
    { ...session, hook_event_name: "PreToolUse", tool_name: toolName, tool_input: { url: "http://localhost:3000/reset", path: "." } },
    mode,
    fixture
  );
}

function createFixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-policy-"));
  return { env: { COMPREHENSION_GATE_STATE_DIR: directory, ...extraEnv } };
}
