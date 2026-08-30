import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { latestHumanPrompt } from "./transcript.mjs";

const STATE_VERSION = 3;
const SATISFIED = new Set(["passed", "bypassed-low"]);
export const CONTROL_ACTIONS = new Set(["pass", "bypass-low"]);

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
    promptRecord: getPromptRecord(input, options),
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
  removeArmedControls(provider, input, options);
  return state;
}

export function ensureGateState(provider, input, options = {}) {
  const current = readGateState(provider, input, options);
  if (current.ok) {
    if (isNewerTurn(current.state, input)) {
      // The host reports a turn the state has never seen: the prompt hook
      // that should have reset the gate was skipped, so reset now.
      return resetGate(provider, input, options);
    }
    const state = reconcilePromptRecord(provider, input, current.state, options);
    if (canAdoptTurn(state, input)) {
      const adopted = {
        ...state,
        turnId: getTurnId(input),
        updatedAt: new Date().toISOString()
      };
      writeGateState(provider, input, adopted, options);
      return adopted;
    }
    return state;
  }
  if (current.reason === "missing") {
    return resetGate(provider, input, options);
  }
  throw new GateStateError(`Gate state is ${current.reason}.`);
}

/*
 * Armed controls live in one file per tool use rather than in a slot of the
 * shared state file. Parallel hook processes therefore never read-modify-write
 * the same record, so arming one control cannot erase another. Each record is
 * bound to the request sequence it was armed in; a reset invalidates it.
 */
export function armGateControl(provider, input, action, options = {}) {
  assertControlAction(action);
  const current = requireCurrentState(provider, input, options);
  const armed = {
    action,
    toolUseId: getToolUseId(input),
    requestSequence: current.requestSequence
  };
  writeJsonAtomically(armedControlPath(provider, input, action, options), armed, options);
  return current;
}

export function completeGateControl(provider, input, action, options = {}) {
  assertControlAction(action);
  const current = requireCurrentState(provider, input, options);
  const armedPath = armedControlPath(provider, input, action, options);
  if (SATISFIED.has(current.status)) {
    // First completion wins; a parallel control that also succeeded is a no-op.
    safeUnlink(options.fs ?? fs, armedPath);
    return current;
  }
  if (!matchesArmedControl(readArmedControl(armedPath, options), current, input, action)) {
    throw new GateStateError("Control command was not armed for this tool use.");
  }

  const status = action === "pass" ? "passed" : "bypassed-low";
  const state = {
    ...current,
    status,
    level: action === "pass" ? current.level ?? null : "low",
    updatedAt: new Date().toISOString()
  };
  writeGateState(provider, input, state, options);
  safeUnlink(options.fs ?? fs, armedPath);
  return state;
}

export function clearGateControl(provider, input, action, options = {}) {
  assertControlAction(action);
  const current = requireCurrentState(provider, input, options);
  if (getToolUseId(input) === null) {
    // Without a tool_use_id the record is shared per action; clearing it
    // would also drop a parallel control that succeeded. Leave it for reset.
    return current;
  }
  const armedPath = armedControlPath(provider, input, action, options);
  if (matchesArmedControl(readArmedControl(armedPath, options), current, input, action)) {
    safeUnlink(options.fs ?? fs, armedPath);
  }
  return current;
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
  writeJsonAtomically(stateFilePath(provider, input, options), state, options);
}

/*
 * One record per tool use. Hosts that omit tool_use_id fall back to one
 * record per action, so distinct actions still cannot clobber each other and
 * identical actions write identical records.
 */
function armedControlPath(provider, input, action, options) {
  const toolUseId = getToolUseId(input);
  const key = toolUseId === null ? `action:${action}` : `tool-use:${toolUseId}`;
  const keyDigest = createHash("sha256").update(key).digest("hex");
  return `${stateFilePath(provider, input, options)}.armed.${keyDigest}`;
}

function readArmedControl(armedPath, options) {
  const filesystem = options.fs ?? fs;
  try {
    return JSON.parse(filesystem.readFileSync(armedPath, "utf8"));
  } catch {
    return null;
  }
}

function removeArmedControls(provider, input, options) {
  const filesystem = options.fs ?? fs;
  const filePath = stateFilePath(provider, input, options);
  const prefix = `${path.basename(filePath)}.armed.`;
  let entries;
  try {
    entries = filesystem.readdirSync(path.dirname(filePath));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(prefix)) {
      safeUnlink(filesystem, path.join(path.dirname(filePath), entry));
    }
  }
}

function writeJsonAtomically(filePath, value, options) {
  const directory = path.dirname(filePath);
  const filesystem = options.fs ?? fs;
  filesystem.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  filesystem.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, {
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

// Codex turn_id, Cursor generation_id, Claude Code prompt_id (2.1.196+).
function getTurnId(input) {
  const turnId = input?.turn_id ?? input?.generation_id ?? input?.prompt_id;
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

function matchesArmedControl(armedControl, state, input, action) {
  return (
    armedControl?.action === action &&
    armedControl.toolUseId === getToolUseId(input) &&
    armedControl.requestSequence === state.requestSequence
  );
}

function assertControlAction(action) {
  if (!CONTROL_ACTIONS.has(action)) {
    throw new GateStateError(`Unknown control action: ${action}`);
  }
}

/*
 * A pending state seeded by an event without a turn id (for example a Cursor
 * sessionStart) would otherwise never match a later preToolUse that carries
 * one, leaving the turn unable to pass. Adopt the first turn id only while
 * the gate is still pending; completion still requires the adopted turn.
 */
function canAdoptTurn(state, input) {
  return (
    state.status === "pending" &&
    state.turnId === null &&
    getTurnId(input) !== null
  );
}

/*
 * Hosts without a turn id (Claude Code) rely on the prompt hook to reset the
 * gate. Each reset records the identity of the latest human prompt record in
 * the transcript; if the prompt hook was skipped or timed out, PreToolUse sees
 * a newer record and resets to pending instead of inheriting the pass.
 *
 * This is the fallback for hosts that provide no turn id at all (Claude Code
 * before prompt_id existed). Policy when the transcript cannot be judged
 * (missing, unreadable, or no recognizable prompt record): a satisfied gate
 * returns to pending, and the re-pass sticks only until a record becomes
 * judgeable again, at which point it is reset because it cannot be tied to
 * the current prompt. A pending gate with no record adopts the first record
 * it can see.
 */
function reconcilePromptRecord(provider, input, state, options) {
  if (state.turnId !== null || typeof input?.transcript_path !== "string" || input.transcript_path === "") {
    return state;
  }
  const record = latestHumanPrompt(input.transcript_path, options.fs ?? fs);
  if (record === state.promptRecord) {
    return state;
  }
  if (record === null) {
    return SATISFIED.has(state.status) ? resetGate(provider, input, options) : state;
  }
  if (state.promptRecord === null && !SATISFIED.has(state.status)) {
    const adopted = { ...state, promptRecord: record, updatedAt: new Date().toISOString() };
    writeGateState(provider, input, adopted, options);
    return adopted;
  }
  // Either a newer record, or a pass granted while nothing was judgeable:
  // in both cases the pass cannot be tied to the current prompt.
  return resetGate(provider, input, options);
}

function getPromptRecord(input, options) {
  if (typeof input?.transcript_path !== "string" || input.transcript_path === "") {
    return null;
  }
  return latestHumanPrompt(input.transcript_path, options.fs ?? fs);
}

function isNewerTurn(state, input) {
  const inputTurnId = getTurnId(input);
  return state.turnId !== null && inputTurnId !== null && state.turnId !== inputTurnId;
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
    (state.promptRecord === null || typeof state.promptRecord === "string")
  );
}

function safeUnlink(filesystem, filePath) {
  try {
    filesystem.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup only.
  }
}
