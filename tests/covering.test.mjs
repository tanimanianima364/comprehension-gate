import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NOTES_DIRECTORY, notesCovering } from "../core/notes.mjs";
import { handleHook } from "../core/gate.mjs";
import { createRepository } from "./helpers.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writeNote(repository, name, covers, { supersedes = [], title = "Why it is this way" } = {}) {
  const target = path.join(repository, NOTES_DIRECTORY, `${name}.md`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const front = [
    "---",
    "covers:",
    ...covers.map(one => `  - ${one}`),
    ...(supersedes.length > 0 ? ["supersedes:", ...supersedes.map(one => `  - ${one}`)] : []),
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n");
  fs.writeFileSync(target, front);
}

test("a path's notes come back with the title that heads them", () => {
  const repository = createRepository();
  writeNote(repository, "2026-09-13-one-a1b2c3d4", ["core/gate.mjs"], { title: "The gate holds nothing" });
  writeNote(repository, "2026-09-13-two-b2c3d4e5", ["README.md"]);

  assert.deepEqual(notesCovering(repository, ["core/gate.mjs"]), [
    {
      file: `${NOTES_DIRECTORY}/2026-09-13-one-a1b2c3d4.md`,
      title: "The gate holds nothing",
      supersededBy: null
    }
  ]);
  assert.deepEqual(notesCovering(repository, ["nothing/here.js"]), []);
});

/*
 * The reason the reader needs this: a path covered by two notes, one of which
 * the other replaced, must not send them off to read the stale one first.
 */
test("a note another note supersedes says which one replaced it", () => {
  const repository = createRepository();
  writeNote(repository, "2026-01-31-old-0a1b2c3d", ["core/gate.mjs"], { title: "The old approach" });
  writeNote(repository, "2026-09-13-new-a1b2c3d4", ["core/gate.mjs"], {
    supersedes: ["2026-01-31-old-0a1b2c3d"],
    title: "The new approach"
  });

  const covering = notesCovering(repository, ["core/gate.mjs"]);
  assert.deepEqual(covering.map(note => [note.title, note.supersededBy]), [
    ["The old approach", `${NOTES_DIRECTORY}/2026-09-13-new-a1b2c3d4.md`],
    ["The new approach", null]
  ]);
});

test("a note with no heading, and an unreadable one, still answer without throwing", () => {
  const repository = createRepository();
  const target = path.join(repository, NOTES_DIRECTORY, "headless.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "---\ncovers:\n  - core/gate.mjs\n---\n\njust prose\n");
  assert.deepEqual(notesCovering(repository, ["core/gate.mjs"]), [
    { file: `${NOTES_DIRECTORY}/headless.md`, title: null, supersededBy: null }
  ]);
});

test("an edit to a covered path carries its notes into the tool call", () => {
  const repository = createRepository();
  writeNote(repository, "2026-09-13-one-a1b2c3d4", ["src/app.js"], { title: "Why app.js is split" });

  const context = JSON.parse(
    handleHook(
      {
        cwd: repository,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: path.join(repository, "src/app.js") }
      }).stdout
  ).hookSpecificOutput.additionalContext;

  assert.match(context, /src\/app\.js/);
  assert.match(context, /2026-09-13-one-a1b2c3d4\.md/);
  assert.match(context, /Why app\.js is split/);
  assert.match(context, /read/i);
});

test("an edit to a path no note covers passes through untouched", () => {
  const repository = createRepository();
  for (const toolInput of [{ file_path: path.join(repository, "src/app.js") }, { command: "sed -i s/a/b/ src/app.js" }]) {
    assert.deepEqual(
      handleHook(
        { cwd: repository, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: toolInput }),
      { exitCode: 0, stdout: "", stderr: "" }
    );
  }
});

test("a relative tool path resolves against the working directory", () => {
  const repository = createRepository();
  writeNote(repository, "2026-09-13-one-a1b2c3d4", ["src/app.js"]);

  const relative = handleHook(
    {
      cwd: repository,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "src/app.js" }
    });
  assert.match(relative.stdout, /2026-09-13-one-a1b2c3d4\.md/);

});

test("a write to an uncovered path is reported the moment it lands", () => {
  const repository = createRepository();
  writeNote(repository, "2026-09-13-one-a1b2c3d4", ["src/covered.js"]);
  fs.mkdirSync(path.join(repository, "src"), { recursive: true });
  fs.writeFileSync(path.join(repository, "src/covered.js"), "export {};\n");
  fs.writeFileSync(path.join(repository, "src/fresh.js"), "export {};\n");

  const after = handleHook(
    {
      cwd: repository,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(repository, "src/fresh.js") }
    });
  const context = JSON.parse(after.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /src\/fresh\.js/);
  assert.doesNotMatch(context, /src\/covered\.js/);
});

test("a write that leaves nothing uncovered says nothing", () => {
  const repository = createRepository();
  fs.mkdirSync(path.join(repository, "src"), { recursive: true });
  fs.writeFileSync(path.join(repository, "src/covered.js"), "export {};\n");
  writeNote(repository, "2026-09-13-one-a1b2c3d4", ["src/covered.js"]);

  assert.deepEqual(
    handleHook(
      {
        cwd: repository,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: path.join(repository, "src/covered.js") }
      }),
    { exitCode: 0, stdout: "", stderr: "" }
  );
});

/*
 * Writing a note is exactly when the remaining list changed, so the check is
 * spent there too -- but the note's own path is never one of the things
 * reported, or it would ask for a note about the note.
 */
test("writing a note reports what is still uncovered, never the note itself", () => {
  const repository = createRepository();
  fs.writeFileSync(path.join(repository, "still-bare.js"), "export {};\n");
  writeNote(repository, "2026-09-13-one-a1b2c3d4", ["something/else.js"]);

  const context = JSON.parse(
    handleHook(
      {
        cwd: repository,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: {
          file_path: path.join(repository, NOTES_DIRECTORY, "2026-09-13-one-a1b2c3d4.md")
        }
      }).stdout
  ).hookSpecificOutput.additionalContext;
  assert.match(context, /still-bare\.js/);
  assert.doesNotMatch(context, /2026-09-13-one-a1b2c3d4\.md/);
});

test("a path outside the repository is left alone", () => {
  const repository = createRepository();
  writeNote(repository, "2026-09-13-one-a1b2c3d4", ["src/app.js"]);
  for (const event of ["PreToolUse", "PostToolUse"]) {
    assert.deepEqual(
      handleHook(
        {
          cwd: repository,
          hook_event_name: event,
          tool_name: "Write",
          tool_input: { file_path: "/etc/hosts" }
        }),
      { exitCode: 0, stdout: "", stderr: "" }
    );
  }
});

/*
 * A host attaches PreToolUse context to the tool result, so a hint on the edit
 * itself reaches the agent only after that edit has run. The read that
 * precedes the edit is where a hint still arrives in time.
 */
test("reading a covered file carries its notes, not only writing to it", () => {
  const repository = createRepository();
  writeNote(repository, "2026-09-13-one-a1b2c3d4", ["src/app.js"], { title: "Why app.js is split" });

  for (const tool of ["Read", "view"]) {
    const result = handleHook(
      {
        cwd: repository,
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: { file_path: path.join(repository, "src/app.js") }
      });
    assert.match(result.stdout, /Why app\.js is split/, tool);
  }
});

// A read is not a change, so it never draws the uncovered notice.
test("reading an uncovered file reports nothing after the fact", () => {
  const repository = createRepository();
  fs.mkdirSync(path.join(repository, "src"), { recursive: true });
  fs.writeFileSync(path.join(repository, "src/fresh.js"), "export {};\n");
  assert.deepEqual(
    handleHook(
      {
        cwd: repository,
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: { file_path: path.join(repository, "src/fresh.js") }
      }),
    { exitCode: 0, stdout: "", stderr: "" }
  );
});

/*
 * Codex sends apply_patch as a command string. It is read here by its own
 * `*** ... File:` headers -- the structured format it is -- and never as a
 * shell command to be parsed.
 */
test("a Codex apply_patch envelope names the files it touches", () => {
  const repository = createRepository();
  writeNote(repository, "2026-09-13-one-a1b2c3d4", ["src/app.js"], { title: "Why app.js is split" });
  const command = [
    "*** Begin Patch",
    "*** Update File: src/app.js",
    "@@",
    "-old",
    "+new",
    "*** Add File: src/fresh.js",
    "*** End Patch"
  ].join("\n");

  const hint = handleHook(
    { cwd: repository, hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command } });
  assert.match(hint.stdout, /Why app\.js is split/);

  fs.mkdirSync(path.join(repository, "src"), { recursive: true });
  fs.writeFileSync(path.join(repository, "src/fresh.js"), "export {};\n");
  const after = handleHook(
    { cwd: repository, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { command } });
  assert.match(
    JSON.parse(after.stdout).hookSpecificOutput.additionalContext,
    /src\/fresh\.js/
  );
});

// A shell command that is not a patch envelope still names nothing.
test("an ordinary shell command is not parsed for paths", () => {
  const repository = createRepository();
  writeNote(repository, "2026-09-13-one-a1b2c3d4", ["src/app.js"]);
  assert.deepEqual(
    handleHook(
      {
        cwd: repository,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "sed -i s/a/b/ src/app.js" }
      }),
    { exitCode: 0, stdout: "", stderr: "" }
  );
});

/*
 * The repository root is resolved through symlinks; a working directory that
 * is itself a symlink has to be, or every file under it is compared against a
 * differently spelled root and looks outside the repository.
 */
test("a working directory reached through a symlink still resolves its files", () => {
  const repository = createRepository();
  writeNote(repository, "2026-09-13-one-a1b2c3d4", ["src/app.js"], { title: "Why app.js is split" });
  const link = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "link-")), "workspace");
  fs.symlinkSync(repository, link, "dir");

  const hint = handleHook(
    {
      cwd: link,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "src/app.js" }
    });
  assert.match(hint.stdout, /Why app\.js is split/);
});

test("a path's notes arrive oldest first, across subdirectories", () => {
  const repository = createRepository();
  writeNote(repository, "2026-09-13-recent-a1b2c3d4", ["src/app.js"], { title: "recent" });
  writeNote(repository, "archive/2026-01-31-oldest-b2c3d4e5", ["src/app.js"], { title: "oldest" });
  writeNote(repository, "archive/deep/2026-05-01-middle-c3d4e5f6", ["src/app.js"], { title: "middle" });

  assert.deepEqual(
    notesCovering(repository, ["src/app.js"]).map(note => note.title),
    ["oldest", "middle", "recent"]
  );
});

/*
 * git tracks a symlink under its own name, so the notes that answer for it are
 * the ones covering the link -- not the ones covering whatever it points at.
 * Resolving the target through realpath looked up the wrong file, and for a
 * deletion named a file that was not the one being deleted.
 */
test("a symlinked file keeps its own name when its notes are looked up", () => {
  const repository = createRepository();
  fs.writeFileSync(path.join(repository, "CLAUDE.md"), "# real\n");
  fs.symlinkSync("CLAUDE.md", path.join(repository, "AGENTS.md"));
  writeNote(repository, "2026-09-13-one-a1b2c3d4", ["AGENTS.md"], { title: "Why AGENTS.md is a link" });

  const read = handleHook(
    {
      cwd: repository,
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: path.join(repository, "AGENTS.md") }
    },
    "compatible"
  );
  assert.match(read.stdout, /Why AGENTS\.md is a link/);

  fs.writeFileSync(path.join(repository, "CLAUDE.md"), "# real\n");
  writeNote(repository, "2026-09-13-two-b2c3d4e5", ["CLAUDE.md"], { title: "Why CLAUDE.md holds it" });
  const both = handleHook(
    {
      cwd: repository,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(repository, "AGENTS.md") }
    },
    "compatible"
  );
  assert.match(both.stdout, /Why AGENTS\.md is a link/, "the link's own notes");
  assert.match(both.stdout, /Why CLAUDE\.md holds it/, "and the target's, since a write through the link changes it");

  const deletion = handleHook(
    {
      cwd: repository,
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Delete File: AGENTS.md\n*** End Patch" }
    },
    "compatible"
  );
  assert.match(deletion.stdout, /Why AGENTS\.md is a link/);
});

/*
 * The notes tree is read once per hook invocation, not once per path a tool
 * names. A patch touching two hundred files against a repository holding five
 * thousand notes would otherwise read a million files inside a hook that has
 * twenty seconds to answer.
 */
test("the notes tree is read once however many paths a tool names", () => {
  const repository = createRepository();
  for (let index = 0; index < 20; index += 1) {
    writeNote(repository, `2026-09-13-note-${String(index).padStart(3, "0")}`, [`src/file-${index}.js`]);
  }
  const candidates = Array.from({ length: 50 }, (unused, index) => `src/file-${index}.js`);

  const real = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (...args) => {
    reads += 1;
    return real(...args);
  };
  try {
    assert.equal(notesCovering(repository, candidates).length, 20);
  } finally {
    fs.readFileSync = real;
  }
  assert.equal(reads, 20, "one read per note, not one per note per path");
});

/*
 * The pre-write lookup the instructions ask for has to find a path whose name
 * holds regular-expression syntax, which means a fixed-string search.
 */
test("the documented note lookup is a fixed-string search", () => {
  const documents = [
    fs.readFileSync(path.join(pluginRoot, "core", "instructions.md"), "utf8"),
    fs.readFileSync(path.join(pluginRoot, "skills", "comprehension-gate", "SKILL.md"), "utf8")
  ];
  for (const text of documents) {
    const command = text.match(/`(grep [^`]+)`/)?.[1];
    assert.ok(command, "the documents name a lookup command");
    assert.match(command, /-\w*F/, command);
    assert.match(command, /--/, `${command}: a path starting with a dash is not an option`);
  }

  const repository = createRepository();
  const awkward = "src/app/[slug]/page.tsx";
  writeNote(repository, "2026-09-13-one-a1b2c3d4", [awkward], { title: "Why the route is dynamic" });
  assert.equal(notesCovering(repository, [awkward]).length, 1, "the hook itself finds it");

  const fixed = spawnSync("grep", ["-rlF", "--", awkward, path.join(repository, NOTES_DIRECTORY)], {
    encoding: "utf8"
  });
  assert.equal(fixed.status, 0, "and so does the documented command");
  const pattern = spawnSync("grep", ["-rl", "--", awkward, path.join(repository, NOTES_DIRECTORY)], {
    encoding: "utf8"
  });
  assert.equal(pattern.status, 1, "while reading it as a pattern finds nothing");
});

/*
 * `..` as a prefix is not `..` as a path segment. A file called `..hidden.js`
 * sits in the repository like any other, and rejecting it as outside left
 * every note about it unmentioned and every write to it unreported -- while
 * the change set named it correctly, so the two disagreed.
 */
test("a file whose name begins with two dots is inside the repository", () => {
  const repository = createRepository();
  writeNote(repository, "2026-09-13-one-a1b2c3d4", ["..hidden.js"], { title: "Why it is hidden" });
  fs.writeFileSync(path.join(repository, "..hidden.js"), "export {};\n");

  const hint = handleHook(
    {
      cwd: repository,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: path.join(repository, "..hidden.js") }
    },
    "compatible"
  );
  assert.match(hint.stdout, /Why it is hidden/);

  // And a write to one no note covers is reported like any other path.
  const bare = createRepository();
  fs.writeFileSync(path.join(bare, "..fresh.js"), "export {};\n");
  const after = handleHook(
    {
      cwd: bare,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(bare, "..fresh.js") }
    },
    "compatible"
  );
  assert.match(
    JSON.parse(after.stdout).hookSpecificOutput.additionalContext,
    /\.\.fresh\.js/
  );
});

// A path that really does leave the repository is still refused.
test("a path that leaves the repository is still outside it", () => {
  const repository = createRepository();
  writeNote(repository, "2026-09-13-one-a1b2c3d4", ["src/app.js"]);
  assert.deepEqual(
    handleHook(
      {
        cwd: repository,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: path.join(repository, "..", "outside.js") }
      },
      "compatible"
    ),
    { exitCode: 0, stdout: "", stderr: "" }
  );
});

/*
 * A tool payload names a path as text and the change set names it as bytes.
 * Both are spelled the same way, so an edit to the ordinary file `x%FF.js`
 * finds the notes for that file and not for one whose name holds a raw byte.
 */
test("a tool path with a percent sign finds its own notes", () => {
  const repository = createRepository();
  // The note names the file the way it is really called; both sides escape.
  writeNote(repository, "2026-09-13-one-a1b2c3d4", ["x%FF.js"], { title: "Why the percent is literal" });
  fs.writeFileSync(path.join(repository, "x%FF.js"), "export {};\n");

  const hint = handleHook(
    {
      cwd: repository,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: path.join(repository, "x%FF.js") }
    },
    "compatible"
  );
  assert.match(hint.stdout, /Why the percent is literal/);
});
