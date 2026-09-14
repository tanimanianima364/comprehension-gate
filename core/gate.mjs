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
import { changedPaths, encodePath, repositoryRoot } from "./changes.mjs";
import { NOTES_DIRECTORY, notesCovering, uncoveredPaths } from "./notes.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const INSTRUCTIONS_PATH = path.join(path.dirname(SCRIPT_PATH), "instructions.md");
const CHANGES_PATH = path.join(path.dirname(SCRIPT_PATH), "changes.mjs");
const MAX_LISTED_PATHS = 10;
const INCOMPLETE_NOTICE =
  "Intent Notes: part of the change set could not be collected, so nothing can be said about what it holds. Treat the branch as having changes that are not listed rather than as unchanged.";
// "stop" is no longer registered -- it had nothing left to do once the hosts
// that could only be warned there were dropped -- but an installed copy that
// still carries the old configuration must be answered rather than told its
// event is unrecognized.
const KNOWN_EVENTS = new Set([
  "sessionstart",
  "userpromptsubmit",
  "pretooluse",
  "posttooluse",
  "stop"
]);
/*
 * Whether a tool reads or writes a file, guessed from its name. A name proves
 * nothing across hosts, which is why the old control protocol refused to trust
 * one -- but that decision gated the gate, and this one only decides whether
 * to offer a hint. Being wrong costs a missing hint or a harmless one, so a
 * pattern that catches every host's spelling beats a list that misses new
 * ones.
 */
const WRITING_TOOL = /write|edit|patch|create|update|append|insert|delete|remove|move|rename/i;
const READING_TOOL = /read|view|open|cat|inspect|grep|search/i;
const TOOL_PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "notebookPath"];
const PATCH_TEXT_KEYS = ["command", "patch", "input", "text"];
const PATCH_ENVELOPE = "*** Begin Patch";
const PATCH_TARGET = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE = /^\*\*\* Move to: (.+)$/;

/*
 * The instructions carry the exact command that prints the change set, so the
 * manual skill runs this plugin's own code instead of a hand-written git
 * one-liner that would disagree with the hook about renames and about a
 * repository with no remote.
 *
 * Both paths are single-quoted, POSIX style: a plugin installed under a
 * directory with a space or a quote in its name must not turn into shell
 * syntax. Only a POSIX shell is spelled for -- see the README on why Windows
 * is out of scope.
 *
 * The substitution goes through a function rather than a replacement string:
 * `$&` and friends in a replacement string are patterns, not text, so a plugin
 * path containing them would have the placeholder spliced back into itself.
 */
export function renderInstructions(options = {}) {
  const runtime = options.runtime ?? process.execPath;
  const entrypoint = options.changes ?? CHANGES_PATH;
  const command = `${quote(runtime)} ${quote(entrypoint)}`;
  return fs
    .readFileSync(INSTRUCTIONS_PATH, "utf8")
    .replaceAll("{{CHANGE_SET_COMMAND}}", () => command);
}

// POSIX single-quoting keeps every byte of a path literal.
function quote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function handleHook(input) {
  const event = normalizeEvent(input?.hook_event_name);

  if (!KNOWN_EVENTS.has(event)) {
    return nonBlockingErrorResult(
      `Intent Notes received an unrecognized hook event (${JSON.stringify(input?.hook_event_name ?? null)}).`
    );
  }

  if (event === "sessionstart") {
    const notice = changeNotice(input);
    return contextResult(
      "SessionStart",
      notice === null ? renderInstructions() : `${renderInstructions()}\n${notice}`
    );
  }

  if (event === "userpromptsubmit") {
    const notice = changeNotice(input);
    return notice === null ? allowResult() : contextResult("UserPromptSubmit", notice);
  }

  if (event === "posttooluse") {
    const notice = uncoveredNotice(input);
    return notice === null ? allowResult() : contextResult("PostToolUse", notice);
  }

  if (event === "stop") {
    return allowResult();
  }

  const hint = recordedIntent(input);
  return hint === null ? allowResult() : contextResult("PreToolUse", hint);
}

// Unparseable stdin means the event type is unknown too, so no event-specific
// payload can be trusted; a non-zero, non-blocking exit reports this for every event.
export function malformedInputResult() {
  return nonBlockingErrorResult("Intent Notes could not parse hook input.");
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
    `Intent Notes: no note on this branch records why these paths changed: ${listPaths(uncovered)}.${short}`,
    `Write one under ${NOTES_DIRECTORY}/ covering them, and leave the docstrings on what you changed`,
    "saying what each file and function is for and why it works the way it does.",
    "A purely mechanical change needs no note and can stay listed here.",
    "Nothing holds the turn and the user is shown no warning, so this reminder is the only notice you get."
  ].join(" ");
}

/*
 * What is already recorded about the files a tool is about to read or write.
 *
 * It fires on reads as well as writes because of when the context arrives: a
 * host attaches it to the tool result, so a hint on the edit itself reaches
 * the agent only after that edit has run. A hint on the read that precedes the
 * edit arrives in time to change it. The instructions still tell the agent to
 * look for a file's notes before changing it; this is the backstop, not the
 * plan.
 */
function recordedIntent(input) {
  const target = toolTargets(input, READING_TOOL);
  if (target === null) {
    return null;
  }
  const covering = notesCovering(target.root, target.paths);
  if (covering.length === 0) {
    return null;
  }
  const described = covering.map(note => {
    const title = note.title === null ? note.file : `${note.file} -- ${note.title}`;
    return note.supersededBy === null ? title : `${title} (superseded by ${note.supersededBy})`;
  });
  return [
    `Intent Notes: ${listPaths(target.paths)} is covered by ${described.map(displayPath).join("; ")}.`,
    "Read what applies before changing it. A change that contradicts a recorded intent is fine,",
    "and is exactly when a new note superseding the old one is owed."
  ].join(" ");
}

/*
 * What still has no record, said the moment a write lands rather than at the
 * next user message. Nothing holds the turn, so this is the only notice that
 * arrives while the work is still in hand.
 *
 * It costs the same two git calls the prompt notice costs, which is why it is
 * spent only on a tool that named a file inside the repository -- and why a
 * write to the notes tree spends it too, since that is exactly when the
 * remaining list has changed.
 */
function uncoveredNotice(input) {
  if (toolTargets(input, null) === null) {
    return null;
  }
  return changeNotice(input);
}

/*
 * The repository-relative paths a tool is about to touch, or null when there
 * are none to resolve: a shell command that is not a patch, paths outside the
 * repository, or a tool that neither writes nor (when `alsoRead` is given)
 * reads.
 *
 * The working directory is resolved through symlinks, because the repository
 * root is; without that, a working directory reached by a link is compared
 * against its own target and every file under it looks outside.
 *
 * A symlinked file answers to two names and both matter. git tracks the link
 * under its own name, so that is the one a deletion touches and the one its
 * notes are filed under; but a write through the link changes the target, and
 * that is the file git will report as changed. Resolving only the target lost
 * the link's own notes; resolving only the link loses the target's. Both are
 * collected, and the target only when it is inside the repository.
 */
function toolTargets(input, alsoRead) {
  const name = String(input?.tool_name ?? "");
  if (!WRITING_TOOL.test(name) && !(alsoRead !== null && alsoRead.test(name))) {
    return null;
  }
  const directory = hookDirectory(input);
  if (directory === null) {
    return null;
  }
  const root = repositoryRoot(directory);
  if (root === null) {
    return null;
  }
  const base = realPath(directory) ?? directory;
  const paths = new Set();
  for (const raw of toolPaths(input?.tool_input)) {
    for (const relative of repositoryRelatives(root, base, raw)) {
      paths.add(relative);
    }
  }
  return paths.size === 0 ? null : { root, paths: [...paths] };
}

/*
 * Every path a tool payload names. Codex sends a patch envelope as a command
 * string, which is read here as the structured format it is, by its own
 * `*** ... File:` headers, and never as a shell command to be parsed.
 */
function toolPaths(toolInput) {
  const paths = [];
  for (const key of TOOL_PATH_KEYS) {
    if (typeof toolInput?.[key] === "string" && toolInput[key] !== "") {
      paths.push(toolInput[key]);
    }
  }
  for (const key of PATCH_TEXT_KEYS) {
    const value = toolInput?.[key];
    if (typeof value === "string" && value.includes(PATCH_ENVELOPE)) {
      paths.push(...patchTargets(value));
    }
  }
  return paths;
}

function patchTargets(patch) {
  const paths = [];
  for (const line of patch.split(/\r?\n/)) {
    const target = line.match(PATCH_TARGET) ?? line.match(PATCH_MOVE);
    if (target) {
      paths.push(target[1].trim());
    }
  }
  return paths;
}

/*
 * Both names a path may answer to: the one as written, with only the directory
 * holding it resolved, and -- when it is a link into the repository -- the one
 * it points at.
 */
function repositoryRelatives(root, base, raw) {
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(base, raw);
  const directory = realPath(path.dirname(absolute)) ?? path.dirname(absolute);
  const names = [path.join(directory, path.basename(absolute))];
  const target = realPath(absolute);
  if (target !== null && target !== names[0]) {
    names.push(target);
  }
  return names.map(name => insideRepository(root, name)).filter(name => name !== null);
}

// Spelled the way a path from git is spelled, so a tool naming the ordinary
// file `x%FF.js` looks up the notes for that file rather than for the one
// whose name holds a raw 0xFF.
function insideRepository(root, absolute) {
  const relative = encodePath(path.relative(root, absolute));
  // `..` as a prefix is not the same as `..` as a path segment: a file called
  // `..hidden.js` sits in the repository like any other, and rejecting it left
  // every note about it unmentioned and every write to it unreported.
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

// The nearest existing ancestor, so a directory that does not exist yet -- one
// a file is about to be created in -- still resolves.
function realPath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) {
      return null;
    }
    const resolved = realPath(parent);
    return resolved === null ? null : path.join(resolved, path.basename(target));
  }
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

function contextResult(eventName, context) {
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

function nonBlockingErrorResult(reason) {
  return { exitCode: 1, stdout: "", stderr: `${reason}\n` };
}

function allowResult() {
  return { exitCode: 0, stdout: "", stderr: "" };
}

// Both supported hosts send cwd.
export function hookDirectory(input) {
  return typeof input?.cwd === "string" && input.cwd !== "" ? input.cwd : null;
}

export async function main() {
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
    result = handleHook(JSON.parse(Buffer.concat(chunks).toString("utf8")));
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
