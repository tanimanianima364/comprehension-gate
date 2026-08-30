import fs from "node:fs";
import path from "node:path";

// Data values each action takes after the encoded workspace argument; the
// single source of truth for both the action set and its arity.
const INSPECTION_VALUE_COUNTS = new Map([
  ["inspect-read", 1],
  ["inspect-search", 2]
]);

export const INSPECTION_ACTIONS = new Set(INSPECTION_VALUE_COUNTS.keys());

export function inspectionValueCount(action) {
  const count = INSPECTION_VALUE_COUNTS.get(action);
  if (count === undefined) {
    throw new Error(`Unknown inspection action: ${action}`);
  }
  return count;
}

const READ_LIMIT = 256 * 1024;
const SEARCH_PATTERN_LIMIT = 256;
const SEARCH_FILE_LIMIT = 5_000;
const SEARCH_FILE_SIZE_LIMIT = 1024 * 1024;
const SEARCH_TOTAL_BYTES_LIMIT = 20 * 1024 * 1024;
const SEARCH_MATCH_LIMIT = 200;
const SEARCH_OUTPUT_LIMIT = 128 * 1024;
const SEARCH_LINE_LIMIT = 300;
const SKIPPED_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeInspectionArgument(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Inspection arguments must be non-empty strings.");
  }
  return Buffer.from(value, "utf8").toString("base64url");
}

export function decodeInspectionArgument(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Inspection argument is not canonical base64url.");
  }
  const bytes = Buffer.from(token, "base64url");
  if (bytes.toString("base64url") !== token) {
    throw new Error("Inspection argument is not canonical base64url.");
  }
  let value;
  try {
    value = utf8Decoder.decode(bytes);
  } catch {
    throw new Error("Inspection argument is not valid UTF-8.");
  }
  if (value.length === 0 || value.includes("\0")) {
    throw new Error("Inspection argument is empty or contains NUL.");
  }
  return value;
}

export function runInspection(action, encodedArguments, output = process.stdout) {
  if (!INSPECTION_ACTIONS.has(action)) {
    throw new Error(`Unknown inspection action: ${action}`);
  }
  const expectedArity = inspectionValueCount(action) + 1;
  if (!Array.isArray(encodedArguments) || encodedArguments.length !== expectedArity) {
    throw new Error(`${action} expects ${expectedArity} encoded arguments.`);
  }
  const [workspaceValue, ...values] = encodedArguments.map(decodeInspectionArgument);
  const workspace = trustedWorkspace(workspaceValue);
  if (action === "inspect-read") {
    output.write(inspectRead(workspace, values[0]));
    return;
  }
  output.write(inspectSearch(workspace, values[0], values[1]));
}

function trustedWorkspace(value) {
  if (!path.isAbsolute(value)) {
    throw new Error("Inspection workspace must be absolute.");
  }
  const workspace = fs.realpathSync(value);
  if (!fs.statSync(workspace).isDirectory()) {
    throw new Error("Inspection workspace is not a directory.");
  }
  return workspace;
}

function inspectRead(workspace, requestedPath) {
  const filePath = resolveInside(workspace, requestedPath);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error("Inspection target is not a regular file.");
  }
  if (stat.size > READ_LIMIT) {
    throw new Error(`Inspection target exceeds ${READ_LIMIT} bytes.`);
  }
  const bytes = fs.readFileSync(filePath);
  return `${decodeText(bytes, "Inspection target")}\n`;
}

function inspectSearch(workspace, pattern, requestedRoot) {
  if (Buffer.byteLength(pattern, "utf8") > SEARCH_PATTERN_LIMIT) {
    throw new Error(`Search pattern exceeds ${SEARCH_PATTERN_LIMIT} bytes.`);
  }
  const searchRoot = resolveInside(workspace, requestedRoot);
  if (!fs.statSync(searchRoot).isDirectory()) {
    throw new Error("Inspection search root is not a directory.");
  }

  const needle = pattern.toLocaleLowerCase("en-US");
  const stack = [searchRoot];
  const matches = [];
  let visitedFiles = 0;
  let visitedBytes = 0;
  let outputBytes = 0;
  let truncated = false;

  while (stack.length > 0 && !truncated) {
    const directory = stack.pop();
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          stack.push(entryPath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      visitedFiles += 1;
      if (visitedFiles > SEARCH_FILE_LIMIT) {
        truncated = true;
        break;
      }
      const stat = fs.statSync(entryPath);
      if (stat.size > SEARCH_FILE_SIZE_LIMIT) {
        continue;
      }
      visitedBytes += stat.size;
      if (visitedBytes > SEARCH_TOTAL_BYTES_LIMIT) {
        truncated = true;
        break;
      }
      let text;
      try {
        text = decodeText(fs.readFileSync(entryPath), "Search target");
      } catch {
        continue;
      }
      const relative = path.relative(workspace, entryPath).split(path.sep).join("/");
      const encodedPath = encodeInspectionArgument(relative);
      const lines = text.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        if (!lines[lineIndex].toLocaleLowerCase("en-US").includes(needle)) {
          continue;
        }
        const snippet = lines[lineIndex].slice(0, SEARCH_LINE_LIMIT);
        const rendered = `${relative}:${lineIndex + 1}: ${snippet} [read-token:${encodedPath}]\n`;
        const renderedBytes = Buffer.byteLength(rendered, "utf8");
        if (matches.length >= SEARCH_MATCH_LIMIT || outputBytes + renderedBytes > SEARCH_OUTPUT_LIMIT) {
          truncated = true;
          break;
        }
        matches.push(rendered);
        outputBytes += renderedBytes;
      }
      if (truncated) {
        break;
      }
    }
  }
  if (truncated) {
    matches.push("[inspection-search:truncated]\n");
  }
  return matches.join("");
}

function resolveInside(workspace, requestedPath) {
  if (path.isAbsolute(requestedPath) || path.win32.isAbsolute(requestedPath)) {
    throw new Error("Inspection paths must be relative to the workspace.");
  }
  const candidate = fs.realpathSync(path.resolve(workspace, requestedPath));
  const relative = path.relative(workspace, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Inspection path escapes the workspace.");
  }
  return candidate;
}

function decodeText(bytes, label) {
  if (bytes.includes(0)) {
    throw new Error(`${label} is binary.`);
  }
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}
