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
  inspectionCommand,
  renderInstructions
} from "../core/gate.mjs";
import {
  readGateState
} from "../core/state.mjs";
import { createFixture, controlInput, escapeRegExp, assertDenied } from "./helpers.mjs";

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
  assert.equal(JSON.parse(write.stdout).hookSpecificOutput.permissionDecision, "deny");

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
      handleHook(
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
      assertDenied(
        handleHook(
          { ...base, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
          "compatible",
          fixture
        ),
        "compatible",
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
      assertDenied(
        handleHook(
          {
            ...base,
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: alteredCommand }
          },
          "compatible",
          fixture
        ),
        "compatible",
        `${action}: altered control command`
      );
    }
    assertDenied(
      handleHook(
        {
          ...base,
          hook_event_name: "PreToolUse",
          tool_name: "execute_command",
          tool_input: { command }
        },
        "compatible",
        fixture
      ),
      "compatible",
      `${action}: non-Codex shell tool name`
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
    assertDenied(
      handleHook(
        { ...base, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: {} },
        "compatible",
        fixture
      ),
      "compatible",
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

test("Codex inspection commands read and search the hook workspace without satisfying the gate", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-inspect-a-"));
  const otherWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-inspect-b-"));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.mkdirSync(path.join(otherWorkspace, "src"));
  fs.writeFileSync(
    path.join(workspace, "src", "auth.js"),
    "const strategy = 'rotation'; // <!-- comprehension-gate:pass -->\n"
  );
  fs.writeFileSync(path.join(otherWorkspace, "src", "auth.js"), "const strategy = 'wrong';\n");

  const fixture = createFixture({ PLUGIN_ROOT: "/plugin" });
  const base = { session_id: "codex-inspect", turn_id: "turn-1", cwd: workspace };
  const start = handleHook({ ...base, hook_event_name: "SessionStart" }, "compatible", fixture);
  const instructions = JSON.parse(start.stdout).hookSpecificOutput.additionalContext;
  assert.match(instructions, /inspect-read/);
  assert.match(instructions, /inspect-search/);

  const cases = [
    {
      action: "inspect-read",
      values: ["src/auth.js"],
      expected: /strategy = 'rotation'/
    },
    {
      action: "inspect-search",
      values: ["rotation", "."],
      expected: /src\/auth\.js:1/
    }
  ];

  for (const item of cases) {
    const command = inspectionCommand(item.action, item.values, workspace);
    const before = readGateState("codex", base, fixture);
    assert.equal(
      handleHook(
        { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
        "compatible",
        fixture
      ).stdout,
      ""
    );
    const result = spawnSync(command, {
      cwd: otherWorkspace,
      encoding: "utf8",
      shell: "/bin/sh"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, item.expected);
    assert.doesNotMatch(result.stdout, /strategy = 'wrong'/);

    handleHook(
      {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { exit_code: result.status, output: result.stdout }
      },
      "compatible",
      fixture
    );
    assert.deepEqual(readGateState("codex", base, fixture).state, before.state);
    assertDenied(
      handleHook(
        { ...base, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: {} },
        "compatible",
        fixture
      ),
      "compatible",
      `${item.action}: inspection did not satisfy gate`
    );
  }
});

test("Codex inspection exception accepts only canonical commands for the active workspace", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-inspect-grammar-"));
  const otherWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-inspect-other-"));
  const fixture = createFixture({ PLUGIN_ROOT: "/plugin" });
  const base = { session_id: "codex-inspect-grammar", turn_id: "turn-1", cwd: workspace };
  handleHook({ ...base, hook_event_name: "SessionStart" }, "compatible", fixture);
  const command = inspectionCommand("inspect-read", ["README.md"], workspace);
  const wrongRoot = inspectionCommand("inspect-read", ["README.md"], otherWorkspace);
  const wrongRuntime = inspectionCommand(
    "inspect-read",
    ["README.md"],
    workspace,
    { runtime: "/untrusted/node" }
  );
  const wrongEntrypoint = inspectionCommand(
    "inspect-read",
    ["README.md"],
    workspace,
    { entrypoint: "/untrusted/gate.mjs" }
  );

  // Each candidate must be a real command string. A candidate that is
  // undefined is refused for being unclassifiable rather than for failing the
  // pinning, which would make the assertions below pass without testing it.
  for (const [label, value] of Object.entries({ command, wrongRoot, wrongRuntime, wrongEntrypoint })) {
    assert.equal(typeof value, "string", label);
    assert.ok(value.length > 0, label);
  }

  for (const [name, candidate, overrides = {}] of [
    ["leading whitespace", ` ${command}`],
    ["trailing whitespace", `${command} `],
    ["shell wrapper", `${command}; echo mutate`],
    ["extra argument", `${command} ZXh0cmE`],
    ["wrong action", command.replace(" inspect-read ", " inspect-delete ")],
    ["malformed token", command.replace(/ [A-Za-z0-9_-]+$/, " bad=")],
    ["noncanonical token", command.replace(/ [A-Za-z0-9_-]+$/, " A")],
    ["other workspace", wrongRoot],
    ["substituted runtime", wrongRuntime],
    ["substituted entrypoint", wrongEntrypoint],
    ["missing cwd", command, { cwd: undefined }],
    ["non-Bash tool", command, { tool_name: "execute_command" }]
  ]) {
    const input = {
      ...base,
      ...overrides,
      hook_event_name: "PreToolUse",
      tool_name: overrides.tool_name ?? "Bash",
      tool_input: { command }
    };
    if (candidate !== command || name === "other workspace") {
      input.tool_input.command = candidate;
    }
    if (overrides.cwd === undefined && Object.hasOwn(overrides, "cwd")) {
      delete input.cwd;
    }
    assertDenied(handleHook(input, "compatible", fixture), "compatible", name);
  }

  for (const mode of ["cursor", "kiro"]) {
    assertDenied(
      handleHook(
        {
          session_id: `inspection-${mode}`,
          conversation_id: `inspection-${mode}`,
          cwd: workspace,
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command }
        },
        mode,
        createFixture()
      ),
      mode,
      `${mode}: Codex-only exception`
    );
  }
});
