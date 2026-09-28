import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { MachineState } from "../../src/machine/machine-state.service.ts";
import type {
  RenderedSchedulerJob,
  SchedulerBackend,
  SchedulerInspection,
  SchedulerSnapshot,
} from "../../src/machine/machine-state.types.ts";
import {
  InvalidScheduleError,
  ScheduleHumanActionRequiredError,
} from "../../src/schedule/schedule-manager.errors.ts";
import { scheduleManagerLayer } from "../../src/schedule/schedule-manager.layer.ts";
import { ScheduleManager } from "../../src/schedule/schedule-manager.service.ts";
import type { SyncSchedule } from "../../src/schedule/schedule-manager.types.ts";

export interface ScheduleManagerContractAdapter {
  readonly platform: "linux" | "macos" | "windows";
  readonly executable: string;
  readonly layer: (scheduler: SchedulerBackend) => Layer.Layer<MachineState>;
  readonly supportsNamedTimezone: boolean;
}

class RecordingScheduler implements SchedulerBackend {
  definition: RenderedSchedulerJob | undefined;
  enabled = false;
  active = false;
  overrides: ReadonlyArray<string> = [];
  installs = 0;
  removals = 0;
  timezoneChangedSinceBoot = false;

  readonly inspect = (
    expected: RenderedSchedulerJob,
  ): Effect.Effect<SchedulerInspection> =>
    Effect.sync(() => ({
      installed: this.definition !== undefined,
      enabled: this.enabled,
      active: this.active,
      overrides: this.overrides,
      timezoneChangedSinceBoot: this.timezoneChangedSinceBoot,
      matches: this.definition?.service === expected.service
        && this.definition.schedule === expected.schedule,
      calendarMatches: this.definition?.schedule === expected.schedule,
    }));

  readonly snapshot = (
    expected: RenderedSchedulerJob,
  ): Effect.Effect<SchedulerSnapshot> =>
    Effect.sync(() => this.definition === undefined
      ? {
        state: "absent" as const,
        platform: expected.platform,
        mechanism: expected.mechanism,
        serviceName: expected.serviceName,
      }
      : {
        state: "present" as const,
        platform: expected.platform,
        mechanism: expected.mechanism,
        serviceName: expected.serviceName,
        enabled: this.enabled,
        servicePresent: true,
        schedulePresent: true,
        service: this.definition.service,
        schedule: this.definition.schedule,
      });

  readonly install = (
    definition: RenderedSchedulerJob,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      this.definition = definition;
      this.enabled = true;
      this.active = true;
      this.installs += 1;
    });

  readonly remove = (): Effect.Effect<void> =>
    Effect.sync(() => {
      this.definition = undefined;
      this.enabled = false;
      this.active = false;
      this.removals += 1;
    });

  readonly restore = (
    expected: RenderedSchedulerJob,
    snapshot: SchedulerSnapshot,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      if (snapshot.state === "absent") {
        this.definition = undefined;
        this.enabled = false;
        return;
      }
      this.definition = {
        ...expected,
        service: snapshot.service ?? "",
        schedule: snapshot.schedule ?? "",
      };
      this.enabled = snapshot.enabled;
      this.active = snapshot.enabled;
    });

  drift(): void {
    if (this.definition === undefined) return;
    this.definition = {
      ...this.definition,
      schedule: `${this.definition.schedule}\n# external drift`,
    };
  }
}

const managerLayer = (
  adapter: ScheduleManagerContractAdapter,
  scheduler: SchedulerBackend,
): Layer.Layer<ScheduleManager> =>
  scheduleManagerLayer.pipe(Layer.provide(adapter.layer(scheduler)));

const runWith = <Value, Error>(
  layer: Layer.Layer<ScheduleManager>,
  effect: Effect.Effect<Value, Error, ScheduleManager>,
): Promise<Value> => Effect.runPromise(effect.pipe(Effect.provide(layer)));

const statusFor = (
  executable: string,
  schedule?: SyncSchedule,
): Effect.Effect<
  RenderedSchedulerJob,
  unknown,
  ScheduleManager
> =>
  Effect.gen(function*() {
    const manager = yield* ScheduleManager;
    const status = yield* manager.status({ executable, schedule });
    return status.definition;
  });

const fixture = (
  platform: ScheduleManagerContractAdapter["platform"],
  name: string,
): Promise<string> =>
  readFile(
    join(process.cwd(), "tests", "fixtures", "schedule", `${platform}-${name}.json`),
    "utf8",
  );

const goldenValue = (definition: RenderedSchedulerJob): string =>
  `${JSON.stringify(definition, undefined, 2)}\n`;

// Golden fixtures must not pin the test executable path (an input, not
// product behavior): install-path tests use real probe-passing scripts.
const goldenDefinition = (
  definition: RenderedSchedulerJob,
  adapter: ScheduleManagerContractAdapter,
): string =>
  goldenValue(definition).replaceAll(adapter.executable, "<test-executable>");

export const scheduleManagerContract = (
  name: string,
  adapter: ScheduleManagerContractAdapter,
): void => {
  describe(`${name} ScheduleManager contract`, () => {
    it("renders stable daily and weekly native definitions", async () => {
      const scheduler = new RecordingScheduler();
      const layer = managerLayer(adapter, scheduler);
      const daily = await runWith(layer, statusFor(adapter.executable));
      const weekly = await runWith(
        layer,
        statusFor(adapter.executable, {
          kind: "weekly",
          weekdays: ["Fri", "Mon", "Fri"],
          localTime: "23:45",
        }),
      );

      expect(goldenDefinition(daily, adapter)).toBe(await fixture(adapter.platform, "daily"));
      expect(goldenDefinition(weekly, adapter)).toBe(await fixture(adapter.platform, "weekly"));
    });

    it("refuses a custom executable that fails under the native unit PATH", async () => {
      // Microck/canonfig#132: an npm wrapper that works interactively can
      // crash under the unit PATH (systemd: PATH=/usr/bin:/bin). The probe
      // runs `<executable> --version` there; /bin/false deterministically
      // exits 1, so install must refuse before writing any unit. Windows
      // is skipped: the probe is posix-only by design (absolute PE launch
      // performs no PATH interpreter lookup).
      if (adapter.platform === "windows") return;
      const scheduler = new RecordingScheduler();
      const layer = managerLayer(adapter, scheduler);
      const error = await runWith(layer, Effect.gen(function*() {
        const manager = yield* ScheduleManager;
        return yield* Effect.flip(manager.install({ executable: "/bin/false" }));
      }));

      expect(error).toBeInstanceOf(ScheduleHumanActionRequiredError);
      expect(scheduler.installs).toBe(0);
    });

    it("preserves named timezone intent or returns Human Action Required", async () => {
      const scheduler = new RecordingScheduler();
      const layer = managerLayer(adapter, scheduler);
      const schedule: SyncSchedule = {
        kind: "daily",
        localTime: "01:30",
        timezone: "America/New_York",
      };
      if (adapter.supportsNamedTimezone) {
        const definition = await runWith(layer, statusFor(adapter.executable, schedule));
        expect(goldenDefinition(definition, adapter)).toBe(
          await fixture(adapter.platform, "timezone"),
        );
        expect(definition.schedule).toContain("America/New_York");
      } else {
        const error = await runWith(
          layer,
          Effect.gen(function*() {
            const manager = yield* ScheduleManager;
            return yield* Effect.flip(manager.status({
              executable: adapter.executable,
              schedule,
            }));
          }),
        );
        expect(error).toBeInstanceOf(ScheduleHumanActionRequiredError);
        expect(`${JSON.stringify(error, undefined, 2)}\n`).toBe(
          await fixture(adapter.platform, "timezone"),
        );
      }

      const custom = {
        kind: "custom",
        expression: "*-*-* 02:15:00",
        timezone: "Europe/Paris",
      } as const;
      if (adapter.supportsNamedTimezone) {
        const definition = await runWith(layer, statusFor(adapter.executable, custom));
        expect(goldenDefinition(definition, adapter)).toBe(
          await fixture(adapter.platform, "custom-timezone"),
        );
        expect(definition.schedule).toContain("Europe/Paris");
      } else {
        const error = await runWith(
          layer,
          Effect.gen(function*() {
            const manager = yield* ScheduleManager;
            return yield* Effect.flip(manager.status({
              executable: adapter.executable,
              schedule: custom,
            }));
          }),
        );
        expect(error).toBeInstanceOf(ScheduleHumanActionRequiredError);
      }
    });

    it.skipIf(adapter.platform !== "macos")("refuses to promise a macOS fire after a live timezone change until reboot", async () => {
      const scheduler = new RecordingScheduler();
      const layer = managerLayer(adapter, scheduler);
      const input = {
        executable: adapter.executable,
        schedule: { kind: "daily", localTime: "06:05" } as const,
      };
      await runWith(layer, Effect.flatMap(ScheduleManager, (manager) => manager.install(input)));
      scheduler.timezoneChangedSinceBoot = true;

      const status = await runWith(layer, Effect.flatMap(ScheduleManager, (manager) => manager.status(input)));
      expect(status.state).toBe("timezone-changed");
      expect(status.nextRun).toBeUndefined();
      expect(status.detail).toContain("Reboot the Mac");
      const error = await runWith(layer, Effect.flatMap(ScheduleManager, (manager) =>
        Effect.flip(manager.install(input))
      ));
      expect(error).toBeInstanceOf(ScheduleHumanActionRequiredError);
      expect(scheduler.installs).toBe(1);

      scheduler.timezoneChangedSinceBoot = false;
      expect((await runWith(layer, Effect.flatMap(ScheduleManager, (manager) => manager.status(input))))
        .state).toBe("current");
    });

    it("uses the exact noninteractive sync argv with native quoting", async () => {
      const scheduler = new RecordingScheduler();
      const layer = managerLayer(adapter, scheduler);
      const definition = await runWith(layer, statusFor(adapter.executable));
      const rendered = `${definition.service}\n${definition.schedule}`;

      expect(rendered).toContain("sync");
      expect(rendered).toContain("--apply");
      expect(rendered).toContain("--no-input");
      expect(rendered).toContain("--scheduled");
      expect(rendered).not.toContain("canonfig sync --apply --no-input");
      if (adapter.platform === "linux") {
        expect(definition.service).toContain(
          `"${adapter.executable}" "sync" "--apply" "--no-input" "--scheduled"`,
        );
      } else if (adapter.platform === "macos") {
        expect(definition.service).toContain(
          "<string>sync</string><string>--apply</string><string>--no-input</string><string>--scheduled</string>",
        );
      } else {
        expect(definition.service).toContain("-Argument 'sync --apply --no-input --scheduled'");
      }
    });

    it("pins a minimal environment with no shell in the native job", async () => {
      const scheduler = new RecordingScheduler();
      const layer = managerLayer(adapter, scheduler);
      const definition = await runWith(layer, statusFor(adapter.executable));
      const rendered = `${definition.service}\n${definition.schedule}`;
      expect(rendered).not.toContain("sh -c");
      expect(rendered).not.toContain("cmd /c");
      expect(rendered).not.toContain("bash -c");
      if (adapter.platform === "linux") {
        expect(definition.service).toContain('Environment="PATH=');
      } else if (adapter.platform === "macos") {
        expect(definition.service).toContain("<key>EnvironmentVariables</key>");
        expect(definition.service).toContain("<key>PATH</key>");
      }
    });

    it("renders executable metacharacters as data instead of shell syntax", async () => {
      const scheduler = new RecordingScheduler();
      const layer = managerLayer(adapter, scheduler);
      const executable = adapter.platform === "windows"
        ? "C:\\Program Files\\canonfig'; Remove-Item C:\\; '.exe"
        : adapter.platform === "macos"
        ? "/Applications/canonfig<&\"';touch"
        : "/opt/canonfig\";touch /tmp/not-created;#";
      const definition = await runWith(layer, statusFor(executable));

      if (adapter.platform === "linux") {
        expect(definition.service).toContain(
          "ExecStart=\"/opt/canonfig\\\";touch /tmp/not-created;#\"",
        );
      } else if (adapter.platform === "macos") {
        expect(definition.service).toContain(
          "<string>/Applications/canonfig&lt;&amp;&quot;&apos;;touch</string>",
        );
      } else {
        expect(definition.service).toContain(
          "-Execute 'C:\\Program Files\\canonfig''; Remove-Item C:\\; ''.exe'",
        );
      }
    });

    it("installs idempotently, detects drift, updates, reports status, and removes", async () => {
      const scheduler = new RecordingScheduler();
      const layer = managerLayer(adapter, scheduler);
      const input = { executable: adapter.executable } as const;

      const first = await runWith(
        layer,
        Effect.gen(function*() {
          const manager = yield* ScheduleManager;
          return yield* manager.install(input);
        }),
      );
      const second = await runWith(
        layer,
        Effect.gen(function*() {
          const manager = yield* ScheduleManager;
          return yield* manager.install(input);
        }),
      );
      expect(first.change).toBe("installed");
      expect(second.change).toBe("unchanged");
      expect(scheduler.installs).toBe(1);

      scheduler.drift();
      const drifted = await runWith(
        layer,
        Effect.gen(function*() {
          const manager = yield* ScheduleManager;
          return yield* manager.inspect(input);
        }),
      );
      expect(drifted.state).toBe("drifted");

      const updated = await runWith(
        layer,
        Effect.gen(function*() {
          const manager = yield* ScheduleManager;
          return yield* manager.update(input);
        }),
      );
      expect(updated.change).toBe("updated");
      expect(updated.status.state).toBe("current");
      expect(scheduler.installs).toBe(2);

      scheduler.enabled = false;
      const disabled = await runWith(
        layer,
        Effect.gen(function*() {
          const manager = yield* ScheduleManager;
          return yield* manager.status(input);
        }),
      );
      expect(disabled.state).toBe("disabled");

      const removed = await runWith(
        layer,
        Effect.gen(function*() {
          const manager = yield* ScheduleManager;
          return yield* manager.remove(input);
        }),
      );
      const removedAgain = await runWith(
        layer,
        Effect.gen(function*() {
          const manager = yield* ScheduleManager;
          return yield* manager.remove(input);
        }),
      );
      expect(removed.change).toBe("removed");
      expect(removedAgain.change).toBe("unchanged");
      expect(scheduler.removals).toBe(1);
    });

    it("captures and restores present and absent native state exactly", async () => {
      const scheduler = new RecordingScheduler();
      const layer = managerLayer(adapter, scheduler);
      const input = {
        executable: adapter.executable,
        schedule: { kind: "daily", localTime: "01:15" } as const,
      };
      const prior = await runWith(
        layer,
        Effect.gen(function*() {
          const manager = yield* ScheduleManager;
          yield* manager.install(input);
          return yield* manager.snapshot(input);
        }),
      );
      expect(prior.state).toBe("present");

      await runWith(
        layer,
        Effect.gen(function*() {
          const manager = yield* ScheduleManager;
          yield* manager.update({
            ...input,
            schedule: { kind: "daily", localTime: "02:30" },
          });
          yield* manager.restore(input, prior);
        }),
      );
      const restored = await runWith(
        layer,
        Effect.gen(function*() {
          const manager = yield* ScheduleManager;
          return yield* manager.snapshot(input);
        }),
      );
      expect(restored).toEqual(prior);

      const absent = await runWith(
        layer,
        Effect.gen(function*() {
          const manager = yield* ScheduleManager;
          yield* manager.remove(input);
          return yield* manager.snapshot(input);
        }),
      );
      expect(absent.state).toBe("absent");
      await runWith(
        layer,
        Effect.gen(function*() {
          const manager = yield* ScheduleManager;
          yield* manager.restore(input, absent);
        }),
      );
      await expect(
        runWith(
          layer,
          Effect.gen(function*() {
            const manager = yield* ScheduleManager;
            return yield* manager.snapshot(input);
          }),
        ),
      ).resolves.toEqual(absent);
    });

    it("rejects malformed times and timezone names", async () => {
      const scheduler = new RecordingScheduler();
      const layer = managerLayer(adapter, scheduler);
      const invalidTime = await runWith(
        layer,
        Effect.gen(function*() {
          const manager = yield* ScheduleManager;
          return yield* Effect.flip(manager.status({
            executable: adapter.executable,
            schedule: { kind: "daily", localTime: "24:00" },
          }));
        }),
      );
      const invalidTimezone = await runWith(
        layer,
        Effect.gen(function*() {
          const manager = yield* ScheduleManager;
          return yield* Effect.flip(manager.status({
            executable: adapter.executable,
            schedule: {
              kind: "daily",
              localTime: "00:00",
              timezone: "local-ish",
            },
          }));
        }),
      );

      expect(invalidTime).toBeInstanceOf(InvalidScheduleError);
      expect(invalidTimezone).toBeInstanceOf(InvalidScheduleError);
      expect(scheduler.installs).toBe(0);
    });

    it("reports a stopped job inactive and restarts it only on an explicit set", async () => {
      // CF-44: a timer stopped outside Canonfig used to read `current`, and
      // `schedule set` with the same calendar answered `unchanged`.
      const scheduler = new RecordingScheduler();
      const layer = managerLayer(adapter, scheduler);
      const input = { executable: adapter.executable } as const;
      await runWith(layer, Effect.flatMap(ScheduleManager, (manager) => manager.install(input)));
      scheduler.active = false;

      const stopped = await runWith(
        layer,
        Effect.flatMap(ScheduleManager, (manager) => manager.status(input)),
      );
      expect(stopped.state).toBe("inactive");
      expect(stopped.detail).toContain("automation disabled outside Canonfig");

      const set = await runWith(
        layer,
        Effect.flatMap(ScheduleManager, (manager) => manager.install(input)),
      );
      expect(set.change).toBe("updated");
      expect(set.status.state).toBe("current");
      expect(scheduler.active).toBe(true);
    });

    it("never recreates or re-enables a job removed, disabled, or stopped outside Canonfig", async () => {
      // CF-46: the post-apply reconciler used to undo these silently.
      const scheduler = new RecordingScheduler();
      const layer = managerLayer(adapter, scheduler);
      const input = { executable: adapter.executable } as const;
      const reconcile = () =>
        runWith(layer, Effect.flatMap(ScheduleManager, (manager) => manager.reconcile(input)));
      await runWith(layer, Effect.flatMap(ScheduleManager, (manager) => manager.install(input)));

      scheduler.active = false;
      expect(await reconcile()).toMatchObject({ action: "left-as-is", status: { state: "inactive" } });
      scheduler.active = true;
      scheduler.enabled = false;
      expect(await reconcile()).toMatchObject({ action: "left-as-is", status: { state: "disabled" } });
      scheduler.definition = undefined;
      expect(await reconcile()).toMatchObject({
        action: "left-as-is",
        status: { state: "not-installed" },
      });
      expect(scheduler.installs).toBe(1);
      expect(scheduler.enabled).toBe(false);
    });

    it("re-renders an armed job whose binding drifted", async () => {
      const scheduler = new RecordingScheduler();
      const layer = managerLayer(adapter, scheduler);
      const input = { executable: adapter.executable } as const;
      await runWith(layer, Effect.flatMap(ScheduleManager, (manager) => manager.install(input)));
      scheduler.definition = { ...scheduler.definition!, service: `${scheduler.definition!.service}#old` };

      const drifted = await runWith(
        layer,
        Effect.flatMap(ScheduleManager, (manager) => manager.status(input)),
      );
      expect(drifted).toMatchObject({ state: "drifted", drift: "binding" });
      const reconciled = await runWith(
        layer,
        Effect.flatMap(ScheduleManager, (manager) => manager.reconcile(input)),
      );
      expect(reconciled).toMatchObject({ action: "updated", status: { state: "current" } });
      expect(scheduler.installs).toBe(2);
    });

    it("refuses to claim an install that a native override would defeat", async () => {
      const scheduler = new RecordingScheduler();
      const layer = managerLayer(adapter, scheduler);
      const input = { executable: adapter.executable } as const;
      await runWith(layer, Effect.flatMap(ScheduleManager, (manager) => manager.install(input)));
      scheduler.overrides = ["/home/follower/.config/systemd/user/canonfig-sync.timer.d/override.conf"];

      const status = await runWith(
        layer,
        Effect.flatMap(ScheduleManager, (manager) => manager.status(input)),
      );
      expect(status.state).toBe("overridden");
      expect(status.detail).toContain("override.conf");
      const error = await runWith(
        layer,
        Effect.flatMap(ScheduleManager, (manager) => Effect.flip(manager.install(input))),
      );
      expect(error).toBeInstanceOf(ScheduleHumanActionRequiredError);
    });
  });
};
