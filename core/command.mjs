import path from "node:path";

const ENTRYPOINT_BOOTSTRAP = "import('node:url').then(m=>import(m.pathToFileURL(Buffer.from(process.argv[1],'base64url').toString('utf8')).href)).then(m=>m.main())";
// Codex passes the command as cmd.exe's final /c argument. Expanding its
// trailing transport quote avoids nested literal quotes being mangled en route.
const CMD_QUOTE = "%cmdcmdline:~-1%";
const SAFE_ARGUMENT = /^[A-Za-z0-9_-]+$/;
const ADAPTERS = new Set(["cursor", "kiro"]);

export function buildEntrypointCommand(entrypoint, argument) {
  if (typeof entrypoint !== "string" || entrypoint.length === 0) {
    throw new Error("Entrypoint must be a non-empty path.");
  }
  if (typeof argument !== "string" || !SAFE_ARGUMENT.test(argument)) {
    throw new Error("Command argument contains shell syntax.");
  }

  const encodedEntrypoint = Buffer.from(entrypoint, "utf8").toString("base64url");
  return `node -e "${ENTRYPOINT_BOOTSTRAP}" ${encodedEntrypoint} ${argument}`;
}

export function buildPinnedEntrypointCommand(
  entrypoint,
  argument,
  runtime = process.execPath,
  platform = process.platform,
  shell = defaultPinnedShell(platform)
) {
  validatePinnedEntrypointInput(entrypoint, argument, runtime, platform);
  if (!pinnedShells(platform).includes(shell)) {
    throw new Error(`Unsupported pinned shell for ${platform}: ${shell}`);
  }
  const encodedEntrypoint = Buffer.from(entrypoint, "utf8").toString("base64url");
  const bootstrap = shell === "cmd"
    ? `${CMD_QUOTE}${ENTRYPOINT_BOOTSTRAP}${CMD_QUOTE}`
    : `"${ENTRYPOINT_BOOTSTRAP}"`;
  return `${pinnedRuntimeInvocation(runtime, platform, shell)} -e ${bootstrap} ${encodedEntrypoint} ${argument}`;
}

export function buildPinnedEntrypointCommands(
  entrypoint,
  argument,
  runtime = process.execPath,
  platform = process.platform
) {
  validatePinnedEntrypointInput(entrypoint, argument, runtime, platform);
  return pinnedShells(platform).map(shell => ({
    shell,
    command: buildPinnedEntrypointCommand(entrypoint, argument, runtime, platform, shell)
  }));
}

export function adapterCommand(provider, root, platform = process.platform) {
  if (!ADAPTERS.has(provider)) {
    throw new Error(`Unsupported adapter: ${provider}`);
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return buildEntrypointCommand(pathApi.join(root, "core", "gate.mjs"), provider);
}

function validatePinnedEntrypointInput(entrypoint, argument, runtime, platform) {
  if (typeof runtime !== "string" || runtime.length === 0) {
    throw new Error("Runtime must be a non-empty path.");
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(runtime)) {
    throw new Error("Runtime must be an absolute path.");
  }
  if (typeof entrypoint !== "string" || entrypoint.length === 0) {
    throw new Error("Entrypoint must be a non-empty path.");
  }
  if (typeof argument !== "string" || !SAFE_ARGUMENT.test(argument)) {
    throw new Error("Command argument contains shell syntax.");
  }
}

function pinnedShells(platform) {
  return platform === "win32" ? ["powershell", "cmd", "posix"] : ["posix"];
}

function defaultPinnedShell(platform) {
  return platform === "win32" ? "powershell" : "posix";
}

function pinnedRuntimeInvocation(value, platform, shell) {
  if (shell === "powershell") {
    const encodedRuntime = Buffer.from(value, "utf8").toString("base64");
    return `& ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedRuntime}')))`;
  }
  if (shell === "cmd") {
    return `${CMD_QUOTE}${quoteCmdPath(value)}${CMD_QUOTE}`;
  }
  if (shell !== "posix") {
    throw new Error(`Unsupported pinned shell: ${shell}`);
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quoteCmdPath(value) {
  if (/["\r\n\0%!]/.test(value)) {
    throw new Error("Runtime path cannot be represented safely for cmd.exe.");
  }
  return value;
}
