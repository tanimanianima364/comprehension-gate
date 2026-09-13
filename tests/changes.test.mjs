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

/*
 * A name that is not valid UTF-8 cannot be written on every file system --
 * APFS refuses it -- but git's index has no such rule, and a history made
 * elsewhere checks out on such a host in exactly this state: the entry
 * present, the file missing. Staging the name is what every host can do.
 */
function stage(repository, name, contents) {
  const blob = spawnSync("git", ["-C", repository, "hash-object", "-w", "--stdin"], {
    input: contents,
    encoding: "utf8"
  });
  assert.equal(blob.status, 0, blob.stderr);
  const staged = spawnSync("git", ["-C", repository, "update-index", "--add", "--index-info"], {
    input: Buffer.concat([Buffer.from(`100644 ${blob.stdout.trim()}\t`), name, Buffer.from("\n")])
  });
  assert.equal(staged.status, 0, staged.stderr.toString());
}

test("a directory outside any repository has no change set", () => {
  assert.equal(changedPaths(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "not-a-repo-"))), null);
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
  const repository = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "clone-")));
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
  const repository = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "clone-")));
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
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "not-a-repo-"));
  assert.deepEqual(changeSetCommandOutput(directory), {
    paths: [],
    complete: false,
    reason: "not a git repository, or git could not be asked"
  });
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
 * The rendered command has to survive a real shell, from a directory whose
 * name holds the characters that would otherwise end its quoting.
 */
test("the rendered command runs in a POSIX shell", () => {
  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gate-quote-"));
  const awkward = path.join(sandbox, "plug in's dir");
  fs.mkdirSync(awkward, { recursive: true });
  fs.cpSync(path.join(path.dirname(CHANGES_ENTRYPOINT)), path.join(awkward, "core"), {
    recursive: true
  });
  const repository = createRepository();
  write(repository, "src.js", "export {};\n");

  const text = renderInstructions({ changes: path.join(awkward, "core", "changes.mjs") });
  const command = text.match(/^'.+' '.+'$/m)[0];
  const run = spawnSync(command, { cwd: repository, encoding: "utf8", shell: "/bin/sh" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).paths, ["src.js"]);
});

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

  // Room for the line naming the repository, or one commit id, but not for
  // forty file names. The temporary directory is deep on macOS and shallow on
  // Linux, so the room is measured rather than assumed.
  const clipped = changedPaths(repository, { maxBuffer: Buffer.byteLength(repository) + 64 });
  assert.deepEqual(clipped.paths, ["working.js"]);
  assert.equal(clipped.complete, false, "a half that could not be collected is admitted, not hidden");
});

test("a repository git cannot read at all still has no change set", () => {
  const repository = createRepository();
  write(repository, "src.js", "export {};\n");
  assert.equal(changedPaths(repository, { maxBuffer: 1 }), null);
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

/*
 * A branch with commits and no base ref to compare them against has a
 * committed half that was never computed, not an empty one. Saying "empty"
 * there erased every commit made in a `--single-branch` clone, or in any
 * repository whose trunk is called something other than main or master.
 */
test("no base ref with commits on HEAD is a failure, not an empty half", () => {
  const repository = createRepository();
  git(repository, ["checkout", "-q", "--detach"]);
  git(repository, ["branch", "-D", "main"]);
  write(repository, "working.js", "export {};\n");
  const changes = changedPaths(repository);
  assert.equal(changes.complete, false, "the committed half was never computed");
  assert.deepEqual(changes.paths, ["working.js"], "the half that was collected is still reported");
});

// A repository with no commits at all has no committed half to miss.
test("no base ref and an unborn HEAD is an ordinary empty half", () => {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "unborn-"));
  const repository = path.join(parent, "fresh");
  fs.mkdirSync(repository);
  git(repository, ["init", "-q", "-b", "main", "."]);
  fs.writeFileSync(path.join(repository, "first.js"), "export {};\n");
  const changes = changedPaths(repository);
  assert.equal(changes.complete, true);
  assert.deepEqual(changes.paths, ["first.js"]);
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

/*
 * A shallow clone does not hold the commit where two branches meet, and a
 * shallow boundary looks to git like a commit with no parents -- so merge-base
 * answers exactly as it does for genuinely unrelated histories, 1 with nothing
 * on stderr. Believing it reported a branch's whole committed half as absent.
 */
test("a shallow clone that cannot reach the merge base is a failure", () => {
  const upstream = createRepository();
  write(upstream, "second.js", "export {};\n");
  commit(upstream, "a second commit to be cut off");
  git(upstream, ["checkout", "-q", "-b", "feature"]);
  write(upstream, "feature.js", "export {};\n");
  commit(upstream, "a commit on the branch");

  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "shallow-"));
  const repository = path.join(parent, "clone");
  git(parent, ["clone", "-q", "--depth=1", "--no-single-branch", "--branch", "feature", `file://${upstream}`, repository]);
  git(repository, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  assert.equal(git(repository, ["rev-parse", "--is-shallow-repository"]).trim(), "true");

  const shallow = changedPaths(repository);
  assert.equal(shallow.complete, false, "a branch's committed half is missing, not empty");

  git(repository, ["fetch", "-q", "--unshallow"]);
  assert.deepEqual(changedPaths(repository), {
    root: fs.realpathSync(repository),
    paths: ["feature.js"],
    complete: true
  });
});

/*
 * git resolves a short ref name against tags first, so a tag named `main`
 * became the base and the branch's own commits vanished from the change set.
 * The candidates are fully qualified for that reason.
 */
test("a tag sharing a branch's name is never the base", () => {
  const repository = createRepository();
  git(repository, ["checkout", "-q", "-b", "feature"]);
  write(repository, "feature.js", "export {};\n");
  commit(repository, "a commit on the branch");
  const expected = { root: repository, paths: ["feature.js"], complete: true };
  assert.deepEqual(changedPaths(repository), expected);

  git(repository, ["tag", "main"]);
  assert.deepEqual(changedPaths(repository), expected, "tagging changed nothing about the branch");
});

/*
 * A directory whose name ends in a space is a different directory. Trimming
 * git's output examined the neighbour instead and reported its change set as
 * this one's -- not a failure, a wrong answer.
 */
test("a working directory whose name ends in a space is the one examined", () => {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "space-"));
  const plain = path.join(parent, "repo");
  const spaced = path.join(parent, "repo ");
  for (const directory of [plain, spaced]) {
    fs.mkdirSync(directory);
    git(directory, ["init", "-q", "-b", "main", "."]);
    git(directory, ["config", "user.email", "test@example.com"]);
    git(directory, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(directory, "seed.txt"), "x\n");
    git(directory, ["add", "-A"]);
    git(directory, ["commit", "-q", "-m", "seed"]);
  }
  fs.writeFileSync(path.join(spaced, "working.js"), "export {};\n");

  assert.deepEqual(changedPaths(spaced), {
    root: fs.realpathSync(spaced),
    paths: ["working.js"],
    complete: true
  });
  assert.deepEqual(changedPaths(plain).paths, [], "and the neighbour is untouched");
});

/*
 * A ref file git cannot read is a failure, and it says so -- a missing ref
 * says nothing at all. Both exit 1, so the warning is the only difference.
 */
test("a broken ref file is a failure, not a missing ref", () => {
  const repository = createRepository();
  git(repository, ["checkout", "-q", "-b", "feature"]);
  write(repository, "feature.js", "export {};\n");
  commit(repository, "a commit on the branch");
  assert.equal(changedPaths(repository).complete, true);

  fs.writeFileSync(path.join(repository, ".git", "refs", "heads", "main"), "garbage\n");
  const lookup = spawnSync("git", ["-C", repository, "rev-parse", "--verify", "--quiet", "refs/heads/main"], {
    encoding: "utf8"
  });
  assert.equal(lookup.status, 1, "git fails the way a missing ref does");
  assert.notEqual(lookup.stderr, "", "but warns, which a missing ref does not");

  const changes = changedPaths(repository);
  assert.equal(changes.complete, false);
  assert.equal(changeSetCommandOutput(repository).complete, false, "and the command says so");
});

/*
 * A git that was killed says nothing and reports no exit code, which is what
 * an absent ref also looks like if only stderr is consulted. Reading it as an
 * absence answered every question this file asks with a confident "no" -- no
 * ref, no default branch, not shallow -- and each of those empties the change
 * set, so a killed git reported a branch with commits on it as unchanged.
 *
 * The injection is a git on PATH that kills itself for one subcommand and
 * hands every other call to the real one.
 */
const SIGNALLED = [
  ["the base ref lookup", "rev-parse --verify --quiet refs/"],
  ["the default branch lookup", "symbolic-ref"]
];

function gitThatDiesOn(pattern) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "git-shim-"));
  const real = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(
    path.join(directory, "git"),
    `#!/bin/sh\ncase "$*" in\n  *"${pattern}"*) kill -TERM $$ ;;\nesac\nexec ${real} "$@"\n`,
    { mode: 0o755 }
  );
  return directory;
}

for (const [description, pattern] of SIGNALLED) {
  test(`a git killed during ${description} is a failure, not an absence`, () => {
    const repository = createRepository();
    git(repository, ["checkout", "-q", "-b", "feature"]);
    write(repository, "committed.js", "export {};\n");
    commit(repository, "a commit on the branch");
    assert.deepEqual(changedPaths(repository).paths, ["committed.js"]);

    const previous = process.env.PATH;
    process.env.PATH = `${gitThatDiesOn(pattern)}:${previous}`;
    try {
      const changes = changedPaths(repository);
      assert.notEqual(changes, null, "the repository itself is still found");
      assert.equal(changes.complete, false, description);
    } finally {
      process.env.PATH = previous;
    }
  });
}

/*
 * git terminates its answer with a line feed, and a carriage return before it
 * belongs to the name on a POSIX filesystem. Taking it off names a different
 * directory, which is then answered about successfully -- the wrong
 * repository's change set returned as this one's.
 */
test("a working directory whose name ends in a carriage return is the one examined", () => {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cr-"));
  const plain = path.join(parent, "repo");
  const returned = path.join(parent, "repo\r");
  for (const directory of [plain, returned]) {
    fs.mkdirSync(directory);
    git(directory, ["init", "-q", "-b", "main", "."]);
    git(directory, ["config", "user.email", "test@example.com"]);
    git(directory, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(directory, "seed.txt"), "x\n");
    git(directory, ["add", "-A"]);
    git(directory, ["commit", "-q", "-m", "seed"]);
  }
  fs.writeFileSync(path.join(returned, "working.js"), "export {};\n");

  assert.deepEqual(changedPaths(returned), {
    root: fs.realpathSync(returned),
    paths: ["working.js"],
    complete: true
  });
  assert.deepEqual(changedPaths(plain).paths, [], "and the neighbour is untouched");
});


/*
 * `HEAD` is a legal file name, and git refuses a command whose argument is both
 * a revision and a path unless the revisions are ended with `--`. Without it an
 * ordinary repository -- no fault injection, just a file with that name -- could
 * not have its committed half collected at all.
 */
test("a file named like a revision does not make the committed half unreadable", () => {
  const repository = createRepository();
  git(repository, ["checkout", "-q", "-b", "feature"]);
  write(repository, "HEAD", "not a ref\n");
  write(repository, "refs/heads/main", "not a ref\n");
  write(repository, "feature.js", "export {};\n");
  commit(repository, "files whose names read as refs");

  const ambiguous = spawnSync(
    "git",
    ["-C", repository, "diff", "--name-only", "HEAD~1", "HEAD"],
    { encoding: "utf8" }
  );
  assert.equal(ambiguous.status, 128, "git itself refuses the command without the separator");
  assert.match(ambiguous.stderr, /ambiguous argument/);

  assert.deepEqual(changedPaths(repository), {
    root: repository,
    paths: ["HEAD", "feature.js", "refs/heads/main"],
    complete: true
  });
  assert.deepEqual(changeSetCommandPaths(repository), ["HEAD", "feature.js", "refs/heads/main"]);
});

/*
 * The shape a CI runner, a devcontainer and an agent sandbox all check out
 * with: `--single-branch --branch <x>` writes no origin/HEAD and fetches no
 * main. Every base candidate is then missing, and reporting that as an empty
 * committed half erased the whole point of the branch -- silently, and with an
 * uncommitted edit alongside it, affirmatively: one file named as the entire
 * change set, marked complete.
 */
test("a single-branch clone of a trunk that is not main is not reported as unchanged", () => {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "single-"));
  const remote = path.join(parent, "remote.git");
  const seed = path.join(parent, "seed");
  git(parent, ["init", "-q", "--bare", "-b", "develop", remote]);
  fs.mkdirSync(seed);
  git(seed, ["init", "-q", "-b", "develop", "."]);
  git(seed, ["config", "user.email", "test@example.com"]);
  git(seed, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(seed, "base.txt"), "base\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "base"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-q", "origin", "develop"]);
  git(seed, ["checkout", "-q", "-b", "feature"]);
  fs.writeFileSync(path.join(seed, "src.js"), "export {};\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "the whole point of the branch"]);
  git(seed, ["push", "-q", "origin", "feature"]);

  const clone = path.join(parent, "clone");
  git(parent, ["clone", "-q", "--single-branch", "--branch", "feature", remote, clone]);
  assert.equal(
    spawnSync("git", ["-C", clone, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]).status,
    1,
    "the clone really has no main to compare against"
  );

  assert.equal(changedPaths(clone).complete, false, "the committed half was never computed");

  fs.appendFileSync(path.join(clone, "src.js"), "more\n");
  const withEdit = changedPaths(clone);
  assert.deepEqual(withEdit.paths, ["src.js"]);
  assert.equal(withEdit.complete, false, "and the one file it can name is not the whole story");
});

/*
 * An orphan branch has every one of its commits and no ancestor in common with
 * its base, so which of them a reviewer would call new cannot be worked out
 * from here. That is a list that is short, not an empty one.
 */
test("unrelated histories are a short list, not an empty one", () => {
  const repository = createRepository();
  git(repository, ["checkout", "-q", "--orphan", "feature"]);
  git(repository, ["rm", "-q", "-rf", "."]);
  write(repository, "orphan.js", "export {};\n");
  commit(repository, "an unrelated history");

  assert.equal(changedPaths(repository).complete, false);
});

/*
 * git warns and still exits 0 when it cannot open part of the working tree.
 * The listing it printed is then short of whatever it could not reach, and a
 * clean exit code is not enough to call it whole.
 */
test("a listing git said was short is not reported as complete", { skip: process.getuid?.() === 0 }, () => {
  const repository = createRepository();
  fs.mkdirSync(path.join(repository, "locked"));
  fs.writeFileSync(path.join(repository, "locked", "inside.js"), "export {};\n");
  fs.writeFileSync(path.join(repository, "visible.js"), "export {};\n");
  fs.chmodSync(path.join(repository, "locked"), 0o000);
  try {
    const warned = spawnSync("git", ["-C", repository, "status", "--porcelain=v1"], { encoding: "utf8" });
    assert.equal(warned.status, 0, "git exits cleanly");
    assert.match(warned.stderr, /could not open directory/, "and says on stderr that it could not look");

    const changes = changedPaths(repository);
    assert.equal(changes.complete, false);
  } finally {
    fs.chmodSync(path.join(repository, "locked"), 0o755);
  }
});

/*
 * Every one of these names a repository, an index or an object store, and git
 * obeys them over the directory it was pointed at. Inherited from the host they
 * made the plugin answer about a tree nobody asked about -- confidently, and
 * marked complete.
 */
test("an inherited GIT_DIR does not redirect the answer to another repository", () => {
  const here = createRepository();
  const there = createRepository();
  write(here, "mine.js", "export {};\n");
  write(there, "theirs.js", "export {};\n");

  const previous = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = path.join(there, ".git");
  process.env.GIT_WORK_TREE = there;
  try {
    const changes = changedPaths(here);
    assert.equal(changes.root, here, "the repository asked about");
    assert.deepEqual(changes.paths, ["mine.js"]);
  } finally {
    for (const [name, value] of [["GIT_DIR", previous.dir], ["GIT_WORK_TREE", previous.tree]]) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

/*
 * A file name is bytes. Decoding it as UTF-8 maps every invalid byte to the
 * same replacement character, so two files whose names differ only there became
 * one path and one of them vanished from the change set without a trace.
 */
/*
 * Escaping only the names that need it traded one collision for another: the
 * escape of a raw 0xFF is `%FF`, which is also how an ordinary file called
 * `x%FF.js` spells itself, so those two collapsed into one path just as the
 * two invalid names had. The escape character is escaped everywhere now.
 */
test("an escaped name and an ordinary name that spells it are two paths", () => {
  const repository = createRepository();
  stage(repository, Buffer.concat([Buffer.from("x"), Buffer.from([0xff]), Buffer.from(".js")]), "raw\n");
  fs.writeFileSync(path.join(repository, "x%FF.js"), "literal\n");

  const changes = changedPaths(repository);
  assert.deepEqual(changes.paths, ["x%25FF.js", "x%FF.js"], "one spelling each, and no two files sharing one");
  assert.deepEqual(changeSetCommandPaths(repository), ["x%25FF.js", "x%FF.js"]);
});

// An ordinary path is left exactly as git spells it, apart from the escape
// character itself.
test("an ordinary path is not otherwise rewritten", () => {
  const repository = createRepository();
  write(repository, "src/\u65e5\u672c\u8a9e.js", "export {};\n");
  write(repository, "plain.js", "export {};\n");
  assert.deepEqual(changedPaths(repository).paths, ["plain.js", "src/\u65e5\u672c\u8a9e.js"]);
});

test("two file names that are not valid UTF-8 stay two paths", () => {
  const repository = createRepository();
  stage(repository, Buffer.concat([Buffer.from("x"), Buffer.from([0xff]), Buffer.from(".js")]), "1\n");
  stage(repository, Buffer.concat([Buffer.from("x"), Buffer.from([0xfe]), Buffer.from(".js")]), "2\n");

  const changes = changedPaths(repository);
  assert.equal(changes.paths.length, 2, `both names survive: ${JSON.stringify(changes.paths)}`);
  assert.equal(new Set(changes.paths).size, 2, "and they are distinct");
});

// A submodule the project's own .gitmodules asks git to ignore is still a
// change this branch made.
test("a submodule set to ignore is still reported", () => {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sub-"));
  const library = path.join(parent, "lib");
  const superproject = path.join(parent, "sup");
  for (const directory of [library, superproject]) {
    fs.mkdirSync(directory);
    git(directory, ["init", "-q", "-b", "main", "."]);
    git(directory, ["config", "user.email", "test@example.com"]);
    git(directory, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(directory, "seed.txt"), "x\n");
    git(directory, ["add", "-A"]);
    git(directory, ["commit", "-q", "-m", "seed"]);
  }
  git(superproject, ["-c", "protocol.file.allow=always", "submodule", "-q", "add", library, "lib"]);
  git(superproject, ["commit", "-q", "-m", "add the submodule"]);
  git(superproject, ["config", "-f", ".gitmodules", "submodule.lib.ignore", "all"]);
  git(superproject, ["add", ".gitmodules"]);
  git(superproject, ["commit", "-q", "-m", "ignore it"]);

  git(superproject, ["checkout", "-q", "-b", "feature"]);
  const checkout = path.join(superproject, "lib");
  // The submodule's own working copy is a repository of its own, and inherits
  // no identity on a machine that has none configured globally.
  git(checkout, ["config", "user.email", "test@example.com"]);
  git(checkout, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(checkout, "new.js"), "export {};\n");
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "-q", "-m", "work in the submodule"]);

  assert.ok(
    changedPaths(superproject).paths.includes("lib"),
    `the submodule is named: ${JSON.stringify(changedPaths(superproject).paths)}`
  );
});
