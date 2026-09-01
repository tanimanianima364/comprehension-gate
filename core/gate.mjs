import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  armGateControl,
  clearGateControl,
  completeGateControl,
  CONTROL_ACTIONS,
  ensureGateState,
  GateStateError,
  checkGate,
  readGateState,
  resetGate
} from "./state.mjs";
import { buildPinnedEntrypointCommand } from "./command.mjs";
import { classifyShellCommand } from "./shell.mjs";
import {
  decodeInspectionArgument,
  encodeInspectionArgument,
  INSPECTION_ACTIONS,
  inspectionValueCount,
  runInspection
} from "./inspection.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const INSTRUCTIONS_PATH = path.join(path.dirname(SCRIPT_PATH), "instructions.md");
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
    options.entrypoint ?? SCRIPT_PATH,
    action,
    options.runtime ?? process.execPath
  );
}

export function inspectionCommand(action, values, workspace, options = {}) {
  if (!INSPECTION_ACTIONS.has(action)) {
    throw new Error(`Unknown inspection action: ${action}`);
  }
  const expectedArity = inspectionValueCount(action);
  if (!Array.isArray(values) || values.length !== expectedArity) {
    throw new Error(`${action} expects ${expectedArity} values.`);
  }
  const normalizedWorkspace = normalizeHookWorkspace(workspace);
  if (!normalizedWorkspace) {
    throw new Error("Inspection workspace must be an absolute path.");
  }
  return inspectionCommandFromEncoded(
    action,
    [encodeInspectionArgument(normalizedWorkspace), ...values.map(encodeInspectionArgument)],
    options
  );
}

export function renderInstructions(provider = "claude", options = {}) {
  const usesShellControl = provider === "codex";
  const commandOptions = controlCommandOptions(options);
  return fs
    .readFileSync(INSTRUCTIONS_PATH, "utf8")
    .replaceAll(
      "{{PASS_CONTROL}}",
      usesShellControl ? controlCommand("pass", commandOptions) : controlTarget("pass")
    )
    .replaceAll(
      "{{BYPASS_CONTROL}}",
      usesShellControl
        ? controlCommand("bypass-low", commandOptions)
        : controlTarget("bypass-low")
    )
    .replaceAll(
      "{{CONTROL_METHOD}}",
      usesShellControl
        ? "In Codex, run the command exactly as shown. Apart from the inspection commands below, these are the only shell commands available while the gate is pending. Do not add whitespace, arguments, wrappers, or different quoting."
        : "Read the path exactly as shown with the host's native file-reading tool. Do not use a shell command to read it."
    )
    .replaceAll(
      "{{INSPECTION_METHOD}}",
      usesShellControl
        ? formatCodexInspectionInstructions(options.cwd, commandOptions)
        : "Use the host's native file-reading and search tools for codebase inspection."
    );
}

export function handleHook(input, mode = "compatible", options = {}) {
  const env = options.env ?? process.env;
  const stateOptions = { env, fs: options.fs };
  const commandOptions = controlCommandOptions(options);
  const provider = detectProvider(mode, env);
  const event = normalizeEvent(input?.hook_event_name);
  // Only trusted lifecycle events may record the workspace Codex inspection is pinned to.
  const trustedReset = { workspace: normalizeHookWorkspace(input?.cwd) };
  const isPromptEvent = event === "userpromptsubmit" || event === "beforesubmitprompt";
  const isStartEvent = event === "sessionstart" || (mode === "kiro" && event === "agentspawn");

  if (!isStartEvent && !isPromptEvent && event !== "posttooluse" && event !== "pretooluse") {
    return blockingErrorResult(
      `Comprehension Gate received an unrecognized hook event (${JSON.stringify(input?.hook_event_name ?? null)}) and fails closed.`
    );
  }

  try {
    if (isStartEvent) {
      const source = String(input?.source ?? "startup").toLowerCase();
      if (source === "compact") {
        const current = readGateState(provider, input, stateOptions);
        if (!current.ok) {
          resetGate(provider, input, stateOptions, trustedReset);
        }
      } else {
        resetGate(provider, input, stateOptions, trustedReset);
      }
      return contextResult(
        mode,
        "SessionStart",
        renderInstructions(provider, { ...commandOptions, cwd: input?.cwd })
      );
    }

    if (isPromptEvent) {
      resetGate(provider, input, stateOptions, trustedReset);
      return contextResult(
        mode,
        "UserPromptSubmit",
        promptResetContext(provider, commandOptions, input?.cwd)
      );
    }

    if (event === "posttooluse") {
      const action = controlActionFor(input, provider, commandOptions);
      if (action) {
        if (controlTransitionSucceeded(input, provider, action)) {
          completeGateControl(provider, input, action, stateOptions);
        } else {
          clearGateControl(provider, input, action, stateOptions);
        }
      }
      return allowResult();
    }

    const state = ensureGateState(provider, input, stateOptions);
    const toolKind = classifyTool(input?.tool_name, provider);

    /*
     * Every shell rule this plugin has reads a command as POSIX shell, so on
     * any other platform the scan applies the wrong grammar and the command
     * table the wrong names: `Remove-Item` matches nothing and would look like
     * inspection. Refuse every shell tool there instead.
     *
     * This sits ahead of the control and inspection exceptions on purpose.
     * Those match a command exactly and return before the classifier is ever
     * consulted, so a guard inside classifyShellCommand would not be reached
     * by them. Keying on the tool kind rather than the provider leaves native
     * reads working on every host, which is how Claude Code, Cursor, and Kiro
     * still pass here.
     */
    if ((options.platform ?? process.platform) === "win32" && toolKind === "shell") {
      return denyResult(
        mode,
        "Comprehension Gate classifies shell commands as POSIX shell and this platform is not one, so no shell command is available. Use the host's native file-reading and search tools."
      );
    }

    const action = controlActionFor(input, provider, commandOptions);
    if (action) {
      armGateControl(provider, input, action, stateOptions);
      return allowResult();
    }
    if (provider === "codex" && codexInspectionAction(input, state, commandOptions)) {
      return allowResult();
    }
    if (toolKind === "read" || toolKind === "harness") {
      return allowResult();
    }
    if (toolKind === "shell" && classifyShellCommand(input?.tool_input?.command) === "read") {
      return allowResult();
    }
    if (toolKind === "network" && env.COMPREHENSION_GATE_ALLOW_NETWORK_INSPECTION === "1") {
      return allowResult();
    }

    const gate = checkGate(provider, input, stateOptions);
    if (gate.satisfied) {
      return allowResult();
    }

    return denyResult(
      mode,
      denialReason(gate.reason, toolKind, provider, commandOptions, input?.cwd)
    );
  } catch (error) {
    const detail = error instanceof GateStateError ? error.message : "Gate state could not be verified.";
    if (isStartEvent) {
      return blockingErrorResult(
        `Comprehension Gate could not initialize for this session. ${detail} The gate remains pending; do not modify the project.`
      );
    }
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

// Unparseable stdin means the event type is unknown too, so no event-specific
// payload can be trusted; a non-zero exit fails closed for every event.
export function malformedInputResult() {
  return blockingErrorResult(
    "Comprehension Gate could not parse hook input and fails closed. Do not modify the project yet."
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

// Exact, case-insensitive match only; stripping characters would let
// "PreToolUse2" or "Pre-Tool-Use" pass as a known event.
function normalizeEvent(event) {
  return String(event ?? "").toLowerCase();
}

function classifyTool(toolName, provider = null) {
  // Exact, case-insensitive match only. Stripping characters would let names
  // such as "Read2" or "@fs/read" collide with allowlisted read-only tools.
  const normalized = String(toolName ?? "").toLowerCase();
  if (READ_ONLY_TOOLS_BY_PROVIDER[provider]?.has(normalized)) {
    return "read";
  }
  if (WRITE_TOOLS.has(normalized)) {
    return "write";
  }
  if (SHELL_TOOLS.has(normalized)) {
    return "shell";
  }
  if (HARNESS_TOOLS_BY_PROVIDER[provider]?.has(normalized)) {
    return "harness";
  }
  if (NETWORK_TOOLS_BY_PROVIDER[provider]?.has(normalized)) {
    return "network";
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

function controlActionFor(input, provider, commandOptions = {}) {
  if (provider === "codex") {
    return codexShellControlAction(input, commandOptions);
  }

  if (classifyTool(input?.tool_name, provider) !== "read") {
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

function codexShellControlAction(input, commandOptions) {
  if (input?.tool_name !== "Bash") {
    return null;
  }
  const command = input?.tool_input?.command;
  if (typeof command !== "string") {
    return null;
  }
  for (const action of CONTROL_ACTIONS) {
    if (command === controlCommand(action, commandOptions)) {
      return action;
    }
  }
  return null;
}

function codexInspectionAction(input, state, commandOptions) {
  if (input?.tool_name !== "Bash") {
    return null;
  }
  const command = input?.tool_input?.command;
  const workspace = normalizeHookWorkspace(input?.cwd);
  if (typeof command !== "string" || !workspace) {
    return null;
  }
  // Pin inspection to the canonical workspace recorded by the last trusted
  // lifecycle event; a per-call cwd may only narrow the readable tree.
  if (state.workspace === null || !isSameOrDescendant(state.workspace, workspace)) {
    return null;
  }

  for (const action of INSPECTION_ACTIONS) {
    const valueCount = inspectionValueCount(action);
    const tokenPattern = "([A-Za-z0-9_-]+)";
    const match = command.match(new RegExp(` ${action} ${tokenPattern}(?: ${tokenPattern}){${valueCount}}$`));
    if (!match) {
      continue;
    }
    const suffix = command.slice(match.index + 1).split(" ");
    const encodedArguments = suffix.slice(1);
    try {
      const decodedWorkspace = decodeInspectionArgument(encodedArguments[0]);
      for (const token of encodedArguments.slice(1)) {
        decodeInspectionArgument(token);
      }
      if (decodedWorkspace !== workspace) {
        continue;
      }
    } catch {
      continue;
    }
    if (command === inspectionCommandFromEncoded(action, encodedArguments, commandOptions)) {
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

function blockingErrorResult(reason) {
  return { exitCode: 2, stdout: "", stderr: `${reason}\n` };
}

function allowResult() {
  return { exitCode: 0, stdout: "", stderr: "" };
}

function denialReason(stateReason, toolKind, provider, commandOptions = {}, cwd) {
  const toolNote = toolKind === "shell"
    ? " This shell command can write, run project code, or needs a shell parser to understand, so it is denied while the gate is pending. Plain inspection commands are available."
    : toolKind === "network"
      ? " Network tools can trigger side effects, so they are denied while the gate is pending unless COMPREHENSION_GATE_ALLOW_NETWORK_INSPECTION=1 is set."
      : toolKind === "other"
        ? " This tool is not on the explicit read-only allowlist, so it is denied while the gate is pending."
        : "";
  const controlInstruction = provider === "codex"
    ? [
        `After mastery, run this exact Codex pass command: ${controlCommand("pass", commandOptions)}`,
        `For a genuinely LOW change only, run this exact Codex LOW bypass command: ${controlCommand("bypass-low", commandOptions)}`
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
    provider === "codex" ? formatCodexInspectionInstructions(cwd, commandOptions) : "",
    toolNote
  ];
  return lines.join(" ").trim();
}

function promptResetContext(provider, commandOptions = {}, cwd) {
  const nativeReadContext = `Comprehension Gate is pending for this user turn. If this message answers a gate question, assess it against the required level and read the exact pass control target with a native file-reading tool only after the answer demonstrates understanding: ${controlTarget("pass")} For a genuinely LOW change only, read this exact bypass target: ${controlTarget("bypass-low")}`;
  if (provider !== "codex") {
    return nativeReadContext;
  }
  return `Comprehension Gate is pending for this user turn. If this message answers a gate question, assess it against the required level and run this exact Codex pass command only after the answer demonstrates understanding: ${controlCommand("pass", commandOptions)} For a genuinely LOW change only, run this exact bypass command: ${controlCommand("bypass-low", commandOptions)} ${formatCodexInspectionInstructions(cwd, commandOptions)}`;
}

function controlCommandOptions(options = {}) {
  return {
    runtime: options.runtime ?? process.execPath,
    entrypoint: options.entrypoint
  };
}

function inspectionCommandFromEncoded(action, encodedArguments, options = {}) {
  return buildPinnedEntrypointCommand(
    options.entrypoint ?? SCRIPT_PATH,
    action,
    options.runtime ?? process.execPath,
    encodedArguments
  );
}

function formatCodexInspectionInstructions(cwd, commandOptions = {}) {
  const workspace = normalizeHookWorkspace(cwd);
  if (!workspace) {
    return "Codex inspection commands are unavailable because the hook did not supply an absolute workspace cwd; remain fail-closed and do not use another shell command.";
  }
  const root = encodeInspectionArgument(workspace);
  const read = inspectionCommandFromEncoded(
    "inspect-read",
    [root, "BASE64URL_PATH"],
    commandOptions
  );
  const search = inspectionCommandFromEncoded(
    "inspect-search",
    [root, "BASE64URL_PATTERN", "BASE64URL_ROOT"],
    commandOptions
  );
  return [
    "Codex may inspect this workspace before pass only through these pinned commands.",
    "Replace each BASE64URL_* placeholder with the unpadded base64url encoding of its UTF-8 value; keep every other byte exact.",
    "Paths and roots must be workspace-relative. Examples: README.md = UkVBRE1FLm1k, auth = YXV0aA, . = Lg.",
    `Read one UTF-8 file:\n${read}`,
    `Search UTF-8 files for a literal string:\n${search}`
  ].join("\n");
}

function isSameOrDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === "") {
    return true;
  }
  return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
}

function normalizeHookWorkspace(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  if (!path.isAbsolute(value)) {
    return null;
  }
  const normalized = path.normalize(value);
  try {
    const canonical = fs.realpathSync(normalized);
    return fs.statSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
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

/*
 * Native read-only tools, keyed by provider: a name proves nothing across
 * hosts, and a Codex extension can present any plain tool name. Only verified
 * built-in names are listed. Codex has no name-based entry at all: it has
 * no native local reader on its hook path and inspects through the pinned
 * bridge commands instead.
 */
const READ_ONLY_TOOLS_BY_PROVIDER = {
  claude: new Set(["glob", "grep", "read"]),
  cursor: new Set(["grep", "read"]),
  kiro: new Set(["fs_read", "read"]),
  // Intentionally empty: a Codex built-in such as view_image can be disabled
  // by feature flag and its name taken over by an extension.
  codex: new Set()
};

/*
 * Host-side tools that cannot mutate the project, keyed by provider because a
 * name proves nothing across hosts (an extension tool may reuse any name).
 * Only verified canonical names are listed; other providers stay
 * deny-by-default until their names are confirmed. Tools that delegate
 * execution are deliberately absent: Skill runs `!command` preprocessing
 * before the model sees it, and Agent/Task can create a git worktree before
 * the subagent's first gated tool call.
 */
const HARNESS_TOOLS_BY_PROVIDER = {
  claude: new Set([
    "askuserquestion",
    "ls",
    "taskcreate",
    "taskget",
    "tasklist",
    "taskupdate",
    "todowrite"
  ])
};

// Denied while pending by default: an HTTP request can have side effects.
// Keyed by provider for the same reason as the read-only list; the opt-in
// only ever covers a host's own built-in network tools.
const NETWORK_TOOLS_BY_PROVIDER = {
  claude: new Set(["webfetch", "websearch"])
};

/*
 * Shell tools run their command through classifyShellCommand on every
 * provider. Unlike the lists above, this is not keyed by provider: those trust
 * a name to mean "read-only", whereas the classifier trusts nothing about the
 * name and reads the command itself. A tool that carries no `command` string
 * fails closed there, so an unfamiliar shell tool is denied rather than
 * waved through.
 */
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
  const [mode = "compatible", ...argumentsAfterMode] = process.argv.slice(2);

  if (CONTROL_ACTIONS.has(mode)) {
    process.stdout.write(`${CONTROL_MARKERS[mode]}\n`);
    return;
  }

  if (INSPECTION_ACTIONS.has(mode)) {
    try {
      runInspection(mode, argumentsAfterMode);
    } catch (error) {
      process.stderr.write(`Comprehension Gate inspection failed: ${error.message}\n`);
      process.exitCode = 2;
    }
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

if (isMainModule(process.argv[1])) {
  await main();
}

function isMainModule(argument) {
  if (typeof argument !== "string" || argument.length === 0) {
    return false;
  }
  try {
    return fs.realpathSync(argument) === fs.realpathSync(SCRIPT_PATH);
  } catch {
    return path.resolve(argument) === path.resolve(SCRIPT_PATH);
  }
}
