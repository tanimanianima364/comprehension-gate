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
import { NOTES_DIRECTORY, uncoveredPaths } from "./notes.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const INSTRUCTIONS_PATH = path.join(path.dirname(SCRIPT_PATH), "instructions.md");
const CHANGES_PATH = path.join(path.dirname(SCRIPT_PATH), "changes.mjs");
const MAX_LISTED_PATHS = 10;
const INCOMPLETE_NOTICE =
  "Comprehension Gate: part of the change set could not be collected, so nothing can be said about what it holds. Treat the branch as having changes that are not listed rather than as unchanged.";

/*
 * The instructions carry the exact command that prints the change set, so the
 * manual skill runs this plugin's own code instead of a hand-written git
 * one-liner that would disagree with the hook about renames and about a
 * repository with no remote.
 *
 * It is spelled for two shells because quoting is not portable: PowerShell
 * needs the call operator before a quoted executable or it reads the line as a
 * string, and it escapes a single quote by doubling it where a POSIX shell
 * closes and reopens the quoting. A plugin installed under a directory with a
 * space or a quote in its name must run on both.
 *
 * The substitution goes through a function rather than a replacement string:
 * `$&` and friends in a replacement string are patterns, not text, so a plugin
 * path containing them would have the placeholder spliced back into itself.
 */
export function renderInstructions(options = {}) {
  const runtime = options.runtime ?? process.execPath;
  const entrypoint = options.changes ?? CHANGES_PATH;
  const command = [
    `POSIX shell: ${posixQuote(runtime)} ${posixQuote(entrypoint)}`,
    `PowerShell: & ${powerShellQuote(runtime)} ${powerShellQuote(entrypoint)}`
  ].join("\n");
  return fs
    .readFileSync(INSTRUCTIONS_PATH, "utf8")
    .replaceAll("{{CHANGE_SET_COMMAND}}", () => command);
}

// POSIX single-quoting keeps every byte of a path literal.
function posixQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/*
 * PowerShell single-quoting is literal too, and doubles a quote to escape it --
 * but it recognizes four more characters as single quotes than the ASCII one,
 * and any of them ends the string. A plugin under a directory named with a
 * typographic apostrophe would otherwise terminate its own argument.
 */
const POWERSHELL_QUOTES = /['\u2018\u2019\u201a\u201b]/g;

function powerShellQuote(value) {
  return `'${value.replaceAll(POWERSHELL_QUOTES, match => match + match)}'`;
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
 * about, produces no notice at all rather than a guess. Neither does a branch
 * whose every changed path is already covered by a note.
 */
function changeNotice(input) {
  const changes = changedPaths(hookDirectory(input));
  if (changes === null) {
    return null;
  }
  /*
   * Silence has to mean "everything is recorded", so it is only reached when
   * the whole change set was collected. A half that could not be read is not an
   * empty half, and is not a covered one either: saying nothing about it would
   * report an unread change as an accounted-for one.
   */
  if (changes.paths.length === 0) {
    return changes.complete ? null : INCOMPLETE_NOTICE;
  }
  const uncovered = uncoveredPaths(changes.root, changes.paths);
  /*
   * Silence has to mean "everything is recorded", so it is only reached when
   * the whole change set was collected. A half that could not be read leaves a
   * list that is short of something, and saying nothing about it would report
   * an unrecorded change as an accounted-for one.
   */
  if (uncovered.length === 0) {
    return changes.complete ? null : INCOMPLETE_NOTICE;
  }
  const short = changes.complete
    ? ""
    : " Part of the change set could not be collected, so this list is short of something.";
  return [
    `Comprehension Gate: no note on this branch records why these paths changed: ${listPaths(uncovered)}.${short}`,
    `Write one under ${NOTES_DIRECTORY}/ covering them, and leave the docstrings on what you changed`,
    "saying what each file and function is for and why it works the way it does.",
    "A purely mechanical change needs no note and can stay listed here.",
    "Nothing holds the turn and the user is shown no warning, so this reminder is the only notice you get."
  ].join(" ");
}

/*
 * Paths are quoted rather than run together with commas. A path is
 * repository-controlled text: it may contain a newline, a quote, or something
 * shaped like an instruction, and the reminder is prose injected into an
 * agent's context. Quoting bounds each one and escapes what would otherwise
 * become a line of its own.
 */
function listPaths(paths) {
  const shown = paths.slice(0, MAX_LISTED_PATHS).map(displayPath);
  const more = paths.length - shown.length;
  return shown.join(", ") + (more > 0 ? `, and ${more} more` : "");
}

// JSON escapes quotes, backslashes and control characters; the two Unicode
// line separators are legal inside a JSON string, so they are escaped here.
function displayPath(value) {
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
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

  /*
   * Collected as bytes and decoded once. Appending each chunk to a string
   * decodes that chunk on its own, so a character straddling a read boundary
   * becomes two broken halves before the payload is ever parsed.
   */
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  let result;
  try {
    result = handleHook(JSON.parse(Buffer.concat(chunks).toString("utf8")), mode);
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
