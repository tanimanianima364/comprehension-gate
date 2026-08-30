import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  decodeInspectionArgument,
  encodeInspectionArgument,
  runInspection
} from "../core/inspection.mjs";

test("inspection read stays inside the canonical workspace and accepts the size boundary", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-inspection-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-inspection-outside-"));
  const sentinel = "outside-secret-sentinel";
  fs.writeFileSync(path.join(outside, "secret.txt"), sentinel);
  fs.writeFileSync(path.join(workspace, "limit.txt"), "x".repeat(256 * 1024));
  fs.writeFileSync(path.join(workspace, "too-large.txt"), "x".repeat(256 * 1024 + 1));
  const candidates = [
    "too-large.txt",
    path.relative(workspace, path.join(outside, "secret.txt")),
    path.join(outside, "secret.txt")
  ];
  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "escape-link"));
    candidates.push("escape-link");
  }

  assert.equal(runRead(workspace, "limit.txt").length, 256 * 1024 + 1);
  for (const candidate of candidates) {
    assert.throws(() => runRead(workspace, candidate));
  }
});

test("inspection search is literal, bounded, and never follows directory symlinks", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-search-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-search-outside-"));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "literal.txt"), "prefix a.*b suffix\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "aZZb outside-secret\n");
  if (process.platform !== "win32") {
    fs.symlinkSync(outside, path.join(workspace, "src", "external"), "dir");
  }

  const literal = runSearch(workspace, "a.*b", ".");
  assert.match(literal, /src\/literal\.txt:1/);
  assert.doesNotMatch(literal, /outside-secret/);
  assert.match(literal, /\[read-token:[A-Za-z0-9_-]+\]/);
  assert.equal(runSearch(workspace, "aZZb", "."), "");
  assert.throws(() => runSearch(workspace, "x".repeat(257), "."));
  if (process.platform !== "win32") {
    assert.throws(() => runSearch(workspace, "secret", "src/external"));
  }

  for (let index = 0; index < 205; index += 1) {
    fs.writeFileSync(path.join(workspace, "src", `match-${index}.txt`), "needle\n");
  }
  const bounded = runSearch(workspace, "needle", "src");
  assert.match(bounded, /\[inspection-search:truncated\]/);
  assert.ok(bounded.split("\n").length <= 202);
});

test("inspection arguments require canonical non-empty UTF-8 base64url", () => {
  for (const value of ["README.md", "認証/処理.ts", "."]) {
    assert.equal(decodeInspectionArgument(encodeInspectionArgument(value)), value);
  }
  for (const token of ["", "A", "YWJj=", "***", "_w"]) {
    assert.throws(() => decodeInspectionArgument(token));
  }
});

function runRead(workspace, relativePath) {
  return capture("inspect-read", [workspace, relativePath]);
}

function runSearch(workspace, pattern, root) {
  return capture("inspect-search", [workspace, pattern, root]);
}

function capture(action, values) {
  let text = "";
  runInspection(
    action,
    values.map(encodeInspectionArgument),
    { write(chunk) { text += chunk; } }
  );
  return text;
}
