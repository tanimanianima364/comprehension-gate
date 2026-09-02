import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the hook entrypoint runs when the plugin root is reached through a symlink", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-symlink-"));
  const linkedRoot = path.join(directory, "plugin");
  fs.symlinkSync(pluginRoot, linkedRoot, "dir");

  const result = spawnSync(
    process.execPath,
    [path.join(linkedRoot, "core", "gate.mjs"), "compatible"],
    {
      encoding: "utf8",
      input: JSON.stringify({
        session_id: "symlink-session",
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "src/app.js" }
      }),
      env: { ...process.env, COMPREHENSION_GATE_STATE_DIR: path.join(directory, "state") }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "symlinked entrypoint must still evaluate the gate");

  const stopResult = spawnSync(
    process.execPath,
    [path.join(linkedRoot, "core", "gate.mjs"), "compatible"],
    {
      encoding: "utf8",
      input: JSON.stringify({
        session_id: "symlink-session",
        cwd: directory,
        hook_event_name: "Stop"
      }),
      env: { ...process.env, COMPREHENSION_GATE_STATE_DIR: path.join(directory, "state") }
    }
  );

  assert.equal(stopResult.status, 0, stopResult.stderr);
  assert.equal(stopResult.stdout, "", "a non-repository directory holds no turn");
});
