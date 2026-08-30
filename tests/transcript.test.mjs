import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { latestHumanPrompt, TRANSCRIPT_TAIL_BYTES } from "../core/transcript.mjs";

test("returns the text of the last human-originated user entry", () => {
  const file = writeTranscript([
    { type: "user", origin: { kind: "human" }, message: { role: "user", content: "first request" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] } },
    { type: "user", origin: { kind: "human" }, message: { role: "user", content: "second request" } },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } },
    { type: "queue-operation", content: "third (queued, not yet a prompt)" }
  ]);
  assert.equal(latestHumanPrompt(file), "second request");
});

test("joins text blocks when the human entry uses array content", () => {
  const file = writeTranscript([
    { type: "user", origin: { kind: "human" }, message: { role: "user", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] } }
  ]);
  assert.equal(latestHumanPrompt(file), "a\nb");
});

test("returns null when no human prompt is recorded or the file is unreadable", () => {
  const file = writeTranscript([
    { type: "user", message: { role: "user", content: "no origin marker" } },
    "not json at all"
  ]);
  assert.equal(latestHumanPrompt(file), null);
  assert.equal(latestHumanPrompt(path.join(path.dirname(file), "missing.jsonl")), null);
});

function writeTranscript(entries) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-transcript-"));
  const file = path.join(directory, "transcript.jsonl");
  fs.writeFileSync(
    file,
    `${entries.map(entry => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n")}\n`
  );
  return file;
}

test("only the tail of a large transcript is scanned", () => {
  const filler = JSON.stringify({ type: "assistant", message: { content: "x".repeat(1024) } });
  const beyondWindow = { type: "user", origin: { kind: "human" }, message: { role: "user", content: "old prompt" } };
  const fillerCount = Math.ceil(TRANSCRIPT_TAIL_BYTES / filler.length) + 2;
  const file = writeTranscript([beyondWindow, ...Array.from({ length: fillerCount }, () => filler)]);
  assert.equal(latestHumanPrompt(file), null, "a prompt outside the tail window is not visible");

  fs.appendFileSync(file, `${JSON.stringify({ type: "user", origin: { kind: "human" }, message: { role: "user", content: "new prompt" } })}\n`);
  assert.equal(latestHumanPrompt(file), "new prompt");
});
