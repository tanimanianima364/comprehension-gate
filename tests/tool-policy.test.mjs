import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleHook } from "../core/gate.mjs";

const HARNESS_TOOLS = ["AskUserQuestion", "LS", "Task", "Agent", "Skill", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"];
const NETWORK_TOOLS = ["WebFetch", "WebSearch", "web_fetch", "web_search"];

test("pending gates allow harness tools that cannot mutate the project", () => {
  for (const toolName of HARNESS_TOOLS) {
    const result = pending(toolName, createFixture());
    assert.equal(result.stdout, "", `${toolName} should be allowed while pending`);
    assert.equal(result.exitCode, 0, toolName);
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

function pending(toolName, fixture) {
  const session = { session_id: `policy-${toolName}` };
  handleHook({ ...session, hook_event_name: "SessionStart" }, "compatible", fixture);
  return handleHook(
    { ...session, hook_event_name: "PreToolUse", tool_name: toolName, tool_input: { url: "http://localhost:3000/reset", path: "." } },
    "compatible",
    fixture
  );
}

function createFixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-policy-"));
  return { env: { COMPREHENSION_GATE_STATE_DIR: directory, ...extraEnv } };
}
