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
  markOutstanding,
  readGateState,
  recordBaseline,
  resetGate
} from "./state.mjs";
import { buildPinnedEntrypointCommand } from "./command.mjs";
import { captureSnapshot, findRepository, snapshotDifference } from "./snapshot.mjs";

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
        ? "In Codex, run the command exactly as shown. Do not add whitespace, arguments, wrappers, or different quoting."
        : "Read the path exactly as shown with the host's native file-reading tool. Do not use a shell command to read it."
    );
}

export function handleHook(input, mode = "compatible", options = {}) {
  const env = options.env ?? process.env;
  const stateOptions = { env, fs: options.fs };
  const commandOptions = controlCommandOptions(options);
  const provider = detectProvider(mode, env);
  const event = normalizeEvent(input?.hook_event_name);
  // Only trusted lifecycle events may record the workspace the gate tracks.
  const trustedReset = { workspace: normalizeHookWorkspace(hookDirectory(input)) };
  const isPromptEvent = event === "userpromptsubmit" || event === "beforesubmitprompt";
  const isStartEvent = event === "sessionstart" || (mode === "kiro" && event === "agentspawn");
  const isStopEvent = event === "stop" || event === "agentstop";

  if (!isStartEvent && !isPromptEvent && !isStopEvent && event !== "posttooluse" && event !== "pretooluse") {
    return nonBlockingErrorResult(
      `Comprehension Gate received an unrecognized hook event (${JSON.stringify(input?.hook_event_name ?? null)}).`
    );
  }

  try {
    if (isStartEvent) {
      const source = String(input?.source ?? "startup").toLowerCase();
      const current = readGateState(provider, input, stateOptions);
      if (source !== "compact" || !current.ok) {
        resetGate(provider, input, stateOptions, { ...trustedReset, baseline: null, outstanding: false, changes: [] });
        const snapshot = snapshotOf(input, trustedReset.workspace);
        if (snapshot) {
          recordBaseline(provider, input, snapshot, stateOptions);
        }
      }
      return contextResult(mode, "SessionStart", renderInstructions(provider, commandOptions));
    }

    if (isPromptEvent) {
      const state = resetGate(provider, input, stateOptions, trustedReset);
      if (!state.outstanding) {
        const snapshot = snapshotOf(input, state.workspace);
        if (snapshot) {
          recordBaseline(provider, input, snapshot, stateOptions);
        }
      }
      return contextResult(mode, "UserPromptSubmit", promptContext(provider, state, commandOptions));
    }

    if (event === "posttooluse") {
      const action = controlActionFor(input, provider, commandOptions);
      if (action) {
        if (controlTransitionSucceeded(input, provider, action)) {
          completeGateControl(provider, input, action, stateOptions);
          const snapshot = snapshotOf(input, readGateState(provider, input, stateOptions).state?.workspace);
          if (snapshot) {
            recordBaseline(provider, input, snapshot, stateOptions);
          }
        } else {
          clearGateControl(provider, input, action, stateOptions);
        }
      }
      return allowResult();
    }

    if (isStopEvent) {
      const state = ensureGateState(provider, input, stateOptions);
      // A Stop payload without a turn id must still be matched to the state
      // it belongs to, or every state call below throws "different turn" and
      // the gate silently allows instead of holding.
      const hasTurnId = typeof input?.turn_id === "string" && input.turn_id !== ""
        || typeof input?.generation_id === "string" && input.generation_id !== ""
        || typeof input?.prompt_id === "string" && input.prompt_id !== "";
      const turnInput = !hasTurnId && state.turnId !== null ? { ...input, prompt_id: state.turnId } : input;
      const snapshot = snapshotOf(input, state.workspace);
      if (!snapshot) {
        return stopAllowResult(mode);
      }
      if (state.baseline === null) {
        recordBaseline(provider, turnInput, snapshot, stateOptions);
        return stopAllowResult(mode);
      }
      const changes = snapshotDifference(state.baseline, snapshot);
      if (changes.length === 0) {
        return stopAllowResult(mode);
      }
      if (checkGate(provider, turnInput, stateOptions).satisfied) {
        recordBaseline(provider, turnInput, snapshot, stateOptions);
        return stopAllowResult(mode);
      }
      markOutstanding(provider, turnInput, changes, stateOptions);
      return stopHoldResult(mode, input, holdReason(changes, provider, commandOptions), userNotice(changes));
    }

    ensureGateState(provider, input, stateOptions);
    const action = controlActionFor(input, provider, commandOptions);
    if (action) {
      armGateControl(provider, input, action, stateOptions);
    }
    return allowResult();
  } catch (error) {
    const detail = error instanceof GateStateError ? error.message : "Gate state could not be verified.";
    if (isStartEvent) {
      return blockingErrorResult(
        `Comprehension Gate could not initialize for this session. ${detail} Changes made in this session will not be checked.`
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
    if (isStopEvent) {
      return stopErrorResult(mode, `Comprehension Gate could not check the project for changes. ${detail}`);
    }
    return allowResult();
  }
}

// Unparseable stdin means the event type is unknown too, so no event-specific
// payload can be trusted; a non-zero, non-blocking exit reports this for every event.
export function malformedInputResult() {
  return nonBlockingErrorResult("Comprehension Gate could not parse hook input.");
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

function isControlReadTool(toolName, provider) {
  return CONTROL_READ_TOOLS_BY_PROVIDER[provider]?.has(String(toolName ?? "").toLowerCase()) ?? false;
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

  if (!isControlReadTool(input?.tool_name, provider)) {
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

function nonBlockingErrorResult(reason) {
  return { exitCode: 1, stdout: "", stderr: `${reason}\n` };
}

function allowResult() {
  return { exitCode: 0, stdout: "", stderr: "" };
}

// A snapshot that cannot be taken (corrupt index, git timeout, missing
// binary) is treated as "not a repository" for this event, so a git failure
// never fails closed at SessionStart, UserPromptSubmit, or Stop.
function snapshotOf(input, workspace) {
  try {
    const repository = findRepository(hookDirectory(input) ?? workspace ?? "");
    return repository ? captureSnapshot(repository) : null;
  } catch {
    return null;
  }
}

function stopAllowResult(mode) {
  return mode === "cursor" ? { exitCode: 0, stdout: "{}\n", stderr: "" } : allowResult();
}

/*
 * Only Claude Code can hold the turn. It is held once: the agent's question
 * ends the turn, and that second Stop carries stop_hook_active, which must be
 * allowed or the agent could never ask. Cursor cannot hold but can submit a
 * follow-up, once per turn and never after an abort. Kiro can only warn.
 */
function stopHoldResult(mode, input, reason, notice) {
  if (mode === "kiro") {
    return { exitCode: 1, stdout: "", stderr: `${reason}\n` };
  }
  if (mode === "cursor") {
    const loops = Number(input?.loop_count ?? 0);
    const hold = input?.status === "completed" && loops === 0;
    return { exitCode: 0, stdout: `${JSON.stringify(hold ? { followup_message: reason } : {})}\n`, stderr: "" };
  }
  if (input?.stop_hook_active === true) {
    return { exitCode: 0, stdout: `${JSON.stringify({ systemMessage: notice })}\n`, stderr: "" };
  }
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({ decision: "block", reason, systemMessage: notice })}\n`,
    stderr: ""
  };
}

// A failing check must not hold a turn forever, so it reports and allows.
function stopErrorResult(mode, message) {
  if (mode === "kiro") {
    return { exitCode: 1, stdout: "", stderr: `${message}\n` };
  }
  if (mode === "cursor") {
    return { exitCode: 0, stdout: "{}\n", stderr: `${message}\n` };
  }
  return { exitCode: 0, stdout: `${JSON.stringify({ systemMessage: message })}\n`, stderr: "" };
}

function holdReason(changes, provider, commandOptions = {}) {
  const controls = provider === "codex"
    ? `run this exact pass command: ${controlCommand("pass", commandOptions)} For a genuinely LOW change only, run this exact LOW bypass command: ${controlCommand("bypass-low", commandOptions)}`
    : `read this exact pass control target with a native file-reading tool: ${controlTarget("pass")} For a genuinely LOW change only, read this exact LOW bypass target: ${controlTarget("bypass-low")}`;
  return [
    "Comprehension Gate: the project changed during this turn and the change has not been explained.",
    `Changed: ${listChanges(changes)}.`,
    "Before finishing, classify the change (LOW is mechanical; MEDIUM requires Explain; HIGH requires Explain + Why + Predict; CRITICAL also requires Transfer) and ask the user to explain it at the required level in their own words.",
    `After the user demonstrates understanding, ${controls}`,
    "Do not revert or relocate the change to avoid the question."
  ].join(" ");
}

function userNotice(changes) {
  return `Comprehension Gate: an unexplained change remains in the project (${listChanges(changes)}). The agent should ask you to explain it before continuing.`;
}

function listChanges(changes) {
  const shown = changes.slice(0, 10);
  const more = changes.length - shown.length;
  return shown.join(", ") + (more > 0 ? `, and ${more} more` : "");
}

function promptContext(provider, state, commandOptions = {}) {
  const controls = provider === "codex"
    ? `run this exact pass command only after the answer demonstrates understanding: ${controlCommand("pass", commandOptions)} For a genuinely LOW change only, run this exact bypass command: ${controlCommand("bypass-low", commandOptions)}`
    : `read the exact pass control target with a native file-reading tool only after the answer demonstrates understanding: ${controlTarget("pass")} For a genuinely LOW change only, read this exact bypass target: ${controlTarget("bypass-low")}`;
  if (state.outstanding) {
    return `Comprehension Gate: an unexplained change from an earlier turn is outstanding (${listChanges(state.changes)}). If this message explains it, assess the explanation against the required level and ${controls} Otherwise, ask for the explanation before doing anything else.`;
  }
  return `Comprehension Gate applies to this turn. If this message answers a gate question, assess it and ${controls} If the project changes during this turn, ask the user to explain the change before finishing.`;
}

function controlCommandOptions(options = {}) {
  return {
    runtime: options.runtime ?? process.execPath,
    entrypoint: options.entrypoint
  };
}

// Claude Code, Codex, and Kiro send cwd; Cursor sends workspace_roots.
export function hookDirectory(input) {
  if (typeof input?.cwd === "string" && input.cwd !== "") {
    return input.cwd;
  }
  const roots = input?.workspace_roots;
  return Array.isArray(roots) && typeof roots[0] === "string" ? roots[0] : null;
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

/*
 * Tools that may arm a control marker, keyed by provider. This is not a
 * permission list -- every tool is allowed to run -- and it has exactly one
 * job: naming the native local file reads whose reading of a plugin-owned
 * marker counts as pass or LOW bypass.
 *
 * Nothing else belongs here even if it is harmless to run. A network fetch is
 * allowed, but it must not be able to arm a control: given a `path` naming
 * the marker and a response body containing it, it would satisfy the gate
 * without ever reading the file. A name proves nothing across hosts either,
 * so only verified built-ins are listed; Codex has no entry at all, because a
 * built-in such as view_image can be disabled by feature flag and its name
 * taken over by an extension, and it uses the pinned shell bridge instead.
 */
const CONTROL_READ_TOOLS_BY_PROVIDER = {
  claude: new Set(["glob", "grep", "read"]),
  cursor: new Set(["grep", "read"]),
  kiro: new Set(["fs_read", "read"]),
  codex: new Set()
};

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
