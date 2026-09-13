import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function git(directory, args) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

// A repository with one commit, so HEAD exists and the tree is clean.
export function createRepository() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-repo-")));
  git(directory, ["init", "-q", "-b", "main"]);
  git(directory, ["config", "user.email", "test@example.com"]);
  git(directory, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(directory, "README.md"), "# Test\n");
  git(directory, ["add", "README.md"]);
  git(directory, ["commit", "-q", "-m", "initial"]);
  return directory;
}
