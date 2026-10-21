import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export interface SchedulerIdentity {
  readonly generation: string;
  readonly installedAt: string;
}

/** Native definition content plus file identity distinguish same-byte reinstalls. */
export const fileSchedulerIdentity = async (paths: ReadonlyArray<string>, expectedContents?: ReadonlyArray<string>): Promise<SchedulerIdentity | undefined> => {
  try {
    const hash = createHash("sha256");
    let installedAt = 0;
    for (const [index, path] of paths.entries()) {
      const before = await stat(path, { bigint: true });
      if (!before.isFile()) return undefined;
      const content = await readFile(path);
      if (expectedContents !== undefined && content.toString("utf8") !== expectedContents[index]) return undefined;
      const after = await stat(path, { bigint: true });
      const key = (value: typeof before) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
      if (key(before) !== key(after)) return undefined;
      hash.update(key(after)).update("\0").update(content).update("\0");
      installedAt = Math.max(installedAt, Number(after.mtimeNs) / 1e6, Number(after.ctimeNs) / 1e6);
    }
    if (paths.length === 0) return undefined;
    return { generation: hash.digest("hex"), installedAt: new Date(Math.ceil(installedAt)).toISOString() };
  } catch { return undefined; }
};

/** Task Scheduler exports the registration date independently of run outcomes. */
export const registeredSchedulerIdentity = (xml: string, registeredAt: string | undefined): SchedulerIdentity | undefined => {
  if (registeredAt === undefined || !Number.isFinite(Date.parse(registeredAt))) return undefined;
  return { generation: createHash("sha256").update(xml).digest("hex"), installedAt: registeredAt };
};
