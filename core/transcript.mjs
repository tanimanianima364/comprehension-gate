import { createHash } from "node:crypto";
import fs from "node:fs";

// Transcripts grow for the life of a session; only the tail can hold the
// prompt that started the current turn, so cap the read to keep the hook fast.
export const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

/*
 * Fallback turn signal for hosts that provide no turn id (Claude Code before
 * prompt_id existed). Returns an identity for the latest human prompt record
 * in the transcript, or null when none can be determined: the record's uuid
 * when it has one, otherwise its absolute byte offset plus a digest of the
 * raw line, so the same prompt text submitted twice yields two identities.
 */
export function latestHumanPrompt(transcriptPath, filesystem = fs) {
  let tail;
  try {
    tail = readTail(transcriptPath, filesystem);
  } catch {
    return null;
  }

  const { buffer, start } = tail;
  let end = buffer.length;
  while (end > 0) {
    const newline = buffer.lastIndexOf(0x0a, end - 1);
    const lineStart = newline + 1;
    if (lineStart === 0 && start > 0) {
      break; // The first line may be cut by the tail window.
    }
    const line = buffer.subarray(lineStart, end);
    const entry = parseRecord(line);
    if (entry !== null && isHumanPrompt(entry)) {
      return identityOf(entry, line, start + lineStart);
    }
    end = newline < 0 ? 0 : newline;
  }
  return null;
}

function identityOf(entry, line, offset) {
  if (typeof entry.uuid === "string" && entry.uuid !== "") {
    return `uuid:${entry.uuid}`;
  }
  return `offset:${offset}:${createHash("sha256").update(line).digest("hex")}`;
}

function parseRecord(line) {
  if (line.length === 0) {
    return null;
  }
  try {
    const entry = JSON.parse(line.toString("utf8"));
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
    return { start, buffer: buffer.subarray(0, bytesRead) };
  } finally {
    filesystem.closeSync(descriptor);
  }
}
