/// <reference lib="es2024.promise" />
import assert from "node:assert/strict";
import { it } from "node:test";
import { TransitionError } from "../../lib/state-machine";
import { settleIconRead, transitionIconSelection, type IconSelections, type IconSelectionEvent } from "./icon-selection";

function selectionOwner() {
  let state: IconSelections = {};
  const send = (event: IconSelectionEvent) => (state = transitionIconSelection(state, event));
  const start = (machineId: string, read: Promise<string>) => {
    const next = send({ type: "read", machineId, previous: { status: "preset", icon: "desktop" } });
    return settleIconRead({ machineId, generation: next[machineId].generation }, read, send);
  };
  return { send, start, selection: (machineId: string) => state[machineId] };
}

for (const type of ["preset", "reset"] as const) {
  it(`a deferred upload cannot override a newer ${type}`, async () => {
    const owner = selectionOwner();
    const read = Promise.withResolvers<string>();
    const upload = owner.start("machine-a", read.promise);
    owner.send({ type, machineId: "machine-a", icon: "laptop" });
    read.resolve("data:image/png;base64,older");
    assert.equal(await upload, null, "superseded reads must not authorize a preference write");
    assert.deepEqual(owner.selection("machine-a"), { status: "preset", icon: "laptop", generation: 2 });
  });
}

it("two uploads resolved out of order retain the newer image", async () => {
  const owner = selectionOwner();
  const older = Promise.withResolvers<string>();
  const newer = Promise.withResolvers<string>();
  const first = owner.start("machine-a", older.promise);
  const second = owner.start("machine-a", newer.promise);
  newer.resolve("data:image/png;base64,newer");
  assert.equal(await second, "data:image/png;base64,newer");
  older.resolve("data:image/png;base64,older");
  assert.equal(await first, null);
  assert.deepEqual(owner.selection("machine-a"), { status: "custom", dataUrl: "data:image/png;base64,newer", generation: 2 });
});

it("late upload failures cannot replace a newer selection with an error", async () => {
  const owner = selectionOwner();
  const read = Promise.withResolvers<string>();
  const upload = owner.start("machine-a", read.promise);
  owner.send({ type: "preset", machineId: "machine-a", icon: "server" });
  read.reject(new Error("Unreadable image"));
  assert.equal(await upload, null);
  assert.equal(owner.selection("machine-a").status, "preset");
});

it("upload ownership is bound to both the machine and generation", async () => {
  const owner = selectionOwner();
  const read = Promise.withResolvers<string>();
  const upload = owner.start("machine-a", read.promise);
  owner.send({ type: "preset", machineId: "machine-b", icon: "server" });
  assert.throws(() => owner.send({ type: "loaded", machineId: "machine-b", generation: 1, dataUrl: "wrong-machine" }), TransitionError);
  read.resolve("data:image/png;base64,machine-a");
  assert.equal(await upload, "data:image/png;base64,machine-a");
  assert.deepEqual(owner.selection("machine-b"), { status: "preset", icon: "server", generation: 1 });
});

it("a current upload failure retains its previous icon and can be retried", async () => {
  const owner = selectionOwner();
  const read = Promise.withResolvers<string>();
  const upload = owner.start("machine-a", read.promise);
  read.reject(new Error("Unreadable image"));
  assert.equal(await upload, null);
  assert.deepEqual(owner.selection("machine-a"), {
    status: "failed", previous: { status: "preset", icon: "desktop" }, error: "Unreadable image", generation: 1,
  });
  const retry = owner.start("machine-a", Promise.resolve("data:image/png;base64,retry"));
  assert.equal(await retry, "data:image/png;base64,retry");
  assert.equal(owner.selection("machine-a").status, "custom");
});
