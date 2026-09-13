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

const GIT_TIMEOUT_MS = 10_000;
// Ordered by how well each ref answers "what will this branch be reviewed
// against": the remote's own default branch first, then its usual names, then
// the local ones for a repository that has no remote at all.
const BASE_CANDIDATES = ["origin/main", "origin/master", "main", "master"];

function git(directory, args) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_TIMEOUT_MS
  });
}

export function changedPaths(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    return null;
  }

  let root;
  try {
    root = fs.realpathSync(git(directory, ["rev-parse", "--show-toplevel"]).trim());
  } catch {
    return null;
  }

  try {
    const paths = new Set([...committedPaths(root), ...workingTreePaths(root)]);
    return { root, paths: [...paths].sort() };
  } catch {
    return null;
  }
}

/*
 * Nothing to compare against is not an error: a repository with no default
 * branch yet, or a HEAD with no common ancestor, still has a working tree,
 * and reporting that half alone is better than reporting nothing.
 */
function committedPaths(root) {
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
  return splitFields(git(root, ["diff", "--name-only", "--no-renames", "-z", mergeBase, "HEAD"]));
}

function resolveBase(root) {
  try {
    const head = git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).trim();
    if (head !== "") {
      return head;
    }
  } catch {
    // No remote, or no default branch recorded for it.
  }
  for (const candidate of BASE_CANDIDATES) {
    try {
      git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);
      return candidate;
    } catch {
      // Not this one.
    }
  }
  return null;
}

/*
 * Porcelain v1 with -z: `XY PATH\0`, and for a rename or copy the original
 * path follows as its own `\0`-terminated field. --untracked-files=all lists
 * files inside untracked directories individually.
 */
function workingTreePaths(root) {
  const fields = splitFields(
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  );
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) {
      continue;
    }
    paths.push(field.slice(3));
    if (field[0] === "R" || field[0] === "C") {
      index += 1;
      if (fields[index]) {
        paths.push(fields[index]);
      }
    }
  }
  return paths;
}

function splitFields(output) {
  return output.split("\0").filter(field => field !== "");
}
