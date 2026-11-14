import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import { ShieldLogEntry, shieldLogDays } from "./shield-log.types.ts";

/*
 * What Shield did on this machine, newest last, in `<folder>/.shield/log.jsonl`. Three writers append to it: the
 * generated hook guard when it blocks a harness write (`blocked`, see shield.ts), `shield install` after a redirected
 * installer (`installed`), and apply-time ingestion when sync moves a stray item (`ingested`).
 */
export const shieldLogPath = (folder: string) => join(folder, ".shield", "log.jsonl");

/** `~/...` for paths inside HOME, so the log and the GUI read the same way on every machine. */
export const homeRelative = (path: string, home: string) =>
  path === home ? "~" : path.startsWith(home + "/") || path.startsWith(home + "\\") ? "~" + path.slice(home.length) : path;

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(ShieldLogEntry));
const recent = (entry: ShieldLogEntry, now: number) => now - Date.parse(entry.at) <= shieldLogDays * 86_400_000;

const readLines = async (path: string) => (await readFile(path, "utf8").catch((error) => {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
  throw error;
})).split("\n");

/**
 * Entries from the last 30 days, newest first. Hook guards append from many agent processes at once without a lock,
 * so a torn or foreign line is skipped instead of hiding every other entry.
 */
export const readShieldLog = async (folder: string, now = Date.now()): Promise<ReadonlyArray<ShieldLogEntry>> =>
  (await readLines(shieldLogPath(folder)))
    .flatMap((line) => {
      const decoded = line.trim() === "" ? undefined : decodeLine(line);
      return decoded?._tag === "Some" && recent(decoded.value, now) ? [decoded.value] : [];
    })
    .reverse();

/**
 * Append entries and drop ones older than 30 days. The rewrite goes through a temporary file and rename, so a reader
 * never sees a half-written log; a guard line appended between the read and the rename is lost, which costs one
 * entry of history and never a block decision.
 */
export const appendShieldLog = async (folder: string, entries: ReadonlyArray<ShieldLogEntry>, now = Date.now()) => {
  if (entries.length === 0) return;
  const path = shieldLogPath(folder);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lines = await readLines(path);
  const kept = lines.filter((line) => {
    const decoded = line.trim() === "" ? undefined : decodeLine(line);
    return decoded?._tag === "Some" && recent(decoded.value, now);
  });
  const added = entries.map((entry) => JSON.stringify(entry));
  if (kept.length === lines.filter((line) => line.trim() !== "").length) {
    await appendFile(path, added.join("\n") + "\n", { mode: 0o600 });
    return;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, [...kept, ...added].join("\n") + "\n", { mode: 0o600 });
  await rename(temporary, path);
};
