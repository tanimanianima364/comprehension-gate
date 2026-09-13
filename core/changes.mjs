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

import { execFileSync } from "node:child_process";
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

function git(directory, args, maxBuffer = GIT_MAX_OUTPUT_BYTES) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    // stderr is captured rather than discarded: it is the only thing that
    // separates "these histories are unrelated" from "a commit could not be
    // read", which git reports with the same exit code.
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer
  });
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
    root = fs.realpathSync(withoutNewline(git(directory, ["rev-parse", "--show-toplevel"], maxBuffer)));
  } catch {
    return null;
  }

  const committed = attempt(() => committedPaths(root, maxBuffer));
  const working = attempt(() => workingTreePaths(root, maxBuffer));
  if (committed === null && working === null) {
    return null;
  }
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
    return [];
  }
  let mergeBase;
  try {
    mergeBase = git(root, ["merge-base", "HEAD", base]).trim();
  } catch (error) {
    /*
     * Exit 1 with nothing on stderr is git's answer for "these histories have
     * no common ancestor" -- and also what it says when a shallow clone simply
     * does not hold the commit where they meet, since a shallow boundary looks
     * like a commit with no parents. The first is legitimately empty; the
     * second is a branch whose whole committed half is missing from the
     * answer, so a shallow repository is asked about before believing it.
     */
    if (error?.status === 1 && String(error.stderr ?? "") === "" && !isShallow(root, maxBuffer)) {
      return [];
    }
    throw error;
  }
  /*
   * --no-renames so a renamed file is reported as both a deletion and an
   * addition, matching how the working tree half names both paths.
   *
   * The trailing `--` ends the revisions. Without it a repository holding a
   * file called `HEAD` makes git refuse the whole command as ambiguous, and
   * the committed half of an ordinary branch cannot be collected at all --
   * no fault injection needed, just a file with that name.
   */
  return splitFields(
    git(root, ["diff", "--name-only", "--no-renames", "-z", mergeBase, "HEAD", "--"], maxBuffer)
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
  const named = attemptGit(() => git(root, ["rev-parse", "--verify", "--quiet", candidate], maxBuffer));
  if (!named.ok) {
    return isAbsence(named) ? MISSING : UNREADABLE;
  }
  const commit = attemptGit(() =>
    git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], maxBuffer)
  );
  return commit.ok ? PRESENT : UNREADABLE;
}

function attemptGit(call) {
  try {
    return { ok: true, stdout: call(), status: 0, signal: null, stderr: "" };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      status: typeof error?.status === "number" ? error.status : null,
      signal: error?.signal ?? null,
      stderr: String(error?.stderr ?? "")
    };
  }
}

/*
 * The one failure that means "there is nothing here" rather than "I could not
 * look": git exited 1 and said nothing. A process killed by a signal -- which
 * is also how a timeout arrives -- reports no exit code at all and an empty
 * stderr, and reading that as an absence turned every question this file asks
 * into a confident "no": no ref, no default branch, not shallow. Each of those
 * answers empties the change set, so a git that was killed reported a branch
 * with commits on it as unchanged.
 */
function isAbsence(result) {
  return result.status === 1 && result.signal === null && result.stderr === "";
}

// Asked only to decide whether an empty merge-base answer can be believed, so
// not being able to ask is itself a reason not to believe it.
function isShallow(root, maxBuffer) {
  const result = attemptGit(() => git(root, ["rev-parse", "--is-shallow-repository"], maxBuffer));
  if (!result.ok) {
    throw new Error("Whether the repository is shallow could not be determined.");
  }
  return result.stdout.trim() === "true";
}

function originHead(root, maxBuffer) {
  const result = attemptGit(() =>
    git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], maxBuffer)
  );
  if (result.ok) {
    const head = result.stdout.trim();
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
  const fields = splitFields(
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], maxBuffer)
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

function splitFields(output) {
  return output.split("\0").filter(field => field !== "");
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
