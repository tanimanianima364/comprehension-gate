import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleHook, inspectionCommands } from "../core/gate.mjs";

const posixOnly = t => {
  if (process.platform === "win32") {
    t.skip("POSIX workspace fixture");
    return true;
  }
  return false;
};
const fixture = () => ({ env: { COMPREHENSION_GATE_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "cg-cwd-")), PLUGIN_ROOT: "/plugin" } });
const workspaceDir = label => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cg-ws-${label}-`)));
const inspect = (base, cwd, target, fx, options = {}) => {
  const [{ command }] = inspectionCommands("inspect-read", ["README.md"], target, options);
  return handleHook({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command } }, "compatible", { ...fx, ...options });
};
const isDenied = result => result.stdout !== "" && JSON.parse(result.stdout).hookSpecificOutput.permissionDecision === "deny";

test("Codex inspection is bound to the cwd recorded at the last reset, not the cwd of the current hook call", t => {
  if (posixOnly(t)) return;
  const fx = fixture();
  const workspace = workspaceDir("a");
  const elsewhere = workspaceDir("b");
  const base = { session_id: "codex-cwd-pin", turn_id: "turn-1" };
  handleHook({ ...base, hook_event_name: "SessionStart", cwd: workspace }, "compatible", fx);

  assert.equal(inspect(base, workspace, workspace, fx).stdout, "", "inspection in the recorded workspace is allowed");
  assert.ok(isDenied(inspect(base, elsewhere, elsewhere, fx)), "a hook cwd that differs from the recorded workspace must not unlock inspection there");

  const turn2 = { ...base, turn_id: "turn-2" };
  handleHook({ ...turn2, hook_event_name: "UserPromptSubmit", cwd: elsewhere, prompt: "next" }, "compatible", fx);
  assert.equal(inspect(turn2, elsewhere, elsewhere, fx).stdout, "", "a prompt reset re-pins the workspace");
});

test("a new turn detected at PreToolUse keeps the recorded workspace instead of trusting the hook cwd", t => {
  if (posixOnly(t)) return;
  const fx = fixture();
  const workspace = workspaceDir("a");
  const elsewhere = workspaceDir("b");
  const turnA = { session_id: "codex-cwd-skip", turn_id: "turn-a" };
  handleHook({ ...turnA, hook_event_name: "SessionStart", cwd: workspace }, "compatible", fx);

  // Turn B's UserPromptSubmit hook was skipped; its first PreToolUse arrives with another cwd.
  const turnB = { ...turnA, turn_id: "turn-b" };
  assert.ok(isDenied(inspect(turnB, elsewhere, elsewhere, fx)), "the first PreToolUse of a new turn must not re-pin the workspace");
  assert.equal(inspect(turnB, workspace, workspace, fx).stdout, "", "the previously recorded workspace still works for the new turn");

  handleHook({ ...turnB, hook_event_name: "UserPromptSubmit", cwd: elsewhere, prompt: "next" }, "compatible", fx);
  assert.equal(inspect(turnB, elsewhere, elsewhere, fx).stdout, "", "a genuine prompt reset re-pins");
});

test("Codex inspection is denied until a lifecycle event has recorded a workspace", t => {
  if (posixOnly(t)) return;
  const fx = fixture();
  const workspace = workspaceDir("a");
  const base = { session_id: "codex-cwd-missing", turn_id: "turn-1" };
  assert.ok(isDenied(inspect(base, workspace, workspace, fx)), "no recorded workspace: deny even though the command matches the hook cwd");
  handleHook({ ...base, hook_event_name: "UserPromptSubmit", cwd: workspace, prompt: "go" }, "compatible", fx);
  assert.equal(inspect(base, workspace, workspace, fx).stdout, "");
});

test("the recorded workspace is compared canonically and permits descendants only", t => {
  if (posixOnly(t)) return;
  const fx = fixture();
  const workspace = workspaceDir("a");
  const child = path.join(workspace, "src");
  fs.mkdirSync(child);
  const sibling = `${workspace}-other`;
  fs.mkdirSync(sibling);
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cg-link-")), "ws");
  fs.symlinkSync(workspace, link, "dir");
  const base = { session_id: "codex-cwd-canonical", turn_id: "turn-1" };

  handleHook({ ...base, hook_event_name: "SessionStart", cwd: `${link}/` }, "compatible", fx);
  assert.equal(inspect(base, workspace, workspace, fx).stdout, "", "symlink + trailing slash at reset resolves to the same workspace");
  assert.equal(inspect(base, child, child, fx).stdout, "", "a descendant narrows the readable tree and is allowed");
  assert.ok(isDenied(inspect(base, sibling, sibling, fx)), "a sibling with a common prefix is denied");
  assert.ok(isDenied(inspect(base, path.dirname(workspace), path.dirname(workspace), fx)), "the parent is denied");
});

test("synthetic Windows workspaces compare case-insensitively with normalized separators", () => {
  const fx = fixture();
  const options = { platform: "win32", runtime: "C:\\Program Files\\nodejs\\node.exe" };
  const base = { session_id: "codex-cwd-win", turn_id: "turn-1" };
  handleHook({ ...base, hook_event_name: "SessionStart", cwd: "C:\\Repo\\" }, "compatible", { ...fx, ...options });
  assert.equal(inspect(base, "c:\\repo\\src", "c:\\repo\\src", fx, options).stdout, "", "casing and trailing separator differences are canonical-equal");
  assert.ok(isDenied(inspect(base, "c:\\repo-other", "c:\\repo-other", fx, options)), "sibling drive path is denied");
});
