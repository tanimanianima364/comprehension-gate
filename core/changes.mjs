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
const BASE_CANDIDATES = ["origin/main", "origin/master", "main", "master"];

function git(directory, args, maxBuffer = GIT_MAX_OUTPUT_BYTES) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
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
    root = fs.realpathSync(git(directory, ["rev-parse", "--show-toplevel"], maxBuffer).trim());
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
 * branch yet, or a HEAD with no common ancestor, still has a working tree,
 * and reporting that half alone is better than reporting nothing.
 */
function committedPaths(root, maxBuffer) {
  const base = resolveBase(root);
  if (base === null) {
    return [];
  }
  let mergeBase;
  try {
    mergeBase = git(root, ["merge-base", "HEAD", base]).trim();
  } catch {
    return [];
  }
  // --no-renames so a renamed file is reported as both a deletion and an
  // addition, matching how the working tree half names both paths.
  return splitFields(
    git(root, ["diff", "--name-only", "--no-renames", "-z", mergeBase, "HEAD"], maxBuffer)
  );
}

/*
 * Every candidate is resolved to a commit before it is adopted. origin/HEAD in
 * particular outlives the branch it points at -- renaming the remote default
 * branch and pruning leaves it dangling -- and adopting a ref that names no
 * commit makes merge-base fail, which would silently empty the committed half
 * of the change set rather than fall through to a base that does exist.
 */
function resolveBase(root) {
  for (const candidate of [originHead(root), ...BASE_CANDIDATES]) {
    if (candidate === null) {
      continue;
    }
    try {
      git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);
      return candidate;
    } catch {
      // Not this one.
    }
  }
  return null;
}

function originHead(root) {
  try {
    const head = git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).trim();
    return head === "" ? null : head;
  } catch {
    // No remote, or no default branch recorded for it.
    return null;
  }
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
  process.stdout.write(`${JSON.stringify(changes === null ? [] : changes.paths, null, 2)}\n`);
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
