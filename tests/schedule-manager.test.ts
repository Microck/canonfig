import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { describe, expect, it } from "vitest";

import type { ScheduleDefault } from "../src/domain/profile.ts";
import { macosMachineStateLayer } from "../src/machine/macos.layer.ts";
import type { SchedulerBackend } from "../src/machine/machine-state.types.ts";
import { windowsMachineStateLayer } from "../src/machine/windows.layer.ts";
import { scheduleManagerContract } from "./contract/schedule-manager.contract.ts";
import { syncScheduleFromDefault } from "../src/schedule/schedule-manager.types.ts";

const linuxEnvironment = [
  { name: "HOME", value: "/home/follower" },
  { name: "PATH", value: "/usr/bin" },
] as const;

const windowsEnvironment = [
  { name: "USERPROFILE", value: "C:\\Users\\Follower" },
  { name: "APPDATA", value: "C:\\Users\\Follower\\AppData\\Roaming" },
  { name: "LOCALAPPDATA", value: "C:\\Users\\Follower\\AppData\\Local" },
  { name: "SystemRoot", value: "C:\\Windows" },
] as const;

scheduleManagerContract("Linux", {
  platform: "linux",
  executable: "/opt/Canonfig Tools/canonfig",
  supportsNamedTimezone: true,
  layer: (scheduler: SchedulerBackend) =>
    linuxMachineStateLayer({
      credentialPolicy: { kind: "local-file", path: "/tmp/credentials" },
      environment: linuxEnvironment,
      schedulerBackend: scheduler,
    }),
});

scheduleManagerContract("macOS", {
  platform: "macos",
  executable: "/Applications/Canonfig Tools/canonfig",
  supportsNamedTimezone: false,
  layer: (scheduler: SchedulerBackend) =>
    macosMachineStateLayer({
      credentialPolicy: { kind: "local-file", path: "/tmp/credentials" },
      environment: linuxEnvironment,
      schedulerBackend: scheduler,
    }),
});

scheduleManagerContract("Windows", {
  platform: "windows",
  executable: "C:\\Program Files\\Canonfig\\canonfig.exe",
  supportsNamedTimezone: false,
  layer: (scheduler: SchedulerBackend) =>
    windowsMachineStateLayer({
      credentialPolicy: {
        kind: "local-file",
        path: "C:\\Users\\Follower\\.canonfig\\credentials",
      },
      environment: windowsEnvironment,
      schedulerBackend: scheduler,
    }),
});

describe("schedule normalization", () => {
  it("preserves, deduplicates, and orders every weekly day", () => {
    // The profile's inherited default is now the only place a schedule is
    // authored, so this covers its normalization rather than the deleted
    // schedule resource spec.
    // A profile default is always in the follower's own timezone, because a
    // named one cannot be rendered by launchd or Task Scheduler.
    const authored = {
      type: "weekly",
      days: ["fri", "mon", "fri", "wed"],
      at: "09:15",
      timezone: "local",
    } satisfies ScheduleDefault;

    expect(syncScheduleFromDefault(authored)).toEqual({
      kind: "weekly",
      weekdays: ["Mon", "Wed", "Fri"],
      localTime: "09:15",
    });
  });
});
