// Task-owned Raft only. The app remains loopback-only; the private Raft tunnel
// reaches a disposable TCP relay, not a changed application security boundary.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, createConnection, type Socket } from "node:net";
import { once } from "node:events";
import { Effect, Layer, ManagedRuntime } from "effect";
import { linuxMachineStateLayer } from "../../../src/machine/linux.layer.ts";
import { runtimeLayer } from "../../../src/runtime/layers.ts";
import { SourceCommands } from "../../../src/cli/source-commands.ts";
import { EnrollmentLive } from "../../../src/enrollment/enrollment.layer.ts";
import { Enrollment } from "../../../src/enrollment/enrollment.service.ts";
import { runGui } from "../../../src/gui/server.ts";

const home = mkdtempSync(join(tmpdir(), "canonfig-fleet-gui-"));
const machine = linuxMachineStateLayer({ environment: [{ name: "HOME", value: home }, { name: "PATH", value: "/usr/bin:/bin" }], credentialPolicy: { kind: "local-file", path: join(home, "credentials") } });
const base = runtimeLayer({ statePath: join(home, ".canonfig/state.sqlite") }, machine);
const runtime = ManagedRuntime.make(Layer.merge(base, EnrollmentLive.pipe(Layer.provide(base))));
const abort = new AbortController();
const sockets = new Set<Socket>();
const proxy = createServer((socket) => {
  const upstream = createConnection({ host: "127.0.0.1", port: 38116 });
  for (const connection of [socket, upstream]) { sockets.add(connection); connection.on("close", () => sockets.delete(connection)); }
  socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
  socket.pipe(upstream).pipe(socket);
});
let gui: Promise<number> | undefined;
try {
  await runtime.runPromise(Effect.flatMap(SourceCommands, (commands) => commands.initialize()));
  await runtime.runPromise(Effect.gen(function*() {
    const enrollment = yield* Enrollment;
    for (const name of ["canary-ui", "second-ui"]) {
      const invitation = yield* enrollment.createInvitation({ endpoint: "https://127.0.0.1:41371", expiresInMilliseconds: 60_000 });
      const follower = yield* enrollment.enrollFollower({ ...invitation, followerName: name });
      yield* enrollment.finalizeFollower(follower.credential);
    }
  }));
  proxy.listen(38117, "0.0.0.0");
  await once(proxy, "listening");
  const ready = Promise.withResolvers<string>();
  gui = runtime.runPromise(runGui({ port: 38116, open: false, host: "127.0.0.1", origin: "http://127.0.0.1:38117" }, {
    writeStdout: (text) => ready.resolve(text.trim()), writeStderr: (text) => process.stderr.write(text), setExitCode: () => {},
  }), { signal: abort.signal });
  void gui.catch(ready.reject);
  writeFileSync("/tmp/canonfig-fleet-gui-url", await ready.promise, { mode: 0o600 });
  writeFileSync("/tmp/canonfig-fleet-gui.pid", String(process.pid), { mode: 0o600 });
  console.log(`FLEET_GUI_READY pid=${process.pid} private-relay=38117`);
  const stopped = Promise.withResolvers<void>();
  process.once("SIGTERM", () => stopped.resolve()); process.once("SIGINT", () => stopped.resolve());
  await stopped.promise;
} finally {
  abort.abort();
  await gui?.catch(() => undefined);
  for (const socket of sockets) socket.destroy();
  proxy.close();
  await runtime.dispose();
  rmSync(home, { recursive: true, force: true });
  rmSync("/tmp/canonfig-fleet-gui-url", { force: true });
  rmSync("/tmp/canonfig-fleet-gui.pid", { force: true });
  console.log("Disposable GUI stopped; Source HOME and bootstrap URL removed.");
}
