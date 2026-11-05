/// <reference types="node" />
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { updateGate, type UpdateGateInput } from "./update-gate.ts";

const idle = (role: UpdateGateInput["role"]): UpdateGateInput => ({
  role,
  serviceInstalled: false,
  serviceBusy: false,
  setupApplying: false,
  publishing: false,
  syncRunning: false,
  syncInterrupted: false,
  skillBusy: false,
});

describe("updateGate", () => {
  it("leaves an idle machine unblocked", () => {
    assert.deepEqual(updateGate(idle("source")), { busyWith: null, unfinished: false });
    assert.deepEqual(updateGate(idle("follower")), { busyWith: null, unfinished: false });
  });

  it("waits for a running source service", () => {
    assert.equal(updateGate({ ...idle("source"), serviceInstalled: true }).busyWith, "service");
  });

  it("waits for a service being installed", () => {
    assert.equal(updateGate({ ...idle("source"), serviceBusy: true }).busyWith, "service");
  });

  it("waits for setup applying", () => {
    assert.equal(updateGate({ ...idle("source"), setupApplying: true }).busyWith, "setup");
  });

  it("waits for a publish", () => {
    assert.equal(updateGate({ ...idle("source"), publishing: true }).busyWith, "publish");
  });

  it("waits for a follower sync", () => {
    assert.equal(updateGate({ ...idle("follower"), syncRunning: true }).busyWith, "sync");
  });

  it("refuses while a follower sync is interrupted", () => {
    assert.deepEqual(updateGate({ ...idle("follower"), syncInterrupted: true }), { busyWith: null, unfinished: true });
  });

  it("waits for a skill check or update on either role", () => {
    assert.equal(updateGate({ ...idle("source"), skillBusy: true }).busyWith, "skill");
    assert.equal(updateGate({ ...idle("follower"), skillBusy: true }).busyWith, "skill");
  });
});
