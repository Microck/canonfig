import { spawnSync } from "node:child_process";
import type { HarnessDescriptor, TargetId } from "./types.ts";
import type { AdapterRegistry } from "./compiler.ts";

export interface DoctorTargetResult {
  id: TargetId;
  name: string;
  found: boolean;
  executable?: string;
  version?: string;
  error?: string;
  descriptor: HarnessDescriptor;
}

function firstLine(value: string): string | undefined {
  const line = value.split(/\r?\n/, 1)[0]?.trim();
  return line ? line : undefined;
}

export function doctorTargets(registry: AdapterRegistry, targets?: readonly TargetId[]): DoctorTargetResult[] {
  const selected = targets ? new Set(targets) : undefined;
  return registry.list()
    .filter((adapter) => !selected || selected.has(adapter.descriptor.id))
    .map((adapter): DoctorTargetResult => {
      const descriptor = adapter.descriptor;
      let lastError: string | undefined;
      for (const executable of descriptor.executables) {
        const result = spawnSync(executable, ["--version"], {
          encoding: "utf8",
          timeout: 4_000,
          windowsHide: true,
        });
        if (!result.error && result.status === 0) {
          const version = firstLine(result.stdout) ?? firstLine(result.stderr);
          return {
            id: descriptor.id,
            name: descriptor.name,
            found: true,
            executable,
            ...(version ? { version } : {}),
            descriptor,
          };
        }
        lastError = result.error?.message ?? firstLine(result.stderr) ?? `exit ${result.status ?? "unknown"}`;
      }
      return {
        id: descriptor.id,
        name: descriptor.name,
        found: false,
        ...(lastError ? { error: lastError } : {}),
        descriptor,
      };
    });
}
