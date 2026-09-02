import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  controlTarget
} from "../core/gate.mjs";

export function createFixture(extraEnv = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-hook-"));
  return {
    env: {
      COMPREHENSION_GATE_STATE_DIR: directory,
      ...extraEnv
    }
  };
}

export function controlInput(action, field = "file_path") {
  if (field === "kiroOperations") {
    return { operations: [{ mode: "Line", path: controlTarget(action) }] };
  }
  return { [field]: controlTarget(action) };
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function assertDenied(result, mode, message) {
  if (mode === "kiro") {
    assert.equal(result.exitCode, 2, message);
    return;
  }
  const output = JSON.parse(result.stdout);
  if (mode === "cursor") {
    assert.equal(output.permission, "deny", message);
    return;
  }
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny", message);
}

import { execFileSync } from "node:child_process";

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
