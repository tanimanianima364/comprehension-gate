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
  for (const toolName of ["read_file", "read", "search_files", "semantic_search", "Read", "Grep"]) {
    const result = pending(toolName, createFixture({ PLUGIN_ROOT: "/plugin" }));
    const output = result.stdout ? JSON.parse(result.stdout) : null;
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny", `${toolName} must be denied on Codex while pending`);
  }
  assert.equal(pending("view_image", createFixture({ PLUGIN_ROOT: "/plugin" })).stdout, "", "Codex view_image is read-only");
});

test("the network opt-in only covers the provider's own built-in network tools", () => {
  const fixture = createFixture({ PLUGIN_ROOT: "/plugin", COMPREHENSION_GATE_ALLOW_NETWORK_INSPECTION: "1" });
  for (const toolName of ["web_search", "web_fetch", "WebFetch"]) {
    const result = pending(toolName, fixture);
    const output = result.stdout ? JSON.parse(result.stdout) : null;
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny", `${toolName} must stay denied on Codex even with the opt-in`);
  }
});

test("pending gates deny network tools by default", () => {
  for (const toolName of NETWORK_TOOLS) {
    const result = pending(toolName, createFixture());
    const output = result.stdout ? JSON.parse(result.stdout) : null;
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny", `${toolName} must be denied while pending`);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /network/i, toolName);
  }
});

test("COMPREHENSION_GATE_ALLOW_NETWORK_INSPECTION=1 opts network tools back in while pending", () => {
  for (const toolName of NETWORK_TOOLS) {
    const result = pending(toolName, createFixture({ COMPREHENSION_GATE_ALLOW_NETWORK_INSPECTION: "1" }));
    assert.equal(result.stdout, "", `${toolName} should be allowed with the opt-in`);
  }
  const off = pending("WebFetch", createFixture({ COMPREHENSION_GATE_ALLOW_NETWORK_INSPECTION: "0" }));
  assert.equal(JSON.parse(off.stdout).hookSpecificOutput.permissionDecision, "deny", "only \"1\" enables the opt-in");
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
