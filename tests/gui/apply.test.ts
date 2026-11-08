import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { expect, it } from "vitest";
import { runCli } from "../../src/cli/cli.ts";
import { FollowerCommands } from "../../src/cli/follower-commands.ts";
import { SourceCommands } from "../../src/cli/source-commands.ts";
import { GroupName } from "../../src/domain/brand.ts";
import { EnrollmentLive } from "../../src/enrollment/enrollment.layer.ts";
import { Enrollment } from "../../src/enrollment/enrollment.service.ts";
import { startSourceServer } from "../../src/enrollment/source-server.ts";
import { GuiOperation, GuiOperationTicket } from "../../src/gui/contract.ts";
import { runGui } from "../../src/gui/server.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import { runtimeLayer } from "../../src/runtime/layers.ts";
import { listSecrets, SECRET_SHARE_GROUP, storeSecret } from "../../src/secrets/secret-store.ts";
import { resolveSecretBindings } from "../../src/secrets/secret-bindings.ts";

function machineRuntime(home: string) {
  const folder = join(home, ".canonfig");
  const statePath = join(folder, "state.sqlite");
  const files = linuxMachineStateLayer({
    environment: [{ name: "HOME", value: home }, { name: "PATH", value: "/usr/bin:/bin" }],
    credentialPolicy: { kind: "local-file", path: join(home, "credentials") },
  });
  // A disposable credential backend exercises real storage and transfer. Native
  // provider selection and refusal of plaintext stores have separate coverage.
  const machine = Layer.effect(MachineState, Effect.map(MachineState, (service) => ({
    ...service,
    credentialCapability: () => Effect.succeed({
      kind: "secure-noninteractive" as const, provider: "secret-service" as const,
      verification: "provider-presence" as const,
    }),
  }))).pipe(Layer.provide(files));
  // Enrollment shares the runtime's own StateRepository. runtimeLayer creates the state folder before opening
  // the database, while Layer.merge builds siblings concurrently, so a second bare repository layer could open
  // state.sqlite before the folder exists ("unable to open database file"). A layer reference is built once per
  // runtime, so this also keeps one connection to the database.
  const runtime = runtimeLayer({ statePath, policyPath: join(folder, "policy.json") }, machine);
  return ManagedRuntime.make(Layer.merge(runtime, EnrollmentLive.pipe(Layer.provide(runtime))));
}

it("refreshes newly shared secrets before a GUI apply succeeds and preserves refresh failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "canonfig-gui-apply-"));
  const sourceHome = join(root, "source");
  const followerHome = join(root, "follower");
  await mkdir(sourceHome); await mkdir(followerHome);
  const source = machineRuntime(sourceHome);
  const follower = machineRuntime(followerHome);
  const controller = new AbortController();
  let gui: Promise<unknown> | undefined;
  let closeSource: (() => Promise<void>) | undefined;
  try {
    await source.runPromise(Effect.flatMap(SourceCommands, (commands) => commands.initialize()));
    await writeFile(join(sourceHome, ".canonfig", "canonfig.jsonc"), JSON.stringify({ version: 1, profile: { id: "secrets", name: "Secrets" }, harnesses: [] }));
    await source.runPromise(Effect.flatMap(SourceCommands, (commands) => commands.publish({ reviewer: "test" })));
    const server = await source.runPromise(startSourceServer({ hostname: "127.0.0.1" }));
    closeSource = server.close;
    const invitation = await source.runPromise(Effect.flatMap(Enrollment, (enrollment) => enrollment.createInvitation({
      endpoint: server.endpoint, expiresInMilliseconds: 60_000,
      groups: [Schema.decodeUnknownSync(GroupName)(SECRET_SHARE_GROUP)],
    })));
    await follower.runPromise(Effect.flatMap(FollowerCommands, (commands) => commands.enroll({ invitation, followerName: "GUI follower", replace: false })));
    expect(await follower.runPromise(listSecrets())).toEqual([]);
    await source.runPromise(storeSecret("after-enrollment", "synthetic-private-value"));
    await follower.runPromise(Effect.flatMap(FollowerCommands, (commands) => commands.synchronize({ mode: "plan", noInput: false })));
    expect(await follower.runPromise(listSecrets())).toEqual([]);
    const ready = Promise.withResolvers<string>();
    gui = follower.runPromise(runGui({ port: 0, open: false, host: "127.0.0.1", origin: undefined }, {
      writeStdout: (text) => ready.resolve(text.trim()), writeStderr: () => {}, setExitCode: () => {},
    }), { signal: controller.signal });
    void gui.catch(ready.reject);
    const url = await ready.promise;
    const origin = new URL(url).origin;
    const exchange = await fetch(url, { redirect: "manual" });
    const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("No GUI session cookie");
    const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "x-canonfig-request": "browser" };
    async function apply() {
      const response = await fetch(`${origin}/api/sync/apply`, { method: "POST", headers, body: "{}" });
      expect(response.status).toBe(202);
      const ticket = Schema.decodeUnknownSync(GuiOperationTicket)(await response.json());
      let operation: typeof GuiOperation.Type;
      const deadline = Date.now() + 30_000;
      do {
        const polled = await fetch(`${origin}/api/operations/${ticket.id}`, { headers });
        operation = Schema.decodeUnknownSync(GuiOperation)(await polled.json());
        if (Date.now() > deadline) throw new Error("Apply did not finish");
      } while (operation.state === "running");
      return operation;
    }
    const applied = await apply();
    expect(applied.state, JSON.stringify(applied)).toBe("succeeded");
    expect(await follower.runPromise(listSecrets())).toMatchObject([{ name: "after-enrollment", origin: "source" }]);
    expect(await follower.runPromise(resolveSecretBindings([{ name: "API_TOKEN", secret: "after-enrollment" }]))).toEqual([
      { name: "API_TOKEN", value: "synthetic-private-value" },
    ]);
    expect(JSON.stringify(applied)).not.toContain("synthetic-private-value");
    await source.runPromise(storeSecret("cli-after-gui", "another-synthetic-value"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await follower.runPromise(runCli(["sync", "--apply", "--json"], {
      writeStdout: (text) => stdout.push(text), writeStderr: (text) => stderr.push(text), setExitCode: () => {},
    }))).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ command: "sync.apply", status: "success", exitCode: 0 });
    expect((await follower.runPromise(listSecrets())).map(({ name }) => name)).toContain("cli-after-gui");
    // A locally owned name cannot be silently replaced by a later shared secret.
    await follower.runPromise(storeSecret("collision", "local-value"));
    await source.runPromise(storeSecret("collision", "source-value"));
    const failed = await apply();
    expect(failed.state).toBe("failed");
    expect(failed.failure).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
    expect(failed.failure?.message).toContain("File synchronization completed, but shared-secret synchronization failed:");
    expect(failed.journal).toMatchObject({ evidence: { outcome: "Converged" } });
  } finally {
    controller.abort();
    await gui?.catch(() => {});
    await closeSource?.();
    await follower.dispose(); await source.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
