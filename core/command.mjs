import path from "node:path";

const ENTRYPOINT_BOOTSTRAP = "import('node:url').then(m=>import(m.pathToFileURL(Buffer.from(process.argv[1],'base64url').toString('utf8')).href)).then(m=>m.main())";
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
  platform = process.platform
) {
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

  const encodedEntrypoint = Buffer.from(entrypoint, "utf8").toString("base64url");
  return `${pinnedRuntimeInvocation(runtime, platform)} -e "${ENTRYPOINT_BOOTSTRAP}" ${encodedEntrypoint} ${argument}`;
}

export function adapterCommand(provider, root, platform = process.platform) {
  if (!ADAPTERS.has(provider)) {
    throw new Error(`Unsupported adapter: ${provider}`);
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return buildEntrypointCommand(pathApi.join(root, "core", "gate.mjs"), provider);
}

function pinnedRuntimeInvocation(value, platform) {
  if (platform === "win32") {
    const encodedRuntime = Buffer.from(value, "utf8").toString("base64");
    return `& ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedRuntime}')))`;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
