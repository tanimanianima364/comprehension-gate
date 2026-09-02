import assert from "node:assert/strict";
import test from "node:test";
import { handleHook } from "../core/gate.mjs";
import { readGateState } from "../core/state.mjs";
import { createFixture, controlInput } from "./helpers.mjs";

const base = { session_id: "tool-policy", prompt_id: "p1" };

function pre(toolName, toolInput, fixture, mode = "compatible") {
  return handleHook({ ...base, hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput }, mode, fixture);
}

test("no tool is refused while the gate is pending", () => {
  const fixture = createFixture();
  handleHook({ ...base, hook_event_name: "SessionStart" }, "compatible", fixture);
  for (const [tool, input] of [
    ["Write", { file_path: "src/app.js", content: "" }],
    ["Edit", { file_path: "src/app.js" }],
    ["NotebookEdit", {}],
    ["apply_patch", { command: "*** Begin Patch" }],
    ["Bash", { command: "rm -rf src && git commit -m wip" }],
    ["mcp__filesystem__write_file", { path: "src/app.js" }],
    ["EnterWorktree", {}],
    ["SomethingNobodyListed", {}]
  ]) {
    const result = pre(tool, input, fixture);
    assert.equal(result.exitCode, 0, tool);
    assert.equal(result.stdout, "", tool);
  }
});

test("only a native read of a control target arms a control", () => {
  const fixture = createFixture();
  handleHook({ ...base, hook_event_name: "SessionStart" }, "compatible", fixture);
  pre("Read", controlInput("pass"), fixture);
  const armed = readGateState("claude", base, fixture);
  assert.ok(armed.ok);
  // A non-read tool naming the target arms nothing: the completion below fails.
  pre("WebFetch", { url: "https://example.com", path: controlInput("pass").file_path }, fixture);
  const completion = handleHook(
    {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com", path: controlInput("pass").file_path },
      tool_response: { stdout: "<!-- comprehension-gate:pass -->" }
    },
    "compatible",
    fixture
  );
  assert.equal(completion.exitCode, 0);
  assert.equal(readGateState("claude", base, fixture).state.status, "pending");
});
