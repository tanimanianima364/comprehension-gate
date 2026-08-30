import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  armGateControl,
  clearGateControl,
  completeGateControl,
  ensureGateState,
  GateStateError,
  checkGate,
  readGateState,
  resetGate
} from "./state.mjs";
import { buildPinnedEntrypointCommand } from "./command.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const INSTRUCTIONS_PATH = path.join(path.dirname(SCRIPT_PATH), "instructions.md");
const CONTROL_ACTIONS = new Set(["pass", "bypass-low"]);
const CONTROL_DIRECTORY = path.join(path.dirname(SCRIPT_PATH), "control");
const CONTROL_MARKERS = {
  pass: "<!-- comprehension-gate:pass -->",
  "bypass-low": "<!-- comprehension-gate:bypass-low -->"
};

export function controlTarget(action) {
  if (!CONTROL_ACTIONS.has(action)) {
    throw new Error(`Unknown control action: ${action}`);
  }
  return path.join(CONTROL_DIRECTORY, action);
}

export function controlCommand(action, options = {}) {
  if (!CONTROL_ACTIONS.has(action)) {
    throw new Error(`Unknown control action: ${action}`);
  }
  return buildPinnedEntrypointCommand(
    SCRIPT_PATH,
    action,
    options.runtime ?? process.execPath,
    options.platform ?? process.platform
  );
}

export function renderInstructions(provider = "claude") {
  const usesShellControl = provider === "codex";
  return fs
    .readFileSync(INSTRUCTIONS_PATH, "utf8")
    .replaceAll(
      "{{PASS_CONTROL}}",
      usesShellControl ? controlCommand("pass") : controlTarget("pass")
    )
    .replaceAll(
      "{{BYPASS_CONTROL}}",
      usesShellControl ? controlCommand("bypass-low") : controlTarget("bypass-low")
    )
    .replaceAll(
      "{{CONTROL_METHOD}}",
      usesShellControl
        ? "In Codex, run the command exactly as shown. It is the only shell command available while the gate is pending. Do not add whitespace, arguments, wrappers, or different quoting."
        : "Read the path exactly as shown with the host's native file-reading tool. Do not use a shell command to read it."
    );
}

export function handleHook(input, mode = "compatible", options = {}) {
  const env = options.env ?? process.env;
  const stateOptions = { env, fs: options.fs };
  const provider = detectProvider(mode, env);
  const event = normalizeEvent(input?.hook_event_name);
  const isPromptEvent = event === "userpromptsubmit" || event === "beforesubmitprompt";

  try {
    if (event === "sessionstart" || (mode === "kiro" && event === "agentspawn")) {
      const source = String(input?.source ?? "startup").toLowerCase();
      if (source === "compact") {
        const current = readGateState(provider, input, stateOptions);
        if (!current.ok) {
          resetGate(provider, input, stateOptions);
        }
      } else {
        resetGate(provider, input, stateOptions);
      }
      return contextResult(mode, "SessionStart", renderInstructions(provider));
    }

    if (isPromptEvent) {
      resetGate(provider, input, stateOptions);
      return contextResult(
        mode,
        "UserPromptSubmit",
        promptResetContext(provider)
      );
    }

    if (event === "posttooluse") {
      const action = controlActionFor(input, provider);
      if (action) {
        if (controlTransitionSucceeded(input, provider, action)) {
          completeGateControl(provider, input, action, stateOptions);
        } else {
          clearGateControl(provider, input, action, stateOptions);
        }
      }
      return allowResult();
    }

    if (event !== "pretooluse") {
      return allowResult();
    }

    ensureGateState(provider, input, stateOptions);
    const toolKind = classifyTool(input?.tool_name);
    const action = controlActionFor(input, provider);
    if (action) {
      armGateControl(provider, input, action, stateOptions);
      return allowResult();
    }
    if (toolKind === "read") {
      return allowResult();
    }

    const gate = checkGate(provider, input, stateOptions);
    if (gate.satisfied) {
      return allowResult();
    }

    return denyResult(mode, denialReason(gate.reason, toolKind, provider));
  } catch (error) {
    const detail = error instanceof GateStateError ? error.message : "Gate state could not be verified.";
    if (isPromptEvent) {
      return promptBlockResult(
        mode,
        `Comprehension Gate could not reset for this prompt. ${detail}`
      );
    }
    if (event === "posttooluse") {
      return contextResult(
        mode,
        "PostToolUse",
        `Comprehension Gate failed to record the control transition. ${detail} The gate remains pending; do not modify the project.`
      );
    }
    return denyResult(mode, `Comprehension Gate failed closed. ${detail}`);
  }
}

export function malformedInputResult(mode = "compatible") {
  return denyResult(
    mode,
    "Comprehension Gate could not parse hook input. Do not modify the project yet."
  );
}

export function controlTransitionSucceeded(input, provider, action) {
  if (!CONTROL_ACTIONS.has(action)) {
    return false;
  }

  const rawResponse = input?.tool_output ?? input?.tool_response;
  if (rawResponse === undefined || rawResponse === null) {
    return false;
  }
  const response = parseJsonString(rawResponse);
  if (provider === "kiro" && response?.success !== true) {
    return false;
  }
  if (hasExplicitFailure(response)) {
    return false;
  }

  return responseText(response).includes(CONTROL_MARKERS[action]);
}

function detectProvider(mode, env) {
  if (mode === "cursor") {
    return "cursor";
  }
  if (mode === "kiro") {
    return "kiro";
  }
  if (env.PLUGIN_ROOT) {
    return "codex";
  }
  if (env.CURSOR_PROJECT_DIR || env.CURSOR_VERSION) {
    return "cursor";
  }
  return "claude";
}

function normalizeEvent(event) {
  return String(event ?? "").replaceAll(/[^a-z]/gi, "").toLowerCase();
}

function classifyTool(toolName) {
  const normalized = String(toolName ?? "").replaceAll(/[^a-z_]/gi, "").toLowerCase();
  if (READ_ONLY_TOOLS.has(normalized)) {
    return "read";
  }
  if (WRITE_TOOLS.has(normalized)) {
    return "write";
  }
  if (SHELL_TOOLS.has(normalized)) {
    return "shell";
  }
  return "other";
}

function parseJsonString(value) {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function hasExplicitFailure(response) {
  if (!response || typeof response !== "object") {
    return false;
  }
  const exitCode = response.exitCode ?? response.exit_code;
  return (
    (typeof exitCode === "number" && exitCode !== 0) ||
    response.success === false ||
    response.ok === false ||
    response.isError === true ||
    response.is_error === true ||
    response.interrupted === true
  );
}

function responseText(response) {
  if (typeof response === "string") {
    return response;
  }
  try {
    return JSON.stringify(response);
  } catch {
    return "";
  }
}

function controlActionFor(input, provider) {
  if (provider === "codex") {
    return codexShellControlAction(input);
  }

  if (classifyTool(input?.tool_name) !== "read") {
    return null;
  }
  const target = provider === "kiro"
    ? kiroReadTarget(input)
    : input?.tool_input?.file_path ?? input?.tool_input?.filePath ?? input?.tool_input?.path;
  if (typeof target !== "string") {
    return null;
  }
  for (const action of CONTROL_ACTIONS) {
    if (path.resolve(target) === path.resolve(controlTarget(action))) {
      return action;
    }
  }
  return null;
}

function codexShellControlAction(input) {
  if (input?.tool_name !== "Bash") {
    return null;
  }
  const command = input?.tool_input?.command;
  if (typeof command !== "string") {
    return null;
  }
  for (const action of CONTROL_ACTIONS) {
    if (command === controlCommand(action)) {
      return action;
    }
  }
  return null;
}

function kiroReadTarget(input) {
  const operations = input?.tool_input?.operations;
  if (!Array.isArray(operations) || operations.length !== 1) {
    return null;
  }
  return operations[0]?.path;
}

function contextResult(mode, eventName, context) {
  if (mode === "kiro") {
    return { exitCode: 0, stdout: `${context}\n`, stderr: "" };
  }
  if (mode === "cursor") {
    if (eventName === "UserPromptSubmit") {
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ continue: true })}\n`,
        stderr: ""
      };
    }
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ additional_context: context })}\n`,
      stderr: ""
    };
  }
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: context
      }
    })}\n`,
    stderr: ""
  };
}

function denyResult(mode, reason) {
  if (mode === "kiro") {
    return { exitCode: 2, stdout: "", stderr: `${reason}\n` };
  }
  if (mode === "cursor") {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        permission: "deny",
        user_message: reason,
        agent_message: reason
      })}\n`,
      stderr: ""
    };
  }
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason
      }
    })}\n`,
    stderr: ""
  };
}

function promptBlockResult(mode, reason) {
  if (mode === "cursor") {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ continue: false, user_message: reason })}\n`,
      stderr: ""
    };
  }
  return { exitCode: 2, stdout: "", stderr: `${reason}\n` };
}

function allowResult() {
  return { exitCode: 0, stdout: "", stderr: "" };
}

function denialReason(stateReason, toolKind, provider) {
  const toolNote = toolKind === "shell"
    ? " Shell commands are unavailable before the gate passes, except an exact provider-supplied control command."
    : toolKind === "other"
      ? " This tool is not on the explicit read-only allowlist, so it is denied while the gate is pending."
      : "";
  const controlInstruction = provider === "codex"
    ? [
        `After mastery, run this exact Codex pass control command: ${controlCommand("pass")}`,
        `For a genuinely LOW change only, run this exact Codex LOW bypass command: ${controlCommand("bypass-low")}`
      ]
    : [
        `After mastery, read this exact control target with a native file-reading tool: ${controlTarget("pass")}`,
        `For a genuinely LOW change only, read this exact control target with a native file-reading tool: ${controlTarget("bypass-low")}`
      ];
  const lines = [
    `Comprehension Gate is not satisfied for the current user turn (${stateReason}).`,
    "Classify it silently: LOW is mechanical; MEDIUM requires Explain; HIGH requires Explain + Why + Predict; CRITICAL also requires Transfer.",
    "Ask the minimum codebase-specific question(s) and wait for the user to demonstrate understanding in their own words.",
    ...controlInstruction,
    toolNote
  ];
  return lines.join(" ").trim();
}

function promptResetContext(provider) {
  const nativeReadContext = `Comprehension Gate is pending for this user turn. If this message answers a gate question, assess it against the required level and read the exact pass control target with a native file-reading tool only after the answer demonstrates understanding: ${controlTarget("pass")} For a genuinely LOW change only, read this exact bypass target: ${controlTarget("bypass-low")}`;
  if (provider !== "codex") {
    return nativeReadContext;
  }
  return `Comprehension Gate is pending for this user turn. If this message answers a gate question, assess it against the required level and run the exact Codex pass control command only after the answer demonstrates understanding: ${controlCommand("pass")} For a genuinely LOW change only, run this exact bypass command: ${controlCommand("bypass-low")}`;
}

const WRITE_TOOLS = new Set([
  "apply_patch",
  "delete",
  "delete_file",
  "edit",
  "fs_write",
  "fswrite",
  "notebookedit",
  "str_replace",
  "str_replace_based_edit_tool",
  "write",
  "writefile"
]);

const READ_ONLY_TOOLS = new Set([
  "file_search",
  "filesearch",
  "fs_read",
  "fsread",
  "glob",
  "grep",
  "list_directory",
  "listdirectory",
  "read",
  "read_file",
  "read_files",
  "readfile",
  "readfiles",
  "ripgrep",
  "search_files",
  "searchfiles",
  "semantic_search",
  "semanticsearch",
  "view_image",
  "viewimage",
  "web_fetch",
  "web_search",
  "webfetch",
  "websearch"
]);

const SHELL_TOOLS = new Set([
  "bash",
  "control_bash_process",
  "execute_bash",
  "execute_cmd",
  "execute_command",
  "powershell",
  "shell"
]);

export async function main() {
  const [mode = "compatible"] = process.argv.slice(2);

  if (CONTROL_ACTIONS.has(mode)) {
    process.stdout.write(`${CONTROL_MARKERS[mode]}\n`);
    return;
  }

  let stdin = "";
  for await (const chunk of process.stdin) {
    stdin += chunk;
  }

  let result;
  try {
    result = handleHook(JSON.parse(stdin), mode);
  } catch {
    result = malformedInputResult(mode);
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(SCRIPT_PATH)) {
  await main();
}
