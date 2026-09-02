/*
 * What "the project changed" means to the gate.
 *
 * The project is the git repository containing the hook's working directory,
 * including every worktree of that repository, so a worktree created anywhere
 * is still inside. A snapshot is each worktree's HEAD plus a content hash for
 * every path `git status` reports; ignored files are never reported, so a
 * scratch file under a gitignored directory is free. Two snapshots differ when
 * a HEAD moved or a path's hash changed, appeared, or disappeared.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const GIT_TIMEOUT_MS = 10_000;
const CHUNK_BYTES = 1024 * 1024;
const chunk = Buffer.allocUnsafe(CHUNK_BYTES);

function git(directory, args) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_TIMEOUT_MS
  });
}

export function findRepository(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    return null;
  }
  let commonDir;
  let listing;
  try {
    const reported = git(directory, ["rev-parse", "--git-common-dir"]).trim();
    commonDir = fs.realpathSync(path.resolve(directory, reported));
    listing = git(directory, ["worktree", "list", "--porcelain"]);
  } catch {
    return null;
  }
  const worktrees = [];
  for (const line of listing.split("\n")) {
    if (!line.startsWith("worktree ")) {
      continue;
    }
    try {
      worktrees.push(fs.realpathSync(line.slice("worktree ".length)));
    } catch {
      // A worktree whose directory is gone has nothing to snapshot.
    }
  }
  return { commonDir, worktrees };
}

export function captureSnapshot(repository) {
  const worktrees = {};
  for (const worktree of repository.worktrees) {
    worktrees[worktree] = { head: headOf(worktree), entries: entriesOf(worktree) };
  }
  return { worktrees };
}

export function snapshotDifference(baseline, current) {
  const changes = [];
  const names = new Set([...Object.keys(baseline.worktrees), ...Object.keys(current.worktrees)]);
  for (const name of [...names].sort()) {
    const before = baseline.worktrees[name] ?? { head: null, entries: {} };
    const after = current.worktrees[name] ?? { head: null, entries: {} };
    if (before.head !== after.head) {
      changes.push(`${name} (HEAD)`);
    }
    const paths = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
    for (const relativePath of [...paths].sort()) {
      if (before.entries[relativePath] !== after.entries[relativePath]) {
        changes.push(path.join(name, relativePath));
      }
    }
  }
  return changes;
}

function headOf(worktree) {
  try {
    return git(worktree, ["rev-parse", "--verify", "HEAD"]).trim();
  } catch {
    return null;
  }
}

/*
 * Porcelain v1 with -z: `XY PATH\0`, and for a rename or copy the original
 * path follows as its own `\0`-terminated field. --untracked-files=all lists
 * files inside untracked directories individually.
 */
function entriesOf(worktree) {
  const output = git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const fields = output.split("\0");
  const entries = {};
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) {
      continue;
    }
    const status = field.slice(0, 2);
    const relativePath = field.slice(3);
    entries[relativePath] = hashOf(path.join(worktree, relativePath));
    if (status[0] === "R" || status[0] === "C") {
      index += 1;
      const original = fields[index];
      if (original) {
        entries[original] = hashOf(path.join(worktree, original));
      }
    }
  }
  return entries;
}

function hashOf(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      return `link:${createHash("sha256").update(fs.readlinkSync(filePath)).digest("hex")}`;
    }
    if (stat.isDirectory()) {
      return `directory:${createHash("sha256").update(directoryListing(filePath)).digest("hex")}`;
    }
    return contentHash(filePath);
  } catch {
    return "missing";
  }
}

/*
 * `git status` never descends into another repository: a nested checkout or a
 * submodule is one entry naming a directory. Its contents are described here
 * instead, by every regular file's path, size and modification time, so a
 * second change inside it is still a change.
 */
function directoryListing(directory) {
  const lines = [];
  const pending = [""];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    for (const entry of fs.readdirSync(path.join(directory, relativeDirectory), { withFileTypes: true })) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git") {
          pending.push(relativePath);
        }
        continue;
      }
      // Symlinks are neither a directory nor a file here, so nothing is followed.
      if (!entry.isFile()) {
        continue;
      }
      const stat = fs.lstatSync(path.join(directory, relativePath));
      lines.push(`${relativePath}\0${stat.size}\0${stat.mtimeMs}\n`);
    }
  }
  return lines.sort().join("");
}

// Read in chunks: an untracked artifact that is not gitignored can be larger
// than memory allows, and it is hashed three or more times per turn.
function contentHash(filePath) {
  const digest = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  try {
    let read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
    while (read > 0) {
      digest.update(chunk.subarray(0, read));
      read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest("hex");
}
