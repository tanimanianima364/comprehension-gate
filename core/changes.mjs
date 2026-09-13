/*
 * What "the branch changed" means.
 *
 * The unit is the branch, not the turn: everything this branch has done that
 * its base has not, which is the same set a reviewer sees in the pull request.
 * That is the range a note has to cover, and it is derived fresh from git on
 * every call, so nothing has to be remembered between hook invocations.
 *
 * The set is the union of two halves: paths committed since the merge base
 * with the default branch, and paths `git status` reports in the working
 * tree. Renames name both paths, because a note attached to the old path has
 * to follow. Ignored files are in neither half, so scratch files stay free.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GIT_TIMEOUT_MS = 10_000;
/*
 * Node kills the child and throws once git's output passes maxBuffer, whose
 * default is 1 MiB -- about six thousand paths. A branch that large is not
 * exotic in a monorepo, and the failure is silent: the change set comes back
 * empty and nothing is ever reported. The limit is raised to something no
 * realistic branch reaches, and the two halves are collected separately so
 * exceeding it on one still leaves the other.
 */
const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
// Ordered by how well each ref answers "what will this branch be reviewed
// against": the remote's own default branch first, then its usual names, then
// the local ones for a repository that has no remote at all.
// Fully qualified, because git resolves a short name against tags first: a tag
// named `main` would otherwise become the base and the branch's own commits
// would vanish from the change set.
const MISSING = "missing";
const PRESENT = "present";
const UNREADABLE = "unreadable";
const BASE_CANDIDATES = [
  "refs/remotes/origin/main",
  "refs/remotes/origin/master",
  "refs/heads/main",
  "refs/heads/master"
];

/*
 * Every variable below names a repository, an index or an object store, and git
 * obeys them over the directory it was pointed at. Inherited from the host --
 * a hook fired from inside another git command, a task runner, a test harness --
 * they make the plugin answer about a tree nobody asked about, confidently and
 * completely. They are removed for our own calls; nothing here wants them.
 */
const GIT_ENVIRONMENT = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_PREFIX"
];

/*
 * spawnSync rather than execFileSync, because stderr on a SUCCESSFUL exit is
 * the thing that has to be read: `git status` warns and exits 0 when it cannot
 * open part of the working tree, and the listing it printed is then short of
 * whatever it could not reach.
 *
 * stdout stays a Buffer. A file name is bytes, and decoding it as UTF-8 too
 * early replaces every invalid byte with the same character -- two differently
 * named files collapse into one path and one of them disappears from the
 * change set.
 */
function run(directory, args, maxBuffer = GIT_MAX_OUTPUT_BYTES) {
  const environment = { ...process.env };
  for (const name of GIT_ENVIRONMENT) {
    delete environment[name];
  }
  const result = spawnSync("git", ["-C", directory, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: environment
  });
  return {
    ok: result.error === undefined && result.status === 0,
    status: typeof result.status === "number" ? result.status : null,
    signal: result.signal ?? null,
    failed: result.error !== undefined,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8")
  };
}

// A command whose whole purpose is to answer a question: anything but a clean
// success is a failure the caller has to hear about.
function ask(directory, args, maxBuffer) {
  const result = run(directory, args, maxBuffer);
  if (!result.ok) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.signal || result.status}`);
  }
  return result;
}

/*
 * A command that prints a list. git warns on stderr and still exits 0 when it
 * could not read part of the tree, so a clean exit is not enough: a listing git
 * itself said was short must not be passed off as the whole of it.
 */
function listing(directory, args, maxBuffer) {
  const result = run(directory, args, maxBuffer);
  if (!result.ok || result.stderr !== "") {
    throw new Error(`git ${args[0]} could not list the whole tree: ${result.stderr.trim() || result.status}`);
  }
  return fieldsOf(result.stdout);
}

// NUL-separated, split at the byte level so a name can hold anything but NUL.
function fieldsOf(buffer) {
  const fields = [];
  let start = 0;
  for (let index = 0; index <= buffer.length; index += 1) {
    if (index === buffer.length || buffer[index] === 0) {
      if (index > start) {
        fields.push(decodePath(buffer.subarray(start, index)));
      }
      start = index + 1;
    }
  }
  return fields;
}

/*
 * UTF-8 when the bytes are UTF-8, and a lossless escape when they are not.
 * Decoding invalid bytes the ordinary way maps every one of them to U+FFFD, so
 * two files whose names differ only there become the same string and one of
 * them vanishes from the change set without a trace.
 */
function decodePath(buffer) {
  const text = buffer.toString("utf8");
  return Buffer.compare(Buffer.from(text, "utf8"), buffer) === 0 ? text : escapeBytes(buffer);
}

function escapeBytes(buffer) {
  let escaped = "";
  for (const byte of buffer) {
    escaped += byte >= 0x20 && byte < 0x7f && byte !== 0x25
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return escaped;
}

export function changedPaths(directory, options = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    return null;
  }

  const maxBuffer = options.maxBuffer ?? GIT_MAX_OUTPUT_BYTES;
  let root;
  try {
    // Only the terminating newline: a directory whose name ends in a space is
    // a different directory, and trimming it examines someone else's
    // repository and reports its change set as this one's.
    root = fs.realpathSync(
      withoutNewline(ask(directory, ["rev-parse", "--show-toplevel"], maxBuffer).stdout.toString("utf8"))
    );
  } catch {
    return null;
  }

  /*
   * null is reserved for "this is not a repository", which is the only reason
   * to say nothing at all. A repository whose every half failed still gets an
   * answer -- an empty one that admits it is empty because nothing could be
   * read, not because nothing changed. Returning null there made the two
   * indistinguishable, and the hook went silent over a branch it could not
   * look at.
   */
  const committed = attempt(() => committedPaths(root, maxBuffer));
  const working = attempt(() => workingTreePaths(root, maxBuffer));
  const paths = new Set([...(committed ?? []), ...(working ?? [])]);
  return {
    root,
    paths: [...paths].sort(),
    // One half that could not be collected leaves the other reported rather
    // than nothing, but the list is then short of something and says so.
    complete: committed !== null && working !== null
  };
}

function attempt(collect) {
  try {
    return collect();
  } catch {
    return null;
  }
}

/*
 * Nothing to compare against is not an error: a repository with no default
 * branch yet, or a HEAD with no common ancestor, still has a working tree, and
 * reporting that half alone is better than reporting nothing.
 *
 * A merge base that cannot be computed for any other reason is an error, and
 * has to reach the caller. The exit code does not separate them -- git answers
 * 1 both for "these histories are unrelated" and for "a commit could not be
 * read" -- but only the second says anything on stderr. Swallowing it as an
 * empty list reported a branch as fully collected when half of it had not been
 * read at all.
 */
function committedPaths(root, maxBuffer) {
  const base = resolveBase(root, maxBuffer);
  if (base === null) {
    /*
     * No base ref at all. That is ordinary in a repository with no commits
     * yet, and a failure in one that has them: the branch has a committed half
     * and this code has no way to compute it. Saying "empty" there erased
     * every commit a `--single-branch` clone or a repository whose trunk is
     * called something other than main or master had made.
     */
    if (headIsBorn(root, maxBuffer)) {
      throw new Error("No base branch could be found to compare against.");
    }
    return [];
  }
  const found = run(root, ["merge-base", "HEAD", base], maxBuffer);
  if (!found.ok) {
    /*
     * Exit 1 with nothing on stderr is git's answer for "these histories have
     * no common ancestor" -- and also what it says when a shallow clone simply
     * does not hold the commit where they meet, since a shallow boundary looks
     * like a commit with no parents.
     *
     * Neither is an empty committed half. A branch with no ancestor in common
     * with its base still has every one of its commits, and which of them a
     * reviewer would call new cannot be worked out from here; a shallow clone
     * is missing the answer rather than holding an empty one. Both say the
     * list is short.
     */
    throw new Error(
      isShallow(root, maxBuffer)
        ? "The clone is shallow and does not reach the merge base."
        : `No merge base with ${base}: ${found.stderr.trim() || "the histories are unrelated"}`
    );
  }
  const mergeBase = found.stdout.toString("utf8").trim();
  /*
   * --no-renames so a renamed file is reported as both a deletion and an
   * addition, matching how the working tree half names both paths.
   *
   * The trailing `--` ends the revisions. Without it a repository holding a
   * file called `HEAD` makes git refuse the whole command as ambiguous, and
   * the committed half of an ordinary branch cannot be collected at all --
   * no fault injection needed, just a file with that name.
   */
  return listing(
    root,
    ["diff", "--name-only", "--no-renames", "--ignore-submodules=none", "-z", mergeBase, "HEAD", "--"],
    maxBuffer
  );
}

/*
 * Every candidate is resolved to a commit before it is adopted. origin/HEAD in
 * particular outlives the branch it points at -- renaming the remote default
 * branch and pruning leaves it dangling -- and adopting a ref that names no
 * commit makes merge-base fail, which would silently empty the committed half
 * of the change set rather than fall through to a base that does exist.
 *
 * A ref that is not there and a ref whose commit cannot be read are different
 * failures, and git answers 1 with an empty stderr for both when asked for
 * `<ref>^{commit}`. Asking for the bare ref separates them: that reads the ref
 * file alone and succeeds even when the object it names is gone. The first is
 * ordinary -- most repositories have only some of these refs -- and the second
 * is a read failure that has to reach the caller, because treating it as "no
 * base" reports a branch with commits on it as having none.
 */
function resolveBase(root, maxBuffer) {
  let unreadable = null;
  for (const candidate of [originHead(root, maxBuffer), ...BASE_CANDIDATES]) {
    if (candidate === null) {
      continue;
    }
    const state = refState(root, candidate, maxBuffer);
    if (state === PRESENT) {
      return candidate;
    }
    if (state === UNREADABLE) {
      unreadable = candidate;
    }
  }
  if (unreadable !== null) {
    throw new Error(`The base ref ${unreadable} could not be read.`);
  }
  return null;
}

/*
 * Three answers, not two. A ref that is not there is ordinary -- most
 * repositories have only some of these. A ref file git could not read, and a
 * ref whose commit object is gone, are failures that have to reach the caller,
 * because reporting either as "no base" says a branch with commits on it has
 * none.
 *
 * git separates the first two by what it writes rather than by exit code: a
 * missing ref says nothing, a broken one warns. The third needs a second
 * question, because asking for `<ref>^{commit}` answers 1 with an empty stderr
 * whether the ref is absent or its object is unreadable; asking for the bare
 * ref reads the ref file alone and succeeds even then.
 */
function refState(root, candidate, maxBuffer) {
  const named = run(root, ["rev-parse", "--verify", "--quiet", candidate], maxBuffer);
  if (!named.ok) {
    return isAbsence(named) ? MISSING : UNREADABLE;
  }
  const commit = run(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], maxBuffer);
  return commit.ok ? PRESENT : UNREADABLE;
}

// Whether HEAD names a commit. A repository with no commits yet has no
// committed half to miss; one that does had its half computed or it did not.
function headIsBorn(root, maxBuffer) {
  const result = run(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], maxBuffer);
  if (result.ok) {
    return true;
  }
  if (isAbsence(result)) {
    return false;
  }
  throw new Error("Whether HEAD names a commit could not be determined.");
}

/*
 * The one failure that means "there is nothing here" rather than "I could not
 * look": git exited 1 and said nothing. A process killed by a signal -- which
 * is also how a timeout arrives -- reports no exit code at all and an empty
 * stderr, and a git that could not be started reports neither; reading any of
 * those as an absence turned every question this file asks into a confident
 * "no": no ref, no default branch, not shallow, no commits. Each of those
 * answers empties the change set, so a git that was killed reported a branch
 * with commits on it as unchanged.
 */
function isAbsence(result) {
  return result.status === 1 && result.signal === null && !result.failed && result.stderr === "";
}

// Asked only to decide whether an empty merge-base answer can be believed, so
// not being able to ask is itself a reason not to believe it.
function isShallow(root, maxBuffer) {
  const result = run(root, ["rev-parse", "--is-shallow-repository"], maxBuffer);
  if (!result.ok) {
    throw new Error("Whether the repository is shallow could not be determined.");
  }
  return result.stdout.toString("utf8").trim() === "true";
}

function originHead(root, maxBuffer) {
  const result = run(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], maxBuffer);
  if (result.ok) {
    const head = result.stdout.toString("utf8").trim();
    return head === "" ? null : head;
  }
  // No remote, or no default branch recorded for it -- but only when git said
  // so by exiting 1 in silence.
  if (isAbsence(result)) {
    return null;
  }
  throw new Error("The remote's default branch could not be read.");
}

/*
 * Porcelain v1 with -z: `XY PATH\0`, and for a rename or copy the original
 * path follows as its own `\0`-terminated field. --untracked-files=all lists
 * files inside untracked directories individually.
 *
 * X is the index and Y the working tree, and a rename can be reported in
 * either: `git mv` stages it as "R ", while a plain move plus `git add -N`
 * reports " R". Both columns have to be tested, or the original path is read
 * as the next entry's status line -- which drops it and invents a path out of
 * its last characters.
 */
function workingTreePaths(root, maxBuffer) {
  const fields = listing(
    root,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
    maxBuffer
  );
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) {
      continue;
    }
    paths.push(field.slice(3));
    if (isRenameOrCopy(field[0]) || isRenameOrCopy(field[1])) {
      index += 1;
      if (fields[index]) {
        paths.push(fields[index]);
      }
    }
  }
  return paths;
}

function isRenameOrCopy(status) {
  return status === "R" || status === "C";
}

// Only the line feed git adds. A carriage return before it is part of the name
// on a POSIX filesystem, and taking it off names a different directory --
// which is answered about successfully, so the wrong repository's change set
// comes back as this one's.
function withoutNewline(output) {
  return output.replace(/\n$/, "");
}


/*
 * The same change set, on stdout, as a JSON array rather than one path per
 * line: a path may contain a newline and git hands it over verbatim, so joined
 * by newlines the single file "alpha\nbeta.js" and the two files "alpha" and
 * "beta.js" are the same bytes and the reader loses what changed. The manual skill runs
 * this rather than carrying its own git one-liner: a hand-written
 * `merge-base HEAD origin/HEAD` resolves nothing in a repository with no
 * remote and drops a rename's original path, so the two would disagree about
 * what has to be recorded exactly where it matters.
 */
export async function main() {
  const changes = changedPaths(process.cwd());
  const answer =
    changes === null
      ? { paths: [], complete: false, reason: "not a git repository, or git could not be asked" }
      : { paths: changes.paths, complete: changes.complete };
  process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
}

if (isMainModule(process.argv[1])) {
  await main();
}

function isMainModule(argument) {
  if (typeof argument !== "string" || argument.length === 0) {
    return false;
  }
  const scriptPath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(argument) === fs.realpathSync(scriptPath);
  } catch {
    return path.resolve(argument) === path.resolve(scriptPath);
  }
}
