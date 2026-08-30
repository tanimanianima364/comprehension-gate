import { createHash } from "node:crypto";
import fs from "node:fs";

// Transcripts grow for the life of a session; only the tail can hold the
// prompt that started the current turn, so cap the read to keep the hook fast.
export const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

/*
 * Claude Code hook payloads carry no turn id, so the transcript is the only
 * per-turn signal available at PreToolUse. Returns an identity for the latest
 * human prompt record, or null when none can be determined. The identity is
 * the record's byte offset plus its uuid (or a digest of the record), so the
 * same prompt text submitted twice yields two different identities.
 */
export function latestHumanPrompt(transcriptPath, filesystem = fs) {
  let tail;
  try {
    tail = readTail(transcriptPath, filesystem);
  } catch {
    return null;
  }

  const lines = tail.text.split("\n");
  let offset = tail.start + Buffer.byteLength(tail.text, "utf8");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    offset -= Buffer.byteLength(line, "utf8") + (index === lines.length - 1 ? 0 : 1);
    if (index === 0 && tail.start > 0) {
      break; // The first line may be cut by the tail window.
    }
    const entry = parseRecord(line);
    if (entry !== null && isHumanPrompt(entry)) {
      const marker = typeof entry.uuid === "string" && entry.uuid !== ""
        ? entry.uuid
        : createHash("sha256").update(line).digest("hex");
      return `${offset}:${marker}`;
    }
  }
  return null;
}

function parseRecord(line) {
  if (line.trim() === "") {
    return null;
  }
  try {
    const entry = JSON.parse(line);
    return entry && typeof entry === "object" ? entry : null;
  } catch {
    return null;
  }
}

/*
 * Human prompts carry `origin.kind: "human"`. Tool results, interruptions,
 * and injected context are also `type: "user"` records but lack that marker;
 * they use array content or `isMeta`. Records without any `origin` field
 * (older formats) count as human only when the content is a plain string.
 */
function isHumanPrompt(entry) {
  if (entry.type !== "user" || entry.isMeta === true) {
    return false;
  }
  if (entry.origin && typeof entry.origin === "object") {
    return entry.origin.kind === "human";
  }
  return typeof entry.message?.content === "string";
}

function readTail(filePath, filesystem) {
  const descriptor = filesystem.openSync(filePath, "r");
  try {
    const size = filesystem.fstatSync(descriptor).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    const bytesRead = filesystem.readSync(descriptor, buffer, 0, length, start);
    return { start, text: buffer.subarray(0, bytesRead).toString("utf8") };
  } finally {
    filesystem.closeSync(descriptor);
  }
}
