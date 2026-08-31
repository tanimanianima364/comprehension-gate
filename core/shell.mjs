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
 * and the whole command counts as inspection only when all of them do. This is
 * a lexer, not a parser: it decides where one command ends and the next
 * begins, and never tries to understand the grammar built out of them. What it
 * cannot decompose that way -- substitution, subshells, redirection,
 * backgrounding, an unterminated quote -- it refuses outright rather than
 * reasoning about.
 */

// Rejected outside quotes. Substitution and subshells hide a whole command
// where no separator is visible; redirection names a write target.
const UNQUOTED_REJECT = new Set(["$", "`", "(", ")", "<", ">"]);

// Rejected inside double quotes too: unlike single quotes, they still expand.
const DOUBLE_QUOTED_REJECT = new Set(["$", "`"]);

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
 * something this scanner refuses to decompose. Tokens come back unquoted, so a
 * denylisted argument cannot be hidden behind quotes.
 */
function splitSegments(command) {
  const segments = [];
  let tokens = [];
  let token = "";
  let tokenStarted = false;
  let quote = null;

  const endToken = () => {
    if (tokenStarted) {
      tokens.push(token);
      token = "";
      tokenStarted = false;
    }
  };
  const endSegment = () => {
    endToken();
    segments.push(tokens);
    tokens = [];
  };
  const append = character => {
    token += character;
    tokenStarted = true;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (quote === "'") {
      // Single quotes suppress every expansion, so nothing here is special.
      if (character === "'") {
        quote = null;
      } else {
        append(character);
      }
      continue;
    }

    if (quote === '"') {
      if (character === "\\") {
        if (index + 1 >= command.length) {
          return null;
        }
        append(command[index + 1]);
        index += 1;
      } else if (character === '"') {
        quote = null;
      } else if (DOUBLE_QUOTED_REJECT.has(character)) {
        return null;
      } else {
        append(character);
      }
      continue;
    }

    if (character === "\\") {
      if (index + 1 >= command.length) {
        return null;
      }
      append(command[index + 1]);
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (character === "&") {
      // `&&` separates; a lone `&` backgrounds, which detaches the command
      // from the decision this hook is making about it.
      if (command[index + 1] !== "&") {
        return null;
      }
      endSegment();
      index += 1;
      continue;
    }
    if (character === "|") {
      if (command[index + 1] === "|") {
        index += 1;
      }
      endSegment();
      continue;
    }
    if (character === ";" || character === "\n" || character === "\r") {
      endSegment();
      continue;
    }
    if (UNQUOTED_REJECT.has(character)) {
      return null;
    }
    if (/\s/.test(character)) {
      endToken();
      continue;
    }
    append(character);
  }

  if (quote !== null) {
    return null;
  }
  endSegment();
  return segments;
}

function isReadCommand(tokens) {
  const name = commandName(tokens[0]);
  if (WRITE_COMMANDS.has(name)) {
    return false;
  }
  if (name === "git") {
    return GIT_READ_SUBCOMMANDS.has(tokens[1]);
  }
  if (name === "sed" && tokens.slice(1).some(token => SED_IN_PLACE.test(token))) {
    return false;
  }
  if (name === "find" && tokens.slice(1).some(token => FIND_WRITE_ACTIONS.has(token))) {
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
