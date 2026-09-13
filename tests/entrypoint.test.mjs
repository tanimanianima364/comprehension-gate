import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createRepository } from "./helpers.mjs";

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
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "src/app.js" }
      })
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "symlinked entrypoint must still evaluate the gate");

  const stopResult = spawnSync(
    process.execPath,
    [path.join(linkedRoot, "core", "gate.mjs"), "compatible"],
    {
      encoding: "utf8",
      input: JSON.stringify({ cwd: directory, hook_event_name: "Stop" })
    }
  );

  assert.equal(stopResult.status, 0, stopResult.stderr);
  assert.equal(stopResult.stdout, "", "a stop never holds a turn");
});

// The whole Kiro contract is the process exit code, which only a real spawn
// shows. It used to be 1 over a changed repository; nothing warns now, so a
// non-zero exit here would surface to the user as a hook failure.
test("a Kiro stop over a changed repository exits zero with nothing on stderr", () => {
  const repository = createRepository();
  const run = payload =>
    spawnSync(process.execPath, [path.join(pluginRoot, "core", "gate.mjs"), "kiro"], {
      encoding: "utf8",
      input: JSON.stringify(payload)
    });

  const spawned = run({ hook_event_name: "agentSpawn", cwd: repository });
  assert.equal(spawned.status, 0, spawned.stderr);
  assert.match(spawned.stdout, /Comprehension Gate/);

  fs.writeFileSync(path.join(repository, "src.js"), "export {};\n");
  const stopped = run({ hook_event_name: "stop", cwd: repository });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.stderr, "");
});
