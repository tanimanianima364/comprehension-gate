import assert from "node:assert/strict";
import test from "node:test";
import {
  controlTarget,
  handleHook
} from "../core/gate.mjs";
import { createFixture, controlInput, assertDenied } from "./helpers.mjs";

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
