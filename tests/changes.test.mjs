import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
  return JSON.parse(result.stdout);
}

function changeSetCommandPaths(repository) {
  return changeSetCommandOutput(repository).paths;
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
  assert.deepEqual(changedPaths(repository), { root: repository, paths: [], complete: true });
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
    paths: ["nested/deep/src.js"],
    complete: true
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
  assert.deepEqual(changeSetCommandPaths(repository), expected);
});

test("the change set command says nothing outside a repository and never fails", () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "not-a-repo-"));
  assert.deepEqual(changeSetCommandOutput(directory), { paths: [], complete: false, reason: "not a git repository, or git could not be asked" });
});

test("the rendered instructions carry the change set command the skill is told to use", () => {
  const text = renderInstructions();
  assert.doesNotMatch(text, /\{\{/);
  assert.match(text, new RegExp(escapeForRegExp(CHANGES_ENTRYPOINT)));
});

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/*
 * A path may contain a newline, and git's -z output hands it over verbatim.
 * Joining such paths with newlines makes one file called "alpha\nbeta.js"
 * indistinguishable from the two files "alpha" and "beta.js", so the reader
 * loses the identity of what changed exactly where it matters most.
 */
test("a newline inside a path does not turn one file into two", () => {
  const repository = createRepository();
  write(repository, "alpha\nbeta.js", "export {};\n");
  write(repository, "plain.js", "export {};\n");

  assert.deepEqual(changedPaths(repository).paths, ["alpha\nbeta.js", "plain.js"]);
  assert.deepEqual(changeSetCommandPaths(repository), ["alpha\nbeta.js", "plain.js"]);
});

/*
 * The command is substituted into the instructions, and a replacement string
 * is not literal text: `$&` in it expands to whatever the pattern matched. A
 * plugin installed under a directory named with those two characters would
 * have its own placeholder spliced back into the path it was replacing.
 */
test("a plugin path containing a replacement pattern survives substitution", () => {
  const entrypoint = "/plugins/gate-$&-$$-$`/core/changes.mjs";
  const text = renderInstructions({ runtime: "/usr/bin/node", changes: entrypoint });
  assert.ok(text.includes(entrypoint), text.match(/^.*changes\.mjs.*$/m)?.[0]);
  assert.doesNotMatch(text, /CHANGE_SET_COMMAND/);
});

/*
 * The POSIX form has to survive a real shell, and PowerShell needs the call
 * operator before a quoted executable or it treats the line as a string. This
 * runs the first for real; the second is asserted by shape, because no
 * PowerShell is available here to run it against.
 */
test("the rendered command runs in a POSIX shell and is spelled for PowerShell too", () => {
  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "gate-quote-"));
  const awkward = path.join(sandbox, "plug in's dir");
  fs.mkdirSync(awkward, { recursive: true });
  fs.cpSync(path.join(path.dirname(CHANGES_ENTRYPOINT)), path.join(awkward, "core"), {
    recursive: true
  });
  const repository = createRepository();
  write(repository, "src.js", "export {};\n");

  const text = renderInstructions({ changes: path.join(awkward, "core", "changes.mjs") });
  const posix = text.match(/^POSIX shell: (.+)$/m)[1];
  const powershell = text.match(/^PowerShell: (.+)$/m)[1];

  const run = spawnSync(posix, { cwd: repository, encoding: "utf8", shell: "/bin/sh" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).paths, ["src.js"]);

  assert.ok(powershell.startsWith("& "), powershell);
  assert.ok(powershell.includes("plug in''s dir"), "PowerShell doubles a single quote to escape it");
});

/*
 * Node kills git and throws once its output passes maxBuffer, whose default is
 * a megabyte -- about six thousand paths. Collected together, exceeding it on
 * the committed half took the working tree with it and the change set came
 * back empty with nothing reported at all. The halves are collected
 * separately now, and a short list says it is short.
 */
test("a committed half too large to collect still leaves the working tree reported", () => {
  const repository = createRepository();
  git(repository, ["checkout", "-q", "-b", "feature"]);
  for (let index = 0; index < 40; index += 1) {
    write(repository, `committed-${index}-with-a-name-long-enough-to-fill-a-buffer.js`, "x\n");
  }
  commit(repository, "many files");
  write(repository, "working.js", "export {};\n");

  const whole = changedPaths(repository);
  assert.equal(whole.complete, true);
  assert.equal(whole.paths.length, 41);

  const clipped = changedPaths(repository, { maxBuffer: 64 });
  assert.deepEqual(clipped.paths, ["working.js"]);
  assert.equal(clipped.complete, false, "a half that could not be collected is admitted, not hidden");
});

test("a repository git cannot read at all still has no change set", () => {
  const repository = createRepository();
  write(repository, "src.js", "export {};\n");
  assert.equal(changedPaths(repository, { maxBuffer: 1 }), null);
});

/*
 * PowerShell recognizes four more characters as single quotes than the ASCII
 * one, and any of them ends a single-quoted string. A plugin under a directory
 * named with a typographic apostrophe would terminate its own argument.
 */
test("every character PowerShell reads as a single quote is escaped", () => {
  const text = renderInstructions({
    runtime: "/usr/bin/node",
    changes: "/home/O\u2019Connor/it\u2018s/\u201aodd\u201b/core/changes.mjs"
  });
  const powershell = text.match(/^PowerShell: (.+)$/m)[1];
  assert.ok(powershell.includes("O\u2019\u2019Connor"), powershell);
  assert.ok(powershell.includes("it\u2018\u2018s"), powershell);
  assert.ok(powershell.includes("\u201a\u201aodd\u201b\u201b"), powershell);

  const posix = text.match(/^POSIX shell: (.+)$/m)[1];
  assert.ok(posix.includes("O\u2019Connor"), "a POSIX shell reads only the ASCII quote");
});

/*
 * A merge base that cannot be computed is not the same as two commits with no
 * common ancestor. git says which by its exit code, and swallowing the first
 * as an empty list reported a branch as fully collected when half of it had
 * never been read.
 *
 * The injection removes the base commit's own object: merge-base cannot read
 * it, while `git status` -- which compares the index and the working tree
 * against HEAD -- still can.
 */
test("a merge base that cannot be computed is a failure, not an empty half", () => {
  const repository = createRepository();
  git(repository, ["checkout", "-q", "-b", "feature"]);
  write(repository, "first.js", "export {};\n");
  commit(repository, "the commit whose object is removed");
  const middle = git(repository, ["rev-parse", "HEAD"]).trim();
  write(repository, "second.js", "export {};\n");
  commit(repository, "a commit on top of it");
  write(repository, "working.js", "export {};\n");
  assert.equal(changedPaths(repository).complete, true);

  // Removing a commit in the middle of the branch leaves the base ref and HEAD
  // both readable, and only the walk between them broken.
  fs.rmSync(path.join(repository, ".git", "objects", middle.slice(0, 2), middle.slice(2)));
  const broken = spawnSync("git", ["-C", repository, "merge-base", "HEAD", "main"], {
    encoding: "utf8"
  });
  assert.notEqual(broken.status, 0, "the injection has to break merge-base");
  assert.notEqual(broken.stderr, "", "and it has to be distinguishable from an unrelated history");
  assert.equal(
    spawnSync("git", ["-C", repository, "status", "--porcelain"]).status,
    0,
    "and has to leave the working tree readable"
  );
  assert.equal(
    spawnSync("git", ["-C", repository, "rev-parse", "--verify", "--quiet", "main^{commit}"]).status,
    0,
    "and the base ref still resolves, so the empty-by-design path is not the one taken"
  );

  const changes = changedPaths(repository);
  assert.equal(changes.complete, false, "the committed half could not be read");
  assert.deepEqual(changes.paths, ["working.js"]);
  assert.equal(changeSetCommandOutput(repository).complete, false, "and the command says so");
});

// A repository with no base at all is legitimately empty on that half.
test("no base to compare against is not a failure", () => {
  const repository = createRepository();
  git(repository, ["checkout", "-q", "--detach"]);
  git(repository, ["branch", "-D", "main"]);
  write(repository, "working.js", "export {};\n");
  const changes = changedPaths(repository);
  assert.equal(changes.complete, true, "a repository with no base still collected both halves");
  assert.deepEqual(changes.paths, ["working.js"]);
});

/*
 * A base ref that is not there and one whose commit cannot be read are
 * different failures, and git answers 1 with an empty stderr for both when
 * asked for `<ref>^{commit}`. Treating the second as "no base" reported a
 * branch with commits on it as having none, through every layer: the change
 * set, the command, and the notice.
 */
test("a base ref whose commit cannot be read is a failure, not a missing base", () => {
  const repository = createRepository();
  const base = git(repository, ["rev-parse", "main"]).trim();
  git(repository, ["checkout", "-q", "-b", "feature"]);
  write(repository, "committed.js", "export {};\n");
  commit(repository, "a commit on the branch");
  assert.deepEqual(changedPaths(repository), {
    root: repository,
    paths: ["committed.js"],
    complete: true
  });

  fs.rmSync(path.join(repository, ".git", "objects", base.slice(0, 2), base.slice(2)));
  assert.equal(
    spawnSync("git", ["-C", repository, "rev-parse", "--verify", "--quiet", "main"]).status,
    0,
    "the ref is still there"
  );
  const commitLookup = spawnSync("git", ["-C", repository, "rev-parse", "--verify", "--quiet", "main^{commit}"], {
    encoding: "utf8"
  });
  assert.equal(commitLookup.status, 1, "and asking for its commit fails the way a missing ref does");
  assert.equal(commitLookup.stderr, "", "with nothing on stderr to tell them apart");

  const changes = changedPaths(repository);
  assert.equal(changes.complete, false);
  assert.deepEqual(changes.paths, []);
  assert.equal(changeSetCommandOutput(repository).complete, false, "and the command says so");
});

// A repository that simply has none of these refs is not a failure.
test("no base ref at all is still an ordinary empty half", () => {
  const repository = createRepository();
  git(repository, ["checkout", "-q", "--detach"]);
  git(repository, ["branch", "-D", "main"]);
  write(repository, "working.js", "export {};\n");
  const changes = changedPaths(repository);
  assert.equal(changes.complete, true);
  assert.deepEqual(changes.paths, ["working.js"]);
});
