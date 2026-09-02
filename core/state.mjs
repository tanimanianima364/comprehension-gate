import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_VERSION = 5;
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

  return path.join(os.homedir(), ".local", "state", "comprehension-gate");
}

export function stateFilePath(provider, input, options = {}) {
  const sessionId = getSessionId(input, options.env ?? process.env);
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

/*
 * overrides.workspace is the canonical workspace recorded by a trusted
 * lifecycle event (SessionStart / prompt submit). Resets triggered from
 * PreToolUse must pass the previously recorded value (or null) so a hook
 * cwd can never become the pin on its own.
 */
export function resetGate(provider, input, options = {}, overrides = {}) {
  const previous = readGateState(provider, input, options);
  const inherited = previous.ok ? previous.state : null;
  const state = {
    version: STATE_VERSION,
    status: "pending",
    requestSequence: inherited ? inherited.requestSequence + 1 : 1,
    turnId: getTurnId(input),
    workspace: overrides.workspace ?? null,
    baseline: Object.hasOwn(overrides, "baseline") ? overrides.baseline : inherited?.baseline ?? null,
    outstanding: Object.hasOwn(overrides, "outstanding") ? overrides.outstanding : inherited?.outstanding ?? false,
    changes: Object.hasOwn(overrides, "changes") ? overrides.changes : inherited?.changes ?? [],
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
      // that should have reset the gate was skipped, so reset now, keeping
      // the workspace recorded by the last trusted lifecycle event.
      return resetGate(provider, input, options, { workspace: current.state.workspace });
    }
    const state = current.state;
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
    return resetGate(provider, input, options, { workspace: null });
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

const MAX_RECORDED_CHANGES = 50;

export function recordBaseline(provider, input, baseline, options = {}) {
  const current = requireCurrentState(provider, input, options);
  const state = { ...current, baseline, outstanding: false, changes: [], updatedAt: new Date().toISOString() };
  writeGateState(provider, input, state, options);
  return state;
}

export function markOutstanding(provider, input, changes, options = {}) {
  const current = requireCurrentState(provider, input, options);
  const state = {
    ...current,
    outstanding: true,
    changes: changes.slice(0, MAX_RECORDED_CHANGES),
    updatedAt: new Date().toISOString()
  };
  writeGateState(provider, input, state, options);
  return state;
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
    safeUnlink(filesystem, temporaryPath);
    throw error;
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

/*
 * Kiro CLI 2.x puts no session identity in the hook payload; it exposes
 * KIRO_SESSION_ID in the hook process environment instead. Verified against
 * 2.16.2, where every trigger's payload carries only hook_event_name, cwd, and
 * the tool fields.
 */
function getSessionId(input, env = {}) {
  const sessionId = input?.session_id ?? input?.conversation_id ?? env?.KIRO_SESSION_ID;
  if (typeof sessionId !== "string" || sessionId.trim() === "") {
    throw new GateStateError("Hook input is missing session_id/conversation_id, and KIRO_SESSION_ID is not set in the hook environment.");
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
    (state.workspace === null || typeof state.workspace === "string") &&
    (state.baseline === null || (typeof state.baseline === "object" && typeof state.baseline.worktrees === "object")) &&
    typeof state.outstanding === "boolean" &&
    Array.isArray(state.changes)
  );
}

function safeUnlink(filesystem, filePath) {
  try {
    filesystem.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup only.
  }
}
