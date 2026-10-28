import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, symlink, realpath, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncCatalogueDirectory, captureCatalogue, decodeCatalogue, exportCatalogue, planCatalogue, synchronizeCatalogue, type Catalogue } from "../../src/profile/lsops-catalogue.ts";
import { parseLsopsArguments, runLsopsCli } from "../../src/profile/lsops-cli.ts";
import { decodeMachineProfileJsonc } from "../../src/domain/profile.ts";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const tool = (description = "Alpha") => ({ description, install_url: "https://www.npmjs.com/package/alpha", install_manager: "bun" });
const cat = (tools: Catalogue["tools"]): Catalogue => ({ version: 1, tools });
const put = <Value>(file: string, data: Value) => writeFile(file, JSON.stringify(data));
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "canonfig-lsops-"))); roots.push(root);
  const config = path.join(root, "config.json"); const bundle = path.join(root, "shared.json");
  await put(bundle, cat({ alpha: tool() }));
  await put(config, { ...cat({ local: { description: "Only on follower", path: "/bin/local", install_url: "https://crates.io/crates/local" } }), projects: [root] });
  return { root, config, bundle, apply: true };
}
const load = async (file: string) => JSON.parse(await readFile(file, "utf8"));

describe("lsops portable catalogue bridge", () => {
  it("exports portable fields only, skips hidden and legacy entries", () => {
    expect(exportCatalogue(cat({ alpha: { ...tool(), path: "/bin/alpha", help: "local", include: true }, hidden: { description: "secret", hide: true }, legacy: { help: "hint" } }))).toEqual(cat({ alpha: tool() }));
  });
  it("previews with no writes, then preserves follower-only records and trust", async () => {
    const options = await fixture(); const before = await readFile(options.config, "utf8");
    expect((await synchronizeCatalogue({ ...options, apply: false })).added).toEqual(["alpha"]);
    expect(await readFile(options.config, "utf8")).toBe(before);
    expect((await readdir(options.root)).sort()).toEqual(["config.json", "shared.json"]);
    await synchronizeCatalogue(options);
    const result = await load(options.config);
    expect(result.tools.local).toEqual(JSON.parse(before).tools.local);
    expect(result.projects).toEqual([options.root]); expect(result.tools.alpha).toEqual(tool());
    expect((await readdir(options.root)).sort()).toEqual(["config.json", "config.json.canonfig-lsops.json", "config.json.canonfig-lsops.json.last-transaction.json", "shared.json"]);
    expect((await synchronizeCatalogue(options)).added).toEqual([]);
  });
  it("updates owned metadata but keeps executable paths and visibility local", async () => {
    const options = await fixture(); await synchronizeCatalogue(options);
    const config = await load(options.config); Object.assign(config.tools.alpha, { path: "/custom/alpha", hide: true }); await put(options.config, config);
    await put(options.bundle, cat({ alpha: tool("New description") })); await synchronizeCatalogue(options);
    expect((await load(options.config)).tools.alpha).toEqual({ ...tool("New description"), path: "/custom/alpha", hide: true });
  });
  it("blocks the whole batch for initial same-name conflict", async () => {
    const options = await fixture(); await put(options.config, cat({ alpha: tool("Local") })); const before = await readFile(options.config, "utf8");
    await put(options.bundle, cat({ alpha: tool(), beta: { description: "Beta" } }));
    expect((await synchronizeCatalogue(options)).conflicts).toEqual(["alpha: independently registered locally"]);
    expect(await readFile(options.config, "utf8")).toBe(before);
    expect(await readdir(options.root)).not.toContain("config.json.canonfig-lsops.json");
  });
  it("never adopts an identical independently registered tool", async () => {
    const options = await fixture(); await put(options.config, cat({ alpha: tool() })); await synchronizeCatalogue(options);
    expect((await load(`${options.config}.canonfig-lsops.json`)).owned).toEqual({});
    await put(options.bundle, cat({})); await synchronizeCatalogue(options);
    expect((await load(options.config)).tools.alpha).toEqual(tool());
  });
  it("removes only owned unchanged metadata and preserves local additions", async () => {
    const options = await fixture(); await synchronizeCatalogue(options);
    const config = await load(options.config); config.tools.alpha.path = "/custom/alpha"; await put(options.config, config);
    await put(options.bundle, cat({})); expect((await synchronizeCatalogue(options)).removed).toEqual(["alpha"]);
    expect((await load(options.config)).tools.alpha).toEqual({ path: "/custom/alpha" });
    expect((await load(options.config)).tools.local.description).toBe("Only on follower");
  });
  it("removes a purely shared record without uninstalling anything", async () => {
    const options = await fixture(); const executable = path.join(options.root, "alpha"); await writeFile(executable, "binary fixture");
    await synchronizeCatalogue(options); await put(options.bundle, cat({})); await synchronizeCatalogue(options);
    expect((await load(options.config)).tools.alpha).toBeUndefined(); expect(await readFile(executable, "utf8")).toBe("binary fixture");
  });
  it.each(["edit", "delete"])("retains local drift on source removal: %s", async (change) => {
    const options = await fixture(); await synchronizeCatalogue(options); const config = await load(options.config);
    if (change === "edit") config.tools.alpha.description = "Changed locally"; else delete config.tools.alpha;
    await put(options.config, config); await put(options.bundle, cat({}));
    expect((await synchronizeCatalogue(options)).conflicts).toEqual(["alpha: local edits to shared metadata"]);
    expect(await load(options.config)).toEqual(config);
  });
  it("does not interpret a missing shared file as removal", async () => {
    const options = await fixture(); await synchronizeCatalogue(options); await rm(options.bundle);
    await expect(synchronizeCatalogue(options)).rejects.toThrow("missing"); expect((await load(options.config)).tools.alpha).toEqual(tool());
  });
  it("refuses self-overwrite and reserved ownership paths", async () => {
    const options = await fixture();
    for (const bundle of [options.config, `${options.config}.updates.json`, `${options.config}.canonfig-lsops.json`, `${options.config}.canonfig-lsops.json.pending`, `${options.config}.canonfig-lsops.json.lock`, `${options.config}.canonfig-lsops.json.last-transaction.json`]) {
      await expect(synchronizeCatalogue({ ...options, bundle })).rejects.toThrow("separate");
      await expect(captureCatalogue({ ...options, bundle })).rejects.toThrow("separate");
    }
    await expect(captureCatalogue({ ...options, bundle: options.config })).rejects.toThrow("different");
    if (process.platform === "win32") {
      await expect(captureCatalogue({ ...options, bundle: options.config.toUpperCase() })).rejects.toThrow("different");
      await expect(synchronizeCatalogue({ ...options, bundle: options.config.toUpperCase() })).rejects.toThrow("separate");
    }
  });
  it("rejects capture aliases by filesystem identity and case spelling", async () => {
    const options = await fixture(); const before = await readFile(options.config,"utf8");
    const alias=path.join(options.root,"alias.json");await link(options.config,alias);
    await expect(captureCatalogue({...options,bundle:alias})).rejects.toThrow("filesystem alias");
    await expect(synchronizeCatalogue({...options,bundle:alias})).rejects.toThrow("filesystem alias");
    await expect(captureCatalogue({...options,bundle:path.join(options.root,"CONFIG.json")})).rejects.toThrow("separate");
    expect(await readFile(options.config,"utf8")).toBe(before);
  });
  it("preserves state and recovery evidence when capture targets either directly or by hard link", async () => {
    const options=await fixture();
    for(const suffix of [".canonfig-lsops.json",".canonfig-lsops.json.pending",".canonfig-lsops.json.last-transaction.json"]){
      const reserved=options.config+suffix;await writeFile(reserved,"private recovery evidence");
      const alias=path.join(options.root,`alias${suffix}`);await link(reserved,alias);
      await expect(captureCatalogue({...options,bundle:reserved})).rejects.toThrow("separate");
      await expect(captureCatalogue({...options,bundle:alias})).rejects.toThrow("filesystem alias");
      expect(await readFile(reserved,"utf8")).toBe("private recovery evidence");
    }
  });
  it("retains a last-successful recovery receipt after flushed config/state commits",async()=>{
    const options=await fixture();const before=await readFile(options.config,"utf8");
    const result=await synchronizeCatalogue(options);
    expect((await load(`${options.config}.canonfig-lsops.json.last-transaction.json`)).before).toBe(before);
    expect(await readdir(options.root)).not.toContain("config.json.canonfig-lsops.json.pending");
    expect(result.durabilityPolicy).toContain(process.platform==="win32"?"file-flushed-atomic-renames":"file-and-directory-flushed");
    expect((await synchronizeCatalogue(options)).conflicts).toEqual([]);
  });
  it("does not open a read-only Windows directory for unsupported FlushFileBuffers",async()=>{
    await expect(syncCatalogueDirectory("does-not-exist", "win32")).resolves.toBeUndefined();
    await expect(syncCatalogueDirectory("does-not-exist", "linux")).rejects.toMatchObject({code:"ENOENT"});
  });
  it("persists journal directory before mutation and keeps evidence when flushing fails", async () => {
    const options=await fixture();let writes=0;
    const before=await readFile(options.config,"utf8");
    await expect(synchronizeCatalogue(options,{
      replace:async()=>{writes++;},syncDirectory:async()=>{throw new Error("Directory flush failed");},
    })).rejects.toThrow("Directory flush failed");
    expect(writes).toBe(0);expect(await readFile(options.config,"utf8")).toBe(before);
    expect((await load(`${options.config}.canonfig-lsops.json.pending`)).before).toBe(before);
  });
  it("binds ownership to exactly one shared catalogue", async () => {
    const options = await fixture(); await synchronizeCatalogue(options); const bundle = path.join(options.root, "different.json"); await put(bundle, cat({}));
    await expect(synchronizeCatalogue({ ...options, bundle })).rejects.toThrow("does not match");
  });
  it("refuses symlinks, stale locks and interrupted writes", async () => {
    const options = await fixture(); const lock = `${options.config}.canonfig-lsops.json.lock`;
    await mkdir(lock); await expect(synchronizeCatalogue(options)).rejects.toThrow("locked"); await rm(lock, { recursive: true });
    await writeFile(`${options.config}.canonfig-lsops.json.pending`, "recovery");
    await expect(synchronizeCatalogue(options)).rejects.toThrow("Interrupted"); await rm(`${options.config}.canonfig-lsops.json.pending`);
    if (process.platform !== "win32") {
      const link = path.join(options.root, "link.json"); await symlink(options.config, link);
      await expect(synchronizeCatalogue({ ...options, config: link })).rejects.toThrow("regular");
    }
  });
  it("leaves a private recovery journal if state commit fails, then refuses further writes", async () => {
    const options = await fixture(); const before = await readFile(options.config, "utf8");
    let calls = 0;
    await expect(synchronizeCatalogue(options, { replace: async (file, bytes) => {
      calls++; if (calls === 2) throw new Error("Simulated state write failure"); await writeFile(file, bytes);
    } })).rejects.toThrow("Simulated");
    const pending = `${options.config}.canonfig-lsops.json.pending`;
    expect((await load(pending)).before).toBe(before);
    expect((await load(options.config)).tools.alpha).toEqual(tool());
    await expect(synchronizeCatalogue(options)).rejects.toThrow("Interrupted");
    expect(await readdir(options.root)).not.toContain("config.json.canonfig-lsops.json.lock");
  });
  it("does not create state or lose a local edit when config commit refuses", async () => {
    const options = await fixture();
    await expect(synchronizeCatalogue(options, { replace: async () => { throw new Error("Concurrent edit"); } })).rejects.toThrow("Concurrent");
    expect((await load(options.config)).tools.alpha).toBeUndefined();
    expect(await readdir(options.root)).not.toContain("config.json.canonfig-lsops.json");
  });
  it("rejects local settings, approvals, ambiguous names and malicious fields in portable input", () => {
    for (const value of [ { ...cat({}), projects: ["/tmp"] }, cat({ a: { description: "A", path: "/bin/a" } }), cat({ a: { description: "A", hide: true } }), cat({ A: { description: "A" }, a: { description: "a" } }), cat({ a: { description: "A", approved: true } }), cat({ "../a": { description: "A" } }) ]) expect(() => decodeCatalogue(JSON.stringify(value), true)).toThrow();
    expect(() => decodeCatalogue('{"version":1,"tools":{"__proto__":{"description":"evil"}}}', true)).toThrow();
  });
  it.each([
    ["https://npmjs.com/package/@scope/pkg", "pnpm", ""], ["https://pypi.org/project/demo/", "pipx", ""],
    ["https://crates.io/crates/demo", "cargo", ""], ["https://formulae.brew.sh/cask/demo", "brew-cask", ""],
    ["https://github.com/owner/homebrew-tap/blob/main/Formula/demo.rb", "brew", ""],
    ["https://raw.githubusercontent.com/owner/homebrew-tap/main/Casks/demo.rb", "brew-cask", ""],
    ["https://pkg.go.dev/example.com/cmd/demo", "go", ""], ["https://example.com/install.sh", "sh", "a".repeat(64)],
  ])("preserves supported lsops installation identity %s", (url, manager, digest) => {
    const value = cat({ demo: { description: "Demo", install_url: url, install_manager: manager } });
    if (digest) value.tools.demo.install_sha256 = digest;
    expect(decodeCatalogue(JSON.stringify(value), true)).toEqual(value);
  });
  it.each([
    { install_url: "https://example.com/install.sh" }, { install_url: "https://npmjs.com/package/demo", install_manager: "cargo" },
    { install_url: "https://example.com/install.sh", install_manager: "sh" },
    { install_url: "https://user:pass@example.com/install.sh", install_manager: "sh", install_sha256: "a".repeat(64) },
    { install_url: "https://npmjs.com/package/demo?token=secret" },
    { install_url: "https://npmjs.com/package/demo", install_sha256: "a".repeat(64) },
  ])("rejects invalid installation identity %#", (install) => expect(() => decodeCatalogue(JSON.stringify(cat({ demo: { description: "Demo", ...install } })), true)).toThrow());
  it("round-trips local capture and does not change existing approvals", async () => {
    const options = await fixture(); const approvals = `${options.config}.updates.json`; await writeFile(approvals, "private approvals");
    const captured = await captureCatalogue({ ...options, apply: false }); expect(captured.tools).toEqual(["local"]);
    await captureCatalogue(options); expect(await load(options.bundle)).toEqual(captured.catalogue);
    expect(await readFile(approvals, "utf8")).toBe("private approvals");
  });
  it("supports a transport file resource without replacing lsops config", () => {
    expect(() => decodeMachineProfileJsonc(JSON.stringify({ version: 2, id: "workstation", name: "Workstation", resources: [{ id: "lsops-catalogue", kind: "file", policy: "replace-if-unmodified", target: "~/.canonfig/lsops-shared.json", spec: { kind: "file", source: "lsops-shared.json" }, verify: { method: "digest" } }] }))).not.toThrow();
  });
  it("rejects unsafe CLI options and exposes the preview default", () => {
    expect(parseLsopsArguments(["sync", "--config", "c", "--bundle", "b"]).apply).toBe(false);
    for (const args of [["sync"], ["sync", "--config", "c", "--bundle", "b", "--watch"], ["sync", "--config", "c", "--bundle", "b", "--interval", "0"], ["install", "--yes"]]) expect(() => parseLsopsArguments(args)).toThrow();
  });
  it("watches new metadata and stops cleanly on cancellation", async () => {
    const options = await fixture(); const controller = new AbortController(); let writes = 0; const errors: string[] = [];
    await runLsopsCli(["sync", "--config", options.config, "--bundle", options.bundle, "--apply", "--watch", "--interval", "1", "--json"], {
      writeStdout: () => { writes++; if (writes === 1) void put(options.bundle, cat({ alpha: tool("Updated") })); if (writes === 2) controller.abort(); },
      writeStderr: (value) => { errors.push(value); controller.abort(); }, setExitCode: () => undefined,
    }, controller.signal);
    expect(errors).toEqual([]); expect(writes).toBe(2); expect((await load(options.config)).tools.alpha.description).toBe("Updated");
  });
  it("reports conflicts with exit 4 and no partial application", async () => {
    const options = await fixture(); await put(options.config, cat({ alpha: tool("Local") })); let exit = 0;
    await runLsopsCli(["sync", "--config", options.config, "--bundle", options.bundle, "--apply"], { writeStdout: () => undefined, writeStderr: () => undefined, setExitCode: (code) => { exit = code; } });
    expect(exit).toBe(4);
  });
  it("does not mistake inherited Object members for an owned tool", () => {
    expect(planCatalogue(cat({}), cat({ toString: { description: "Utility" } }), {}).added).toEqual(["toString"]);
  });
  it("treats case aliases as conflicts, never merges them", () => {
    expect(planCatalogue(cat({ ALPHA: tool() }), cat({ alpha: tool() }), {}).conflicts).toHaveLength(1);
  });
});
