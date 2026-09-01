import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  controlTarget,
  handleHook
} from "../core/gate.mjs";
import { adapterCommand } from "../core/command.mjs";
import { readGateState } from "../core/state.mjs";
import { createFixture, controlInput, assertDenied } from "./helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Kiro keeps agentSpawn payload compatibility", () => {
  const fixture = createFixture();
  const start = handleHook(
    { session_id: "kiro-agent-spawn", hook_event_name: "agentSpawn" },
    "kiro",
    fixture
  );
  assert.match(start.stdout, /Comprehension Gate/);
  const write = handleHook(
    {
      session_id: "kiro-agent-spawn",
      hook_event_name: "preToolUse",
      tool_name: "fs_write",
      tool_input: {}
    },
    "kiro",
    fixture
  );
  assertDenied(write, "kiro", "legacy agentSpawn");
});

test("Kiro requires success true and the expected marker", () => {
  const fixture = createFixture();
  const base = { session_id: "kiro-control" };
  handleHook({ ...base, hook_event_name: "agentSpawn" }, "kiro", fixture);

  handleHook(
    {
      ...base,
      hook_event_name: "preToolUse",
      tool_name: "read",
      tool_input: controlInput("pass", "kiroOperations")
    },
    "kiro",
    fixture
  );
  handleHook(
    {
      ...base,
      hook_event_name: "postToolUse",
      tool_name: "read",
      tool_input: controlInput("pass", "kiroOperations"),
      tool_response: {
        success: false,
        result: ["<!-- comprehension-gate:pass -->"]
      }
    },
    "kiro",
    fixture
  );
  assert.equal(
    handleHook(
      { ...base, hook_event_name: "preToolUse", tool_name: "fs_write", tool_input: {} },
      "kiro",
      fixture
    ).exitCode,
    2
  );

  handleHook(
    {
      ...base,
      hook_event_name: "preToolUse",
      tool_name: "read",
      tool_input: controlInput("pass", "kiroOperations")
    },
    "kiro",
    fixture
  );
  handleHook(
    {
      ...base,
      hook_event_name: "postToolUse",
      tool_name: "read",
      tool_input: controlInput("pass", "kiroOperations"),
      tool_response: {
        success: true,
        result: ["<!-- comprehension-gate:pass -->"]
      }
    },
    "kiro",
    fixture
  );
  assert.equal(
    handleHook(
      { ...base, hook_event_name: "preToolUse", tool_name: "fs_write", tool_input: {} },
      "kiro",
      fixture
    ).exitCode,
    0
  );
});

test("Kiro control reads require exactly one operations path on Pre and Post", () => {
  const invalidInputs = [
    ["direct path", controlInput("pass", "path")],
    ["missing operations", {}],
    ["empty operations", { operations: [] }],
    ["non-array operations", { operations: "invalid" }],
    ["null operation", { operations: [null] }],
    ["missing path", { operations: [{ mode: "Line" }] }],
    ["non-string path", { operations: [{ mode: "Line", path: 42 }] }],
    ["two operations", {
      operations: [
        { mode: "Line", path: controlTarget("pass") },
        { mode: "Line", path: controlTarget("pass") }
      ]
    }],
    ["wrong operations path", {
      operations: [{ mode: "Line", path: `${controlTarget("pass")}.other` }]
    }],
    ["direct target cannot override empty operations", {
      path: controlTarget("pass"),
      operations: []
    }]
  ];

  for (const [index, [name, toolInput]] of invalidInputs.entries()) {
    const fixture = createFixture();
    const base = { session_id: `kiro-invalid-operations-${index}` };
    handleHook({ ...base, hook_event_name: "SessionStart" }, "kiro", fixture);
    const event = {
      ...base,
      tool_name: "read",
      tool_use_id: `bad-${index}`,
      tool_input: toolInput
    };
    const read = handleHook(
      {
        ...event,
        hook_event_name: "preToolUse",
      },
      "kiro",
      fixture
    );
    assert.equal(read.stdout, "", name);
    handleHook(
      {
        ...event,
        hook_event_name: "postToolUse",
        tool_response: {
          success: true,
          result: ["<!-- comprehension-gate:pass -->"]
        }
      },
      "kiro",
      fixture
    );
    assertDenied(
      handleHook(
        { ...base, hook_event_name: "preToolUse", tool_name: "write", tool_input: {} },
        "kiro",
        fixture
      ),
      "kiro",
      name
    );
  }

  const fixture = createFixture();
  const base = { session_id: "kiro-valid-operations" };
  handleHook({ ...base, hook_event_name: "SessionStart" }, "kiro", fixture);
  const arm = handleHook(
    {
      ...base,
      hook_event_name: "preToolUse",
      tool_name: "read",
      tool_use_id: "kiro-pass",
      tool_input: controlInput("pass", "kiroOperations")
    },
    "kiro",
    fixture
  );
  assert.equal(arm.stdout, "");
  handleHook(
    {
      ...base,
      hook_event_name: "postToolUse",
      tool_name: "read",
      tool_use_id: "kiro-pass",
      tool_input: controlInput("pass", "kiroOperations"),
      tool_response: {
        success: true,
        result: ["<!-- comprehension-gate:pass -->"]
      }
    },
    "kiro",
    fixture
  );

  const allowed = handleHook(
    { ...base, hook_event_name: "preToolUse", tool_name: "fs_write", tool_input: {} },
    "kiro",
    fixture
  );
  assert.equal(allowed.exitCode, 0);
});

/*
 * Kiro CLI 2.x embeds its hooks in the agent config instead of a standalone
 * file, but everything the gate depends on is the same. Verified against
 * 2.16.2 by capturing real hook payloads:
 *
 *   preToolUse   {"hook_event_name":"preToolUse","cwd":"...",
 *                 "tool_name":"fs_read",
 *                 "tool_input":{"operations":[{"mode":"Line","path":"..."}]}}
 *   postToolUse  ... "tool_response":{"success":true,"result":[...]}
 *
 * Two things differ from the documentation. The matcher is not a regex there:
 * only "*" or an omitted matcher fires for every tool, while ".*" -- the value
 * the docs' own example uses -- fires for none, which would leave the gate
 * silently absent. And no payload carries a session id; the hook process gets
 * KIRO_SESSION_ID in its environment instead.
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

test("a Kiro 2.x session is identified by KIRO_SESSION_ID when the payload omits one", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-kiro2-"));
  const env = { COMPREHENSION_GATE_STATE_DIR: directory, KIRO_SESSION_ID: "kiro-2x-session" };
  const cwd = process.cwd();

  assert.equal(
    handleHook({ hook_event_name: "agentSpawn", cwd }, "kiro", { env }).exitCode,
    0,
    "a payload without session_id still starts a session"
  );

  const write = handleHook(
    { hook_event_name: "preToolUse", cwd, tool_name: "fs_write", tool_input: {} },
    "kiro",
    { env }
  );
  assert.equal(write.exitCode, 2, "the gate is pending for that session");

  const state = readGateState("kiro", { session_id: "kiro-2x-session" }, { env });
  assert.equal(state.ok, true, "state is keyed by the environment session id");
  assert.equal(state.state.status, "pending");
});
