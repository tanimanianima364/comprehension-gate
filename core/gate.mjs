/*
 * The hook never interrupts anyone.
 *
 * It refuses no tool, holds no turn, blocks no prompt, and shows the user
 * nothing. Its whole job is to put two things in front of the agent: what to
 * record about a change, and which paths on this branch a record still has to
 * cover. Everything it knows it derives from git when asked, so there is no
 * session state to keep, no baseline to retake, and nothing to clear.
 *
 * That is a deliberate trade. Nothing makes the agent write anything; a host
 * that ignores the injected context leaves no trace behind. The reminder is
 * the only pressure there is.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changedPaths } from "./changes.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const INSTRUCTIONS_PATH = path.join(path.dirname(SCRIPT_PATH), "instructions.md");
const CHANGES_PATH = path.join(path.dirname(SCRIPT_PATH), "changes.mjs");
const MAX_LISTED_PATHS = 10;

/*
 * The instructions carry the exact command that prints the change set, so the
 * manual skill runs this plugin's own code instead of a hand-written git
 * one-liner that would disagree with the hook about renames and about a
 * repository with no remote. Both paths are single-quoted: a plugin installed
 * under a directory with a space or a quote in it must not turn into shell
 * syntax.
 */
export function renderInstructions(options = {}) {
  const runtime = options.runtime ?? process.execPath;
  const entrypoint = options.changes ?? CHANGES_PATH;
  return fs
    .readFileSync(INSTRUCTIONS_PATH, "utf8")
    .replaceAll("{{CHANGE_SET_COMMAND}}", `${quote(runtime)} ${quote(entrypoint)}`);
}

// POSIX single-quoting keeps every byte of a path literal.
function quote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function handleHook(input, mode = "compatible") {
  const event = normalizeEvent(input?.hook_event_name);
  const isPromptEvent = event === "userpromptsubmit" || event === "beforesubmitprompt";
  const isStartEvent = event === "sessionstart" || (mode === "kiro" && event === "agentspawn");
  const isStopEvent = event === "stop" || event === "agentstop";

  if (!isStartEvent && !isPromptEvent && !isStopEvent && event !== "posttooluse" && event !== "pretooluse") {
    return nonBlockingErrorResult(
      `Comprehension Gate received an unrecognized hook event (${JSON.stringify(input?.hook_event_name ?? null)}).`
    );
  }

  if (isStartEvent) {
    const notice = changeNotice(input);
    const context = notice === null ? renderInstructions() : `${renderInstructions()}\n${notice}`;
    return contextResult(mode, "SessionStart", context);
  }

  if (isPromptEvent) {
    const notice = changeNotice(input);
    return notice === null
      ? quietResult(mode, "UserPromptSubmit")
      : contextResult(mode, "UserPromptSubmit", notice);
  }

  if (event === "posttooluse") {
    return toolAllowResult(mode, "PostToolUse");
  }

  if (isStopEvent) {
    return stopAllowResult(mode);
  }

  return toolAllowResult(mode, "PreToolUse");
}

// Unparseable stdin means the event type is unknown too, so no event-specific
// payload can be trusted; a non-zero, non-blocking exit reports this for every event.
export function malformedInputResult() {
  return nonBlockingErrorResult("Comprehension Gate could not parse hook input.");
}

/*
 * A directory that is not a repository, or a repository git cannot be asked
 * about, produces no notice at all rather than a guess.
 */
function changeNotice(input) {
  const changes = changedPaths(hookDirectory(input));
  if (changes === null || changes.paths.length === 0) {
    return null;
  }
  return [
    `Comprehension Gate: this branch has changed ${listPaths(changes.paths)}.`,
    "Account for the change at its level before finishing: a mechanical change needs nothing,",
    "and anything above that needs a short insight about the convention or principle the change touched.",
    "Nothing holds the turn and the user is shown no warning, so this reminder is the only notice you get."
  ].join(" ");
}

function listPaths(paths) {
  const shown = paths.slice(0, MAX_LISTED_PATHS);
  const more = paths.length - shown.length;
  return shown.join(", ") + (more > 0 ? `, and ${more} more` : "");
}

// Exact, case-insensitive match only; stripping characters would let
// "PreToolUse2" or "Pre-Tool-Use" pass as a known event.
function normalizeEvent(event) {
  return String(event ?? "").toLowerCase();
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

// Cursor reads an empty stdout as a hook failure, so a turn with nothing to
// say still has to answer it in the shape that event expects.
function quietResult(mode, eventName) {
  if (mode === "cursor" && eventName === "UserPromptSubmit") {
    return { exitCode: 0, stdout: `${JSON.stringify({ continue: true })}\n`, stderr: "" };
  }
  return allowResult();
}

function nonBlockingErrorResult(reason) {
  return { exitCode: 1, stdout: "", stderr: `${reason}\n` };
}

function allowResult() {
  return { exitCode: 0, stdout: "", stderr: "" };
}

// Cursor's preToolUse is registered failClosed, so an allow must be spelled out there.
function toolAllowResult(mode, eventName) {
  if (mode !== "cursor") {
    return allowResult();
  }
  const output = eventName === "PreToolUse" ? { permission: "allow" } : {};
  return { exitCode: 0, stdout: `${JSON.stringify(output)}\n`, stderr: "" };
}

function stopAllowResult(mode) {
  return mode === "cursor" ? { exitCode: 0, stdout: "{}\n", stderr: "" } : allowResult();
}

// Claude Code, Codex, and Kiro send cwd; Cursor sends workspace_roots. Only
// the first root is watched: the branch a note belongs to is the one being
// worked in, and a second repository has its own notes.
export function hookDirectory(input) {
  if (typeof input?.cwd === "string" && input.cwd !== "") {
    return input.cwd;
  }
  const roots = input?.workspace_roots;
  return Array.isArray(roots) && typeof roots[0] === "string" ? roots[0] : null;
}

export async function main() {
  const [mode = "compatible"] = process.argv.slice(2);

  let stdin = "";
  for await (const chunk of process.stdin) {
    stdin += chunk;
  }

  let result;
  try {
    result = handleHook(JSON.parse(stdin), mode);
  } catch {
    result = malformedInputResult();
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
