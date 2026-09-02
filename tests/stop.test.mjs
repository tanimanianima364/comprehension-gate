import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleHook } from "../core/gate.mjs";
import { readGateState } from "../core/state.mjs";
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

test("an unexplained change holds the turn once, then lets the question through", () => {
  const repository = createRepository();
  const { fixture, base } = session("compatible", repository);
  fs.writeFileSync(path.join(repository, "src.js"), "export {};\n");

  const held = stop("compatible", base, fixture);
  const output = JSON.parse(held.stdout);
  assert.equal(output.decision, "block");
  assert.match(output.reason, /src\.js/);
  assert.match(output.reason, /control\/pass/);
  assert.match(output.systemMessage, /unexplained/i);
  assert.equal(readGateState("claude", base, fixture).state.outstanding, true);

  const second = stop("compatible", base, fixture, { stop_hook_active: true });
  const secondOutput = JSON.parse(second.stdout);
  assert.equal(secondOutput.decision, undefined);
  assert.match(secondOutput.systemMessage, /unexplained/i);
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

test("an outstanding change survives a new prompt until it is explained", () => {
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
