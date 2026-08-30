import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleHook, inspectionCommands } from "../core/gate.mjs";

test("Codex inspection is bound to the cwd recorded at the last reset, not the cwd of the current hook call", t => {
  if (process.platform === "win32") {
    t.skip("POSIX workspace fixture");
    return;
  }
  const fixture = createFixture({ PLUGIN_ROOT: "/plugin" });
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cg-cwd-a-")));
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cg-cwd-b-")));
  const base = { session_id: "codex-cwd-pin", turn_id: "turn-1" };
  handleHook({ ...base, hook_event_name: "SessionStart", cwd: workspace }, "compatible", fixture);

  const [{ command: inside }] = inspectionCommands("inspect-read", ["README.md"], workspace);
  assert.equal(
    handleHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", cwd: workspace, tool_input: { command: inside } }, "compatible", fixture).stdout,
    "",
    "inspection in the recorded workspace is allowed"
  );

  const [{ command: outside }] = inspectionCommands("inspect-read", ["README.md"], elsewhere);
  const denied = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", cwd: elsewhere, tool_input: { command: outside } },
    "compatible",
    fixture
  );
  assert.equal(
    JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision,
    "deny",
    "a hook cwd that differs from the recorded workspace must not unlock inspection there"
  );

  // A new prompt re-pins the workspace from the host-supplied cwd.
  handleHook({ ...base, turn_id: "turn-2", hook_event_name: "UserPromptSubmit", cwd: elsewhere, prompt: "next" }, "compatible", fixture);
  assert.equal(
    handleHook({ ...base, turn_id: "turn-2", hook_event_name: "PreToolUse", tool_name: "Bash", cwd: elsewhere, tool_input: { command: outside } }, "compatible", fixture).stdout,
    ""
  );
});

function createFixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-cwd-"));
  return { env: { COMPREHENSION_GATE_STATE_DIR: directory, ...extraEnv } };
}
