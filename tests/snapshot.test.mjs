import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureSnapshot, findRepository, snapshotDifference } from "../core/snapshot.mjs";
import { createRepository, git } from "./helpers.mjs";

test("a directory outside any repository has no repository", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-plain-"));
  assert.equal(findRepository(directory), null);
  assert.equal(findRepository("relative/path"), null);
  assert.equal(findRepository(undefined), null);
});

test("a repository is found from a subdirectory and lists every worktree", () => {
  const repository = createRepository();
  fs.mkdirSync(path.join(repository, "src"));
  const found = findRepository(path.join(repository, "src"));
  assert.equal(found.commonDir, path.join(repository, ".git"));
  assert.deepEqual(found.worktrees, [repository]);

  const other = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-wt-")), "feature");
  git(repository, ["worktree", "add", "-q", other, "-b", "feature"]);
  const withWorktree = findRepository(repository);
  assert.deepEqual(withWorktree.worktrees.sort(), [repository, fs.realpathSync(other)].sort());
  // The same repository is found from inside the worktree.
  assert.equal(findRepository(other).commonDir, path.join(repository, ".git"));
});

test("a clean repository snapshots to its HEAD and no entries", () => {
  const repository = createRepository();
  const snapshot = captureSnapshot(findRepository(repository));
  const head = git(repository, ["rev-parse", "HEAD"]).trim();
  assert.deepEqual(snapshot, { worktrees: { [repository]: { head, entries: {} } } });
});

test("edits, additions, deletions, and commits are differences; ignored files are not", () => {
  const repository = createRepository();
  const found = findRepository(repository);
  const baseline = captureSnapshot(found);

  assert.deepEqual(snapshotDifference(baseline, captureSnapshot(found)), []);

  fs.writeFileSync(path.join(repository, "README.md"), "# Edited\n");
  assert.deepEqual(snapshotDifference(baseline, captureSnapshot(found)), [path.join(repository, "README.md")]);

  fs.writeFileSync(path.join(repository, "README.md"), "# Test\n");
  fs.mkdirSync(path.join(repository, "src"));
  fs.writeFileSync(path.join(repository, "src", "new.js"), "export {};\n");
  assert.deepEqual(snapshotDifference(baseline, captureSnapshot(found)), [path.join(repository, "src", "new.js")]);

  fs.writeFileSync(path.join(repository, ".gitignore"), "scratch/\n");
  fs.mkdirSync(path.join(repository, "scratch"));
  fs.writeFileSync(path.join(repository, "scratch", "note.txt"), "x");
  const withIgnore = snapshotDifference(baseline, captureSnapshot(found));
  assert.ok(withIgnore.includes(path.join(repository, ".gitignore")));
  assert.ok(!withIgnore.some(change => change.includes("scratch")));

  fs.rmSync(path.join(repository, "src"), { recursive: true });
  fs.rmSync(path.join(repository, ".gitignore"));
  fs.rmSync(path.join(repository, "scratch"), { recursive: true });
  fs.rmSync(path.join(repository, "README.md"));
  assert.deepEqual(snapshotDifference(baseline, captureSnapshot(found)), [path.join(repository, "README.md")]);

  git(repository, ["checkout", "-q", "--", "README.md"]);
  assert.deepEqual(snapshotDifference(baseline, captureSnapshot(found)), []);

  fs.writeFileSync(path.join(repository, "README.md"), "# Committed\n");
  git(repository, ["commit", "-q", "-a", "-m", "edit"]);
  assert.deepEqual(snapshotDifference(baseline, captureSnapshot(found)), [`${repository} (HEAD)`]);

  // A file larger than one read chunk is hashed by content, not skipped.
  const large = path.join(repository, "large.bin");
  const bytes = Buffer.alloc(3 * 1024 * 1024, 7);
  fs.writeFileSync(large, bytes);
  assert.deepEqual(snapshotDifference(baseline, captureSnapshot(found)), [`${repository} (HEAD)`, large]);
  const withLarge = captureSnapshot(found);
  bytes[bytes.length - 1] = 8;
  fs.writeFileSync(large, bytes);
  assert.deepEqual(snapshotDifference(withLarge, captureSnapshot(found)), [large]);
});

test("a change inside a nested repository is a difference", () => {
  const repository = createRepository();
  const nested = path.join(repository, "inner");
  fs.mkdirSync(nested);
  git(nested, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(nested, "a.js"), "export {};\n");

  const found = findRepository(repository);
  const baseline = captureSnapshot(found);
  assert.deepEqual(snapshotDifference(baseline, captureSnapshot(found)), []);

  // git status collapses the nested repository into one entry, so the first
  // change is caught by the entry appearing; this is the second change.
  fs.writeFileSync(path.join(nested, "a.js"), "export const a = 1;\n");
  // git reports the untracked nested repository with a trailing separator.
  assert.deepEqual(snapshotDifference(baseline, captureSnapshot(found)), [`${nested}${path.sep}`]);
});

test("the walk into a nested repository stops after two thousand files", () => {
  const repository = createRepository();
  const nested = path.join(repository, "vendor");
  fs.mkdirSync(nested);
  git(nested, ["init", "-q", "-b", "main"]);
  for (let index = 1; index <= 2005; index += 1) {
    fs.writeFileSync(path.join(nested, `file-${String(index).padStart(4, "0")}.txt`), "x");
  }

  const found = findRepository(repository);
  const nestedHash = () => captureSnapshot(found).worktrees[repository].entries["vendor/"];
  const baseline = nestedHash();

  fs.writeFileSync(path.join(nested, "file-2003.txt"), "beyond the cap");
  assert.equal(nestedHash(), baseline, "a change past the cap is not seen");

  fs.writeFileSync(path.join(nested, "file-0001.txt"), "inside the cap");
  assert.notEqual(nestedHash(), baseline);
});

test("a change in a second worktree is a difference in the same repository", () => {
  const repository = createRepository();
  const other = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-wt-")), "feature");
  git(repository, ["worktree", "add", "-q", other, "-b", "feature"]);
  const found = findRepository(repository);
  const baseline = captureSnapshot(found);
  fs.writeFileSync(path.join(other, "feature.js"), "export {};\n");
  assert.deepEqual(
    snapshotDifference(baseline, captureSnapshot(found)),
    [path.join(fs.realpathSync(other), "feature.js")]
  );
});

test("a rename records both paths and a symlink hashes its target", () => {
  const repository = createRepository();
  const found = findRepository(repository);
  const baseline = captureSnapshot(found);
  git(repository, ["mv", "README.md", "GUIDE.md"]);
  const changes = snapshotDifference(baseline, captureSnapshot(found));
  assert.deepEqual(changes, [path.join(repository, "GUIDE.md"), path.join(repository, "README.md")]);

  fs.symlinkSync("GUIDE.md", path.join(repository, "link.md"));
  const entries = captureSnapshot(found).worktrees[repository].entries;
  assert.match(entries["link.md"], /^link:[0-9a-f]{64}$/);
});
