import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  armGateControl,
  GateStateError,
  checkGate,
  completeGateControl,
  readGateState,
  resetGate,
  satisfyGate
} from "../core/state.mjs";

test("gate resets, passes, and resets again for a new turn", () => {
  const fixture = createFixture();
  const first = { session_id: "session-1", turn_id: "turn-1" };
  const second = { session_id: "session-1", turn_id: "turn-2" };

  assert.equal(resetGate("codex", first, fixture).status, "pending");
  assert.equal(checkGate("codex", first, fixture).satisfied, false);
  assert.equal(satisfyGate("codex", first, "pass", fixture).status, "passed");
  assert.equal(checkGate("codex", first, fixture).satisfied, true);

  const reset = resetGate("codex", second, fixture);
  assert.equal(reset.requestSequence, 2);
  assert.equal(checkGate("codex", second, fixture).satisfied, false);
  assert.equal(checkGate("codex", first, fixture).reason, "turn-mismatch");
});

test("LOW bypass records a satisfied low-level state", () => {
  const fixture = createFixture();
  const input = { session_id: "session-low" };

  resetGate("claude", input, fixture);
  const state = satisfyGate("claude", input, "bypass-low", fixture);

  assert.equal(state.status, "bypassed-low");
  assert.equal(state.level, "low");
  assert.equal(checkGate("claude", input, fixture).satisfied, true);
});

test("a control completion must match the armed action and tool use", () => {
  const fixture = createFixture();
  const armed = {
    session_id: "session-armed",
    turn_id: "turn-armed",
    tool_use_id: "tool-1"
  };

  resetGate("codex", armed, fixture);
  armGateControl("codex", armed, "pass", fixture);

  assert.throws(
    () => completeGateControl(
      "codex",
      { ...armed, tool_use_id: "tool-2" },
      "pass",
      fixture
    ),
    GateStateError
  );
  assert.equal(checkGate("codex", armed, fixture).satisfied, false);
  assert.equal(completeGateControl("codex", armed, "pass", fixture).status, "passed");
});

test("Cursor conversation and generation ids isolate native hook state", () => {
  const fixture = createFixture();
  const first = { conversation_id: "conversation-1", generation_id: "generation-1" };
  const second = { conversation_id: "conversation-1", generation_id: "generation-2" };

  resetGate("cursor", first, fixture);
  satisfyGate("cursor", first, "pass", fixture);
  assert.equal(checkGate("cursor", first, fixture).satisfied, true);
  assert.equal(checkGate("cursor", second, fixture).reason, "turn-mismatch");
});

test("missing state fails closed", () => {
  const fixture = createFixture();
  const input = { session_id: "missing" };

  assert.equal(readGateState("kiro", input, fixture).reason, "missing");
  assert.throws(
    () => satisfyGate("kiro", input, "pass", fixture),
    GateStateError
  );
});

test("session ids cannot escape the state directory", () => {
  const fixture = createFixture();
  const input = { session_id: "../../outside" };

  resetGate("cursor", input, fixture);
  const files = fs.readdirSync(fixture.env.COMPREHENSION_GATE_STATE_DIR);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.json$/);
});

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comprehension-gate-state-"));
  return { env: { COMPREHENSION_GATE_STATE_DIR: directory } };
}

test("concurrently armed controls do not clobber each other", () => {
  const fixture = createFixture();
  const turn = { session_id: "session-parallel", turn_id: "turn-1" };
  resetGate("codex", turn, fixture);

  armGateControl("codex", { ...turn, tool_use_id: "tool-1" }, "pass", fixture);
  armGateControl("codex", { ...turn, tool_use_id: "tool-2" }, "bypass-low", fixture);

  assert.equal(
    completeGateControl("codex", { ...turn, tool_use_id: "tool-1" }, "pass", fixture).status,
    "passed"
  );
});

test("an armed control from an earlier request cannot complete after a reset", () => {
  const fixture = createFixture();
  const turn = { session_id: "session-stale-arm", tool_use_id: "tool-1" };
  resetGate("claude", turn, fixture);
  armGateControl("claude", turn, "pass", fixture);
  resetGate("claude", turn, fixture);

  assert.throws(() => completeGateControl("claude", turn, "pass", fixture), GateStateError);
  assert.equal(checkGate("claude", turn, fixture).satisfied, false);
});
