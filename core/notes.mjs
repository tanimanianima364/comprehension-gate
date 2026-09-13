/*
 * Which changed paths still have nothing recorded about them.
 *
 * A note is a markdown file under docs/notes whose front matter names, in
 * `covers`, the repository-relative paths the note accounts for. Notes are
 * immutable once written, so a path accumulates notes rather than having one
 * rewritten; any note naming a path is enough to cover it, and a later note
 * that supersedes an earlier one says so in prose for the reader rather than
 * changing what is covered.
 *
 * Everything here fails soft. A note that cannot be read or parsed covers
 * nothing, and an unreadable tree covers nothing at all: the reminder is the
 * only signal there is, so reporting a path as uncovered is always safer than
 * throwing the hook away. Nothing here decides whether a path deserves a note
 * -- that judgment stays with the agent.
 */

import fs from "node:fs";
import path from "node:path";

export const NOTES_DIRECTORY = "docs/notes";

const NOTE_PREFIX = `${NOTES_DIRECTORY}/`;
const FRONT_MATTER_FENCE = "---";

export function uncoveredPaths(root, paths) {
  const covered = coveredPaths(root);
  return paths.filter(candidate => {
    const normalized = normalizeCandidate(candidate);
    return normalized !== null && !normalized.startsWith(NOTE_PREFIX) && !covered.has(normalized);
  });
}

function coveredPaths(root) {
  const covered = new Set();
  for (const notePath of noteFiles(path.join(root, ...NOTES_DIRECTORY.split("/")))) {
    let text;
    try {
      text = fs.readFileSync(notePath, "utf8");
    } catch {
      continue;
    }
    for (const entry of parseCovers(text)) {
      const normalized = normalizeCovered(entry);
      if (normalized !== null) {
        covered.add(normalized);
      }
    }
  }
  return covered;
}

function noteFiles(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...noteFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files;
}

/*
 * Front matter is read by hand rather than with a YAML parser: the plugin has
 * no dependencies, and the one key that has to be machine-read is a list of
 * strings. Both spellings a writer reaches for are accepted, because a note
 * whose list is spelled the other way would silently cover nothing.
 */
function parseCovers(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONT_MATTER_FENCE) {
    return [];
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === FRONT_MATTER_FENCE);
  if (end === -1) {
    return [];
  }
  const frontMatter = lines.slice(1, end);
  const start = frontMatter.findIndex(line => /^covers:/.test(line));
  if (start === -1) {
    return [];
  }

  const inline = frontMatter[start].slice("covers:".length).trim();
  if (inline !== "") {
    return inline
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",");
  }

  const items = [];
  for (const line of frontMatter.slice(start + 1)) {
    const match = line.match(/^\s*-\s*(.+)$/);
    if (!match) {
      break;
    }
    items.push(match[1]);
  }
  return items;
}

function normalizeCovered(entry) {
  return normalizeCandidate(String(entry).trim().replace(/^["']|["']$/g, ""));
}

// Repository-relative, POSIX-spelled, and inside the repository. An entry that
// escapes it names something the change set can never contain, so it is
// dropped rather than allowed to cover a path by accident.
function normalizeCandidate(candidate) {
  if (typeof candidate !== "string" || candidate === "") {
    return null;
  }
  const normalized = path.posix.normalize(candidate.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  return normalized === "." ? null : normalized.replace(/^\.\//, "");
}
