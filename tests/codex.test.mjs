import assert from "node:assert/strict";
import {
  spawnSync
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  controlCommand,
  controlTarget,
  handleHook,
  renderInstructions
} from "../core/gate.mjs";
import {
  readGateState
} from "../core/state.mjs";
import { createFixture, controlInput, escapeRegExp } from "./helpers.mjs";

test("a failed Codex control result cannot pass the gate", () => {
  const fixture = createFixture({ PLUGIN_ROOT: "/plugin" });
  const base = {
    session_id: "session-failed-control",
    turn_id: "turn-failed-control",
    hook_event_name: "SessionStart",
    source: "startup"
  };
  handleHook(base, "compatible", fixture);

  handleHook(
    {
      session_id: base.session_id,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "failed-tool",
      tool_input: { command: controlCommand("pass") }
    },
    "compatible",
    fixture
  );

  handleHook(
    {
      session_id: base.session_id,
      turn_id: base.turn_id,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "failed-tool",
      tool_input: { command: controlCommand("pass") },
      tool_response: { exit_code: 1, output: "Process exited with code 1" }
    },
    "compatible",
    fixture
  );

  const write = handleHook(
    { session_id: base.session_id, turn_id: base.turn_id, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(write.stdout, "");
  assert.equal(
    readGateState("codex", { session_id: base.session_id, turn_id: base.turn_id }, { env: fixture.env }).state.status,
    "pending",
    "a failed Codex control result cannot pass the gate"
  );

  handleHook(
    {
      session_id: base.session_id,
      turn_id: base.turn_id,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "successful-tool",
      tool_input: { command: controlCommand("pass") }
    },
    "compatible",
    fixture
  );
  handleHook(
    {
      session_id: base.session_id,
      turn_id: base.turn_id,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "successful-tool",
      tool_input: { command: controlCommand("pass") },
      tool_response: {
        exit_code: 0,
        output: "<!-- comprehension-gate:pass -->\n"
      }
    },
    "compatible",
    fixture
  );
  const allowed = handleHook(
    { session_id: base.session_id, turn_id: base.turn_id, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(allowed.stdout, "");
});

test("Codex completes pass and LOW bypass through only the exact pinned Bash control", () => {
  for (const action of ["pass", "bypass-low"]) {
    const fixture = createFixture({ PLUGIN_ROOT: "/plugin" });
    const base = {
      session_id: `codex-pinned-${action}`,
      turn_id: "turn-1"
    };
    const start = handleHook(
      { ...base, hook_event_name: "SessionStart" },
      "compatible",
      fixture
    );
    const instructions = JSON.parse(start.stdout).hookSpecificOutput.additionalContext;
    assert.match(instructions, new RegExp(escapeRegExp(controlCommand("pass"))));
    assert.match(instructions, new RegExp(escapeRegExp(controlCommand("bypass-low"))));
    assert.doesNotMatch(instructions, new RegExp(escapeRegExp(controlTarget("pass"))));
    assert.equal(renderInstructions("codex"), instructions);

    if (action === "pass") {
      const synthetic = handleHook(
        {
          ...base,
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_use_id: "synthetic-read",
          tool_input: controlInput("pass")
        },
        "compatible",
        fixture
      );
      assert.equal(synthetic.stdout, "");
      assert.equal(
        readGateState("codex", base, { env: fixture.env }).state.status,
        "pending",
        "Codex synthetic Read did not arm"
      );
    }

    const command = controlCommand(action);
    assert.equal(command.startsWith("node "), false);
    assert.match(command, new RegExp(escapeRegExp(process.execPath)));
    for (const alteredCommand of [
      ` ${command}`,
      `${command} `,
      `${command} --extra`,
      `${command}; echo mutate`
    ]) {
      const altered = handleHook(
        {
          ...base,
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: alteredCommand }
        },
        "compatible",
        fixture
      );
      assert.equal(altered.stdout, "", `${action}: altered control command`);
    }
    const nonCodexTool = handleHook(
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "execute_command",
        tool_input: { command }
      },
      "compatible",
      fixture
    );
    assert.equal(nonCodexTool.stdout, "", `${action}: non-Codex shell tool name`);
    assert.equal(
      readGateState("codex", base, { env: fixture.env }).state.status,
      "pending",
      `${action}: neither an altered command nor a non-Codex tool name armed the control`
    );

    const toolUseId = `codex-${action}`;
    const arm = handleHook(
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: toolUseId,
        tool_input: { command }
      },
      "compatible",
      fixture
    );
    assert.equal(arm.stdout, "");
    const armAlone = handleHook(
      { ...base, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: {} },
      "compatible",
      fixture
    );
    assert.equal(armAlone.stdout, "");
    assert.equal(
      readGateState("codex", base, { env: fixture.env }).state.status,
      "pending",
      `${action}: arm alone did not satisfy the gate`
    );

    const result = spawnSync(command, {
      encoding: "utf8",
      shell: "/bin/sh",
      env: fixture.env
    });
    assert.equal(result.status, 0, result.stderr);

    handleHook(
      {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: toolUseId,
        tool_input: { command },
        tool_response: { exit_code: result.status, output: result.stdout }
      },
      "compatible",
      fixture
    );
    assert.equal(
      handleHook(
        { ...base, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: {} },
        "compatible",
        fixture
      ).stdout,
      "",
      action
    );
  }
});

test("Codex pinned control command ignores PATH-shadowed node", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-node-shadow-"));
  const binaryDirectory = path.join(directory, "bin");
  const sentinel = path.join(directory, "shadow-node-ran");
  fs.mkdirSync(binaryDirectory);
  fs.writeFileSync(
    path.join(binaryDirectory, "node"),
    `#!/bin/sh\ntouch ${JSON.stringify(sentinel)}\n`
  );
  fs.chmodSync(path.join(binaryDirectory, "node"), 0o700);
  const env = { ...process.env, PATH: `${binaryDirectory}${path.delimiter}${process.env.PATH ?? ""}` };
  const result = spawnSync(controlCommand("pass"), {
    cwd: directory,
    env,
    encoding: "utf8",
    shell: "/bin/sh"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "<!-- comprehension-gate:pass -->\n");
  assert.equal(fs.existsSync(sentinel), false, "pinned control used PATH-shadowed node");
});
