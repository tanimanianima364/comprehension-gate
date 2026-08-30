import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { latestHumanPrompt, TRANSCRIPT_TAIL_BYTES } from "../core/transcript.mjs";

const human = (content, extra = {}) => ({
  type: "user",
  origin: { kind: "human" },
  message: { role: "user", content },
  ...extra
});

test("returns the identity of the last human-originated user entry", () => {
  const file = writeTranscript([
    human("first request", { uuid: "u1" }),
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] } },
    human("second request", { uuid: "u2" }),
    { type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } },
    { type: "queue-operation", content: "third (queued, not yet a prompt)" }
  ]);
  assert.match(latestHumanPrompt(file), /u2$/);
});

test("identical prompt text sent twice yields different identities", () => {
  const file = writeTranscript([human("続けて")]);
  const first = latestHumanPrompt(file);
  fs.appendFileSync(file, `${JSON.stringify(human("続けて"))}\n`);
  const second = latestHumanPrompt(file);
  assert.notEqual(first, null);
  assert.notEqual(first, second);
});

test("non-minified JSON records are still recognized", () => {
  const file = writeTranscript([JSON.stringify(human("spaced"), null, 0).replaceAll('":', '": ').replaceAll(",", ", ")]);
  assert.notEqual(latestHumanPrompt(file), null);
});

test("records without an origin marker count as human only when the content is a plain string", () => {
  const file = writeTranscript([
    { type: "user", message: { role: "user", content: "legacy typed prompt" }, uuid: "legacy" },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "injected" }] } },
    { type: "user", isMeta: true, message: { role: "user", content: "meta" } }
  ]);
  assert.match(latestHumanPrompt(file), /legacy$/);
});

test("returns null when no human prompt is recorded or the file is unreadable", () => {
  const file = writeTranscript([
    { type: "user", message: { role: "user", content: [{ type: "tool_result" }] } },
    "not json at all"
  ]);
  assert.equal(latestHumanPrompt(file), null);
  assert.equal(latestHumanPrompt(path.join(path.dirname(file), "missing.jsonl")), null);
});

test("only the tail of a large transcript is scanned", () => {
  const filler = JSON.stringify({ type: "assistant", message: { content: "x".repeat(1024) } });
  const fillerCount = Math.ceil(TRANSCRIPT_TAIL_BYTES / filler.length) + 2;
  const file = writeTranscript([human("old prompt"), ...Array.from({ length: fillerCount }, () => filler)]);
  assert.equal(latestHumanPrompt(file), null, "a prompt outside the tail window is not visible");

  fs.appendFileSync(file, `${JSON.stringify(human("new prompt", { uuid: "new" }))}\n`);
  assert.match(latestHumanPrompt(file), /new$/);
});

test("a short read decodes only the bytes actually read", () => {
  const file = writeTranscript([human("short read", { uuid: "short" })]);
  const shortFs = new Proxy(fs, {
    get(target, property) {
      if (property === "readSync") {
        return (descriptor, buffer, offset, length, position) =>
          target.readSync(descriptor, buffer, offset, Math.ceil(length / 2), position + Math.floor(length / 2));
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  // Half the record is cut off, so no human prompt is decodable; trailing NULs must not be parsed.
  assert.doesNotThrow(() => latestHumanPrompt(file, shortFs));
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
