import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ScheduleDefault } from "../src/domain/profile.ts";
import { macosMachineStateLayer } from "../src/machine/macos.layer.ts";
import type { SchedulerBackend } from "../src/machine/machine-state.types.ts";
import { windowsMachineStateLayer } from "../src/machine/windows.layer.ts";
import { scheduleManagerContract } from "./contract/schedule-manager.contract.ts";
import { ScheduleHumanActionRequiredError } from "../src/schedule/schedule-manager.errors.ts";
import { scheduleManagerLayer } from "../src/schedule/schedule-manager.layer.ts";
import { ScheduleManager } from "../src/schedule/schedule-manager.service.ts";
import {
  desiredScheduleInput,
  syncScheduleFromDefault,
} from "../src/schedule/schedule-manager.types.ts";
import { daylightSavingGapWarning, nextScheduledRun } from "../src/schedule/schedule-calendar.ts";
import { stableRuntimeExecutable } from "../src/schedule/schedule-command.ts";

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

// Install-path contract tests exercise the set-time executable probe, which
// runs `<executable> --version` under the native unit PATH. These fixtures
// are real scripts (with quoting-sensitive spaces in their paths) that exit
// 0 for any arguments; a wrapper needing a newer interpreter than the unit
// PATH provides must fail that probe instead (Microck/canonfig#132).
const linuxFixture = "/tmp/Canonfig Test Tools/canonfig-linux";
const macosFixture = "/tmp/Canonfig Test Tools/canonfig-macos";
beforeAll(async () => {
  await mkdir("/tmp/Canonfig Test Tools", { recursive: true });
  for (const path of [linuxFixture, macosFixture]) {
    await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(path, 0o755);
  }
});

scheduleManagerContract("Linux", {
  platform: "linux",
  executable: linuxFixture,
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
  executable: macosFixture,
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

describe("schedule selection", () => {
  const profileDefault = { type: "daily", at: "04:30", timezone: "local" } satisfies ScheduleDefault;

  it("never installs a profile default without the follower's consent", () => {
    // CF-47: a profile scheduleDefault used to install a timer on the first
    // apply of a follower that never ran `schedule set`.
    expect(desiredScheduleInput(undefined, profileDefault)).toBeUndefined();
    expect(desiredScheduleInput({ kind: "disabled" }, profileDefault)).toBeUndefined();
    expect(desiredScheduleInput({ kind: "inherit" }, profileDefault)).toEqual({
      schedule: { kind: "daily", localTime: "04:30" },
    });
  });
});

describe("schedule calendar semantics", () => {
  const now = Date.parse("2026-09-01T12:00:00Z");

  it("names the days a local time does not exist and what systemd does then", () => {
    // CF-52: nonexistent spring-forward times were skipped without warning.
    const warning = daylightSavingGapWarning(
      { kind: "daily", localTime: "00:00", timezone: "America/Santiago" },
      "linux",
      now,
    );
    expect(warning).toContain("2026-09-06");
    expect(warning).toContain("systemd skips the run");
    expect(daylightSavingGapWarning(
      { kind: "daily", localTime: "02:30", timezone: "Europe/Berlin" },
      "linux",
      now,
    )).toContain("2027-03-28");
    // Only selected weekdays count: 2027-03-28 is a Sunday.
    expect(daylightSavingGapWarning(
      { kind: "weekly", weekdays: ["Mon"], localTime: "02:30", timezone: "Europe/Berlin" },
      "linux",
      now,
    )).toBeUndefined();
  });

  it("computes the next run in the schedule's zone without a same-day catch-up", () => {
    // CF-50: a time already passed today runs next tomorrow.
    expect(nextScheduledRun({ kind: "daily", localTime: "11:30", timezone: "UTC" }, now))
      .toBe("2026-09-02T11:30:00.000Z");
    expect(nextScheduledRun({ kind: "daily", localTime: "01:30", timezone: "America/New_York" }, now))
      .toBe("2026-09-02T05:30:00.000Z");
  });
});

describe("stable scheduled runtime", () => {
  it("names Homebrew's opt symlink instead of the versioned Cellar binary", async () => {
    // CF-53: `brew upgrade` deletes the Cellar version the job pinned.
    const root = await mkdtemp(join(tmpdir(), "canonfig-brew-"));
    try {
      const cellar = join(root, "Cellar", "node@24", "24.16.0", "bin");
      await mkdir(cellar, { recursive: true });
      await writeFile(join(cellar, "node"), "");
      await mkdir(join(root, "opt"), { recursive: true });
      await symlink(join(root, "Cellar", "node@24", "24.16.0"), join(root, "opt", "node@24"));
      expect(stableRuntimeExecutable(join(cellar, "node"))).toBe(join(root, "opt", "node@24", "bin", "node"));
      // A stale opt link (pointing elsewhere) is never trusted.
      await unlink(join(root, "opt", "node@24"));
      expect(stableRuntimeExecutable(join(cellar, "node"))).toBe(join(cellar, "node"));
      expect(stableRuntimeExecutable("/usr/bin/node")).toBe("/usr/bin/node");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("systemd user timer effective state", () => {
  const roots: Array<string> = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  /**
   * A user manager simulated by marker files: `systemctl show` reports what a
   * real manager would after `stop`, `enable`, and drop-in changes.
   */
  const simulatedHost = async (linger: "yes" | "no" = "yes") => {
    const root = await mkdtemp(join(tmpdir(), "canonfig-systemd-"));
    roots.push(root);
    const home = join(root, "home");
    const state = join(root, "manager");
    await mkdir(state, { recursive: true });
    const systemctl = join(root, "systemctl");
    await writeFile(systemctl, `#!/bin/sh
state='${state}'
echo "$*" >> "$state/calls"
case "$2" in
  show)
    active=inactive; test -f "$state/active" && active=active
    unit=disabled; test -f "$state/enabled" && unit=enabled
    printf 'Id=canonfig-sync.timer\\nLoadState=loaded\\nActiveState=%s\\nUnitFileState=%s\\nDropInPaths=%s\\nTimersCalendar={ OnCalendar=%s ; next_elapse=n/a }\\n\\nId=canonfig-sync.service\\nLoadState=loaded\\nActiveState=inactive\\nResult=success\\nExecMainStatus=0\\nExecMainExitTimestamp=\\n' \\
      "$active" "$unit" "$(cat "$state/dropins" 2>/dev/null)" "$(cat "$state/calendar" 2>/dev/null || echo '*-*-* 04:00:00')"
    ;;
  enable) touch "$state/enabled"; test "$3" = "--now" && touch "$state/active" ;;
  start) touch "$state/active" ;;
  stop) rm -f "$state/active" ;;
  disable) rm -f "$state/enabled" "$state/active" ;;
esac
exit 0
`);
    const loginctl = join(root, "loginctl");
    await writeFile(loginctl, `#!/bin/sh\nprintf 'Linger=${linger}\\n'\n`);
    await chmod(systemctl, 0o755);
    await chmod(loginctl, 0o755);
    const machine = linuxMachineStateLayer({
      credentialPolicy: { kind: "local-file", path: join(root, "credentials") },
      environment: [
        { name: "HOME", value: home },
        { name: "PATH", value: "/usr/bin:/bin" },
        { name: "CANONFIG_SYSTEMCTL", value: systemctl },
        { name: "CANONFIG_LOGINCTL", value: loginctl },
      ],
    });
    const layer = scheduleManagerLayer.pipe(Layer.provide(machine));
    const run = <Value, Error>(
      effect: (manager: ScheduleManager["Service"]) => Effect.Effect<Value, Error>,
    ) => Effect.runPromise(Effect.flatMap(ScheduleManager, effect).pipe(Effect.provide(layer)));
    return { home, state, run };
  };
  const input = { schedule: { kind: "daily", localTime: "04:00" } } as const;

  it("reports a timer stopped outside Canonfig as inactive and restarts it on set", async () => {
    // CF-44: inspection queried only `is-enabled`, so a stopped timer that
    // never fires read `current`, and `schedule set` changed nothing.
    const host = await simulatedHost();
    expect((await host.run((manager) => manager.install(input))).status.state).toBe("current");
    await unlink(join(host.state, "active"));

    const stopped = await host.run((manager) => manager.status(input));
    expect(stopped.state).toBe("inactive");
    expect(stopped.detail).toContain("canonfig schedule set");
    // The post-apply reconciler leaves it stopped.
    expect((await host.run((manager) => manager.reconcile(input))).action).toBe("left-as-is");
    expect((await host.run((manager) => manager.status(input))).state).toBe("inactive");

    const set = await host.run((manager) => manager.install(input));
    expect(set).toMatchObject({ change: "updated", status: { state: "current" } });
  });

  it("reports a drop-in that overrides the calendar", async () => {
    // CF-45: drift detection compared unit file text only.
    const host = await simulatedHost();
    await host.run((manager) => manager.install(input));
    const dropIn = join(host.home, ".config/systemd/user/canonfig-sync.timer.d/override.conf");
    await writeFile(join(host.state, "dropins"), dropIn);
    await writeFile(join(host.state, "calendar"), "*-*-* 03:33:00");

    const status = await host.run((manager) => manager.status(input));
    expect(status).toMatchObject({ state: "overridden", effectiveCalendar: "*-*-* 03:33:00" });
    expect(status.detail).toContain(dropIn);
    const error = await host.run((manager) => Effect.flip(manager.install(input)));
    expect(error).toBeInstanceOf(ScheduleHumanActionRequiredError);
  });

  it("restarts the timer with a fresh stamp so a passed time does not catch up at once", async () => {
    // CF-50: Persistent=true ran a time already passed today right after set.
    const host = await simulatedHost();
    const before = Date.now();
    await host.run((manager) => manager.install(input));
    const stamp = await stat(join(host.home, ".local/share/systemd/timers/stamp-canonfig-sync.timer"));
    expect(stamp.mtimeMs).toBeGreaterThanOrEqual(before - 2_000);
    const calls = (await readFile(join(host.state, "calls"), "utf8")).split("\n");
    expect(calls.indexOf("--user stop canonfig-sync.timer"))
      .toBeLessThan(calls.indexOf("--user enable --now canonfig-sync.timer"));
  });

  it("warns that the job only runs while logged in when linger is off", async () => {
    // CF-49: logged-out mode was undiagnosed.
    const host = await simulatedHost("no");
    const status = (await host.run((manager) => manager.install(input))).status;
    expect(status.lingering).toBe(false);
    expect(status.warnings.join("\n")).toContain("loginctl enable-linger");
  });
});
