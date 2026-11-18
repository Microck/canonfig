import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { FollowerCommands } from "../../src/cli/follower-commands.ts";
import { SourceCommands } from "../../src/cli/source-commands.ts";
import { EnrollmentLive } from "../../src/enrollment/enrollment.layer.ts";
import { Enrollment } from "../../src/enrollment/enrollment.service.ts";
import { machineHealthDirectory, readMachineHealth, recordMachineHealth } from "../../src/enrollment/fleet-update.ts";
import { startSourceServer } from "../../src/enrollment/source-server.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { runtimeLayer } from "../../src/runtime/layers.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";

// Doctor runs in-process and reads process.env for harness roots, so the runner's own
// harness settings must not point it at real configs (and real MCP servers).
const HARNESS_ROOT_VARIABLES = [
  "CLAUDE_CONFIG_DIR", "CODEX_HOME", "COPILOT_HOME", "CURSOR_CONFIG_DIR", "GROK_HOME", "HERMES_HOME", "KILO_CONFIG_DIR",
  "KIMI_CODE_HOME", "OMP_PROFILE", "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "PI_PROFILE", "QWEN_HOME",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
];
afterEach(() => { vi.unstubAllEnvs(); });

const machineRuntime = (home: string, name: string) => {
  const directory = join(home, name);
  const state = join(directory, ".canonfig", "state.sqlite");
  const machine = linuxMachineStateLayer({
    environment: [{ name: "HOME", value: directory }, { name: "PATH", value: join(directory, "bin") }],
    credentialPolicy: { kind: "local-file", path: join(directory, "credentials") },
  });
  const base = runtimeLayer({ statePath: state }, machine);
  return { directory, state, runtime: ManagedRuntime.make(Layer.merge(base, EnrollmentLive.pipe(Layer.provide(base)))) };
};

/** Doctor fails on a fixture machine (no schedule, no harnesses), so read the report from either outcome. */
const doctorReport = (runtime: ReturnType<typeof machineRuntime>["runtime"]) =>
  runtime.runPromise(Effect.flatMap(FollowerCommands, (commands) => commands.doctor({ noInput: true, timeoutMilliseconds: 5_000 })).pipe(
    Effect.match({ onSuccess: (payload) => payload, onFailure: (failure) => "details" in failure ? failure.details : undefined }),
  ));

it.skipIf(process.platform === "win32")("collects each machine's doctor report on the Source and refuses unauthenticated reports", async () => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-machine-health-"));
  for (const name of HARNESS_ROOT_VARIABLES) vi.stubEnv(name, undefined);
  const source = machineRuntime(home, "source");
  const follower = machineRuntime(home, "follower");
  let close: (() => Promise<void>) | undefined;
  try {
    await source.runtime.runPromise(Effect.flatMap(SourceCommands, (commands) => commands.initialize()));
    writeFileSync(join(source.directory, ".canonfig", "canonfig.jsonc"), JSON.stringify({ version: 1, profile: { id: "health", name: "Health" }, harnesses: [] }));
    await source.runtime.runPromise(Effect.flatMap(SourceCommands, (commands) => commands.publish({ reviewer: "health-test" })));
    const control = await source.runtime.runPromise(Effect.gen(function*() {
      const enrollment = yield* Enrollment;
      const server = yield* startSourceServer({ hostname: "127.0.0.1" });
      const invitation = yield* enrollment.createInvitation({ endpoint: server.endpoint, expiresInMilliseconds: 60_000 });
      return { enrollment, server, invitation };
    }));
    close = control.server.close;
    await follower.runtime.runPromise(Effect.flatMap(FollowerCommands, (commands) => commands.enroll({ invitation: control.invitation, followerName: "laptop", replace: false })));
    const configuration = await follower.runtime.runPromise(Effect.flatMap(StateRepository, (repository) => repository.getFollowerSynchronizationConfiguration()));
    if (configuration === undefined) throw new Error("Follower enrollment missing");

    expect(await doctorReport(follower.runtime)).toMatchObject({ sourceReport: { status: "sent" } });
    expect(await doctorReport(source.runtime)).toMatchObject({ sourceReport: { status: "recorded" } });

    const { machines } = readMachineHealth(source.state);
    const laptop = machines[configuration.follower.id];
    if (laptop === undefined) throw new Error("The follower's report was not recorded");
    expect(laptop).toMatchObject({ name: "laptop", report: { probes: expect.arrayContaining([expect.objectContaining({ name: "mcp" })]) } });
    expect(machines.source?.report.probes.map((probe) => probe.name)).toContain("mcp");

    const refused = await source.runtime.runPromise(Effect.result(control.enrollment.reportMachineHealth("not-a-credential", laptop.report)));
    expect(refused._tag).toBe("Failure");
    // An authentication failure, not a storage error, so the follower gets 401/403.
    if (refused._tag === "Failure") expect(refused.failure._tag).not.toBe("EnrollmentConfigurationError");
    expect(Object.keys(readMachineHealth(source.state).machines).sort()).toEqual([configuration.follower.id, "source"].sort());

    // Each machine has its own file; a key with `:` (allowed in follower ids, not in Windows file names) round-trips.
    await Effect.runPromise(Effect.all(["fleet:a", "fleet:b", "fleet:c"].map((key) =>
      recordMachineHealth(source.state, key, key, laptop.report)), { concurrency: "unbounded" }));
    expect(Object.keys(readMachineHealth(source.state).machines)).toEqual(expect.arrayContaining(["fleet:a", "fleet:b", "fleet:c", "source"]));

    // A corrupt record hides only itself.
    writeFileSync(join(machineHealthDirectory(source.state), "corrupt.json"), "{not json");
    expect(Object.keys(readMachineHealth(source.state).machines)).toEqual(expect.arrayContaining(["fleet:a", "source"]));
  } finally {
    await close?.();
    await follower.runtime.dispose();
    await source.runtime.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});
