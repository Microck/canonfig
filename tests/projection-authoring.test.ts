import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { maximumAuthoringBytes, readAuthoringItem, readAuthoringItems, writeAuthoringItems, editAuthoringConfig, type AuthoringTarget } from "../src/projection/authoring.ts";
import { loadCanonicalFiles } from "../src/projection/folder.ts";
import { commandFailure, failureBody } from "../src/gui/routing.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const fixture = (config = '{\n  // Keep this explanation.\n  "version": 1,\n  "harnesses": ["codex"],\n  "local": { "allow": ["instructions", "skills", "mcp"] }\n}\n') => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-authoring-"));
  homes.push(home);
  const folder = join(home, ".canonfig");
  mkdirSync(folder);
  writeFileSync(join(folder, "canonfig.jsonc"), config);
  const target: AuthoringTarget = { folder, scope: "canonical", statePath: join(folder, "state.sqlite") };
  const layer = linuxMachineStateLayer({ environment: [{ name: "HOME", value: home }] });
  return { home, target, layer };
};
const file = (path: string, text: string) => ({ path, content: new TextEncoder().encode(text), executable: false });

describe("shared folder authoring", () => {
  it("validates candidate-local presence without consulting the disk", async () => {
    const { target } = fixture();
    const candidate = new Map([
      ["canonfig.jsonc", file("canonfig.jsonc", '{"version":1,"harnesses":[]}')],
      ["local/skills/ignored/SKILL.md", file("local/skills/ignored/SKILL.md", "not decoded")],
    ]);
    const loaded = await loadCanonicalFiles(target.folder, candidate);
    expect(loaded.ignoredLocal).toEqual(["local/skills/"]);
  });

  it("preserves JSONC comments and atomically replaces the file", async () => {
    const { target, layer } = fixture();
    const path = join(target.folder, "canonfig.jsonc");
    const before = readFileSync(path, "utf8");
    const descriptor = openSync(path, "r");
    const inode = statSync(path).ino;
    try {
      await Effect.runPromise(Effect.gen(function*() {
        const item = yield* readAuthoringItem(target, "canonfig.jsonc");
        yield* editAuthoringConfig(target, item.digest, [{ path: ["profile"], value: { id: "work", name: "Work" } }]);
      }).pipe(Effect.provide(layer)));
      expect(readFileSync(path, "utf8")).toContain("// Keep this explanation.");
      expect(readFileSync(path, "utf8")).toContain('"name": "Work"');
      expect(statSync(path).ino).not.toBe(inode);
      expect(readFileSync(descriptor, "utf8")).toBe(before);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(target.folder).sort()).toEqual(["canonfig.jsonc"]);
    } finally { closeSync(descriptor); }
  });

  it("refuses stale edits and create collisions without changing the hand edit", async () => {
    const { target, layer } = fixture();
    await Effect.runPromise(Effect.gen(function*() {
      const original = yield* readAuthoringItem(target, "canonfig.jsonc");
      writeFileSync(join(target.folder, "canonfig.jsonc"), '// Hand edit\n{"version":1,"harnesses":[]}\n');
      const error = yield* editAuthoringConfig(target, original.digest, [{ path: ["harnesses"], value: ["codex"] }]).pipe(Effect.flip);
      expect(error._tag).toBe("AuthoringConflict");
      expect(readFileSync(join(target.folder, "canonfig.jsonc"), "utf8")).toContain("Hand edit");
      writeFileSync(join(target.folder, "AGENTS.md"), "Mine\n");
      const create = yield* writeAuthoringItems(target, [{ path: "AGENTS.md", expectedDigest: null, files: [file("AGENTS.md", "Yours\n")] }]).pipe(Effect.flip);
      expect(create._tag).toBe("AuthoringConflict");
      expect(readFileSync(join(target.folder, "AGENTS.md"), "utf8")).toBe("Mine\n");
    }).pipe(Effect.provide(layer)));
  });

  it("rejects an invalid complete candidate before writing any item", async () => {
    const { target, layer } = fixture();
    const before = readFileSync(join(target.folder, "canonfig.jsonc"), "utf8");
    await Effect.runPromise(Effect.gen(function*() {
      const item = yield* readAuthoringItem(target, "canonfig.jsonc");
      const error = yield* editAuthoringConfig(target, item.digest, [{ path: ["surfaces"], value: { claude: ["rules"] } }], [
        { path: "AGENTS.md", expectedDigest: null, files: [file("AGENTS.md", "Never written")] },
      ]).pipe(Effect.flip);
      expect(error._tag).toBe("AuthoringInvalid");
    }).pipe(Effect.provide(layer)));
    expect(readFileSync(join(target.folder, "canonfig.jsonc"), "utf8")).toBe(before);
    expect(readdirSync(target.folder)).toEqual(["canonfig.jsonc"]);
  });

  it("admits a readable candidate just below the aggregate byte budget and refuses one byte over before writing", async () => {
    const { target, layer } = fixture();
    mkdirSync(join(target.folder, "local"));
    writeFileSync(join(target.folder, "local/AGENTS.md"), "Local instructions\n");
    const skill = file("skills/large/SKILL.md", "---\nname: large\ndescription: Large binary skill\n---\nInstructions\n");
    const existingBytes = statSync(join(target.folder, "canonfig.jsonc")).size + statSync(join(target.folder, "local/AGENTS.md")).size;
    const available = maximumAuthoringBytes - existingBytes - skill.content.byteLength - 1;
    // Reuse one backing buffer for the candidate; only real filesystem reads allocate the full tree.
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const assets = Array.from({ length: Math.ceil(available / chunk.byteLength) }, (_, index) => ({
      path: `skills/large/asset-${index}.bin`, executable: false,
      content: chunk.subarray(0, Math.min(chunk.byteLength, available - index * chunk.byteLength)),
    }));
    await Effect.runPromise(Effect.gen(function*() {
      const refused = yield* writeAuthoringItems(target, [{
        path: "skills/large", expectedDigest: null,
        files: [skill, ...assets, file("skills/large/extra.bin", "xx")],
      }]).pipe(Effect.mapError(commandFailure), Effect.flip);
      expect(failureBody(refused.category, refused.message)).toMatchObject({
        category: "usage-or-configuration", exitCode: 2,
        message: expect.stringContaining(`Authoring files exceed the ${maximumAuthoringBytes} byte total limit.`),
      });
      expect(readdirSync(target.folder).sort()).toEqual(["canonfig.jsonc", "local"]);
      yield* writeAuthoringItems(target, [{ path: "skills/large", expectedDigest: null, files: [skill, ...assets] }]);
      const saved = yield* readAuthoringItems(target);
      const savedBytes = saved.flatMap((item) => item.files).reduce((total, file) => total + file.content.byteLength, 0);
      expect(savedBytes + statSync(join(target.folder, "local/AGENTS.md")).size).toBe(maximumAuthoringBytes - 1);
      expect(statSync(join(target.folder, assets[0]!.path)).size).toBe(chunk.byteLength);
    }).pipe(Effect.provide(layer)));
  }, 60_000);

  it("creates, updates and deletes whole skills with digest preconditions", async () => {
    const { target, layer } = fixture();
    await Effect.runPromise(Effect.gen(function*() {
      const skill = file("skills/deploy/SKILL.md", "---\nname: deploy\ndescription: Deploy the app\n---\nRun checks.\n");
      yield* writeAuthoringItems(target, [{ path: "skills/deploy", expectedDigest: null, files: [skill, file("skills/deploy/scripts/run.sh", "exit 0\n")] }]);
      const items = yield* readAuthoringItems(target);
      expect(items.map((item) => item.path)).toEqual(["canonfig.jsonc", "skills/deploy"]);
      const read = yield* readAuthoringItem(target, "skills/deploy");
      expect(read.files).toHaveLength(2);
      expect(read.files.every((file) => /^[a-f0-9]{64}$/u.test(file.digest))).toBe(true);
      yield* writeAuthoringItems(target, [{ path: "skills/deploy", expectedDigest: read.digest, files: [skill] }]);
      expect(readdirSync(join(target.folder, "skills/deploy"))).toEqual(["SKILL.md"]);
      const updated = yield* readAuthoringItem(target, "skills/deploy");
      yield* writeAuthoringItems(target, [{ path: "skills/deploy", expectedDigest: updated.digest, files: [] }]);
      expect((yield* readAuthoringItem(target, "skills/deploy")).digest).toBeNull();
    }).pipe(Effect.provide(layer)));
    expect(readdirSync(target.folder)).toEqual(["canonfig.jsonc"]);
  });
  it.each(["file-to-directory", "directory-to-file"])("changes skill topology %s after digest checks", async (direction) => {
    const { target, layer } = fixture();
    const skill = file("skills/deploy/SKILL.md", "---\nname: deploy\ndescription: Deploy\n---\nRun checks.\n");
    const before = file(direction === "file-to-directory" ? "skills/deploy/assets" : "skills/deploy/assets/nested/old.txt", "Old");
    const after = file(direction === "file-to-directory" ? "skills/deploy/assets/nested/new.txt" : "skills/deploy/assets", "New");
    await Effect.runPromise(Effect.gen(function*() {
      yield* writeAuthoringItems(target, [{ path: "skills/deploy", expectedDigest: null, files: [skill, before] }]);
      const original = yield* readAuthoringItem(target, "skills/deploy");
      writeFileSync(join(target.folder, before.path), "Hand edit");
      const stale = yield* writeAuthoringItems(target, [{ path: original.path, expectedDigest: original.digest, files: [skill, after] }]).pipe(Effect.flip);
      expect(stale._tag).toBe("AuthoringConflict");
      expect(readFileSync(join(target.folder, before.path), "utf8")).toBe("Hand edit");
      const current = yield* readAuthoringItem(target, "skills/deploy");
      yield* writeAuthoringItems(target, [{ path: current.path, expectedDigest: current.digest, files: [skill, after] }]);
      expect(readFileSync(join(target.folder, after.path), "utf8")).toBe("New");
      expect((yield* readAuthoringItem(target, current.path)).files.map(({ path }) => path).sort()).toEqual([skill.path, after.path].sort());
    }).pipe(Effect.provide(layer)));
  });


  it("validates resource declarations together with their file content", async () => {
    const { target, layer } = fixture();
    await Effect.runPromise(Effect.gen(function*() {
      const config = yield* readAuthoringItem(target, "canonfig.jsonc");
      yield* editAuthoringConfig(target, config.digest, [{ path: ["resources", "notes"], value: { kind: "file", target: "~/.notes", source: "files/notes.txt" } }], [
        { path: "files/notes.txt", expectedDigest: null, files: [file("files/notes.txt", "Notes\n")] },
      ]);
      const notes = yield* readAuthoringItem(target, "files/notes.txt");
      const refused = yield* writeAuthoringItems(target, [{ path: notes.path, expectedDigest: notes.digest, files: [] }]).pipe(Effect.flip);
      expect(refused._tag).toBe("AuthoringInvalid");
      expect(readFileSync(join(target.folder, "files/notes.txt"), "utf8")).toBe("Notes\n");
    }).pipe(Effect.provide(layer)));
  });

  it("refuses authored targets inside a harness before writing any candidate files", async () => {
    const { target, layer } = fixture();
    const before = readFileSync(join(target.folder, "canonfig.jsonc"), "utf8");
    await Effect.runPromise(Effect.gen(function*() {
      const config = yield* readAuthoringItem(target, "canonfig.jsonc");
      const error = yield* editAuthoringConfig(target, config.digest, [
        { path: ["resources", "private"], value: { kind: "file", target: "~/.codex/auth.json", source: "files/private.json" } },
      ], [
        { path: "files/private.json", expectedDigest: null, files: [file("files/private.json", "{}\n")] },
        { path: "AGENTS.md", expectedDigest: null, files: [file("AGENTS.md", "Must not be written\n")] },
      ]).pipe(Effect.flip);
      expect(error._tag).toBe("CanonicalFolderError");
      expect(error.message).toContain("which belongs to OpenAI Codex");
    }).pipe(Effect.provide(layer)));
    expect(readFileSync(join(target.folder, "canonfig.jsonc"), "utf8")).toBe(before);
    expect(readdirSync(target.folder)).toEqual(["canonfig.jsonc"]);
  });
  it("validates every authored resource even when locally excluded", async () => {
    const { target, layer } = fixture();
    mkdirSync(join(target.folder, "local"));
    writeFileSync(join(target.folder, "local/local.jsonc"), '{"excludeResources":["private"]}');
    const before = readFileSync(join(target.folder, "canonfig.jsonc"), "utf8");
    await Effect.runPromise(Effect.gen(function*() {
      const config = yield* readAuthoringItem(target, "canonfig.jsonc");
      const result = yield* editAuthoringConfig(target, config.digest, [
        { path: ["resources", "private"], value: { kind: "file", target: "~/.codex/auth.json", source: "files/private.json" } },
      ], [{ path: "files/private.json", expectedDigest: null, files: [file("files/private.json", "{}")] }]).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(layer)));
    expect(readFileSync(join(target.folder, "canonfig.jsonc"), "utf8")).toBe(before);
    expect(readdirSync(target.folder).sort()).toEqual(["canonfig.jsonc", "local"]);
  });


  it("uses the same writer for local items and refuses categories outside local.allow", async () => {
    const fixtureValue = fixture();
    const target = { ...fixtureValue.target, scope: "local" as const };
    await Effect.runPromise(Effect.gen(function*() {
      yield* writeAuthoringItems(target, [{ path: "AGENTS.md", expectedDigest: null, files: [file("AGENTS.md", "My instructions\n")] }]);
      const denied = yield* writeAuthoringItems(target, [{ path: "rules/private.md", expectedDigest: null, files: [file("rules/private.md", "My rule\n")] }]).pipe(Effect.flip);
      expect(denied._tag).toBe("AuthoringInvalid");
      yield* editAuthoringConfig(target, null, [{ path: ["mcp", "docs"], value: { transport: "stdio", command: "docs" } }]);
      const localConfig = yield* readAuthoringItem(target, "local.jsonc");
      const settings = yield* editAuthoringConfig(target, localConfig.digest, [{ path: ["settings"], value: { codex: { model: "mine" } } }]).pipe(Effect.flip);
      expect(settings._tag).toBe("AuthoringInvalid");
      expect(readFileSync(join(target.folder, "local/AGENTS.md"), "utf8")).toBe("My instructions\n");
    }).pipe(Effect.provide(fixtureValue.layer)));
  });
  it.each(["mcp", "settings"])("retains unchanged disallowed local %s during permitted saves", async (category) => {
    const { target: canonical, layer } = fixture('{"version":1,"harnesses":[],"local":{"allow":["instructions"]}}');
    const target = { ...canonical, scope: "local" as const };
    const entries = category === "mcp" ? { docs: { transport: "stdio", command: "docs" } } : { codex: { model: "mine" } };
    mkdirSync(join(target.folder, "local"));
    writeFileSync(join(target.folder, "local/local.jsonc"), JSON.stringify({ [category]: entries }));
    await Effect.runPromise(Effect.gen(function*() {
      yield* writeAuthoringItems(target, [{ path: "AGENTS.md", expectedDigest: null, files: [file("AGENTS.md", "Allowed")] }]);
      const config = yield* readAuthoringItem(target, "local.jsonc");
      yield* editAuthoringConfig(target, config.digest, [{ path: ["backups"], value: false }]);
      const updated = yield* readAuthoringItem(target, "local.jsonc");
      const refused = yield* editAuthoringConfig(target, updated.digest, [
        { path: [category, category === "mcp" ? "docs" : "codex", category === "mcp" ? "command" : "model"], value: "changed" },
      ]).pipe(Effect.flip);
      expect(refused._tag).toBe("AuthoringInvalid");
      yield* editAuthoringConfig(target, updated.digest, [{ path: [category], value: undefined }]);
    }).pipe(Effect.provide(layer)));
    expect(readFileSync(join(target.folder, "local/AGENTS.md"), "utf8")).toBe("Allowed");
  });


  it("refuses traversal and symlinks without reading or changing the target", async () => {
    const { target, layer, home } = fixture();
    const outside = join(home, "private");
    writeFileSync(outside, "untouched");
    symlinkSync(outside, join(target.folder, "AGENTS.md"));
    await Effect.runPromise(Effect.gen(function*() {
      expect((yield* readAuthoringItem(target, "../private").pipe(Effect.flip))._tag).toBe("AuthoringInvalid");
      expect((yield* readAuthoringItem(target, "AGENTS.md").pipe(Effect.flip))._tag).toBe("AuthoringInvalid");
    }).pipe(Effect.provide(layer)));
    expect(readFileSync(outside, "utf8")).toBe("untouched");
  });
});
