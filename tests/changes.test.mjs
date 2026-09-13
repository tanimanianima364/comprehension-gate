import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { changedPaths } from "../core/changes.mjs";
import { renderInstructions } from "../core/gate.mjs";
import { createRepository, git } from "./helpers.mjs";

const CHANGES_ENTRYPOINT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "core",
  "changes.mjs"
);

function changeSetCommandOutput(repository) {
  const result = spawnSync(process.execPath, [CHANGES_ENTRYPOINT], {
    cwd: repository,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").filter(line => line !== "");
}

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

/*
 * `git mv` stages the rename, so the status is "R " and the original path
 * follows. A plain move plus `git add -N` puts the R in the second column
 * instead -- " R" -- and reading only the first column leaves the original
 * path to be parsed as the next status line, which loses it and invents a
 * path from its last characters.
 */
test("a rename is named in full whether it is staged or not", () => {
  const repository = createRepository();
  write(repository, "old.js", "export {};\n");
  commit(repository, "add");

  fs.renameSync(path.join(repository, "old.js"), path.join(repository, "new.js"));
  git(repository, ["add", "-N", "new.js"]);
  assert.equal(
    git(repository, ["status", "--porcelain=v1"]).split("\n")[0].slice(0, 2),
    " R",
    "the case only exists while git reports the rename in the worktree column"
  );
  assert.deepEqual(changedPaths(repository).paths, ["new.js", "old.js"]);

  git(repository, ["add", "-A"]);
  assert.deepEqual(changedPaths(repository).paths, ["new.js", "old.js"]);
});

/*
 * origin/HEAD outlives the branch it points at: renaming the remote default
 * branch and pruning leaves it dangling, and adopting it makes merge-base
 * fail, which silently empties the committed half of the change set.
 */
test("a dangling origin/HEAD falls through to a base that exists", () => {
  const upstream = createRepository();
  const repository = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "clone-")));
  git(path.dirname(repository), ["clone", "-q", upstream, repository]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["config", "user.name", "Test"]);
  git(upstream, ["branch", "-m", "main", "renamed-default"]);
  git(repository, ["fetch", "-q", "--prune"]);
  git(repository, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  assert.throws(() => git(repository, ["rev-parse", "--verify", "origin/main^{commit}"]));

  git(repository, ["checkout", "-q", "-b", "feature", "origin/renamed-default"]);
  write(repository, "committed.js", "export {};\n");
  commit(repository, "commit on the branch");

  assert.deepEqual(changedPaths(repository).paths, ["committed.js"]);
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

/*
 * The manual skill used to carry its own `git merge-base HEAD origin/HEAD`
 * one-liner, which resolved nothing in a repository with no remote -- the
 * outer `git diff` then succeeded with empty output, so the skill saw no
 * change at all -- and which dropped a committed rename's original path. Both
 * cases are here, and both are answered by the skill running the same code the
 * hook runs.
 */
test("the command the skill runs reports exactly what the hook reports", () => {
  const repository = createRepository();
  git(repository, ["checkout", "-q", "-b", "feature"]);
  write(repository, "committed.js", "export {};\n");
  commit(repository, "commit on the branch");
  git(repository, ["mv", "README.md", "readme.md"]);
  commit(repository, "committed rename");
  write(repository, "working.js", "export {};\n");

  const expected = changedPaths(repository).paths;
  assert.deepEqual(expected, ["README.md", "committed.js", "readme.md", "working.js"]);
  assert.deepEqual(changeSetCommandOutput(repository), expected);
});

test("the change set command says nothing outside a repository and never fails", () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "not-a-repo-"));
  assert.deepEqual(changeSetCommandOutput(directory), []);
});

test("the rendered instructions carry the change set command the skill is told to use", () => {
  const text = renderInstructions();
  assert.doesNotMatch(text, /\{\{/);
  assert.match(text, new RegExp(escapeForRegExp(CHANGES_ENTRYPOINT)));
});

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
