import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleHook } from "../core/gate.mjs";
import { readGateState, stateFilePath } from "../core/state.mjs";
import { createFixture, controlInput, createRepository, git } from "./helpers.mjs";

function session(mode, repository, extra = {}) {
  const fixture = createFixture(mode === "kiro" ? { KIRO_SESSION_ID: "kiro-session" } : {});
  const ids = mode === "cursor"
    ? { conversation_id: "conv-1", generation_id: "g1", workspace_roots: [repository] }
    : mode === "kiro"
      ? { cwd: repository }
      : { session_id: "stop-session", prompt_id: "p1", cwd: repository };
  const base = { ...ids, ...extra };
  const startEvent = mode === "kiro" ? "agentSpawn" : mode === "cursor" ? "sessionStart" : "SessionStart";
  handleHook({ ...base, hook_event_name: startEvent, source: "startup" }, mode, fixture);
  return { fixture, base };
}

function stop(mode, base, fixture, extra = {}) {
  const event = mode === "kiro" ? "stop" : mode === "cursor" ? "stop" : "Stop";
  const cursorFields = mode === "cursor" ? { status: "completed", loop_count: 0 } : {};
  return handleHook({ ...base, ...cursorFields, hook_event_name: event, ...extra }, mode, fixture);
}

function pass(base, fixture) {
  handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t-pass", tool_input: controlInput("pass") },
    "compatible",
    fixture
  );
  handleHook(
    {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_use_id: "t-pass",
      tool_input: controlInput("pass"),
      tool_response: { stdout: "<!-- comprehension-gate:pass -->\n", stderr: "", interrupted: false }
    },
    "compatible",
    fixture
  );
}

test("a turn that changes nothing ends without objection", () => {
  const repository = createRepository();
  const { fixture, base } = session("compatible", repository);
  const result = stop("compatible", base, fixture);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "");
});

test("an unaccounted change holds the turn once, then lets the insight through", () => {
  const repository = createRepository();
  const { fixture, base } = session("compatible", repository);
  fs.writeFileSync(path.join(repository, "src.js"), "export {};\n");

  const held = stop("compatible", base, fixture);
  const output = JSON.parse(held.stdout);
  assert.equal(output.decision, "block");
  assert.match(output.reason, /src\.js/);
  assert.match(output.reason, /control\/pass/);
  assert.match(output.systemMessage, /unaccounted/i);
  assert.equal(readGateState("claude", base, fixture).state.outstanding, true);

  const second = stop("compatible", base, fixture, { stop_hook_active: true });
  const secondOutput = JSON.parse(second.stdout);
  assert.equal(secondOutput.decision, undefined);
  assert.match(secondOutput.systemMessage, /unaccounted/i);
});

test("a pass in the same turn covers the change, before or after the writes", () => {
  const repository = createRepository();
  const { fixture, base } = session("compatible", repository);

  pass(base, fixture);
  fs.writeFileSync(path.join(repository, "after.js"), "export {};\n");
  const afterPass = stop("compatible", base, fixture);
  assert.equal(afterPass.stdout, "");
  assert.equal(readGateState("claude", base, fixture).state.outstanding, false);

  const next = { ...base, prompt_id: "p2" };
  handleHook({ ...next, hook_event_name: "UserPromptSubmit", prompt: "more" }, "compatible", fixture);
  fs.writeFileSync(path.join(repository, "before.js"), "export {};\n");
  pass(next, fixture);
  const explainedLater = stop("compatible", next, fixture);
  assert.equal(explainedLater.stdout, "");
});

test("an outstanding change survives a new prompt until it is accounted for", () => {
  const repository = createRepository();
  const { fixture, base } = session("compatible", repository);
  fs.writeFileSync(path.join(repository, "src.js"), "export {};\n");
  stop("compatible", base, fixture);

  const next = { ...base, prompt_id: "p2" };
  const prompt = handleHook({ ...next, hook_event_name: "UserPromptSubmit", prompt: "unrelated" }, "compatible", fixture);
  assert.match(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext, /outstanding/i);
  assert.match(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext, /src\.js/);

  const heldAgain = stop("compatible", next, fixture);
  assert.equal(JSON.parse(heldAgain.stdout).decision, "block");

  const third = { ...base, prompt_id: "p3" };
  handleHook({ ...third, hook_event_name: "UserPromptSubmit", prompt: "it adds src.js because..." }, "compatible", fixture);
  pass(third, fixture);
  const afterPass = readGateState("claude", third, fixture).state;
  assert.equal(afterPass.outstanding, false);
  assert.equal(typeof afterPass.baseline.worktrees[repository].entries["src.js"], "string");
  assert.equal(stop("compatible", third, fixture).stdout, "");
  assert.equal(readGateState("claude", third, fixture).state.outstanding, false);
});

test("a prompt retakes the baseline only when nothing is outstanding", () => {
  const repository = createRepository();
  const { fixture, base } = session("compatible", repository);
  // The user edits between turns; that is theirs to explain to nobody.
  fs.writeFileSync(path.join(repository, "user.js"), "export {};\n");
  const next = { ...base, prompt_id: "p2" };
  handleHook({ ...next, hook_event_name: "UserPromptSubmit", prompt: "hi" }, "compatible", fixture);
  assert.equal(stop("compatible", next, fixture).stdout, "");
});

test("a commit with a clean tree is a change", () => {
  const repository = createRepository();
  const { fixture, base } = session("compatible", repository);
  fs.writeFileSync(path.join(repository, "README.md"), "# Changed\n");
  git(repository, ["commit", "-q", "-a", "-m", "agent commit"]);
  assert.equal(JSON.parse(stop("compatible", base, fixture).stdout).decision, "block");
});

test("a Stop payload without a turn id still holds", () => {
  const repository = createRepository();
  const { fixture, base } = session("compatible", repository);
  fs.writeFileSync(path.join(repository, "src.js"), "export {};\n");

  const withoutTurnId = { session_id: base.session_id, cwd: base.cwd, hook_event_name: "Stop" };
  const held = handleHook(withoutTurnId, "compatible", fixture);
  const output = JSON.parse(held.stdout);
  assert.equal(output.decision, "block");
  assert.equal(readGateState("claude", base, fixture).state.outstanding, true);
});

test("a session outside a repository never holds", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-plain-"));
  const { fixture, base } = session("compatible", plain);
  fs.writeFileSync(path.join(plain, "x.js"), "");
  assert.equal(stop("compatible", base, fixture).stdout, "");
});

test("a state without a baseline adopts the current snapshot instead of holding", () => {
  const repository = createRepository();
  const fixture = createFixture();
  const base = { session_id: "no-start", prompt_id: "p1", cwd: repository };
  fs.writeFileSync(path.join(repository, "src.js"), "export {};\n");
  // First event of the session is Stop: nothing to compare with.
  assert.equal(stop("compatible", base, fixture).stdout, "");
  assert.notEqual(readGateState("claude", base, fixture).state.baseline, null);
});

test("a corrupt git index does not fail closed at SessionStart, UserPromptSubmit, or Stop", () => {
  const repository = createRepository();
  // Corrupting the index makes `git status` throw while `rev-parse` still
  // succeeds, so `findRepository` finds the repository but `captureSnapshot`
  // fails inside `entriesOf`.
  fs.writeFileSync(path.join(repository, ".git", "index"), "garbage");
  const fixture = createFixture();
  const base = { session_id: "corrupt-session", prompt_id: "p1", cwd: repository };

  const start = handleHook({ ...base, hook_event_name: "SessionStart", source: "startup" }, "compatible", fixture);
  assert.equal(start.exitCode, 0);

  const prompt = handleHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "hi" }, "compatible", fixture);
  assert.equal(prompt.exitCode, 0);
  assert.equal(JSON.parse(prompt.stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");

  const stopResult = stop("compatible", base, fixture);
  assert.equal(stopResult.exitCode, 0);
  assert.equal(stopResult.stdout, "");
});

test("an unreadable state file allows the stop with a message", () => {
  const repository = createRepository();
  const { fixture, base } = session("compatible", repository);
  fs.writeFileSync(stateFilePath("claude", base, fixture), "{not json");
  fs.writeFileSync(path.join(repository, "src.js"), "export {};\n");

  const result = stop("compatible", base, fixture);
  assert.equal(result.exitCode, 0);
  assert.match(JSON.parse(result.stdout).systemMessage, /could not check/);
});

test("the hold reason lists at most ten paths", () => {
  const repository = createRepository();
  const { fixture, base } = session("compatible", repository);
  for (let index = 0; index < 12; index += 1) {
    fs.writeFileSync(path.join(repository, `file-${index}.js`), "export {};\n");
  }

  const held = stop("compatible", base, fixture);
  assert.match(JSON.parse(held.stdout).reason, /and 2 more/);
});

test("Cursor gets a follow-up message once and nothing on an aborted turn", () => {
  const repository = createRepository();
  const { fixture, base } = session("cursor", repository);
  fs.writeFileSync(path.join(repository, "src.js"), "export {};\n");

  const held = stop("cursor", base, fixture);
  assert.match(JSON.parse(held.stdout).followup_message, /src\.js/);

  const looped = stop("cursor", base, fixture, { loop_count: 1 });
  assert.deepEqual(JSON.parse(looped.stdout), {});

  const aborted = stop("cursor", base, fixture, { status: "aborted" });
  assert.deepEqual(JSON.parse(aborted.stdout), {});
  assert.equal(readGateState("cursor", base, fixture).state.outstanding, true);
});

test("a Cursor workspace root after the first is still watched", () => {
  const first = createRepository();
  const second = createRepository();
  const fixture = createFixture();
  const base = { conversation_id: "conv-roots", generation_id: "g1", workspace_roots: [first, second] };
  handleHook({ ...base, hook_event_name: "sessionStart" }, "cursor", fixture);

  const changed = path.join(second, "src.js");
  fs.writeFileSync(changed, "export {};\n");
  const held = stop("cursor", base, fixture);
  assert.ok(
    JSON.parse(held.stdout).followup_message?.includes(changed),
    `the second root's change must be reported: ${held.stdout}`
  );
});

test("Kiro warns on stderr with a non-blocking exit and stays quiet when clean", () => {
  const repository = createRepository();
  const { fixture, base } = session("kiro", repository);
  assert.equal(stop("kiro", base, fixture).exitCode, 0);

  fs.writeFileSync(path.join(repository, "src.js"), "export {};\n");
  const held = stop("kiro", base, fixture);
  assert.equal(held.exitCode, 1);
  assert.match(held.stderr, /src\.js/);

  const alias = handleHook({ ...base, hook_event_name: "agentStop" }, "kiro", fixture);
  assert.equal(alias.exitCode, 1);
});

// SessionStart re-baselines, which is right for a genuinely new session but
// wrong for one continuing over a still-outstanding change: it reset the record
// and took the current tree as the new baseline, so the change the gate was
// holding simply vanished. The source does not matter to the guard, which is
// what these cases pin; what does matter is the session id, and the case below
// pins the limit that follows from it.
for (const source of ["resume", "clear", "startup"]) {
  test(`an outstanding change survives a SessionStart ${source} that keeps the session id`, () => {
    const repository = createRepository();
    const { fixture, base } = session("compatible", repository);
    fs.writeFileSync(path.join(repository, "src.js"), "export {};\n");

    const held = stop("compatible", base, fixture);
    assert.equal(JSON.parse(held.stdout).decision, "block");
    const outstanding = readGateState("claude", base, fixture).state;
    assert.equal(outstanding.outstanding, true);

    handleHook({ ...base, hook_event_name: "SessionStart", source }, "compatible", fixture);

    const after = readGateState("claude", base, fixture).state;
    assert.equal(after.outstanding, true, "the record is kept");
    assert.deepEqual(after.changes, outstanding.changes, "the changed paths are kept");
    assert.deepEqual(after.baseline, outstanding.baseline, "the baseline is not retaken over the change");

    // A control still clears it, so the only way out stays the intended one.
    pass(base, fixture);
    assert.equal(readGateState("claude", base, fixture).state.status, "passed");
  });
}

test("SessionStart still re-baselines when nothing is outstanding", () => {
  const repository = createRepository();
  const { fixture, base } = session("compatible", repository);

  // An edit the user made outside any turn is theirs, and a new session must
  // not open by asking about it.
  fs.writeFileSync(path.join(repository, "theirs.js"), "export {};\n");
  handleHook({ ...base, hook_event_name: "SessionStart", source: "startup" }, "compatible", fixture);

  const result = stop("compatible", base, fixture);
  assert.equal(result.stdout, "", "the pre-existing edit is part of the new baseline");
});

// Keeping the record must not cost the rest of what SessionStart does. The
// reset is the lifecycle boundary that adopts the new turn, advances the
// request sequence, and discards controls armed before it; only the three
// fields carrying the change are inherited.
test("a SessionStart over an outstanding change is still a lifecycle boundary", () => {
  const repository = createRepository();
  const { fixture, base } = session("compatible", repository);
  fs.writeFileSync(path.join(repository, "src.js"), "export {};\n");
  stop("compatible", base, fixture);
  const before = readGateState("claude", base, fixture).state;
  assert.equal(before.outstanding, true);

  handleHook(
    { ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t-stale", tool_input: controlInput("pass") },
    "compatible",
    fixture
  );
  handleHook({ ...base, hook_event_name: "SessionStart", source: "resume" }, "compatible", fixture);

  const after = readGateState("claude", base, fixture).state;
  assert.equal(after.outstanding, true, "the record is kept");
  assert.deepEqual(after.changes, before.changes);
  assert.equal(after.requestSequence > before.requestSequence, true, "the reset still ran");

  handleHook(
    {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_use_id: "t-stale",
      tool_input: controlInput("pass"),
      tool_response: { stdout: "<!-- comprehension-gate:pass -->\n" }
    },
    "compatible",
    fixture
  );
  assert.equal(
    readGateState("claude", base, fixture).state.status,
    "pending",
    "a control armed before the boundary does not complete after it"
  );
});

// The limit of this fix, asserted rather than left to be discovered. State is
// keyed by a digest of provider and session id, so the record is reachable
// only while that id holds. A SessionStart that keeps the id -- what --resume
// does -- is covered. A host that mints a new id lands on a different state
// file, finds nothing, and baselines the current tree. Carrying the record
// across that boundary needs an identity more stable than the session id,
// which is a change to the state model rather than to this branch.
test("a SessionStart under a new session id does not carry the record", () => {
  const repository = createRepository();
  const { fixture, base } = session("compatible", repository);
  fs.writeFileSync(path.join(repository, "src.js"), "export {};\n");
  stop("compatible", base, fixture);
  assert.equal(readGateState("claude", base, fixture).state.outstanding, true);

  const renamed = { ...base, session_id: "stop-session-after-clear" };
  handleHook({ ...renamed, hook_event_name: "SessionStart", source: "clear" }, "compatible", fixture);

  assert.equal(readGateState("claude", renamed, fixture).state.outstanding, false);
  assert.equal(stop("compatible", renamed, fixture).stdout, "", "the change is baselined under the new id");
  assert.equal(
    readGateState("claude", base, fixture).state.outstanding,
    true,
    "the original record is orphaned, not cleared"
  );
});
