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
// A key at column zero ends a list; an entry is a dash, a space, and a name.
const KEY_LINE = /^[A-Za-z_][A-Za-z0-9_-]*:/;
const ENTRY_LINE = /^\s+-[ \t]+(\S.*)$/;

export function uncoveredPaths(root, changed) {
  const covered = coveredPaths(root, new Set(changed));
  return changed.filter(
    candidate =>
      typeof candidate === "string" &&
      candidate !== "" &&
      !candidate.startsWith(NOTE_PREFIX) &&
      !covered.has(candidate)
  );
}

function coveredPaths(root, inChangeSet) {
  const covered = new Set();
  for (const notePath of noteFiles(path.join(root, ...NOTES_DIRECTORY.split("/")))) {
    if (!inChangeSet.has(repositoryPath(root, notePath))) {
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(notePath, "utf8");
    } catch {
      continue;
    }
    const frontMatter = frontMatterOf(text);
    if (frontMatter === null) {
      continue;
    }
    for (const entry of parseList(frontMatter, "covers")) {
      const repositoryRelative = coveredPath(entry);
      if (repositoryRelative !== null) {
        covered.add(repositoryRelative);
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
 * strings. Both spellings a writer reaches for are read -- the block list and
 * the inline `[a, b]` -- because a list spelled the other way would silently
 * cover nothing.
 *
 * Leniency past that point runs the wrong way, and this is the one place in
 * the plugin where failing soft is not the safe direction. Failing to read a
 * list leaves its paths reported, which someone notices and can fix; reading
 * one loosely silences paths the note never explained, which nobody ever finds
 * out about. So anything that is not unambiguously a list of strings -- an
 * unclosed bracket, an unterminated quote, a bare scalar -- reads as no list
 * at all.
 */
/*
 * Front matter is read by hand, and the grammar it accepts is deliberately
 * smaller than YAML's rather than an approximation of it.
 *
 * A key line is the key and nothing else. An entry is `- ` and then the rest
 * of the line, taken literally: no quoting, no escaping, no inline `[a, b]`,
 * no comments. There is nothing in an entry to decode, so nothing to decode
 * wrongly -- and every character a richer format would have treated as syntax
 * is simply part of the name, which is what a file name is.
 *
 * That is the lesson of three rounds of fixes to a reader that tried to accept
 * YAML's spelling of a list: each round closed one hole and left the next.
 * Quoted strings mis-decoded into names the note never wrote; a comma inside a
 * quoted path split it in two; a continuation line ended the list early and
 * kept a prefix of a path as though it were the path. Every one of those
 * silenced a file nobody would ever learn was missed.
 *
 * So the list is read whole or not at all. The next key ends it; a blank line
 * does not; anything else voids it, because a line this reader cannot read is
 * a line whose meaning it is guessing at.
 */
function frontMatterOf(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONT_MATTER_FENCE) {
    return null;
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === FRONT_MATTER_FENCE);
  return end === -1 ? null : lines.slice(1, end);
}

function parseList(frontMatter, key) {
  const start = frontMatter.findIndex(line => line.trimEnd() === `${key}:`);
  if (start === -1) {
    return [];
  }
  const items = [];
  for (const line of frontMatter.slice(start + 1)) {
    if (line.trim() === "") {
      continue;
    }
    if (KEY_LINE.test(line)) {
      break;
    }
    const entry = line.match(ENTRY_LINE);
    if (entry === null) {
      return [];
    }
    /*
     * Not trimmed. A trailing space is a legal part of a file name, and taking
     * it off made a note that named "app.js " cover "app.js" instead -- a path
     * it never mentioned silenced, and the one it did mention still reported.
     * An entry with an accidental trailing space now simply matches nothing,
     * which is the direction that leaves the path in the reminder.
     */
    items.push(entry[1]);
  }
  return items;
}

/*
 * A `covers` entry is spelled by a person and has to reach the spelling git
 * uses: `/`-separated, repository-relative, no leading `./`. It is never
 * rewritten beyond that -- in particular a backslash stays a backslash, since
 * it is a legal character in a POSIX file name and git reports it as one. An
 * entry that escapes the repository names something the change set can never
 * contain, so it is dropped rather than allowed to match by accident.
 */
function coveredPath(entry) {
  if (entry === "") {
    return null;
  }
  const normalized = path.posix.normalize(entry);
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  return normalized === "." ? null : normalized.replace(/^\.\//, "");
}

// An OS path into repository spelling. Only a host whose separator is a
// backslash has anything to convert; on a POSIX host a backslash in a name is
// part of the name.
function repositoryPath(root, target) {
  const relative = path.relative(root, target);
  return path.sep === "\\" ? relative.replaceAll("\\", "/") : relative;
}
