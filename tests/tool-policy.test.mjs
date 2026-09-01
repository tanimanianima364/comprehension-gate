import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleHook } from "../core/gate.mjs";

const HARNESS_TOOLS = ["AskUserQuestion", "LS", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"];
const DELEGATING_TOOLS = ["Skill", "Agent", "Task"];
const NETWORK_TOOLS = ["WebFetch", "WebSearch"];
const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit", "apply_patch", "fs_write", "EnterWorktree"];

/*
 * The gate allows by default and denies a named set. A tool is on that set
 * when writing is its primary use, or when it offers no way to read at all --
 * not merely because some path through it could write.
 *
 * The asymmetry is the reason. A tool that slips past the deny list means one
 * change reaches the project without a comprehension check, with the user
 * present and the instructions still telling the agent not to mutate. A tool
 * wrongly denied costs capability on every session, silently, until somebody
 * happens to trip over it. The common mutation paths are named here; the long
 * tail is accepted, as it already is for shell commands.
 */
test("pending gates deny the tools whose primary use is writing", () => {
  for (const toolName of WRITE_TOOLS) {
    const result = pending(toolName, createFixture());
    const output = result.stdout ? JSON.parse(result.stdout) : null;
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny", `${toolName} must be denied while pending`);
  }
});

test("pending gates allow harness tools that cannot mutate the project", () => {
  for (const toolName of HARNESS_TOOLS) {
    const result = pending(toolName, createFixture());
    assert.equal(result.stdout, "", `${toolName} should be allowed while pending`);
    assert.equal(result.exitCode, 0, toolName);
  }
});

test("pending gates allow the provider's built-in network reads", () => {
  for (const toolName of NETWORK_TOOLS) {
    assert.equal(pending(toolName, createFixture()).stdout, "", `${toolName} should be allowed while pending`);
  }
});

/*
 * These delegate execution, so an earlier revision denied them: a skill runs
 * `!command` preprocessing and a subagent can create a worktree before its
 * first gated tool call. Neither makes writing their primary use, and both
 * have ordinary read uses, so the criterion allows them and the delegated
 * write joins the accepted long tail.
 */
test("pending gates allow tools that delegate execution", () => {
  for (const toolName of DELEGATING_TOOLS) {
    assert.equal(pending(toolName, createFixture()).stdout, "", `${toolName} should be allowed while pending`);
  }
});

/*
 * The previous allowlist went stale every time the host gained a tool, and the
 * loss was invisible: ToolSearch and plan mode were denied for months while
 * the session instructions promised that gathering information and planning
 * were allowed.
 */
test("pending gates allow host tools nobody enumerated", () => {
  for (const toolName of ["ToolSearch", "EnterPlanMode", "ExitPlanMode", "TaskOutput", "ListAgents", "SomeToolAddedNextYear"]) {
    assert.equal(pending(toolName, createFixture()).stdout, "", `${toolName} should be allowed while pending`);
  }
});

test("pending gates allow MCP tools that are not named write tools", () => {
  for (const toolName of ["mcp__filesystem__read_file", "MCP:filesystem.read_file", "@filesystem/read_file"]) {
    assert.equal(pending(toolName, createFixture()).stdout, "", `${toolName} should be allowed while pending`);
  }
});

test("the write list is not provider-keyed, so a write name is denied on every host", () => {
  for (const fixture of [createFixture(), createFixture({ PLUGIN_ROOT: "/plugin" })]) {
    const result = pending("Write", fixture);
    const output = result.stdout ? JSON.parse(result.stdout) : null;
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
  }
  for (const mode of ["cursor", "kiro"]) {
    const result = pending("fs_write", createFixture(), mode);
    const denied = mode === "kiro" ? result.exitCode === 2 : JSON.parse(result.stdout).permission === "deny";
    assert.ok(denied, `${mode}: fs_write must be denied`);
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
