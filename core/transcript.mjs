import fs from "node:fs";

/*
 * Claude Code hook payloads carry no turn id, so the transcript is the only
 * per-turn signal available at PreToolUse. Human prompts are recorded as
 * `type: "user"` entries whose `origin.kind` is "human"; tool results,
 * interruptions, and injected context do not carry that marker.
 */
// Transcripts grow for the life of a session; only the tail can hold the
// prompt that started the current turn, so cap the read to keep the hook fast.
export const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

export function latestHumanPrompt(transcriptPath, filesystem = fs) {
  let raw;
  try {
    raw = readTail(transcriptPath, filesystem);
  } catch {
    return null;
  }

  const lines = raw.split("\n");
  // A partial first line (cut by the tail window) fails JSON.parse and is skipped.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('"type":"user"') || !line.includes('"human"')) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "user" || entry?.origin?.kind !== "human") {
      continue;
    }
    const text = promptText(entry.message?.content);
    if (text !== null) {
      return text;
    }
  }
  return null;
}

function promptText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const blocks = content.filter(block => block?.type === "text" && typeof block.text === "string");
  return blocks.length > 0 ? blocks.map(block => block.text).join("\n") : null;
}

function readTail(filePath, filesystem) {
  const descriptor = filesystem.openSync(filePath, "r");
  try {
    const size = filesystem.fstatSync(descriptor).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    filesystem.readSync(descriptor, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    filesystem.closeSync(descriptor);
  }
}
