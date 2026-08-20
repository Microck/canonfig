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
  installs = 0;
  removals = 0;

  readonly inspect = (
    expected: RenderedSchedulerJob,
  ): Effect.Effect<SchedulerInspection> =>
    Effect.sync(() => ({
      installed: this.definition !== undefined,
      enabled: this.enabled,
      matches: this.definition?.service === expected.service
        && this.definition.schedule === expected.schedule,
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
      this.installs += 1;
    });

  readonly remove = (): Effect.Effect<void> =>
    Effect.sync(() => {
      this.definition = undefined;
      this.enabled = false;
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

      expect(goldenValue(daily)).toBe(await fixture(adapter.platform, "daily"));
      expect(goldenValue(weekly)).toBe(await fixture(adapter.platform, "weekly"));
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
        expect(goldenValue(definition)).toBe(
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
        expect(goldenValue(definition)).toBe(
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

    it("uses the exact noninteractive sync argv with native quoting", async () => {
      const scheduler = new RecordingScheduler();
      const layer = managerLayer(adapter, scheduler);
      const definition = await runWith(layer, statusFor(adapter.executable));
      const rendered = `${definition.service}\n${definition.schedule}`;

      expect(rendered).toContain("sync");
      expect(rendered).toContain("--apply");
      expect(rendered).toContain("--no-input");
      expect(rendered).not.toContain("canonfig sync --apply --no-input");
      if (adapter.platform === "linux") {
        expect(definition.service).toContain(
          `"${adapter.executable}" "sync" "--apply" "--no-input"`,
        );
      } else if (adapter.platform === "macos") {
        expect(definition.service).toContain(
          "<string>sync</string><string>--apply</string><string>--no-input</string>",
        );
      } else {
        expect(definition.service).toContain("-Argument 'sync --apply --no-input'");
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
  });
};
