import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { handleHook } from "../core/gate.mjs";
import { adapterCommand } from "../core/command.mjs";
import { createRepository } from "./helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Kiro keeps agentSpawn payload compatibility", () => {
  const repository = createRepository();
  const start = handleHook({ hook_event_name: "agentSpawn", cwd: repository }, "kiro");
  assert.match(start.stdout, /Comprehension Gate/);

  const write = handleHook(
    { hook_event_name: "preToolUse", cwd: repository, tool_name: "fs_write", tool_input: {} },
    "kiro"
  );
  assert.equal(write.exitCode, 0);
  assert.equal(write.stdout, "");
});

/*
 * Kiro 2.x documentation is wrong about the matcher: it is not a regex, and
 * only "*" or an omitted matcher fires for every tool, while ".*" -- the value
 * the docs' own example uses -- fires for none, which would leave the gate
 * silently absent.
 */
test("the Kiro 2.x adapter matches every tool and runs the same mode", () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(root, "adapters", "kiro-2x", "hooks.json"), "utf8")
  );
  for (const trigger of ["agentSpawn", "userPromptSubmit", "preToolUse", "postToolUse"]) {
    assert.equal(config.hooks[trigger].length, 1, trigger);
    assert.equal(config.hooks[trigger][0].matcher, "*", `${trigger}: only "*" fires for every tool`);
  }
  assert.match(adapterCommand("kiro-2x", "/plugin"), / kiro$/);
});

// Kiro's only channel was a non-zero exit the host showed as a warning. It no
// longer warns, so a stop over a changed branch has to leave stderr empty.
test("a Kiro stop over a changed branch exits zero and says nothing", () => {
  const repository = createRepository();
  fs.writeFileSync(path.join(repository, "src.js"), "export {};\n");
  const stopped = handleHook({ hook_event_name: "stop", cwd: repository }, "kiro");
  assert.equal(stopped.exitCode, 0);
  assert.equal(stopped.stderr, "");
  assert.equal(stopped.stdout, "");
});
