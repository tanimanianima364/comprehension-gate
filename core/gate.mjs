import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEntrypointCommand } from "./command.mjs";
import {
  armGateControl,
  clearGateControl,
  completeGateControl,
  ensureGateState,
  GateStateError,
  checkGate,
  readGateState,
  resetGate
} from "./state.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const INSTRUCTIONS_PATH = path.join(path.dirname(SCRIPT_PATH), "instructions.md");
const CONTROL_ACTIONS = new Set(["pass", "bypass-low"]);

export function controlCommand(action) {
  if (!CONTROL_ACTIONS.has(action)) {
    throw new Error(`Unknown control action: ${action}`);
  }
  return buildEntrypointCommand(SCRIPT_PATH, action);
}

export function renderInstructions() {
  return fs
    .readFileSync(INSTRUCTIONS_PATH, "utf8")
    .replaceAll("{{PASS_COMMAND}}", controlCommand("pass"))
    .replaceAll("{{BYPASS_COMMAND}}", controlCommand("bypass-low"));
}

export function handleHook(input, mode = "compatible", options = {}) {
  const env = options.env ?? process.env;
  const stateOptions = { env, fs: options.fs };
  const provider = detectProvider(mode, env);
  const event = normalizeEvent(input?.hook_event_name);
  const isPromptEvent = event === "userpromptsubmit" || event === "beforesubmitprompt";

  try {
    if (event === "sessionstart" || (mode === "kiro" && event === "agentspawn")) {
      const source = String(input?.source ?? "startup").toLowerCase();
      if (source === "compact") {
        const current = readGateState(provider, input, stateOptions);
        if (!current.ok) {
          resetGate(provider, input, stateOptions);
        }
      } else {
        resetGate(provider, input, stateOptions);
      }
      return contextResult(mode, "SessionStart", renderInstructions());
    }

    if (isPromptEvent) {
      resetGate(provider, input, stateOptions);
      return contextResult(
        mode,
        "UserPromptSubmit",
        "Comprehension Gate is pending for this user turn. If this message answers a gate question, assess it against the required level and run the exact pass command only after the answer demonstrates understanding."
      );
    }

    if (event === "posttooluse") {
      if (classifyTool(input?.tool_name) === "shell") {
        const action = controlActionFor(input?.tool_input?.command);
        if (action) {
          if (controlCommandSucceeded(input, provider, action)) {
            completeGateControl(provider, input, action, stateOptions);
          } else {
            clearGateControl(provider, input, action, stateOptions);
          }
        }
      }
      return allowResult();
    }

    if (event !== "pretooluse") {
      return allowResult();
    }

    ensureGateState(provider, input, stateOptions);
    const toolKind = classifyTool(input?.tool_name);
    if (toolKind === "read") {
      return allowResult();
    }

    if (toolKind === "shell") {
      const command = input?.tool_input?.command;
      const action = controlActionFor(command);
      if (action) {
        armGateControl(provider, input, action, stateOptions);
        return allowResult();
      }
      if (isReadOnlyShellCommand(command)) {
        return allowResult();
      }
    }

    const gate = checkGate(provider, input, stateOptions);
    if (gate.satisfied) {
      return allowResult();
    }

    return denyResult(mode, denialReason(gate.reason, toolKind));
  } catch (error) {
    const detail = error instanceof GateStateError ? error.message : "Gate state could not be verified.";
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
        `Comprehension Gate failed to record the control command. ${detail} The gate remains pending; do not modify the project.`
      );
    }
    return denyResult(mode, `Comprehension Gate failed closed. ${detail}`);
  }
}

export function malformedInputResult(mode = "compatible") {
  return denyResult(
    mode,
    "Comprehension Gate could not parse hook input. Do not modify the project yet."
  );
}

export function isReadOnlyShellCommand(command) {
  const tokens = tokenizeConservative(command);
  if (!tokens || tokens.length === 0) {
    return false;
  }

  const executable = path.basename(tokens[0].replaceAll("\\", "/")).toLowerCase();
  const args = tokens.slice(1);

  if (executable === "rg" || executable === "ripgrep") {
    return !args.some(arg => arg === "--pre" || arg.startsWith("--pre="));
  }
  if (executable === "find") {
    return !args.some(arg => FIND_MUTATING_FLAGS.some(flag => arg.startsWith(flag)));
  }
  if (executable === "sort") {
    return !args.some(arg => arg === "-o" || arg === "--output" || arg.startsWith("--output=") || /^-o.+/.test(arg) || /^\/o$/i.test(arg));
  }
  if (executable === "tree") {
    return !args.some(arg => arg === "-o" || arg === "--output" || arg.startsWith("--output=") || /^-o.+/.test(arg));
  }
  if (executable === "uniq") {
    return args.filter(arg => !arg.startsWith("-")).length <= 1;
  }
  if (executable === "file") {
    return !args.some(arg => arg === "-C" || arg === "--compile");
  }
  if (executable === "hostname") {
    return args.every(arg => arg.startsWith("-") || arg.startsWith("/"));
  }
  if (executable === "git") {
    return isReadOnlyGit(args);
  }
  if (executable === "go") {
    return (
      ["env", "version"].includes((args[0] ?? "").toLowerCase()) &&
      !args.some(arg => arg === "-w" || arg.startsWith("-w=") || arg === "-u" || arg.startsWith("-u="))
    );
  }
  if (executable === "cargo") {
    return (args[0] ?? "").toLowerCase() === "version";
  }
  if (executable === "command") {
    return args[0] === "-v" && args.length === 2;
  }
  return SIMPLE_READ_COMMANDS.has(executable);
}

export function controlCommandSucceeded(input, provider, action) {
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

  const marker = action === "pass"
    ? "<!-- comprehension-gate:pass -->"
    : "<!-- comprehension-gate:bypass-low -->";
  return responseText(response).includes(marker);
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

function normalizeEvent(event) {
  return String(event ?? "").replaceAll(/[^a-z]/gi, "").toLowerCase();
}

function classifyTool(toolName) {
  const normalized = String(toolName ?? "").replaceAll(/[^a-z_]/gi, "").toLowerCase();
  if (READ_ONLY_TOOLS.has(normalized)) {
    return "read";
  }
  if (WRITE_TOOLS.has(normalized)) {
    return "write";
  }
  if (SHELL_TOOLS.has(normalized)) {
    return "shell";
  }
  return "other";
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

function controlActionFor(command) {
  if (typeof command !== "string") {
    return null;
  }
  const trimmed = command.trim();
  for (const action of CONTROL_ACTIONS) {
    if (trimmed === controlCommand(action)) {
      return action;
    }
  }
  return null;
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

function denyResult(mode, reason) {
  if (mode === "kiro") {
    return { exitCode: 2, stdout: "", stderr: `${reason}\n` };
  }
  if (mode === "cursor") {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        permission: "deny",
        user_message: reason,
        agent_message: reason
      })}\n`,
      stderr: ""
    };
  }
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason
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

function allowResult() {
  return { exitCode: 0, stdout: "", stderr: "" };
}

function denialReason(stateReason, toolKind) {
  const toolNote = toolKind === "shell"
    ? " Before the gate passes, use dedicated read/search tools or a conservatively recognized read-only shell command."
    : toolKind === "other"
      ? " This tool is not on the explicit read-only allowlist, so it is denied while the gate is pending."
      : "";
  return [
    `Comprehension Gate is not satisfied for the current user turn (${stateReason}).`,
    "Classify it silently: LOW is mechanical; MEDIUM requires Explain; HIGH requires Explain + Why + Predict; CRITICAL also requires Transfer.",
    "Ask the minimum codebase-specific question(s) and wait for the user to demonstrate understanding in their own words.",
    `After mastery, run this exact standalone command: ${controlCommand("pass")}`,
    `For a genuinely LOW change only, run this exact standalone command: ${controlCommand("bypass-low")}`,
    toolNote
  ].join(" ").trim();
}

function tokenizeConservative(command) {
  if (typeof command !== "string" || command.trim() === "") {
    return null;
  }

  const tokens = [];
  let token = "";
  let quote = null;
  let escaping = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if (escaping) {
      token += character;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        if (quote === '"' && (character === "$" || character === "`")) {
          return null;
        }
        token += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (character === "\n" || character === "\r") {
        return null;
      }
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    if (";&|><`$#(){}".includes(character)) {
      return null;
    }
    token += character;
  }

  if (escaping || quote) {
    return null;
  }
  if (token) {
    tokens.push(token);
  }
  return tokens;
}

function isReadOnlyGit(args) {
  if (
    args[0] !== "--no-pager" ||
    args[1] !== "-c" ||
    args[2] !== "core.fsmonitor=false"
  ) {
    return false;
  }

  const commandArgs = args.slice(3);
  const subcommand = (commandArgs[0] ?? "").toLowerCase();
  const subcommandArgs = commandArgs.slice(1);
  if (args.some(arg => arg === "--output" || arg.startsWith("--output="))) {
    return false;
  }
  if (GIT_DIFF_FAMILY.has(subcommand)) {
    const pathspecSeparator = subcommandArgs.indexOf("--");
    const optionArgs = pathspecSeparator === -1
      ? subcommandArgs
      : subcommandArgs.slice(0, pathspecSeparator);
    const disablesExternalDiff = optionArgs.includes("--no-ext-diff");
    const disablesTextconv = optionArgs.includes("--no-textconv");
    const disablesSignature = subcommand === "diff" || optionArgs.includes("--no-show-signature");
    const malformedDisable = subcommandArgs.some(arg =>
      arg.startsWith("--no-ext-diff=") ||
      arg.startsWith("--no-textconv=") ||
      arg.startsWith("--no-show-signature=")
    );
    const enablesHelper = subcommandArgs.some(arg =>
      matchesLongOptionPrefix(arg, "--ext-diff") ||
      matchesLongOptionPrefix(arg, "--textconv") ||
      matchesLongOptionPrefix(arg, "--show-signature") ||
      arg.includes("%G")
    );
    return disablesExternalDiff && disablesTextconv && disablesSignature && !malformedDisable && !enablesHelper;
  }
  if (subcommand === "cat-file") {
    return !subcommandArgs.some(arg =>
      matchesLongOptionPrefix(arg, "--filters") ||
      matchesLongOptionPrefix(arg, "--textconv")
    );
  }
  if (subcommand === "grep") {
    return !subcommandArgs.some(arg =>
      matchesLongOptionPrefix(arg, "--textconv") ||
      matchesLongOptionPrefix(arg, "--open-files-in-pager") ||
      /^-[^-]*O/.test(arg)
    );
  }
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) {
    return true;
  }
  if (subcommand === "tag") {
    const tagArgs = subcommandArgs;
    if (tagArgs.length === 0) {
      return true;
    }
    const hasListMode = tagArgs[0] === "-l" || tagArgs[0] === "--list";
    return hasListMode && tagArgs.slice(1).every(arg => !arg.startsWith("-"));
  }
  if (subcommand === "branch") {
    const branchArgs = subcommandArgs;
    return (
      branchArgs.length === 0 ||
      (branchArgs.length === 1 && branchArgs[0] === "--show-current")
    );
  }
  if (subcommand === "config") {
    const allowed = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin", "--show-scope"]);
    const mutating = new Set(["--add", "--edit", "-e", "--remove-section", "--rename-section", "--replace-all", "--unset", "--unset-all"]);
    return subcommandArgs.some(arg => allowed.has(arg)) && !subcommandArgs.some(arg => mutating.has(arg));
  }
  if (subcommand === "remote") {
    const operation = (subcommandArgs[0] ?? "").toLowerCase();
    if (operation === "show") {
      return subcommandArgs[1] === "-n";
    }
    return operation === "" || operation === "-v" || operation === "get-url";
  }
  if (subcommand === "worktree") {
    return (subcommandArgs[0] ?? "").toLowerCase() === "list";
  }
  return false;
}

function matchesLongOptionPrefix(argument, option) {
  const candidate = argument.split("=", 1)[0];
  return candidate.length > 2 && candidate.startsWith("--") && option.startsWith(candidate);
}

const WRITE_TOOLS = new Set([
  "apply_patch",
  "delete",
  "delete_file",
  "edit",
  "fs_write",
  "fswrite",
  "notebookedit",
  "str_replace",
  "str_replace_based_edit_tool",
  "write",
  "writefile"
]);

const READ_ONLY_TOOLS = new Set([
  "file_search",
  "filesearch",
  "fs_read",
  "fsread",
  "glob",
  "grep",
  "list_directory",
  "listdirectory",
  "read",
  "read_file",
  "read_files",
  "readfile",
  "readfiles",
  "ripgrep",
  "search_files",
  "searchfiles",
  "semantic_search",
  "semanticsearch",
  "view_image",
  "viewimage",
  "web_fetch",
  "web_search",
  "webfetch",
  "websearch"
]);

const SHELL_TOOLS = new Set([
  "bash",
  "control_bash_process",
  "execute_bash",
  "execute_cmd",
  "execute_command",
  "powershell",
  "shell"
]);

const SIMPLE_READ_COMMANDS = new Set([
  "[",
  "basename",
  "cat",
  "compare-object",
  "df",
  "dir",
  "dirname",
  "du",
  "echo",
  "get-childitem",
  "get-command",
  "get-content",
  "get-item",
  "get-location",
  "grep",
  "head",
  "id",
  "jq",
  "ls",
  "md5sum",
  "measure-object",
  "printenv",
  "ps",
  "pwd",
  "readlink",
  "realpath",
  "resolve-path",
  "select-string",
  "sha256sum",
  "stat",
  "tail",
  "test",
  "type",
  "uname",
  "wc",
  "where",
  "which",
  "whoami"
]);

const FIND_MUTATING_FLAGS = ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"];

const GIT_READ_SUBCOMMANDS = new Set([
  "describe",
  "ls-files",
  "ls-tree",
  "merge-base",
  "name-rev",
  "rev-list",
  "rev-parse",
  "show-ref"
]);

const GIT_DIFF_FAMILY = new Set(["diff", "log", "show"]);

export async function main() {
  const [modeOrAction = "compatible"] = process.argv.slice(2);
  if (CONTROL_ACTIONS.has(modeOrAction)) {
    const marker = modeOrAction === "pass"
      ? "<!-- comprehension-gate:pass -->"
      : "<!-- comprehension-gate:bypass-low -->";
    process.stdout.write(`${marker}\n`);
    return;
  }

  let stdin = "";
  for await (const chunk of process.stdin) {
    stdin += chunk;
  }

  let result;
  try {
    result = handleHook(JSON.parse(stdin), modeOrAction);
  } catch {
    result = malformedInputResult(modeOrAction);
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(SCRIPT_PATH)) {
  await main();
}
