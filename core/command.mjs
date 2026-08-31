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
  extraArguments = []
) {
  if (typeof runtime !== "string" || runtime.length === 0) {
    throw new Error("Runtime must be a non-empty path.");
  }
  if (!path.isAbsolute(runtime)) {
    throw new Error("Runtime must be an absolute path.");
  }
  if (typeof entrypoint !== "string" || entrypoint.length === 0) {
    throw new Error("Entrypoint must be a non-empty path.");
  }
  if (typeof argument !== "string" || !SAFE_ARGUMENT.test(argument)) {
    throw new Error("Command argument contains shell syntax.");
  }
  if (!Array.isArray(extraArguments) || extraArguments.some(value =>
    typeof value !== "string" || !SAFE_ARGUMENT.test(value)
  )) {
    throw new Error("Extra command argument contains shell syntax.");
  }

  const encodedEntrypoint = Buffer.from(entrypoint, "utf8").toString("base64url");
  const suffix = [encodedEntrypoint, argument, ...extraArguments].join(" ");
  return `${quotePath(runtime)} -e "${ENTRYPOINT_BOOTSTRAP}" ${suffix}`;
}

export function adapterCommand(provider, root) {
  if (!ADAPTERS.has(provider)) {
    throw new Error(`Unsupported adapter: ${provider}`);
  }
  return buildEntrypointCommand(path.join(root, "core", "gate.mjs"), provider);
}

// Single-quoting keeps every byte of the runtime path literal, so plugin-path
// bytes are never interpreted as shell syntax.
function quotePath(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
