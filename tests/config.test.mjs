import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  adapterCommand,
  buildEntrypointCommand
} from "../core/command.mjs";
import { readGateState } from "../core/state.mjs";

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
  assert.equal("matcher" in config.hooks.PreToolUse[0], false);
  assert.equal("matcher" in config.hooks.PostToolUse[0], false);
});

test("native PreToolUse adapters route unknown and MCP tools", () => {
  const cursor = readJson("adapters/cursor/hooks.json");
  const cursorPreToolUse = cursor.hooks.preToolUse[0];
  assert.equal("matcher" in cursorPreToolUse, false);
  assert.equal("matcher" in cursor.hooks.postToolUse[0], false);

  const kiro = readJson("adapters/kiro/hooks.json");
  const kiroPreToolUse = kiro.hooks.find(hook => hook.trigger === "PreToolUse");
  const kiroPostToolUse = kiro.hooks.find(hook => hook.trigger === "PostToolUse");
  assert.equal(kiroPreToolUse.matcher, "*");
  assert.equal(kiroPostToolUse.matcher, "*");
});

test("native adapter templates use only the documented placeholder", () => {
  for (const provider of ["cursor", "kiro"]) {
    const raw = fs.readFileSync(path.join(root, "adapters", provider, "hooks.json"), "utf8");
    assert.match(raw, /__COMPREHENSION_GATE_COMMAND__/);
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
    assert.doesNotMatch(result.stdout, /__COMPREHENSION_GATE_COMMAND__/);
    const config = JSON.parse(result.stdout);
    const command = adapterCommandFromConfig(provider, config);
    const parsed = parseEntrypointCommand(command);
    assert.equal(parsed.entrypoint, path.join(root, "core", "gate.mjs"));
    assert.equal(parsed.argument, provider);
    assert.doesNotMatch(command, /core[\\/]gate\.mjs/);
  }
});

test("Windows adapter and entrypoint paths are encoded outside shell syntax", () => {
  const windowsRoot = String.raw`C:\dev\plugin-$HOME-$(whoami)-%TEMP%-&-|-^-!-spaces-'single'-"double"-\`tick\``;
  const expectedEntrypoint = path.win32.join(windowsRoot, "core", "gate.mjs");

  for (const provider of ["cursor", "kiro"]) {
    const command = adapterCommand(provider, windowsRoot, "win32");
    const parsed = parseEntrypointCommand(command);
    assert.equal(parsed.entrypoint, expectedEntrypoint);
    assert.equal(parsed.argument, provider);
    assertShellPathIsOpaque(command, windowsRoot);
  }

  for (const argument of ["compatible", "cursor"]) {
    const command = buildEntrypointCommand(expectedEntrypoint, argument);
    const parsed = parseEntrypointCommand(command);
    assert.equal(parsed.entrypoint, expectedEntrypoint);
    assert.equal(parsed.argument, argument);
    assertShellPathIsOpaque(command, windowsRoot);
  }
});

test("entrypoint command builders reject unencoded shell arguments", () => {
  assert.throws(() => buildEntrypointCommand("", "pass"), /non-empty/);
  assert.throws(
    () => buildEntrypointCommand("/plugin/core/gate.mjs", "pass && mutate"),
    /shell syntax/
  );
  assert.throws(() => adapterCommand("unknown", "/plugin"), /Unsupported adapter/);
});

test("encoded adapter commands execute through native Windows shells", {
  skip: process.platform !== "win32"
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-win-"));
  const specialRoot = path.join(
    sandbox,
    "plugin-%TEMP%-$HOME-$(Write-Output wrong)-!-^-&-spaces"
  );
  fs.mkdirSync(specialRoot);
  fs.cpSync(path.join(root, "core"), path.join(specialRoot, "core"), {
    recursive: true
  });
  const command = adapterCommand("cursor", specialRoot, "win32");
  const batchPath = path.join(sandbox, "run-adapter.cmd");
  fs.writeFileSync(batchPath, `@echo off\r\n${command}\r\n`);
  const input = JSON.stringify({
    conversation_id: "windows-shell",
    hook_event_name: "sessionStart"
  });
  const shells = [
    {
      name: "cmd",
      executable: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/c", batchPath],
      probeArgs: ["/d", "/c", "exit 0"]
    },
    {
      name: "PowerShell",
      executable: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
      probeArgs: ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]
    }
  ];

  for (const shell of shells) {
    const available = spawnSync(shell.executable, shell.probeArgs);
    if (available.error?.code === "ENOENT") {
      t.diagnostic(`${shell.name} unavailable`);
      continue;
    }
    const result = spawnSync(shell.executable, shell.args, {
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        COMPREHENSION_GATE_STATE_DIR: path.join(sandbox, `state-${shell.name}`)
      }
    });
    assert.equal(result.status, 0, `${shell.name}: ${result.stderr}`);
    assert.match(result.stdout, /Comprehension Gate/, shell.name);
  }
});

test("adapter renderer safely executes roots with POSIX shell metacharacters", {
  skip: process.platform === "win32"
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-render-"));
  const sentinel = path.join(sandbox, "renderer-sentinel");
  const fixtureParent = path.join(sandbox, "node_modules");
  fs.mkdirSync(fixtureParent);
  const specialRoot = path.join(
    fixtureParent,
    "plugin-`touch${IFS}renderer-sentinel`-$-'single'-\"double\""
  );
  fs.mkdirSync(specialRoot);
  fs.cpSync(path.join(root, "core"), path.join(specialRoot, "core"), {
    recursive: true
  });

  for (const provider of ["cursor", "kiro"]) {
    const render = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "render-adapter.mjs"), provider, "--root", specialRoot],
      { encoding: "utf8" }
    );
    assert.equal(render.status, 0, render.stderr);
    const config = JSON.parse(render.stdout);
    const command = provider === "cursor"
      ? config.hooks.sessionStart[0].command
      : config.hooks.find(hook => hook.trigger === "SessionStart").action.command;
    const input = provider === "cursor"
      ? { conversation_id: "quoted-cursor", hook_event_name: "sessionStart" }
      : { session_id: "quoted-kiro", hook_event_name: "SessionStart" };
    const childEnv = {
      ...process.env,
      COMPREHENSION_GATE_STATE_DIR: path.join(sandbox, `state-${provider}`)
    };
    delete childEnv.NODE_V8_COVERAGE;
    const run = spawnSync(command, {
      cwd: sandbox,
      encoding: "utf8",
      env: childEnv,
      input: JSON.stringify(input),
      shell: "/bin/sh"
    });

    assert.equal(run.status, 0, `${provider}: ${run.stderr}`);
    assert.match(run.stdout, /Comprehension Gate/, provider);
    assert.equal(fs.existsSync(sentinel), false, `${provider}: command substitution ran`);
  }
});

test("Kiro adapter matches and blocks every documented 3.x mutation tool", () => {
  const config = readJson("adapters/kiro/hooks.json");
  const preHook = config.hooks.find(hook => hook.trigger === "PreToolUse");
  const postHook = config.hooks.find(hook => hook.trigger === "PostToolUse");
  const mutationTools = [
    "fs_write",
    "str_replace",
    "delete_file",
    "execute_bash",
    "control_bash_process"
  ];

  assert.equal(preHook.matcher, "*");
  assert.equal(postHook.matcher, "*");

  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-kiro-"));
  const env = {
    ...process.env,
    COMPREHENSION_GATE_STATE_DIR: stateDirectory
  };
  const session = "kiro-entrypoint";
  const start = runKiroHook({ session_id: session, hook_event_name: "SessionStart" }, env);
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /Comprehension Gate/);
  const state = readGateState("kiro", { session_id: session }, { env });
  assert.equal(state.ok, true);
  assert.equal(state.state.status, "pending");

  for (const toolName of [...mutationTools, "@filesystem/write_file"]) {
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

function adapterCommandFromConfig(provider, config) {
  return provider === "cursor"
    ? config.hooks.sessionStart[0].command
    : config.hooks.find(hook => hook.trigger === "SessionStart").action.command;
}

function parseEntrypointCommand(command) {
  const match = command.match(/^node -e "([^"]+)" ([A-Za-z0-9_-]+) ([A-Za-z0-9_-]+)$/);
  assert.ok(match, command);
  return {
    bootstrap: match[1],
    entrypoint: Buffer.from(match[2], "base64url").toString("utf8"),
    argument: match[3]
  };
}

function assertShellPathIsOpaque(command, rawPath) {
  assert.equal(command.includes(rawPath), false);
  for (const token of ["$HOME", "$(", "%TEMP%", "&", "|", "^", "!", "`"]) {
    assert.equal(command.includes(token), false, token);
  }
}

function runKiroHook(input, env) {
  return spawnSync(
    process.execPath,
    [path.join(root, "core", "gate.mjs"), "kiro"],
    { encoding: "utf8", input: JSON.stringify(input), env }
  );
}
