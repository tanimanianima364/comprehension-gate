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

/*
 * The plugin once asked questions and blocked writes until they were answered.
 * That is gone, but its wording outlived it in the metadata a host shows a
 * user: three manifests said so for a month after the behaviour was removed,
 * and the Codex skill metadata did for longer. What a host displays is read
 * here as text, so a stale phrase fails the suite instead of shipping.
 */
const USER_FACING = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".codex-plugin/plugin.json",
  "package.json",
  "skills/comprehension-gate/agents/openai.yaml",
  "skills/comprehension-gate/SKILL.md"
];

test("user-facing metadata does not describe the removed question-and-block workflow", () => {
  for (const relativePath of USER_FACING) {
    const text = fs.readFileSync(path.join(root, relativePath), "utf8");
    assert.doesNotMatch(
      text,
      /comprehension check|demonstrated? understanding|understanding before|blocks? meaningful|require[sd]? .*understanding/i,
      relativePath
    );
    // A purely mechanical change needs no note, so no blurb may promise one
    // for every change. `\b` keeps "each changed path" out of it.
    assert.doesNotMatch(text, /\b(each|every) change\b/i, relativePath);
  }
});

/*
 * OpenAI's skill metadata has two constraints a host enforces on display:
 * `default_prompt` must name the skill as `$comprehension-gate`, or the host
 * cannot route the prompt to it, and `short_description` is a 25-64 character
 * blurb. The file is read as text because the plugin has no YAML dependency.
 */
test("the Codex skill metadata names the skill and keeps its blurb short", () => {
  const text = fs.readFileSync(path.join(root, "skills", "comprehension-gate", "agents", "openai.yaml"), "utf8");
  const prompt = text.match(/^\s*default_prompt: "(.*)"$/m)?.[1];
  const blurb = text.match(/^\s*short_description: "(.*)"$/m)?.[1];
  assert.ok(prompt && blurb, "both fields are present, double-quoted");
  assert.match(prompt, /\$comprehension-gate\b/);
  assert.ok(blurb.length >= 25 && blurb.length <= 64, `${blurb.length} characters: ${blurb}`);
});

// Four manifests carry one description, or a host shows whichever it reads.
test("every manifest gives the same description", () => {
  const descriptions = new Set([
    readJson(".claude-plugin/plugin.json").description,
    readJson(".claude-plugin/marketplace.json").plugins[0].description,
    readJson(".codex-plugin/plugin.json").description,
    readJson("package.json").description
  ]);
  assert.equal(descriptions.size, 1, [...descriptions].join("\n"));
});

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}
