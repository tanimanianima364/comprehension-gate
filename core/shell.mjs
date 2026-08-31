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
 * unquoted separators into segments. Every segment is classified on its own,
 * and the whole command counts as inspection only when all of them do. The
 * scan decides where one command ends and the next begins; it never tries to
 * understand the grammar built out of them, and every ambiguity resolves to a
 * refusal, so a misreading can only cost a false denial.
 *
 * Three constructs get more than lexical treatment, each for a stated reason:
 *
 * - Redirection is allowed only where it cannot name a file to write:
 *   /dev/null, and file-descriptor duplication. Any other target is refused.
 * - Parameter expansion (`$VAR`, `${VAR}`) is allowed, because POSIX does not
 *   re-parse the result of an expansion for control operators; an expanded
 *   value becomes argument text and cannot introduce a second command.
 * - Command substitution (`$(...)`, backticks) does run a command, so its body
 *   is classified recursively rather than refused.
 *
 * An expansion of either kind in the command-name position is refused: the
 * name is what the denylist matches on, so a hidden one cannot be judged.
 */

// Rejected outside quotes. These name no command that can be classified.
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
  // command name says nothing about what gets written.
  "bash", "bun", "cmd", "csh", "dash", "deno", "doas", "env", "eval", "exec",
  "fish", "ksh", "node", "nohup", "osascript", "perl", "php", "powershell",
  "pwsh", "python", "python2", "python3", "ruby", "script", "setsid", "sh",
  "sudo", "timeout", "xargs", "zsh",
  // Build, test, and package tooling: runs project-defined code.
  "bazel", "bundle", "cargo", "cmake", "composer", "dotnet", "gem", "go",
  "gradle", "make", "mvn", "ninja", "npm", "npx", "pip", "pip3", "pnpm",
  "poetry", "rustc", "tsc", "uv", "yarn",
  // Network transfer: side effects plus a write target.
  "curl", "ftp", "nc", "rsync", "scp", "ssh", "wget",
  // Other version control systems, whose read subcommands are not verified.
  "hg", "svn"
]);

// git subcommands that only report. `status` refreshes the index, but that is
// git's own bookkeeping rather than a project mutation, and losing it would
// remove the most common orientation command there is.
const GIT_READ_SUBCOMMANDS = new Set([
  "blame", "cat-file", "describe", "diff", "grep", "log", "ls-files",
  "ls-tree", "rev-list", "rev-parse", "shortlog", "show", "status"
]);

const FIND_WRITE_ACTIONS = new Set([
  "-delete", "-execdir", "-exec", "-fls", "-fprint", "-fprintf", "-ok", "-okdir"
]);

const SED_IN_PLACE = /^(--in-place|-[a-z]*i)/;
const REDIRECT_TARGET = "/dev/null";
const VARIABLE_NAME = /[A-Za-z_]/;

export function classifyShellCommand(command) {
  if (typeof command !== "string") {
    return "write";
  }
  const segments = splitSegments(command);
  if (segments === null) {
    return "write";
  }
  // An empty segment (a trailing `;`, say) runs nothing, so it is dropped
  // rather than judged; a command with nothing left to run is not inspection.
  const commands = segments.filter(tokens => tokens.length > 0);
  if (commands.length === 0) {
    return "write";
  }
  return commands.every(isReadCommand) ? "read" : "write";
}

/*
 * Returns one token list per segment, or null when the command contains
 * something this scanner refuses. Tokens are `{ value, expanded }`: the value
 * is unquoted, so a denylisted argument cannot hide behind quotes, and
 * `expanded` records that part of it came from an expansion whose result the
 * scanner cannot see.
 */
function splitSegments(command) {
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
        return null;
      }
      append(command[index + 1]);
      index += 2;
      continue;
    }

    if (character === "$" || character === "`") {
      const expansion = readExpansion(command, index);
      if (expansion === null) {
        return null;
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
        return null;
      }
      index = redirect.next;
      continue;
    }
    if (character === "&") {
      // `&&` separates; a lone `&` backgrounds, which detaches the command
      // from the decision this hook is making about it.
      if (command[index + 1] !== "&") {
        return null;
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
      return null;
    }
    if (/\s/.test(character)) {
      endToken();
      index += 1;
      continue;
    }
    append(character);
    index += 1;
  }

  if (quote !== null) {
    return null;
  }
  endSegment();
  return segments;
}

/*
 * Consumes one expansion starting at `start`. Command substitution bodies are
 * classified recursively; a body that is not inspection, or an expansion this
 * scanner does not model, refuses the whole command.
 */
function readExpansion(command, start) {
  if (command[start] === "`") {
    const end = command.indexOf("`", start + 1);
    if (end === -1 || classifyShellCommand(command.slice(start + 1, end)) === "write") {
      return null;
    }
    return { next: end + 1 };
  }

  const next = command[start + 1];
  if (next === "(") {
    const end = findClosingParenthesis(command, start + 1);
    if (end === -1 || classifyShellCommand(command.slice(start + 2, end)) === "write") {
      return null;
    }
    return { next: end + 1 };
  }
  if (next === "{") {
    const end = command.indexOf("}", start + 2);
    if (end === -1) {
      return null;
    }
    // A substitution nested in a parameter expansion is not decomposed here,
    // so refuse rather than let its body through unclassified.
    const body = command.slice(start + 2, end);
    if (body.includes("$") || body.includes("`")) {
      return null;
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
  // modeled, so they refuse rather than expand into something unexamined.
  return null;
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

function isReadCommand(tokens) {
  // The denylist matches on the command name, so a name the scanner could not
  // resolve cannot be judged at all.
  if (tokens[0].expanded) {
    return false;
  }
  const name = commandName(tokens[0].value);
  if (WRITE_COMMANDS.has(name)) {
    return false;
  }
  const rest = tokens.slice(1).map(token => token.value);
  if (name === "git") {
    return GIT_READ_SUBCOMMANDS.has(rest[0]);
  }
  if (name === "sed" && rest.some(token => SED_IN_PLACE.test(token))) {
    return false;
  }
  if (name === "find" && rest.some(token => FIND_WRITE_ACTIONS.has(token))) {
    return false;
  }
  return true;
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
