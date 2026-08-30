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

export function adapterCommand(provider, root, platform = process.platform) {
  if (!ADAPTERS.has(provider)) {
    throw new Error(`Unsupported adapter: ${provider}`);
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return buildEntrypointCommand(pathApi.join(root, "core", "gate.mjs"), provider);
}
