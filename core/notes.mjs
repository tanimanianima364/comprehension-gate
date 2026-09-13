/*
 * Which changed paths still have nothing recorded about them, and which notes
 * already say something about a path.
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
import { encodePath } from "./changes.mjs";

export const NOTES_DIRECTORY = "docs/notes";

const NOTE_PREFIX = `${NOTES_DIRECTORY}/`;
const FRONT_MATTER_FENCE = "---";
// A key at column zero ends a list; an entry is a dash, a space, and a name.
const KEY_LINE = /^[A-Za-z_][A-Za-z0-9_-]*:/;
// An entry is indentation, a dash, ONE space, and then the name verbatim. The
// space after the dash is the whole of the fixed prefix: a second one belongs
// to the name, since a file name may begin with a space, and eating it made a
// note that named " app.js" cover "app.js" instead.
const ENTRY_LINE = /^\s+- (.*)$/;

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

/*
 * Every note that accounts for any of these paths, oldest file name first,
 * each saying whether a later note replaced it. The reader needs that last
 * part: a path covered by two notes must not send them to the stale one first.
 *
 * It takes the whole list rather than one path at a time because the tree is
 * read once per call. A patch touching two hundred files against a repository
 * holding five thousand notes would otherwise read a million files inside a
 * hook that has twenty seconds to answer.
 *
 * Unlike coverage this is not scoped to a change set: the question here is
 * what is on record about this file, and a note an earlier branch left is
 * exactly what someone about to edit it should read.
 */
export function notesCovering(root, candidates) {
  const targets = new Set(candidates);
  const notes = readNotes(root);
  const superseders = new Map();
  for (const note of notes) {
    for (const id of note.supersedes) {
      superseders.set(id, note.file);
    }
  }
  return notes
    .filter(note => note.covers.some(entry => targets.has(entry)))
    .map(note => ({
      file: note.file,
      title: note.title,
      supersededBy: superseders.get(note.id) ?? null
    }));
}

export function isNotePath(candidate) {
  return typeof candidate === "string" && candidate.startsWith(NOTE_PREFIX);
}

function coveredPaths(root, inChangeSet) {
  const covered = new Set();
  for (const note of readNotes(root)) {
    /*
     * Spelled the way the change set spells it, escape character included,
     * for this comparison only. Without it a note called `n%.md` is never
     * found in the set -- while a base note that happens to be called
     * `n%25.md` is, and covers this change with a record that was never about
     * it. The spelling is a matching key, not a file name: the note's own path
     * stays as it is on disk, since that is what the reader is sent to open.
     */
    if (!inChangeSet.has(encodePath(note.file))) {
      continue;
    }
    for (const entry of note.covers) {
      covered.add(entry);
    }
  }
  return covered;
}

function readNotes(root) {
  const notes = [];
  for (const notePath of noteFiles(path.join(root, ...NOTES_DIRECTORY.split("/")))) {
    let bytes;
    try {
      bytes = fs.readFileSync(notePath);
    } catch {
      continue;
    }
    /*
     * A note that is not valid UTF-8 is not read at all. Decoding it anyway
     * replaces each bad byte with U+FFFD, and a `covers` entry that then reads
     * as "src\uFFFD.js" covers a real file of that name -- one the note never
     * meant, silenced by an encoding accident.
     */
    const text = bytes.toString("utf8");
    if (Buffer.compare(Buffer.from(text, "utf8"), bytes) !== 0) {
      continue;
    }
    const frontMatter = frontMatterOf(text);
    if (frontMatter === null) {
      continue;
    }
    notes.push({
      file: repositoryPath(root, notePath),
      id: path.basename(notePath, ".md"),
      covers: parseList(frontMatter.keys, "covers")
        .map(coveredPath)
        .filter(entry => entry !== null),
      supersedes: parseList(frontMatter.keys, "supersedes"),
      title: titleOf(frontMatter.body)
    });
  }
  return notes;
}

function titleOf(body) {
  for (const line of body) {
    const match = line.match(/^#\s+(.+)$/);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

/*
 * Ordered by file name rather than by position in the tree, and sorted once
 * the whole walk is done. The names carry the date, so this is what puts a
 * path's notes oldest first; sorting each directory as it is reached would
 * order an archived 2026-01 note after a 2026-09 one sitting at the top level.
 */
function noteFiles(root) {
  return walk(root).sort(
    (left, right) => compare(path.basename(left), path.basename(right)) || compare(left, right)
  );
}

function walk(directory) {
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
      files.push(...walk(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files;
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

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
  return end === -1 ? null : { keys: lines.slice(1, end), body: lines.slice(end + 1) };
}

function parseList(keys, key) {
  const start = keys.findIndex(line => line.trimEnd() === `${key}:`);
  if (start === -1) {
    return [];
  }
  const items = [];
  for (const line of keys.slice(start + 1)) {
    if (line.trim() === "") {
      continue;
    }
    if (KEY_LINE.test(line)) {
      break;
    }
    const entry = line.match(ENTRY_LINE);
    if (entry === null || entry[1] === "") {
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
  // Spelled the way a path from git is spelled: the escape character escaped,
  // so an entry naming a file called `x%FF.js` meets the path git reports for
  // it rather than the one it reports for a name holding a raw 0xFF.
  const normalized = encodePath(path.posix.normalize(entry));
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  return normalized === "." ? null : normalized.replace(/^\.\//, "");
}

// The repository's own spelling. This runs on POSIX only, where the separator
// is the one git uses and a backslash in a name is part of the name.
function repositoryPath(root, target) {
  return path.relative(root, target);
}
