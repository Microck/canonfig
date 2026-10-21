import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const command = async (file: string, args: string[]): Promise<string> =>
  (await execute(file, args, { timeout: 5000, maxBuffer: 4096,
    windowsHide: true, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  })).stdout.trim();

/** OS process birth identity, not just a PID that can be recycled after exit. */
export const processIdentity = async (pid: number): Promise<string | undefined> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "linux") {
      const [boot, record] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readFile(`/proc/${pid}/stat`, "utf8"),
      ]);
      // comm is parenthesized and may itself contain spaces or parentheses.
      const start = record.slice(record.lastIndexOf(")") + 2).split(/\s+/u)[19];
      if (start === undefined || !/^\d+$/u.test(start) || boot.trim().length === 0) return undefined;
      return `linux:${boot.trim()}:${start}`;
    }
    if (process.platform === "darwin") {
      const [boot, started] = await Promise.all([
        command("/usr/sbin/sysctl", ["-n", "kern.boottime"]),
        command("/bin/ps", ["-p", String(pid), "-o", "lstart="]),
      ]);
      return boot.length > 0 && started.length > 0 ? `darwin:${boot}:${started}` : undefined;
    }
    if (process.platform === "win32") {
      const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
      if (root === undefined) return undefined;
      const started = await command(join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; [System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)`,
      ]);
      return /^\d+$/u.test(started) ? `win32:${started}` : undefined;
    }
  } catch { /* Unknown identity must never justify stealing a live lease. */ }
  return undefined;
};

/** Cache only a verified identity; transient lookup failures remain retryable. */
export const cacheSuccessfulProcessIdentity = (lookup: () => Promise<string | undefined>): (() => Promise<string | undefined>) => {
  let identity: string | undefined;
  return async () => identity ??= await lookup();
};
