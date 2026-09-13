import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("plugin manifests and the hook configuration are valid JSON", () => {
  for (const relativePath of [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "hooks/hooks.json"
  ]) {
    assert.doesNotThrow(() => readJson(relativePath), relativePath);
  }
});

test("the hook config covers session start, prompt, and both tool events", () => {
  const config = readJson("hooks/hooks.json");
  assert.deepEqual(Object.keys(config.hooks), [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse"
  ]);
  for (const [event, entries] of Object.entries(config.hooks)) {
    // Every event shells out to git, so none may be killed before git's own timeout.
    assert.equal(entries[0].hooks[0].timeout, 20, event);
    assert.doesNotMatch(entries[0].hooks[0].command, /gate\.mjs" \w/, `${event}: no mode argument`);
  }
  // An omitted matcher is what routes built-in, MCP, and unknown tools alike.
  assert.equal("matcher" in config.hooks.PreToolUse[0], false);
  assert.equal("matcher" in config.hooks.PostToolUse[0], false);
});

// The skill used to carry its own `git merge-base HEAD origin/HEAD` one-liner,
// which saw nothing at all in a repository with no remote.
test("the manual skill defers to the session instructions for the change set", () => {
  const skill = fs.readFileSync(
    path.join(root, "skills", "comprehension-gate", "SKILL.md"),
    "utf8"
  );
  assert.doesNotMatch(skill, /origin\/HEAD/);
  assert.doesNotMatch(skill, /merge-base/);
  assert.match(skill, /change set command the active Comprehension Gate session instructions supply/);
});

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}
