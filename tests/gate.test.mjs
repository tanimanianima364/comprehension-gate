import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  controlTarget,
  controlTransitionSucceeded,
  handleHook,
  malformedInputResult
} from "../core/gate.mjs";
import { readGateState, stateFilePath } from "../core/state.mjs";

test("compatible flow blocks shell and writes until the native pass control completes", () => {
  const fixture = createFixture({ PLUGIN_ROOT: "/plugin" });
  const base = { session_id: "session-1", turn_id: "turn-1" };

  const start = handleHook(
    { ...base, hook_event_name: "SessionStart", source: "startup" },
    "compatible",
    fixture
  );
  assert.equal(start.exitCode, 0);
  assert.equal(JSON.parse(start.stdout).hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(start.stdout, /Comprehension Gate/);

  const blocked = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch" } },
    "compatible",
    fixture
  );
  assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, "deny");

  const shellBlocked = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rg --files" } },
    "compatible",
    fixture
  );
  assertDenied(shellBlocked, "compatible", "pending shell");

  const pass = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "tool-pass", tool_input: controlInput("pass") },
    "compatible",
    fixture
  );
  assert.equal(pass.stdout, "");

  const stillBlocked = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "src/app.js" } },
    "compatible",
    fixture
  );
  assert.equal(JSON.parse(stillBlocked.stdout).hookSpecificOutput.permissionDecision, "deny");

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
  const blockedAgain = handleHook(
    { ...base, turn_id: "turn-2", hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assert.equal(JSON.parse(blockedAgain.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("pending gates deny MCP tools across providers and restore them after pass", () => {
  const cases = [
    {
      name: "compatible",
      mode: "compatible",
      fixture: createFixture({ PLUGIN_ROOT: "/plugin" }),
      base: { session_id: "mcp-compatible", turn_id: "turn-1" },
      startEvent: "SessionStart",
      preEvent: "PreToolUse",
      postEvent: "PostToolUse",
      readTool: "Read",
      controlField: "file_path",
      shellTool: "Bash",
      mcpTool: "mcp__filesystem__write_file",
      response: { stdout: "<!-- comprehension-gate:pass -->" }
    },
    {
      name: "cursor",
      mode: "cursor",
      fixture: createFixture(),
      base: { conversation_id: "mcp-cursor", generation_id: "generation-1" },
      startEvent: "sessionStart",
      preEvent: "preToolUse",
      postEvent: "postToolUse",
      readTool: "Read",
      controlField: "path",
      shellTool: "Shell",
      mcpTool: "MCP:filesystem.write_file",
      output: JSON.stringify({ exitCode: 0, stdout: "<!-- comprehension-gate:pass -->" })
    },
    {
      name: "kiro",
      mode: "kiro",
      fixture: createFixture(),
      base: { session_id: "mcp-kiro" },
      startEvent: "SessionStart",
      preEvent: "preToolUse",
      postEvent: "postToolUse",
      readTool: "fs_read",
      controlField: "path",
      shellTool: "execute_bash",
      mcpTool: "@filesystem/write_file",
      response: { success: true, result: ["<!-- comprehension-gate:pass -->"] }
    }
  ];

  for (const item of cases) {
    handleHook(
      { ...item.base, hook_event_name: item.startEvent },
      item.mode,
      item.fixture
    );

    const read = handleHook(
      { ...item.base, hook_event_name: item.preEvent, tool_name: item.readTool, tool_input: {} },
      item.mode,
      item.fixture
    );
    assert.equal(read.stdout, "", `${item.name}: known read-only tool`);

    const pendingMcp = handleHook(
      { ...item.base, hook_event_name: item.preEvent, tool_name: item.mcpTool, tool_input: {} },
      item.mode,
      item.fixture
    );
    assertDenied(pendingMcp, item.mode, `${item.name}: pending MCP`);

    const toolUseId = `${item.name}-pass`;
    const arm = handleHook(
      {
        ...item.base,
        hook_event_name: item.preEvent,
        tool_name: item.readTool,
        tool_use_id: toolUseId,
        tool_input: controlInput("pass", item.controlField)
      },
      item.mode,
      item.fixture
    );
    assert.equal(arm.stdout, "", `${item.name}: arm pass`);

    handleHook(
      {
        ...item.base,
        hook_event_name: item.postEvent,
        tool_name: item.readTool,
        tool_use_id: toolUseId,
        tool_input: controlInput("pass", item.controlField),
        ...(item.output === undefined
          ? { tool_response: item.response }
          : { tool_output: item.output })
      },
      item.mode,
      item.fixture
    );

    const passedMcp = handleHook(
      { ...item.base, hook_event_name: item.preEvent, tool_name: item.mcpTool, tool_input: {} },
      item.mode,
      item.fixture
    );
    assert.equal(passedMcp.stdout, "", `${item.name}: passed MCP`);
    assert.equal(passedMcp.exitCode, 0, `${item.name}: passed MCP`);

    const passedShell = handleHook(
      {
        ...item.base,
        hook_event_name: item.preEvent,
        tool_name: item.shellTool,
        tool_input: { command: "cat README.md" }
      },
      item.mode,
      item.fixture
    );
    assert.equal(passedShell.stdout, "", `${item.name}: passed shell`);
    assert.equal(passedShell.exitCode, 0, `${item.name}: passed shell`);
  }
});

test("first PreToolUse initializes missing state and permits a later pass", () => {
  const fixture = createFixture({ PLUGIN_ROOT: "/plugin" });
  const base = { session_id: "missing-first", turn_id: "turn-1" };

  const blocked = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} },
    "compatible",
    fixture
  );
  assertDenied(blocked, "compatible", "initial write");
  const pending = readGateState("codex", base, { env: fixture.env });
  assert.equal(pending.ok, true);
  assert.equal(pending.state.status, "pending");

  const arm = handleHook(
    {
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_use_id: "missing-pass",
      tool_input: controlInput("pass")
    },
    "compatible",
    fixture
  );
  assert.equal(arm.stdout, "");
  handleHook(
    {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_use_id: "missing-pass",
      tool_input: controlInput("pass"),
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

test("invalid and unreadable state remain fail-closed at PreToolUse", () => {
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
  assertDenied(invalid, "compatible", "invalid state");
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
  assertDenied(unreadable, "compatible", "unreadable state");
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
  assertDenied(write, "compatible", "non-control read did not arm the gate");
});

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
      tool_name: "Read",
      tool_use_id: "failed-tool",
      tool_input: controlInput("pass")
    },
    "compatible",
    fixture
  );

  handleHook(
    {
      session_id: base.session_id,
      turn_id: base.turn_id,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_use_id: "failed-tool",
      tool_input: controlInput("pass"),
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
      tool_name: "Read",
      tool_use_id: "successful-tool",
      tool_input: controlInput("pass")
    },
    "compatible",
    fixture
  );
  handleHook(
    {
      session_id: base.session_id,
      turn_id: base.turn_id,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_use_id: "successful-tool",
      tool_input: controlInput("pass"),
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

test("a control completion armed in an earlier turn cannot pass a reset gate", () => {
  const fixture = createFixture({ PLUGIN_ROOT: "/plugin" });
  const first = { session_id: "session-stale", turn_id: "turn-1" };
  handleHook({ ...first, hook_event_name: "SessionStart" }, "compatible", fixture);
  handleHook(
    {
      ...first,
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_use_id: "old-tool",
      tool_input: controlInput("pass")
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
      tool_name: "Read",
      tool_use_id: "old-tool",
      tool_input: controlInput("pass"),
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
  assert.equal(JSON.parse(write.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("provider-specific denial shapes are correct", () => {
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
  const cursorDenied = handleHook(
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
  assert.equal(JSON.parse(cursorDenied.stdout).permission, "deny");

  const kiro = createFixture();
  const kiroStart = handleHook(
    { session_id: "kiro", hook_event_name: "SessionStart" },
    "kiro",
    kiro
  );
  assert.match(kiroStart.stdout, /Comprehension Gate/);
  const kiroDenied = handleHook(
    { session_id: "kiro", hook_event_name: "preToolUse", tool_name: "fs_write", tool_input: {} },
    "kiro",
    kiro
  );
  assert.equal(kiroDenied.exitCode, 2);
  assert.match(kiroDenied.stderr, /not satisfied/);
});

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
      tool_name: "fs_read",
      tool_input: controlInput("pass")
    },
    "kiro",
    fixture
  );
  handleHook(
    {
      ...base,
      hook_event_name: "postToolUse",
      tool_name: "fs_read",
      tool_input: controlInput("pass"),
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
      tool_name: "fs_read",
      tool_input: controlInput("pass")
    },
    "kiro",
    fixture
  );
  handleHook(
    {
      ...base,
      hook_event_name: "postToolUse",
      tool_name: "fs_read",
      tool_input: controlInput("pass"),
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

test("malformed hook input fails closed", () => {
  assert.equal(JSON.parse(malformedInputResult("compatible").stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(malformedInputResult("kiro").exitCode, 2);
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
  assert.equal(JSON.parse(write.stdout).hookSpecificOutput.permissionDecision, "deny");
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

  const shellRead = handleHook(
    {
      session_id: "shell-control-denied",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: `cat ${controlTarget("pass")}` }
    },
    "compatible",
    createFixture()
  );
  assertDenied(shellRead, "compatible", "control target through shell");
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

  const shell = handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pwd" } },
    "compatible",
    fixture
  );
  assert.equal(shell.stdout, "");
});

test("pending denies every ordinary shell tool alias", () => {
  const shellTools = [
    "Bash",
    "PowerShell",
    "Shell",
    "control_bash_process",
    "execute_bash",
    "execute_cmd",
    "execute_command"
  ];

  for (const toolName of shellTools) {
    const result = handleHook(
      {
        session_id: `pending-shell-${toolName}`,
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: { command: "cat README.md" }
      },
      "compatible",
      createFixture()
    );
    assertDenied(result, "compatible", toolName);
  }

  for (const item of [
    { mode: "cursor", base: { conversation_id: "pending-cursor-shell" }, tool: "Shell" },
    { mode: "kiro", base: { session_id: "pending-kiro-shell" }, tool: "execute_bash" }
  ]) {
    const result = handleHook(
      {
        ...item.base,
        hook_event_name: "preToolUse",
        tool_name: item.tool,
        tool_input: { command: "Get-Content README.md" }
      },
      item.mode,
      createFixture()
    );
    assertDenied(result, item.mode, `${item.mode}: pending shell`);
  }
});

test("a PATH-shadowed read command is reachable outside the gate but denied while pending", t => {
  if (process.platform === "win32") {
    t.skip("POSIX PATH-shadow fixture is unavailable on Windows");
    return;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-path-shadow-"));
  const binaryDirectory = path.join(directory, "bin");
  const sentinel = path.join(directory, "shadow-cat-ran");
  fs.mkdirSync(binaryDirectory);
  fs.writeFileSync(
    path.join(binaryDirectory, "cat"),
    [
      "#!/usr/bin/env node",
      'import fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(sentinel)}, "ran");`
    ].join("\n")
  );
  fs.chmodSync(path.join(binaryDirectory, "cat"), 0o700);

  const env = { ...process.env, PATH: `${binaryDirectory}${path.delimiter}${process.env.PATH ?? ""}` };
  const direct = spawnSync("cat", ["README.md"], { cwd: directory, env, encoding: "utf8" });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(fs.existsSync(sentinel), true, "fixture did not resolve the shadowed cat");
  fs.unlinkSync(sentinel);

  const denied = handleHook(
    {
      session_id: "path-shadow-shell",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat README.md" }
    },
    "compatible",
    createFixture(env)
  );
  assertDenied(denied, "compatible", "PATH-shadowed cat");
  assert.equal(fs.existsSync(sentinel), false, "denied hook executed the shadowed cat");
});

function createFixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-hook-"));
  return {
    env: {
      COMPREHENSION_GATE_STATE_DIR: directory,
      ...extraEnv
    }
  };
}

function controlInput(action, field = "file_path") {
  return { [field]: controlTarget(action) };
}

function assertDenied(result, mode, message) {
  if (mode === "kiro") {
    assert.equal(result.exitCode, 2, message);
    return;
  }
  const output = JSON.parse(result.stdout);
  if (mode === "cursor") {
    assert.equal(output.permission, "deny", message);
    return;
  }
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny", message);
}
