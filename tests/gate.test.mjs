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
  controlTransitionSucceeded,
  handleHook,
  malformedInputResult
} from "../core/gate.mjs";
import {
  readGateState,
  stateFilePath
} from "../core/state.mjs";
import { createFixture, controlInput } from "./helpers.mjs";

test("compatible flow allows every tool and records the pass", () => {
  const fixture = createFixture();
  const base = { session_id: "session-1", turn_id: "turn-1" };

  const start = handleHook(
    { ...base, hook_event_name: "SessionStart", source: "startup" },
    "compatible",
    fixture
  );
  assert.equal(start.exitCode, 0);
  assert.equal(JSON.parse(start.stdout).hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(start.stdout, /Comprehension Gate/);

  const applyPatch = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch" } },
    "compatible",
    fixture
  );
  assert.equal(applyPatch.stdout, "");

  const shellCall = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sed -i s/a/b/ README.md" } },
    "compatible",
    fixture
  );
  assert.equal(shellCall.stdout, "");

  const pass = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "tool-pass", tool_input: controlInput("pass") },
    "compatible",
    fixture
  );
  assert.equal(pass.stdout, "");

  const write = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "src/app.js" } },
    "compatible",
    fixture
  );
  assert.equal(write.stdout, "");

  handleHook(
    {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_use_id: "tool-pass",
      tool_input: controlInput("pass"),
      tool_response: {
        stdout: "<!-- comprehension-gate:pass -->\n",
        stderr: "",
        interrupted: false
      }
    },
    "compatible",
    fixture
  );

  assert.equal(readGateState("claude", base, { env: fixture.env }).state.status, "passed");

  const allowed = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "src/app.js" } },
    "compatible",
    fixture
  );
  assert.equal(allowed.stdout, "");

  handleHook(
    { ...base, turn_id: "turn-2", hook_event_name: "UserPromptSubmit", prompt: "another request" },
    "compatible",
    fixture
  );
  const afterReset = handleHook(
    { ...base, turn_id: "turn-2", hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(afterReset.stdout, "");
});
test("first PreToolUse initializes missing state and permits a later pass", () => {
  const fixture = createFixture({ PLUGIN_ROOT: "/plugin" });
  const base = { session_id: "missing-first", turn_id: "turn-1" };

  const initial = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(initial.stdout, "", "initial write");
  const pending = readGateState("codex", base, { env: fixture.env });
  assert.equal(pending.ok, true);
  assert.equal(pending.state.status, "pending");

  const arm = handleHook(
    {
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "missing-pass",
      tool_input: { command: controlCommand("pass") }
    },
    "compatible",
    fixture
  );
  assert.equal(arm.stdout, "");
  handleHook(
    {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "missing-pass",
      tool_input: { command: controlCommand("pass") },
      tool_response: { stdout: "<!-- comprehension-gate:pass -->" }
    },
    "compatible",
    fixture
  );

  const allowed = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(allowed.stdout, "");
});

test("invalid and unreadable state allow the tool and do not arm a control", () => {
  const fixture = createFixture({ PLUGIN_ROOT: "/plugin" });
  const base = { session_id: "invalid-first", turn_id: "turn-1" };
  const filePath = stateFilePath("codex", base, { env: fixture.env });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "not-json\n");

  const invalid = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(invalid.stdout, "", "invalid state");
  assert.equal(fs.readFileSync(filePath, "utf8"), "not-json\n");

  let writeAttempts = 0;
  const unreadableFs = new Proxy(fs, {
    get(target, property) {
      if (property === "readFileSync") {
        return () => {
          const error = new Error("injected unreadable state");
          error.code = "EACCES";
          throw error;
        };
      }
      if (["writeFileSync", "renameSync", "copyFileSync"].includes(property)) {
        return () => {
          writeAttempts += 1;
          throw new Error("state must not be rewritten");
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const unreadable = handleHook(
    {
      session_id: "unreadable-first",
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {}
    },
    "compatible",
    { ...fixture, fs: unreadableFs }
  );
  assert.equal(unreadable.stdout, "", "unreadable state");
  assert.equal(writeAttempts, 0);
});

test("only exact native control targets arm the gate", () => {
  const fixture = createFixture();
  const base = { session_id: "session-2", hook_event_name: "SessionStart", source: "startup" };
  handleHook(base, "compatible", fixture);

  const read = handleHook(
    {
      session_id: "session-2",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: `${controlTarget("pass")}-other` }
    },
    "compatible",
    fixture
  );

  assert.equal(read.stdout, "");
  const write = handleHook(
    { session_id: "session-2", hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(write.stdout, "");
  assert.equal(
    readGateState("claude", { session_id: "session-2" }, { env: fixture.env }).state.status,
    "pending",
    "non-control read did not arm the gate"
  );
});

test("a control completion armed in an earlier turn cannot pass a reset gate", () => {
  const fixture = createFixture({ PLUGIN_ROOT: "/plugin" });
  const first = { session_id: "session-stale", turn_id: "turn-1" };
  handleHook({ ...first, hook_event_name: "SessionStart" }, "compatible", fixture);
  handleHook(
    {
      ...first,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "old-tool",
      tool_input: { command: controlCommand("pass") }
    },
    "compatible",
    fixture
  );

  const second = { session_id: first.session_id, turn_id: "turn-2" };
  handleHook(
    { ...second, hook_event_name: "UserPromptSubmit", prompt: "new request" },
    "compatible",
    fixture
  );
  handleHook(
    {
      ...first,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "old-tool",
      tool_input: { command: controlCommand("pass") },
      tool_response: { exit_code: 0, output: "<!-- comprehension-gate:pass -->" }
    },
    "compatible",
    fixture
  );

  const write = handleHook(
    { ...second, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(write.stdout, "");
  assert.equal(
    readGateState("codex", second, { env: fixture.env }).state.status,
    "pending",
    "a control completion armed in an earlier turn cannot pass a reset gate"
  );
});

test("provider-specific context and allow shapes are correct", () => {
  const cursor = createFixture();
  handleHook({ session_id: "cursor", hook_event_name: "SessionStart" }, "cursor", cursor);
  const cursorReset = handleHook(
    {
      conversation_id: "cursor",
      generation_id: "generation-1",
      hook_event_name: "beforeSubmitPrompt",
      prompt: "change the code"
    },
    "cursor",
    cursor
  );
  assert.deepEqual(JSON.parse(cursorReset.stdout), { continue: true });
  const cursorAllowed = handleHook(
    {
      conversation_id: "cursor",
      generation_id: "generation-1",
      hook_event_name: "preToolUse",
      tool_name: "Write",
      tool_input: {}
    },
    "cursor",
    cursor
  );
  assert.equal(cursorAllowed.exitCode, 0);
  assert.deepEqual(JSON.parse(cursorAllowed.stdout), { permission: "allow" });

  const kiro = createFixture();
  const kiroStart = handleHook(
    { session_id: "kiro", hook_event_name: "SessionStart" },
    "kiro",
    kiro
  );
  assert.match(kiroStart.stdout, /Comprehension Gate/);
  const kiroAllowed = handleHook(
    { session_id: "kiro", hook_event_name: "preToolUse", tool_name: "fs_write", tool_input: {} },
    "kiro",
    kiro
  );
  assert.equal(kiroAllowed.exitCode, 0);
  assert.equal(kiroAllowed.stdout, "");
});

test("cursor preToolUse and postToolUse answer with JSON so failClosed does not block every tool", () => {
  const fixture = createFixture();
  handleHook({ conversation_id: "cursor-json", hook_event_name: "sessionStart" }, "cursor", fixture);
  const base = { conversation_id: "cursor-json", generation_id: "generation-1" };

  const preToolUse = handleHook(
    { ...base, hook_event_name: "preToolUse", tool_name: "Write", tool_input: {} },
    "cursor",
    fixture
  );
  assert.equal(preToolUse.exitCode, 0);
  assert.deepEqual(JSON.parse(preToolUse.stdout), { permission: "allow" });

  const postToolUse = handleHook(
    {
      ...base,
      hook_event_name: "postToolUse",
      tool_name: "Write",
      tool_input: {},
      tool_output: JSON.stringify({ exitCode: 0, stdout: "" })
    },
    "cursor",
    fixture
  );
  assert.equal(postToolUse.exitCode, 0);
  assert.deepEqual(JSON.parse(postToolUse.stdout), {});
});

test("cursor preToolUse still answers allow when the state file cannot be read", () => {
  const fixture = createFixture();
  const base = { conversation_id: "cursor-unreadable", generation_id: "generation-1" };
  handleHook({ ...base, hook_event_name: "sessionStart" }, "cursor", fixture);
  const filePath = stateFilePath("cursor", base, { env: fixture.env });
  fs.writeFileSync(filePath, "{not json");

  const preToolUse = handleHook(
    { ...base, hook_event_name: "preToolUse", tool_name: "Write", tool_input: {} },
    "cursor",
    fixture
  );
  assert.equal(preToolUse.exitCode, 0);
  assert.deepEqual(JSON.parse(preToolUse.stdout), { permission: "allow" });
});

test("compatible preToolUse still answers with empty stdout", () => {
  const fixture = createFixture();
  handleHook({ session_id: "compatible-empty", hook_event_name: "SessionStart" }, "compatible", fixture);
  const preToolUse = handleHook(
    { session_id: "compatible-empty", hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(preToolUse.exitCode, 0);
  assert.equal(preToolUse.stdout, "");
});

test("provider result parsing rejects missing markers and explicit failures", () => {
  assert.equal(
    controlTransitionSucceeded(
      { tool_response: { exit_code: 0, output: "no marker" } },
      "codex",
      "pass"
    ),
    false
  );
  assert.equal(
    controlTransitionSucceeded(
      { tool_output: JSON.stringify({ exitCode: 1, stdout: "<!-- comprehension-gate:pass -->" }) },
      "cursor",
      "pass"
    ),
    false
  );
  assert.equal(
    controlTransitionSucceeded(
      { tool_output: JSON.stringify({ exitCode: 0, stdout: "<!-- comprehension-gate:pass -->" }) },
      "cursor",
      "pass"
    ),
    true
  );
});

test("malformed hook input fails closed with a non-zero exit for every mode", () => {
  for (const mode of ["compatible", "cursor", "kiro"]) {
    const result = malformedInputResult(mode);
    assert.equal(result.exitCode, 1, mode);
    assert.equal(result.stdout, "", `${mode}: no event-specific payload can be trusted`);
    assert.match(result.stderr, /could not parse hook input/);
  }
});

test("a failed prompt reset blocks submission and invalidates an earlier pass", () => {
  const fixture = createFixture();
  const base = { session_id: "reset-failure" };
  handleHook({ ...base, hook_event_name: "SessionStart" }, "compatible", fixture);
  handleHook(
    {
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_use_id: "reset-pass",
      tool_input: controlInput("pass")
    },
    "compatible",
    fixture
  );
  handleHook(
    {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_use_id: "reset-pass",
      tool_input: controlInput("pass"),
      tool_response: { stdout: "<!-- comprehension-gate:pass -->" }
    },
    "compatible",
    fixture
  );

  let failRename = true;
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync" && failRename) {
        return () => {
          failRename = false;
          throw new Error("injected rename failure");
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const reset = handleHook(
    { ...base, hook_event_name: "UserPromptSubmit", prompt: "next request" },
    "compatible",
    { ...fixture, fs: failingFs }
  );
  assert.equal(reset.exitCode, 2);
  assert.match(reset.stderr, /could not reset/);

  const write = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(write.stdout, "");
  assert.equal(
    readGateState("claude", base, { env: fixture.env }).state.status,
    "pending",
    "a failed prompt reset invalidates an earlier pass"
  );
});

test("command entrypoint consumes hook JSON over stdin", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-cli-"));
  const input = JSON.stringify({
    session_id: "cli-session",
    hook_event_name: "SessionStart",
    source: "startup"
  });
  const result = spawnSync(process.execPath, [new URL("../core/gate.mjs", import.meta.url).pathname, "compatible"], {
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      COMPREHENSION_GATE_STATE_DIR: directory,
      PLUGIN_ROOT: "/plugin"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, "SessionStart");
});

test("native control targets contain the exact standalone markers", () => {
  assert.throws(() => controlTarget("unknown"), /Unknown control action/);
  for (const [action, marker] of [
    ["pass", "<!-- comprehension-gate:pass -->\n"],
    ["bypass-low", "<!-- comprehension-gate:bypass-low -->\n"]
  ]) {
    assert.equal(fs.readFileSync(controlTarget(action), "utf8"), marker);
    assert.doesNotMatch(controlTarget(action), /(^|[\\/])node(?:\.exe)?(?:$|\s)/i);
  }

  // Reading a control target through the shell is ordinary inspection, so it
  // proceeds, but only a native read of the target arms the control. Printing
  // the marker must never satisfy the gate.
  const fixture = createFixture();
  const base = { session_id: "shell-control-inert" };
  handleHook({ ...base, hook_event_name: "SessionStart" }, "compatible", fixture);

  const shellRead = handleHook(
    {
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "shell-control",
      tool_input: { command: `cat ${controlTarget("pass")}` }
    },
    "compatible",
    fixture
  );
  assert.equal(shellRead.stdout, "", "control target through shell is inspection");

  handleHook(
    {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "shell-control",
      tool_input: { command: `cat ${controlTarget("pass")}` },
      tool_response: { stdout: "<!-- comprehension-gate:pass -->" }
    },
    "compatible",
    fixture
  );

  const stillPending = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "src/app.js" } },
    "compatible",
    fixture
  );
  assert.equal(stillPending.stdout, "");
  assert.equal(
    readGateState("claude", base, { env: fixture.env }).state.status,
    "pending",
    "shell-printed marker must not satisfy the gate"
  );
});

test("LOW bypass completes through the native read control", () => {
  const fixture = createFixture();
  const base = { session_id: "native-low-control" };
  handleHook({ ...base, hook_event_name: "SessionStart" }, "compatible", fixture);

  handleHook(
    {
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_use_id: "low-control",
      tool_input: controlInput("bypass-low")
    },
    "compatible",
    fixture
  );
  handleHook(
    {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_use_id: "low-control",
      tool_input: controlInput("bypass-low"),
      tool_response: { stdout: "<!-- comprehension-gate:bypass-low -->" }
    },
    "compatible",
    fixture
  );

  assert.equal(readGateState("claude", base, { env: fixture.env }).state.status, "bypassed-low");
});
