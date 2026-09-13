import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { NOTES_DIRECTORY, uncoveredPaths } from "../core/notes.mjs";
import { createRepository } from "./helpers.mjs";

function writeNote(repository, name, body) {
  const target = path.join(repository, NOTES_DIRECTORY, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

const NOTE = `---
covers:
  - core/gate.mjs
  - core/changes.mjs
---

# What this change was for
`;

/*
 * The defect this file exists to prevent. A note covers the change it is part
 * of, not the path forever: one left by an earlier branch records what that
 * change was for, so a later branch changing the same file is reported again.
 * Without this, the first note about a file silences it for good, and on a
 * repository of any age the reminder decays into nothing.
 */
test("a note from an earlier change does not cover a later one", () => {
  const repository = createRepository();
  writeNote(repository, "2026-01-01-an-earlier-branch-0a1b2c3d.md", NOTE);
  assert.deepEqual(uncoveredPaths(repository, ["core/gate.mjs"]), ["core/gate.mjs"]);
});

test("a repository with no notes leaves every path uncovered", () => {
  const repository = createRepository();
  assert.deepEqual(uncoveredPaths(repository, ["core/gate.mjs", "README.md"]), [
    "core/gate.mjs",
    "README.md"
  ]);
});

test("a note covers exactly the paths it lists", () => {
  const repository = createRepository();
  const note = "2026-09-13-a-gate-rewrite-a1b2c3d4.md";
  writeNote(repository, note, NOTE);
  assert.deepEqual(
    uncoveredPaths(repository, [
      `${NOTES_DIRECTORY}/${note}`,
      "core/gate.mjs",
      "core/changes.mjs",
      "README.md"
    ]),
    ["README.md"]
  );
});

test("notes in subdirectories are found, and several notes are read together", () => {
  const repository = createRepository();
  writeNote(repository, "2026-09-13-one-a1b2c3d4.md", "---\ncovers:\n  - core/gate.mjs\n---\n");
  writeNote(repository, "archive/2026-01-01-two-b2c3d4e5.md", "---\ncovers:\n  - README.md\n---\n");
  assert.deepEqual(
    uncoveredPaths(repository, [
      `${NOTES_DIRECTORY}/2026-09-13-one-a1b2c3d4.md`,
      `${NOTES_DIRECTORY}/archive/2026-01-01-two-b2c3d4e5.md`,
      "core/gate.mjs",
      "README.md",
      "other.js"
    ]),
    ["other.js"]
  );
});

/*
 * A note the parser cannot read must leave its paths uncovered rather than
 * throw: the reminder is the only signal there is, and a hook that crashed
 * would remove it silently.
 */
test("a note with no front matter, an unterminated one, or no covers key covers nothing", () => {
  const repository = createRepository();
  writeNote(repository, "prose.md", "# Just prose\n\ncovers: core/gate.mjs\n");
  writeNote(repository, "unterminated.md", "---\ncovers:\n  - core/changes.mjs\n");
  writeNote(repository, "empty.md", "---\nsupersedes: []\n---\n");
  assert.deepEqual(
    uncoveredPaths(repository, [
      `${NOTES_DIRECTORY}/prose.md`,
      `${NOTES_DIRECTORY}/unterminated.md`,
      `${NOTES_DIRECTORY}/empty.md`,
      "core/gate.mjs",
      "core/changes.mjs"
    ]),
    ["core/gate.mjs", "core/changes.mjs"]
  );
});

test("a covers entry is normalized, and one that escapes the repository is ignored", () => {
  const repository = createRepository();
  writeNote(
    repository,
    "odd.md",
    "---\ncovers:\n  - ./core/gate.mjs\n  - core//changes.mjs\n  - ../outside.js\n  - /etc/passwd\n---\n"
  );
  assert.deepEqual(
    uncoveredPaths(repository, [
      `${NOTES_DIRECTORY}/odd.md`,
      "core/gate.mjs",
      "core/changes.mjs",
      "outside.js"
    ]),
    ["outside.js"]
  );
});

// Writing a note must not itself demand a note.
test("the notes directory is never uncovered", () => {
  const repository = createRepository();
  assert.deepEqual(
    uncoveredPaths(repository, [`${NOTES_DIRECTORY}/2026-09-13-a-a1b2c3d4.md`, "core/gate.mjs"]),
    ["core/gate.mjs"]
  );
});

test("an unreadable notes tree leaves every path uncovered instead of throwing", { skip: process.getuid?.() === 0 }, () => {
  const repository = createRepository();
  fs.mkdirSync(path.join(repository, NOTES_DIRECTORY), { recursive: true });
  fs.writeFileSync(path.join(repository, NOTES_DIRECTORY, "note.md"), NOTE);
  fs.chmodSync(path.join(repository, NOTES_DIRECTORY, "note.md"), 0o000);
  try {
    assert.deepEqual(
      uncoveredPaths(repository, [`${NOTES_DIRECTORY}/note.md`, "core/gate.mjs"]),
      ["core/gate.mjs"]
    );
  } finally {
    fs.chmodSync(path.join(repository, NOTES_DIRECTORY, "note.md"), 0o644);
  }
});

/*
 * Reading a list is where leniency runs the wrong way. Failing to read one
 * leaves its paths reported, which is recoverable; reading one loosely
 * silences paths the note never explained, which nobody ever finds out about.
 */
const MALFORMED = [
  ["an inline list", "covers: [core/gate.mjs]"],
  ["an unclosed inline list", "covers: [core/gate.mjs"],
  ["a scalar where a list is required", "covers: core/gate.mjs"],
  ["a quoted scalar where a list is required", 'covers: "core/gate.mjs"'],
  ["no space between the key and a value", "covers:[core/gate.mjs]"],
  ["anything after the key", "covers: # the files this change touched"]
];

for (const [description, line] of MALFORMED) {
  test(`${description} covers nothing`, () => {
    const repository = createRepository();
    writeNote(repository, "broken.md", `---\n${line}\n---\n`);
    assert.deepEqual(
      uncoveredPaths(repository, [`${NOTES_DIRECTORY}/broken.md`, "core/gate.mjs"]),
      ["core/gate.mjs"]
    );
  });
}

// Splitting on every comma turned one quoted path into two, which both failed
// to cover the real path and silenced two files the note had never named.
test("an unquoted comma in a block entry is part of the path too", () => {
  const repository = createRepository();
  writeNote(repository, "comma-block.md", "---\ncovers:\n  - src/a,b.js\n---\n");
  assert.deepEqual(
    uncoveredPaths(repository, [`${NOTES_DIRECTORY}/comma-block.md`, "src/a,b.js", "src/a"]),
    ["src/a"]
  );
});

/*
 * Reading a list is where leniency runs the wrong way, and an entry is not a
 * miniature language: there is no quoting, no escaping and no inline form to
 * get wrong, so the only thing left to check is that every line is an entry.
 */
const MALFORMED_BLOCK = [
  ["a dash with no space after it", "  -core/gate.mjs"],
  ["a dash with nothing after it", "  -"],
  ["a line that is neither an entry nor a key", "  - core/gate.mjs\n  stray"],
  ["a continuation line", "  - core/gate\n    .mjs"],
  ["a comment between entries", "  # why\n  - core/gate.mjs"],
  ["a trailing comment", "  - core/gate.mjs # why"]
];

for (const [description, line] of MALFORMED_BLOCK) {
  test(`a block entry with ${description} covers nothing`, () => {
    const repository = createRepository();
    writeNote(repository, "broken.md", `---\ncovers:\n${line}\n---\n`);
    assert.deepEqual(
      uncoveredPaths(repository, [`${NOTES_DIRECTORY}/broken.md`, "core/gate.mjs"]),
      ["core/gate.mjs"]
    );
  });
}

test("a changed path is matched as the name git gave, not rewritten", () => {
  const repository = createRepository();
  assert.deepEqual(uncoveredPaths(repository, ["docs\\notes\\src.js"]), ["docs\\notes\\src.js"]);
  assert.deepEqual(uncoveredPaths(repository, ["..\\src.js"]), ["..\\src.js"]);
  assert.deepEqual(uncoveredPaths(repository, ["a\\b.js"]), ["a\\b.js"]);
});


/*
 * Everything about an entry is literal, so a name holding a character another
 * format would have treated as syntax is spelled plainly and matched plainly.
 */
const LITERAL = ["a#b.js", "a'b.js", 'a"b.js', "a\\b.js", "a,b.js", "a[b].js", "a b.js"];

for (const name of LITERAL) {
  test(`an entry naming ${JSON.stringify(name)} is taken literally`, () => {
    const repository = createRepository();
    writeNote(repository, "literal.md", `---\ncovers:\n  - ${name}\n---\n`);
    assert.deepEqual(uncoveredPaths(repository, [`${NOTES_DIRECTORY}/literal.md`, name]), []);
  });
}

/*
 * A list is read whole or not at all. Stopping at the first line it could not
 * read kept whatever came before it, which covered a path the note had not
 * named -- `- src/report` followed by an indented `final.js` is one path in
 * every format that allows the continuation, and two in none.
 */
test("a list that is not read whole covers nothing at all", () => {
  const repository = createRepository();
  writeNote(
    repository,
    "partial.md",
    "---\ncovers:\n  - core/gate.mjs\n  - src/report\n    final.js\n---\n"
  );
  assert.deepEqual(
    uncoveredPaths(repository, [
      `${NOTES_DIRECTORY}/partial.md`,
      "core/gate.mjs",
      "src/report",
      "src/report final.js"
    ]),
    ["core/gate.mjs", "src/report", "src/report final.js"]
  );
});

test("the next key ends the list without voiding it", () => {
  const repository = createRepository();
  writeNote(
    repository,
    "keys.md",
    "---\ncovers:\n  - core/gate.mjs\nsupersedes:\n  - 2026-01-01-old-0a1b2c3d\n---\n"
  );
  assert.deepEqual(
    uncoveredPaths(repository, [`${NOTES_DIRECTORY}/keys.md`, "core/gate.mjs"]),
    []
  );
});

test("a blank line between entries does not end the list", () => {
  const repository = createRepository();
  writeNote(repository, "blank.md", "---\ncovers:\n  - core/gate.mjs\n\n  - core/notes.mjs\n---\n");
  assert.deepEqual(
    uncoveredPaths(repository, [`${NOTES_DIRECTORY}/blank.md`, "core/gate.mjs", "core/notes.mjs"]),
    []
  );
});

/*
 * A trailing space is a legal part of a file name. Trimming the entry made a
 * note that named "app.js " cover "app.js" instead: a path it never mentioned
 * silenced, and the one it did mention still reported.
 */
test("an entry is not trimmed, so it cannot cover a path it does not name", () => {
  const repository = createRepository();
  writeNote(repository, "space.md", "---\ncovers:\n  - app.js \n---\n");
  assert.deepEqual(
    uncoveredPaths(repository, [`${NOTES_DIRECTORY}/space.md`, "app.js", "app.js "]),
    ["app.js"]
  );
});
