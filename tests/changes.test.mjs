import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { changedPaths } from "../core/changes.mjs";
import { createRepository, git } from "./helpers.mjs";

function write(repository, relativePath, contents) {
  const target = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function commit(repository, message) {
  git(repository, ["add", "-A"]);
  git(repository, ["commit", "-q", "-m", message]);
}

test("a directory outside any repository has no change set", () => {
  assert.equal(changedPaths(fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "not-a-repo-"))), null);
  assert.equal(changedPaths("relative/path"), null);
});

test("a clean default branch has changed nothing", () => {
  const repository = createRepository();
  assert.deepEqual(changedPaths(repository), { root: repository, paths: [] });
});

test("uncommitted edits, additions, and deletions are the change set; ignored files are not", () => {
  const repository = createRepository();
  write(repository, ".gitignore", "ignored/\n");
  write(repository, "deleted.js", "export {};\n");
  commit(repository, "ignore, and a file to delete");

  write(repository, "README.md", "# Edited\n");
  write(repository, "added.js", "export {};\n");
  write(repository, "ignored/scratch.js", "export {};\n");
  fs.rmSync(path.join(repository, "deleted.js"));

  assert.deepEqual(changedPaths(repository).paths, ["README.md", "added.js", "deleted.js"]);
});

test("commits on a branch are the change set, alongside uncommitted work", () => {
  const repository = createRepository();
  git(repository, ["checkout", "-q", "-b", "feature"]);
  write(repository, "committed.js", "export {};\n");
  commit(repository, "commit on the branch");
  write(repository, "working.js", "export {};\n");

  assert.deepEqual(changedPaths(repository).paths, ["committed.js", "working.js"]);
});

test("a file committed on the branch and then edited is named once", () => {
  const repository = createRepository();
  git(repository, ["checkout", "-q", "-b", "feature"]);
  write(repository, "src.js", "export {};\n");
  commit(repository, "commit on the branch");
  write(repository, "src.js", "export const changed = true;\n");

  assert.deepEqual(changedPaths(repository).paths, ["src.js"]);
});

test("a rename names both the old path and the new one", () => {
  const repository = createRepository();
  write(repository, "old.js", "export {};\n");
  commit(repository, "add");
  git(repository, ["mv", "old.js", "new.js"]);

  assert.deepEqual(changedPaths(repository).paths, ["new.js", "old.js"]);
});

test("the change set is found from a subdirectory and named relative to the repository", () => {
  const repository = createRepository();
  write(repository, "nested/deep/src.js", "export {};\n");

  assert.deepEqual(changedPaths(path.join(repository, "nested", "deep")), {
    root: repository,
    paths: ["nested/deep/src.js"]
  });
});

// Without a remote there is no origin/HEAD to compare against, so the local
// default branch is the base; work committed on a branch cut from it is still
// the change set.
test("a repository with no remote compares against the local default branch", () => {
  const repository = createRepository();
  git(repository, ["checkout", "-q", "-b", "feature"]);
  write(repository, "committed.js", "export {};\n");
  commit(repository, "commit on the branch");

  assert.deepEqual(changedPaths(repository).paths, ["committed.js"]);
});

test("a branch cut from the remote default branch compares against it", () => {
  const upstream = createRepository();
  const repository = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "clone-")));
  git(path.dirname(repository), ["clone", "-q", upstream, repository]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["config", "user.name", "Test"]);
  git(repository, ["checkout", "-q", "-b", "feature"]);
  write(repository, "committed.js", "export {};\n");
  commit(repository, "commit on the branch");

  assert.deepEqual(changedPaths(repository).paths, ["committed.js"]);
});

// A repository whose git data cannot be read must leave the reminder silent
// rather than report a change set it could not compute.
test("an unreadable repository has no change set", () => {
  const repository = createRepository();
  fs.rmSync(path.join(repository, ".git", "HEAD"));

  assert.equal(changedPaths(repository), null);
});
