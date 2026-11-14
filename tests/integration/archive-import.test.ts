import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { Effect, Layer, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { SourceIdentity } from "../../src/domain/identity.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import { importLocal } from "../../src/projection/sync.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { StateRepository } from "../../src/state/state-repository.service.ts";
import {
  defaultScheduledInvocation,
  FollowerSynchronizationConfiguration,
} from "../../src/synchronization/follower-sync-config.ts";
import { SynchronizationLive } from "../../src/synchronization/synchronization.layer.ts";

/**
 * Hand-built archives that a Canonfig export never produces, imported with
 * the real machine layer, SQLite and synchronization engine. Each one must be
 * refused before anything is written, and nothing may land outside the home.
 * The one substitution wraps the real `atomicWrite` to create a target first,
 * the way a concurrent process would after import checked the folder.
 */

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Entry {
  readonly path: string;
  readonly content?: string;
  readonly mode?: number;
  /** ustar type flag; regular file by default. */
  readonly type?: string;
  readonly linkname?: string;
}

const octal = (header: Buffer, offset: number, length: number, value: number) =>
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");

const header = (name: string, size: number, mode: number, type: string, linkname = "") => {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  octal(block, 100, 8, mode);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, size);
  octal(block, 136, 12, 0);
  block.fill(32, 148, 156);
  block.write(type, 156, "ascii");
  block.write(linkname, 157, 100, "utf8");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  block.write(`${block.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
};

const pad = (bytes: Buffer) => Buffer.concat([bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);

/**
 * A gzip tar whose first entry is a manifest listing `listed` (every regular
 * entry by default) with correct checksums, then `entries` as given.
 */
const archiveOf = (entries: ReadonlyArray<Entry>, options: { readonly listed?: ReadonlyArray<Entry>; readonly manifestFirst?: boolean } = {}) => {
  const listed = options.listed ?? entries.filter((entry) => (entry.type ?? "0") === "0");
  const manifest = JSON.stringify({
    format: "canonfig-export",
    version: 2,
    canonfigVersion: "7.1.3",
    createdAt: "2026-11-05T00:00:00.000Z",
    role: "source",
    files: listed.map((entry) => ({
      path: entry.path,
      size: Buffer.byteLength(entry.content ?? ""),
      sha256: createHash("sha256").update(entry.content ?? "").digest("hex"),
      mode: `0${(entry.mode ?? 0o644).toString(8)}`,
    })),
  });
  const all: ReadonlyArray<Entry> = options.manifestFirst === false
    ? [...entries, { path: "manifest.json", content: manifest }]
    : [{ path: "manifest.json", content: manifest }, ...entries];
  const blocks = all.flatMap((entry, index) => {
    const record = `path=${entry.path}\n`;
    const length = Buffer.byteLength(record) + 1 + String(Buffer.byteLength(record) + 4).length;
    const pax = Buffer.from(`${length} ${record}`);
    const content = Buffer.from(entry.content ?? "");
    return [
      header(`PaxHeaders/${index}`, pax.length, 0o644, "x"), pad(pax),
      header(`file-${index}`, content.length, entry.mode ?? 0o644, entry.type ?? "0", entry.linkname), pad(content),
    ];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
};

const config: Entry = { path: "folder/canonfig.jsonc", content: "{ \"version\": 1, \"harnesses\": [] }\n" };

const machine = (wrap: (base: Layer.Layer<MachineState>) => Layer.Layer<MachineState> = (base) => base) => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-archive-import-"));
  roots.push(root);
  const home = join(root, "home");
  const folder = join(home, ".canonfig");
  mkdirSync(folder, { recursive: true });
  const statePath = join(folder, "state.sqlite");
  const machineLayer = wrap(linuxMachineStateLayer({
    environment: [{ name: "HOME", value: home }, { name: "XDG_CACHE_HOME", value: join(home, ".cache") }],
    credentialPolicy: { kind: "local-file", path: join(home, "credentials") },
  }));
  const layer = SynchronizationLive.pipe(
    Layer.provideMerge(stateRepositoryLayer(statePath)),
    Layer.provideMerge(machineLayer),
  );
  const importing = (archive: string) =>
    Effect.runPromise(importLocal(statePath, archive, "apply", false, undefined).pipe(Effect.flip, Effect.provide(layer)));
  const withArchive = (bytes: Uint8Array) => {
    const path = join(root, "crafted.tar.gz");
    writeFileSync(path, bytes);
    return importing(path);
  };
  return { root, home, folder, statePath, layer, importing, withArchive };
};

describe("import refuses archives a Canonfig export never produces", () => {
  it.each<readonly [string, ReadonlyArray<Entry>]>([
    ["a path climbing out with ..", [config, { path: "folder/../escape.md", content: "x" }]],
    ["an absolute path", [config, { path: "/tmp/escape.md", content: "x" }]],
    ["a symbolic link", [config, { path: "folder/skills/x/link", type: "2", linkname: "/etc/passwd" }]],
    ["a hard link", [config, { path: "folder/skills/x/link", type: "1", linkname: "folder/canonfig.jsonc" }]],
    ["a character device", [config, { path: "folder/rules/null", type: "3" }]],
    ["a directory entry", [config, { path: "folder/rules", type: "5" }]],
    ["state outside the allowlist", [config, { path: "folder/state.sqlite", content: "x" }]],
    ["a takeover snapshot", [config, { path: "folder/.backups/x/manifest.json", content: "{}" }]],
    ["a harness file of an unknown harness", [config, { path: "harnesses/unknown/.x/file", content: "x" }]],
    ["a credential file", [config, { path: "folder/skills/x/.env", content: "TOKEN=x" }]],
    ["paths that differ only in case", [config, { path: "folder/rules/A.md", content: "a" }, { path: "folder/rules/a.md", content: "b" }]],
    ["a special mode", [config, { path: "folder/hooks/run.sh", content: "x", mode: 0o4755 }]],
    ["no canonfig.jsonc", [{ path: "folder/AGENTS.md", content: "x" }]],
    ["a malformed local/local.jsonc", [config, { path: "folder/local/local.jsonc", content: "{ \"backups\": " }]],
  ])("refuses %s", async (_name, entries) => {
    const target = machine();
    const error = await target.withArchive(archiveOf(entries));
    expect(error._tag).toBe("ArchiveIntegrityError");
    expect(readdirSync(target.folder).filter((name) => !name.startsWith("state.sqlite"))).toEqual([]);
    expect(existsSync(join(target.home, "escape.md"))).toBe(false);
    expect(existsSync(join(target.root, "escape.md"))).toBe(false);
  });

  it("refuses an entry the manifest does not list, and a listed file the archive lacks", async () => {
    const target = machine();
    const extra = { path: "folder/AGENTS.md", content: "smuggled" };
    expect((await target.withArchive(archiveOf([config, extra], { listed: [config] })))._tag).toBe("ArchiveIntegrityError");
    expect((await target.withArchive(archiveOf([config], { listed: [config, extra] })))._tag).toBe("ArchiveIntegrityError");
    expect((await target.withArchive(archiveOf([config], { manifestFirst: false })))._tag).toBe("ArchiveIntegrityError");
    expect(readdirSync(target.folder).filter((name) => !name.startsWith("state.sqlite"))).toEqual([]);
  });

  it("refuses tar data after the end-of-archive marker", async () => {
    const target = machine();
    const tar = gunzipSync(archiveOf([config]));
    const smuggled = gzipSync(Buffer.concat([tar, header("file-x", 1, 0o644, "0"), pad(Buffer.from("x"))]));
    const error = await target.withArchive(smuggled);
    expect(error._tag).toBe("ArchiveIntegrityError");
    expect(readdirSync(target.folder).filter((name) => !name.startsWith("state.sqlite"))).toEqual([]);
  });

  it("refuses an archive larger than any export from its size, before reading it", async () => {
    const target = machine();
    const path = join(target.root, "huge.tar.gz");
    writeFileSync(path, "");
    // Sparse, so only a size check on the opened file refuses it quickly.
    truncateSync(path, 512 * 1024 * 1024);
    const error = await target.importing(path);
    expect(error._tag).toBe("ArchiveIntegrityError");
    expect(error.message).toContain("larger than any export");
  });

  it("refuses an enrolled follower before reading the archive", async () => {
    const target = machine();
    const decode = Schema.decodeUnknownSync;
    const follower = {
      id: "follower-1",
      name: "laptop",
      groups: [],
      revoked: false,
      credentialReference: "canonfig:follower-1",
      enrolledAt: "2026-11-03T00:00:00Z",
    };
    await Effect.runPromise(Effect.flatMap(StateRepository, (repository) =>
      repository.saveFollowerSynchronizationConfiguration({
        sourceIdentity: decode(SourceIdentity)({ keyId: "source-key", publicKeyFingerprint: "source-fingerprint" }),
        configuration: decode(FollowerSynchronizationConfiguration)({
          schemaVersion: 1,
          lifecycle: { _tag: "Active" },
          follower,
          profile: "workstation",
          source: { endpoint: "https://127.0.0.1:9/", tlsFingerprint: "tls-fingerprint", signingFingerprint: "source-fingerprint" },
          credentialReference: follower.credentialReference,
          cacheDirectory: join(target.folder, "cache"),
          stateLocation: target.statePath,
          agentPolicy: "deterministic-only",
          scheduledInvocation: defaultScheduledInvocation,
          updatedAt: "2026-11-03T00:00:00Z",
        }),
      })
    ).pipe(Effect.provide(target.layer)));
    const error = await target.importing(join(target.root, "never-read.tar.gz"));
    expect(error._tag).toBe("ArchiveRequestError");
    expect(error.message).toContain("enrolled Follower");
  });
});

describe("import never overwrites a file that appears while it runs", () => {
  it("keeps a canonfig.jsonc created after the check, rolls back and reports a conflict", async () => {
    let racedPath: string | undefined;
    const target = machine((base) =>
      Layer.effect(MachineState, Effect.gen(function*() {
        const real = yield* MachineState;
        return MachineState.of({
          ...real,
          // Another process creates the file between the occupancy check
          // and the import's write of it.
          atomicWrite: (input) =>
            input.noReplace === true && input.path.absolute.endsWith(join(".canonfig", "canonfig.jsonc"))
              ? Effect.sync(() => {
                racedPath = input.path.absolute;
                writeFileSync(input.path.absolute, "raced");
              }).pipe(Effect.andThen(real.atomicWrite(input)))
              : real.atomicWrite(input),
        });
      })).pipe(Layer.provide(base))
    );
    const error = await target.withArchive(archiveOf([
      config,
      { path: "folder/AGENTS.md", content: "# imported\n" },
      { path: "folder/rules/style.md", content: "imported rule\n" },
    ]));
    expect(error._tag).toBe("ArchiveConflictError");
    expect(error).toMatchObject({ path: racedPath });
    expect(readFileSync(join(target.folder, "canonfig.jsonc"), "utf8")).toBe("raced");
    // Everything else the run wrote was rolled back.
    expect(existsSync(join(target.folder, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(target.folder, "rules", "style.md"))).toBe(false);
  });
});
