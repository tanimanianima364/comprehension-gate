import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_VERSION = 2;
const SATISFIED = new Set(["passed", "bypassed-low"]);
const CONTROL_ACTIONS = new Set(["pass", "bypass-low"]);

export class GateStateError extends Error {}

export function resolveStateDirectory(env = process.env) {
  if (env.COMPREHENSION_GATE_STATE_DIR) {
    return path.resolve(env.COMPREHENSION_GATE_STATE_DIR);
  }

  const pluginData = env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA;
  if (pluginData) {
    return path.join(path.resolve(pluginData), "state");
  }

  if (env.XDG_STATE_HOME) {
    return path.join(path.resolve(env.XDG_STATE_HOME), "comprehension-gate");
  }

  if (process.platform === "win32" && env.LOCALAPPDATA) {
    return path.join(path.resolve(env.LOCALAPPDATA), "comprehension-gate", "state");
  }

  return path.join(os.homedir(), ".local", "state", "comprehension-gate");
}

export function stateFilePath(provider, input, options = {}) {
  const sessionId = getSessionId(input);
  const digest = createHash("sha256")
    .update(`${provider}\0${sessionId}`)
    .digest("hex");
  return path.join(resolveStateDirectory(options.env), `${digest}.json`);
}

export function readGateState(provider, input, options = {}) {
  const filePath = stateFilePath(provider, input, options);
  const filesystem = options.fs ?? fs;

  let raw;
  try {
    raw = filesystem.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: false, reason: "missing", filePath };
    }
    return { ok: false, reason: "unreadable", filePath, error };
  }

  try {
    const state = JSON.parse(raw);
    if (!isValidState(state)) {
      return { ok: false, reason: "invalid", filePath };
    }
    return { ok: true, state, filePath };
  } catch (error) {
    return { ok: false, reason: "invalid", filePath, error };
  }
}

export function resetGate(provider, input, options = {}) {
  const previous = readGateState(provider, input, options);
  const requestSequence = previous.ok ? previous.state.requestSequence + 1 : 1;
  const state = {
    version: STATE_VERSION,
    status: "pending",
    requestSequence,
    turnId: getTurnId(input),
    armedControl: null,
    updatedAt: new Date().toISOString()
  };

  /*
   * Invalidate an existing state before the atomic replacement. If a later
   * mkdir/temp/rename step fails, readers see pending or invalid JSON rather
   * than a stale pass from the preceding request.
   */
  if (previous.ok) {
    overwriteGateState(provider, input, state, options);
  }
  writeGateState(provider, input, state, options);
  return state;
}

export function ensureGateState(provider, input, options = {}) {
  const current = readGateState(provider, input, options);
  if (current.ok) {
    return current.state;
  }
  if (current.reason === "missing") {
    return resetGate(provider, input, options);
  }
  throw new GateStateError(`Gate state is ${current.reason}.`);
}

export function satisfyGate(provider, input, action, options = {}) {
  assertControlAction(action);
  const current = readGateState(provider, input, options);
  if (!current.ok) {
    throw new GateStateError(`Gate state is ${current.reason}.`);
  }
  if (!matchesCurrentTurn(current.state, input)) {
    throw new GateStateError("Gate state belongs to a different turn.");
  }

  const status = action === "pass" ? "passed" : "bypassed-low";
  const state = {
    ...current.state,
    status,
    level: action === "pass" ? current.state.level ?? null : "low",
    armedControl: null,
    updatedAt: new Date().toISOString()
  };
  writeGateState(provider, input, state, options);
  return state;
}

export function armGateControl(provider, input, action, options = {}) {
  assertControlAction(action);
  const current = requireCurrentState(provider, input, options);
  const state = {
    ...current,
    armedControl: {
      action,
      toolUseId: getToolUseId(input)
    },
    updatedAt: new Date().toISOString()
  };
  writeGateState(provider, input, state, options);
  return state;
}

export function completeGateControl(provider, input, action, options = {}) {
  assertControlAction(action);
  const current = requireCurrentState(provider, input, options);
  if (!matchesArmedControl(current.armedControl, input, action)) {
    throw new GateStateError("Control command was not armed for this tool use.");
  }

  const status = action === "pass" ? "passed" : "bypassed-low";
  const state = {
    ...current,
    status,
    level: action === "pass" ? current.level ?? null : "low",
    armedControl: null,
    updatedAt: new Date().toISOString()
  };
  writeGateState(provider, input, state, options);
  return state;
}

export function clearGateControl(provider, input, action, options = {}) {
  assertControlAction(action);
  const current = requireCurrentState(provider, input, options);
  if (!matchesArmedControl(current.armedControl, input, action)) {
    return current;
  }

  const state = {
    ...current,
    armedControl: null,
    updatedAt: new Date().toISOString()
  };
  writeGateState(provider, input, state, options);
  return state;
}

export function checkGate(provider, input, options = {}) {
  const current = readGateState(provider, input, options);
  if (!current.ok) {
    return { satisfied: false, reason: current.reason };
  }
  if (!matchesCurrentTurn(current.state, input)) {
    return { satisfied: false, reason: "turn-mismatch", state: current.state };
  }
  return {
    satisfied: SATISFIED.has(current.state.status),
    reason: current.state.status,
    state: current.state
  };
}

function writeGateState(provider, input, state, options) {
  const filePath = stateFilePath(provider, input, options);
  const directory = path.dirname(filePath);
  const filesystem = options.fs ?? fs;
  filesystem.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  filesystem.writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });

  try {
    filesystem.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (process.platform !== "win32") {
      safeUnlink(filesystem, temporaryPath);
      throw error;
    }
    filesystem.copyFileSync(temporaryPath, filePath);
    safeUnlink(filesystem, temporaryPath);
  }
}

function overwriteGateState(provider, input, state, options) {
  const filesystem = options.fs ?? fs;
  filesystem.writeFileSync(
    stateFilePath(provider, input, options),
    `${JSON.stringify(state)}\n`,
    { encoding: "utf8", flag: "w", mode: 0o600 }
  );
}

function getSessionId(input) {
  const sessionId = input?.session_id ?? input?.conversation_id;
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new GateStateError("Hook input is missing session_id/conversation_id.");
  }
  return sessionId;
}

function getTurnId(input) {
  const turnId = input?.turn_id ?? input?.generation_id;
  return typeof turnId === "string" && turnId !== ""
    ? turnId
    : null;
}

function getToolUseId(input) {
  const toolUseId = input?.tool_use_id;
  return typeof toolUseId === "string" && toolUseId !== ""
    ? toolUseId
    : null;
}

function requireCurrentState(provider, input, options) {
  const current = readGateState(provider, input, options);
  if (!current.ok) {
    throw new GateStateError(`Gate state is ${current.reason}.`);
  }
  if (!matchesCurrentTurn(current.state, input)) {
    throw new GateStateError("Gate state belongs to a different turn.");
  }
  return current.state;
}

function matchesArmedControl(armedControl, input, action) {
  return (
    armedControl?.action === action &&
    armedControl.toolUseId === getToolUseId(input)
  );
}

function assertControlAction(action) {
  if (!CONTROL_ACTIONS.has(action)) {
    throw new GateStateError(`Unknown control action: ${action}`);
  }
}

function matchesCurrentTurn(state, input) {
  const inputTurnId = getTurnId(input);
  if (state.turnId === null && inputTurnId === null) {
    return true;
  }
  return state.turnId === inputTurnId;
}

function isValidState(state) {
  return (
    state?.version === STATE_VERSION &&
    typeof state.status === "string" &&
    Number.isInteger(state.requestSequence) &&
    state.requestSequence > 0 &&
    (state.turnId === null || typeof state.turnId === "string") &&
    (
      state.armedControl === null ||
      (
        CONTROL_ACTIONS.has(state.armedControl?.action) &&
        (
          state.armedControl.toolUseId === null ||
          typeof state.armedControl.toolUseId === "string"
        )
      )
    )
  );
}

function safeUnlink(filesystem, filePath) {
  try {
    filesystem.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup only.
  }
}
