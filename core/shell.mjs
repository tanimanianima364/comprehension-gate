/*
 * Shell inspection policy for the pending gate.
 *
 * The gate's threat model is a cooperative agent that mutates the project
 * while believing it is only looking around, not one that evades the hook on
 * purpose (README "Security boundary"). So the command table below is a
 * denylist: an unrecognized command is treated as inspection. That leaves a
 * known residual bypass -- an unlisted mutating command, or one whose name is
 * rebound by a shell function, alias, or PATH entry -- which is accepted
 * deliberately so that exploration before pass is not crippled.
 *
 * A command is scanned once, tracking POSIX quoting state, and split on
 * unquoted separators into segments. Every segment is judged on its own as
 * "read", "write", or "unknown", and the whole command takes the worst of
 * them. The scan decides where one command ends and the next begins; it never
 * tries to understand the grammar built out of them.
 *
 * "Unknown" is where the two entry points differ. A command typed by the agent
 * resolves every ambiguity to a refusal, so a misreading can only cost a false
 * denial. A script file run through `bash <path>` or `sh <path>` is scanned
 * leniently: a known write inside it still refuses, but a construct the scan
 * cannot judge -- a subshell, an expansion in the command-name position, a
 * heredoc -- is let through, because a read-only helper script refused for its
 * syntax would be lost to the agent in every session. Both directions serve
 * the same purpose: the gate exists to keep the user able to explain the code
 * the agent writes, not to sandbox the agent.
 *
 * Three constructs get more than lexical treatment, each for a stated reason:
 *
 * - Redirection is allowed only where it cannot name a file to write:
 *   /dev/null, and file-descriptor duplication. Any other target is a write.
 * - Parameter expansion (`$VAR`, `${VAR}`) is allowed, because POSIX does not
 *   re-parse the result of an expansion for control operators; an expanded
 *   value becomes argument text and cannot introduce a second command.
 * - Command substitution (`$(...)`, backticks) does run a command, so its body
 *   is classified recursively rather than refused.
 *
 * An expansion of either kind in the command-name position is unknown: the
 * name is what the denylist matches on, so a hidden one cannot be judged.
 *
 * Every rule here reads the string as POSIX shell. The refusal for other
 * platforms lives in handleHook rather than in this function, because the
 * Codex control and inspection exceptions return before it would be called.
 */

import fs from "node:fs";
import path from "node:path";

// Undecomposable outside quotes when the agent types them. Inside a script,
// `(` and `)` are read as segment boundaries so that what runs inside a
// subshell or function body is still judged, and `<` is plain argument text.
const UNQUOTED_REJECT = new Set(["<", "(", ")"]);

const WRITE_COMMANDS = new Set([
  // Filesystem mutation
  "chgrp", "chmod", "chown", "cp", "dd", "install", "ln", "mkdir", "mv",
  "rm", "rmdir", "shred", "tee", "touch", "truncate", "unlink",
  // Patch application
  "apply_patch", "patch",
  // Interactive or in-place editors
  "ed", "emacs", "nano", "vi", "vim",
  // Interpreters and wrappers: these run arbitrary code, so the visible
  // command name says nothing about what gets written. `bash` and `sh` are
  // the exception, handled below by reading what they are given.
  "bun", "cmd", "csh", "dash", "deno", "doas", "env", "eval", "exec",
  "fish", "ksh", "node", "nohup", "perl", "php", "powershell",
  "pwsh", "python", "python2", "python3", "ruby", "script", "setsid",
  "sudo", "timeout", "xargs", "zsh",
  // Wrappers that run their first operand as a command. They are refused
  // rather than unwrapped, matching how env, sudo, xargs, timeout, and nohup
  // above are already handled.
  "builtin", "chrt", "command", "ionice", "nice", "setarch", "stdbuf",
  "taskset", "time",
  // Build, test, and package tooling: runs project-defined code.
  "bazel", "bundle", "cargo", "cmake", "composer", "dotnet", "gem", "go",
  "gradle", "make", "mvn", "ninja", "npm", "npx", "pip", "pip3", "pnpm",
  "poetry", "rustc", "tsc", "uv", "yarn",
  // Network transfer: side effects plus a write target.
  "curl", "ftp", "nc", "rsync", "scp", "ssh", "wget",
  // Other version control systems, whose read subcommands are not verified.
  "hg", "svn"
]);

// Shells whose script operand is read and judged instead of refused.
const SCRIPT_SHELLS = new Set(["bash", "sh"]);

// git subcommands that leave the working tree alone. `status` refreshes the
// index and `fetch` and `branch` move refs, but that is git's own bookkeeping
// rather than a change to a file the user would need to explain.
const GIT_READ_SUBCOMMANDS = new Set([
  "blame", "branch", "cat-file", "describe", "diff", "fetch", "grep", "log",
  "ls-files", "ls-tree", "rev-list", "rev-parse", "shortlog", "show", "status"
]);

/*
 * `sed` and `find` are classified by what their arguments say, so their flags
 * are an allowlist rather than a denylist. A flag the scanner cannot see --
 * an expansion, or one nobody has vetted -- then falls outside the allowed set
 * instead of slipping past, which is the same failure direction that protects
 * the git subcommands above.
 *
 * The residual is a sed script body: `w` and `s///w` write a file whatever the
 * flags say. That is the accepted denylist trade described at the top of this
 * file, not something these lists claim to cover.
 */
const SED_READ_FLAGS = new Set([
  "-E", "-e", "-f", "-n", "-r", "-s", "-u", "-z",
  "--debug", "--expression", "--file", "--null-data", "--posix", "--quiet",
  "--regexp-extended", "--sandbox", "--separate", "--silent", "--unbuffered"
]);

const FIND_READ_PRIMARIES = new Set([
  "-H", "-L", "-P", "-a", "-and", "-anewer", "-atime", "-depth", "-empty",
  "-follow", "-group", "-iname", "-inum", "-ipath", "-iregex", "-links",
  "-maxdepth", "-mindepth", "-mmin", "-mtime", "-name", "-newer", "-nogroup",
  "-not", "-nouser", "-o", "-or", "-path", "-perm", "-print", "-print0",
  "-printf", "-prune", "-quit", "-regex", "-size", "-true", "-false", "-type",
  "-user", "-xdev"
]);

// A leading-dash numeric operand (`-mtime -1`) is a value, not a flag.
const NUMERIC_OPERAND = /^-\d+$/;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Assignment targets that change which program a name resolves to, or what the
// shell runs on startup. A prefix setting one of these is refused outright.
const RESOLUTION_ASSIGNMENTS = new Set([
  "BASHOPTS", "BASH_ENV", "ENV", "IFS", "LD_AUDIT", "LD_LIBRARY_PATH",
  "LD_PRELOAD", "PATH", "SHELLOPTS"
]);
const REDIRECT_TARGET = "/dev/null";
const VARIABLE_NAME = /[A-Za-z_]/;

/*
 * `options.cwd` is the hook's absolute working directory, used to locate a
 * script operand; without it no script can be judged. Only an agent-typed
 * command enters here, so unknown resolves to write.
 */
export function classifyShellCommand(command, options = {}) {
  return scan(command, { cwd: options.cwd, lenient: false, scripts: new Set() }) === "read"
    ? "read"
    : "write";
}

function scan(command, options) {
  if (typeof command !== "string") {
    return "unknown";
  }
  const split = splitSegments(command, options);
  if (split.refusal) {
    return split.refusal;
  }
  // An empty segment (a trailing `;`, say) runs nothing, so it is dropped
  // rather than judged; a command with nothing left to run is not inspection.
  const commands = split.segments.filter(tokens => tokens.length > 0);
  if (commands.length === 0) {
    return "unknown";
  }
  return worst(commands.map(tokens => judgeCommand(tokens, options)));
}

function worst(verdicts) {
  if (verdicts.includes("write")) {
    return "write";
  }
  return verdicts.includes("unknown") ? "unknown" : "read";
}

/*
 * Returns `{ segments }`, one token list per segment, or `{ refusal }` naming
 * why the scan stopped: "write" for a construct that names a write target, and
 * "unknown" for one this scanner does not decompose. In lenient mode the
 * unknown constructs are read past instead. Tokens are `{ value, expanded }`:
 * the value is unquoted, so a denylisted argument cannot hide behind quotes,
 * and `expanded` records that part of it came from an expansion whose result
 * the scanner cannot see.
 */
function splitSegments(command, options) {
  const { lenient } = options;
  const segments = [];
  let tokens = [];
  let value = "";
  let started = false;
  let expanded = false;
  let quote = null;
  let index = 0;

  const endToken = () => {
    if (started) {
      tokens.push({ value, expanded });
      value = "";
      started = false;
      expanded = false;
    }
  };
  const endSegment = () => {
    endToken();
    segments.push(tokens);
    tokens = [];
  };
  const append = character => {
    value += character;
    started = true;
  };

  while (index < command.length) {
    const character = command[index];

    if (quote === "'") {
      // Single quotes suppress every expansion, so nothing here is special.
      if (character === "'") {
        quote = null;
      } else {
        append(character);
      }
      index += 1;
      continue;
    }

    if (character === "\\") {
      if (index + 1 >= command.length) {
        if (!lenient) {
          return { refusal: "unknown" };
        }
        index += 1;
        continue;
      }
      // Backslash-newline is line continuation and adds nothing to the token.
      if (command[index + 1] !== "\n") {
        append(command[index + 1]);
      }
      index += 2;
      continue;
    }

    if (character === "$" || character === "`") {
      const expansion = readExpansion(command, index, options);
      if (expansion.refusal) {
        return expansion;
      }
      started = true;
      expanded = true;
      index = expansion.next;
      continue;
    }

    if (quote === '"') {
      if (character === '"') {
        quote = null;
      } else {
        append(character);
      }
      index += 1;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      index += 1;
      continue;
    }
    // An unquoted `#` at the start of a word begins a comment.
    if (character === "#" && !started) {
      while (index < command.length && command[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === ">" || (character === "&" && command[index + 1] === ">")) {
      // A bare file-descriptor number belongs to the redirection, not to the
      // argument list. Anything less clear stays a token, which can only make
      // the redirection target fail to match and so refuse.
      if (started && !expanded && /^\d+$/.test(value)) {
        value = "";
        started = false;
      }
      const redirect = readRedirect(command, index);
      if (redirect === null) {
        return { refusal: "write" };
      }
      index = redirect.next;
      continue;
    }
    if (character === "&") {
      // `&&` separates; a lone `&` backgrounds, which detaches the command
      // from the decision this hook is making about it.
      if (command[index + 1] !== "&") {
        if (!lenient) {
          return { refusal: "unknown" };
        }
        endSegment();
        index += 1;
        continue;
      }
      endSegment();
      index += 2;
      continue;
    }
    if (character === "|") {
      index += command[index + 1] === "|" ? 2 : 1;
      endSegment();
      continue;
    }
    if (character === ";" || character === "\n" || character === "\r") {
      endSegment();
      index += 1;
      continue;
    }
    if (UNQUOTED_REJECT.has(character)) {
      if (!lenient) {
        return { refusal: "unknown" };
      }
      if (character === "<") {
        append(character);
      } else {
        endSegment();
      }
      index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      endToken();
      index += 1;
      continue;
    }
    append(character);
    index += 1;
  }

  if (quote !== null && !lenient) {
    return { refusal: "unknown" };
  }
  endSegment();
  return { segments };
}

/*
 * Consumes one expansion starting at `start`, returning `{ next }` or
 * `{ refusal }`. Command substitution bodies are classified recursively; a
 * body that writes refuses in either mode, and one the scan cannot judge, or
 * an expansion this scanner does not model, refuses only when strict.
 */
function readExpansion(command, start, options) {
  const { lenient } = options;
  // An unterminated expansion is read past one character at a time when
  // lenient, so the lines after it are still judged.
  const unknown = () => (lenient ? { next: start + 1 } : { refusal: "unknown" });
  const substitution = (body, next) => {
    const verdict = scan(body, { ...options, scripts: new Set(options.scripts) });
    if (verdict === "write") {
      return { refusal: "write" };
    }
    return verdict === "unknown" && !lenient ? { refusal: "unknown" } : { next };
  };

  if (command[start] === "`") {
    const end = command.indexOf("`", start + 1);
    return end === -1 ? unknown() : substitution(command.slice(start + 1, end), end + 1);
  }

  const next = command[start + 1];
  if (next === "(") {
    const end = findClosingParenthesis(command, start + 1);
    return end === -1 ? unknown() : substitution(command.slice(start + 2, end), end + 1);
  }
  if (next === "{") {
    const end = command.indexOf("}", start + 2);
    if (end === -1) {
      return unknown();
    }
    // A substitution nested in a parameter expansion is not decomposed here,
    // so refuse rather than let its body through unclassified.
    const body = command.slice(start + 2, end);
    if ((body.includes("$") || body.includes("`")) && !lenient) {
      return { refusal: "unknown" };
    }
    return { next: end + 1 };
  }
  if (next !== undefined && VARIABLE_NAME.test(next)) {
    let end = start + 1;
    while (end < command.length && /[A-Za-z0-9_]/.test(command[end])) {
      end += 1;
    }
    return { next: end };
  }
  // Positional and special parameters are rare on a command line and are not
  // modeled, so they refuse rather than expand into something unexamined. In
  // a script they are ordinary, and read as a one-character expansion.
  if (lenient) {
    return { next: next === undefined ? start + 1 : start + 2 };
  }
  return { refusal: "unknown" };
}

function findClosingParenthesis(command, open) {
  let depth = 0;
  let quote = null;
  for (let index = open; index < command.length; index += 1) {
    const character = command[index];
    if (quote !== null) {
      if (character === "\\" && quote === '"') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "\\") {
      index += 1;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/*
 * Consumes one redirection starting at `start`, allowing only the forms that
 * cannot name a file to write: a /dev/null target, and descriptor duplication.
 */
function readRedirect(command, start) {
  let index = start;
  if (command[index] === "&") {
    index += 1;
  }
  index += 1;
  if (command[index] === ">") {
    index += 1;
  }

  if (command[index] === "&") {
    index += 1;
    const duplicateStart = index;
    if (command[index] === "-") {
      return { next: index + 1 };
    }
    while (index < command.length && /\d/.test(command[index])) {
      index += 1;
    }
    return index === duplicateStart ? null : { next: index };
  }

  while (command[index] === " " || command[index] === "\t") {
    index += 1;
  }
  const targetStart = index;
  while (index < command.length && !/[\s;|&<>()`$'"]/.test(command[index])) {
    index += 1;
  }
  return command.slice(targetStart, index) === REDIRECT_TARGET ? { next: index } : null;
}

function judgeCommand(tokens, options) {
  /*
   * A segment may open with NAME=VALUE assignments, so the first token is not
   * necessarily the command. Step over them to reach the name the tables are
   * meant to match. An assignment that rebinds command resolution or shell
   * startup is refused: PATH shadowing is an accepted residual only where the
   * scan cannot see it, and here it is written out in the command itself.
   */
  let index = 0;
  while (index < tokens.length && isAssignment(tokens[index])) {
    if (RESOLUTION_ASSIGNMENTS.has(tokens[index].value.split("=", 1)[0])) {
      return "write";
    }
    index += 1;
  }

  const command = tokens[index];
  // Assignments with no command after them execute nothing.
  if (command === undefined) {
    return "read";
  }
  // The denylist matches on the command name, so a name the scanner could not
  // resolve cannot be judged at all.
  if (command.expanded) {
    return "unknown";
  }
  const name = commandName(command.value);
  if (WRITE_COMMANDS.has(name)) {
    return "write";
  }
  const rest = tokens.slice(index + 1);
  if (name === "git") {
    if (rest[0] === undefined || rest[0].expanded) {
      return "unknown";
    }
    return GIT_READ_SUBCOMMANDS.has(rest[0].value) ? "read" : "write";
  }
  if (name === "sed") {
    return judgeFlags(rest, SED_READ_FLAGS);
  }
  if (name === "find") {
    return judgeFlags(rest, FIND_READ_PRIMARIES);
  }
  if (SCRIPT_SHELLS.has(name)) {
    return judgeScript(rest, options);
  }
  return "read";
}

// An expanded token is never treated as an assignment: its text is not fully
// visible, so it falls through and is judged as the command name instead,
// where an unresolved expansion already refuses.
function isAssignment(token) {
  return !token.expanded && ASSIGNMENT.test(token.value);
}

function judgeFlags(rest, allowed) {
  let verdict = "read";
  for (const token of rest) {
    // An expanded argument could be any flag at all, so it can never be
    // confirmed to be one of the allowed ones.
    if (token.expanded) {
      verdict = "unknown";
    } else if (token.value.startsWith("-") && !NUMERIC_OPERAND.test(token.value)
      && !allowed.has(token.value)) {
      return "write";
    }
  }
  return verdict;
}

/*
 * `bash <path> [args]` is judged by reading the script leniently; `bash -c
 * <string>` is judged by scanning the string. Any other shape -- no operand,
 * another option, an expanded operand -- cannot be judged. A script that
 * cannot be located or read, or that runs itself, refuses: those are failures
 * of the lookup, not ambiguities in what the script does.
 */
function judgeScript(rest, options) {
  const operand = rest[0];
  if (operand === undefined || operand.expanded) {
    return "unknown";
  }
  if (operand.value === "-c") {
    const inline = rest[1];
    return inline === undefined || inline.expanded
      ? "unknown"
      : scan(inline.value, { ...options, scripts: new Set(options.scripts) });
  }
  if (operand.value.startsWith("-")) {
    return "unknown";
  }
  if (typeof options.cwd !== "string" || !path.isAbsolute(options.cwd)) {
    return "write";
  }
  const resolved = path.resolve(options.cwd, operand.value);
  if (options.scripts.has(resolved)) {
    return "write";
  }
  let content;
  try {
    content = fs.readFileSync(resolved, "utf8");
  } catch {
    return "write";
  }
  const scripts = new Set(options.scripts);
  scripts.add(resolved);
  return scan(content, { ...options, lenient: true, scripts }) === "write" ? "write" : "read";
}

/*
 * Dropping the directory, the case, and an executable extension only ever
 * widens the denylist, so every normalization here is safe in that direction:
 * `/bin/RM`, `node.exe`, and `npm.cmd` all reach their listed name.
 */
function commandName(value) {
  const separator = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  const base = (separator === -1 ? value : value.slice(separator + 1)).toLowerCase();
  return base.replace(/\.(?:exe|com|bat|cmd|ps1)$/, "");
}
