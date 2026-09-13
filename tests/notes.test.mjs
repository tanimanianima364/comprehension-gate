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

test("a repository with no notes leaves every path uncovered", () => {
  const repository = createRepository();
  assert.deepEqual(uncoveredPaths(repository, ["core/gate.mjs", "README.md"]), [
    "core/gate.mjs",
    "README.md"
  ]);
});

test("a note covers exactly the paths it lists", () => {
  const repository = createRepository();
  writeNote(repository, "2026-09-13-a-gate-rewrite-a1b2c3d4.md", NOTE);
  assert.deepEqual(uncoveredPaths(repository, ["core/gate.mjs", "core/changes.mjs", "README.md"]), [
    "README.md"
  ]);
});

test("covers is read as a block list or an inline list", () => {
  const repository = createRepository();
  writeNote(repository, "inline.md", '---\ncovers: ["core/gate.mjs", core/changes.mjs]\n---\n');
  assert.deepEqual(uncoveredPaths(repository, ["core/gate.mjs", "core/changes.mjs"]), []);
});

test("notes in subdirectories are found, and several notes are read together", () => {
  const repository = createRepository();
  writeNote(repository, "2026-09-13-one-a1b2c3d4.md", "---\ncovers:\n  - core/gate.mjs\n---\n");
  writeNote(repository, "archive/2026-01-01-two-b2c3d4e5.md", "---\ncovers:\n  - README.md\n---\n");
  assert.deepEqual(uncoveredPaths(repository, ["core/gate.mjs", "README.md", "other.js"]), ["other.js"]);
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
  assert.deepEqual(uncoveredPaths(repository, ["core/gate.mjs", "core/changes.mjs"]), [
    "core/gate.mjs",
    "core/changes.mjs"
  ]);
});

test("a covers entry is normalized, and one that escapes the repository is ignored", () => {
  const repository = createRepository();
  writeNote(
    repository,
    "odd.md",
    '---\ncovers:\n  - "./core/gate.mjs"\n  - core//changes.mjs\n  - ../outside.js\n  - /etc/passwd\n---\n'
  );
  assert.deepEqual(
    uncoveredPaths(repository, ["core/gate.mjs", "core/changes.mjs", "outside.js"]),
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
    assert.deepEqual(uncoveredPaths(repository, ["core/gate.mjs"]), ["core/gate.mjs"]);
  } finally {
    fs.chmodSync(path.join(repository, NOTES_DIRECTORY, "note.md"), 0o644);
  }
});
