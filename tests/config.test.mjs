import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("plugin manifests and hook configurations are valid JSON", () => {
  const files = [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "hooks/hooks.json",
    "adapters/cursor/hooks.json",
    "adapters/kiro/hooks.json"
  ];
  for (const relativePath of files) {
    assert.doesNotThrow(
      () => JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")),
      relativePath
    );
  }
});

test("shared hook config covers reset and mutation events", () => {
  const config = readJson("hooks/hooks.json");
  assert.ok(config.hooks.SessionStart);
  assert.ok(config.hooks.UserPromptSubmit);
  assert.ok(config.hooks.PostToolUse);
  assert.match(config.hooks.PreToolUse[0].matcher, /Write/);
  assert.match(config.hooks.PreToolUse[0].matcher, /Bash/);
});

test("native adapter templates use only the documented placeholder", () => {
  for (const provider of ["cursor", "kiro"]) {
    const raw = fs.readFileSync(path.join(root, "adapters", provider, "hooks.json"), "utf8");
    assert.match(raw, /__COMPREHENSION_GATE_ROOT__/);
    assert.doesNotMatch(raw, /\/home\/|[A-Z]:\\\\/);
  }
});

test("adapter renderer emits portable, placeholder-free JSON", () => {
  for (const provider of ["cursor", "kiro"]) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "render-adapter.mjs"), provider, "--root", root],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /__COMPREHENSION_GATE_ROOT__/);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.match(result.stdout, /core[\\/]gate\.mjs/);
  }
});

test("Kiro adapter matches and blocks every documented 3.x mutation tool", () => {
  const config = readJson("adapters/kiro/hooks.json");
  const preHook = config.hooks.find(hook => hook.trigger === "PreToolUse");
  const postHook = config.hooks.find(hook => hook.trigger === "PostToolUse");
  const preMatcher = new RegExp(preHook.matcher, "i");
  const postMatcher = new RegExp(postHook.matcher, "i");
  const mutationTools = [
    "fs_write",
    "str_replace",
    "delete_file",
    "execute_bash",
    "control_bash_process"
  ];

  for (const toolName of mutationTools) {
    assert.equal(preMatcher.test(toolName), true, toolName);
  }
  assert.equal(postMatcher.test("execute_bash"), true);

  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-kiro-"));
  const env = {
    ...process.env,
    COMPREHENSION_GATE_STATE_DIR: stateDirectory
  };
  const session = "kiro-entrypoint";
  const start = runKiroHook({ session_id: session, hook_event_name: "agentSpawn" }, env);
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /Comprehension Gate/);

  for (const toolName of mutationTools) {
    const result = runKiroHook(
      {
        session_id: session,
        hook_event_name: "preToolUse",
        tool_name: toolName,
        tool_input: toolName === "execute_bash" ? { command: "touch blocked" } : {}
      },
      env
    );
    assert.equal(result.status, 2, `${toolName}: ${result.stderr}`);
  }
});

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function runKiroHook(input, env) {
  return spawnSync(
    process.execPath,
    [path.join(root, "core", "gate.mjs"), "kiro"],
    { encoding: "utf8", input: JSON.stringify(input), env }
  );
}
