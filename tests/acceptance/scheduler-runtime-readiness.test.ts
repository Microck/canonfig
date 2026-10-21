import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installedSystemdCommand, installedLaunchdCommand, installedWindowsCommand,
  installedBindingProblem, linuxExecutableHeader, nativeExecutableHeader } from "../../src/machine/installed-scheduler-command.ts";

describe("installed scheduler command decoding", () => {
  it("decodes escaped systemd specifiers and variables without expanding them", () => {
    expect(installedSystemdCommand('ExecStart="/tmp/node %%$" "/tmp/main %%$$.js" "sync"')).toEqual({
      executable: "/tmp/node %$", arguments: ["/tmp/main %$.js", "sync"],
    });
    expect(installedSystemdCommand('Environment="PATH=/tmp/bin:/usr/bin"\nExecStart="/tmp/wrapper" "sync"')?.searchPath).toEqual(["/tmp/bin", "/usr/bin"]);
    expect(installedSystemdCommand('ExecStart="/tmp/node" "$HOME/main.js"')).toBeUndefined();
    expect(installedSystemdCommand('ExecStart=/tmp/node main.js')).toBeUndefined();
    expect(installedSystemdCommand('ExecStart="/tmp/node"\nExecStart="/tmp/other"')).toBeUndefined();
  });
  it("decodes launchd arguments and XML entities", () => {
    expect(installedLaunchdCommand('<key>ProgramArguments</key><array><string>/tmp/node &amp; tools</string><string>/tmp/&quot;main&quot;.js</string><string>sync</string></array>')).toEqual({
      executable: "/tmp/node & tools", arguments: ['/tmp/"main".js', "sync"],
    });
    expect(installedLaunchdCommand('<key>ProgramArguments</key><array><string>/tmp/wrapper</string><string>sync</string></array><key>EnvironmentVariables</key><dict><key>PATH</key><string>/tmp/bin:/usr/bin</string></dict>')?.searchPath).toEqual(["/tmp/bin", "/usr/bin"]);
    expect(installedLaunchdCommand('<key>ProgramArguments</key><array><data>unknown</data></array>')).toBeUndefined();
  });
  it("decodes Windows quoted paths without treating ordinary backslashes as escapes", () => {
    expect(installedWindowsCommand(String.raw`C:\Program Files\node.exe`, String.raw`"C:\App Files\main.js" sync ""`)).toEqual({
      executable: String.raw`C:\Program Files\node.exe`, arguments: [String.raw`C:\App Files\main.js`, "sync", ""],
    });
    expect(installedWindowsCommand("node.exe", '"unterminated')).toBeUndefined();
  });
  it.skipIf(process.platform === "win32").each(["", "-S "])("detects a deleted PATH interpreter behind an env %s wrapper without executing it", async (split) => {
    const root = await mkdtemp(join(tmpdir(), "canonfig-wrapper-readiness-"));
    try {
      const wrapper = join(root, "canonfig");
      const interpreter = join(root, "canonfig-test-node");
      await writeFile(wrapper, `#!/usr/bin/env ${split}canonfig-test-node\nthrow new Error('must not run');\n`, { mode: 0o755 });
      await chmod(wrapper, 0o755);
      await writeFile(interpreter, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await chmod(interpreter, 0o755);
      const command = { executable: wrapper, arguments: ["sync"], searchPath: [root] };
      expect(await installedBindingProblem(command)).toBeUndefined();
      expect(await installedBindingProblem({ executable: wrapper, arguments: ["sync"] })).toContain("cannot be verified");
      await unlink(interpreter);
      expect(await installedBindingProblem(command)).toContain("interpreter");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("matches env PATH fallback without confusing child exits with exec failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "canonfig-path-fallback-"));
    try {
      const first = join(root, "first"), second = join(root, "second");
      await mkdir(first); await mkdir(second);
      const wrapper = join(root, "wrapper");
      const early = join(first, "fixture-runtime");
      const late = join(second, "fixture-runtime");
      const missing = join(root, "missing-interpreter");
      for (const [path, content] of [
        [wrapper, "#!/usr/bin/env fixture-runtime\n"],
        [early, `#!${missing}\n`],
        [late, "#!/bin/sh\nexit 0\n"],
      ]) {
        await writeFile(path!, content!, { mode: 0o755 });
        await chmod(path!, 0o755);
      }
      const command = { executable: wrapper, arguments: [], searchPath: [first, second] };
      const run = () => spawnSync(wrapper, [], { env: { PATH: [first, second].join(":") }, timeout: 5000 });
      expect(run().status).toBe(0);
      expect(await installedBindingProblem(command)).toBeUndefined();
      // This candidate starts env successfully. Its missing child must not
      // cause fallback to the later candidate, unlike a missing kernel interpreter.
      await writeFile(early, `#!/usr/bin/env ${missing}\n`);
      expect(run().status).not.toBe(0);
      expect(await installedBindingProblem(command)).toContain("interpreter");
      await writeFile(early, `#!${missing}\n`);
      await unlink(late);
      expect(run().status).not.toBe(0);
      expect(await installedBindingProblem(command)).toContain("interpreter");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    [1, 1, "ia32", 3], [1, 2, "mips", 8], [2, 1, "x64", 62], [2, 2, "ppc64", 21],
  ] as const)("recognizes native ELF class %i byte order %i without executing it", (elfClass, byteOrder, architecture, machine) => {
    const wide = elfClass === 2, little = byteOrder === 1;
    const headerSize = wide ? 64 : 52, entrySize = wide ? 56 : 32;
    const contents = Buffer.alloc(headerSize + entrySize);
    contents.set([0x7f, 0x45, 0x4c, 0x46, elfClass, byteOrder, 1]);
    const u16 = (value: number, at: number) => little ? contents.writeUInt16LE(value, at) : contents.writeUInt16BE(value, at);
    const u32 = (value: number, at: number) => little ? contents.writeUInt32LE(value, at) : contents.writeUInt32BE(value, at);
    const word = (value: number, at: number) => wide
      ? (little ? contents.writeBigUInt64LE(BigInt(value), at) : contents.writeBigUInt64BE(BigInt(value), at)) : u32(value, at);
    u16(2, 16); u16(machine, 18); u32(1, 20); word(0x1000, 24); word(headerSize, wide ? 32 : 28);
    u16(headerSize, wide ? 52 : 40); u16(entrySize, wide ? 54 : 42); u16(1, wide ? 56 : 44);
    u32(1, headerSize); // PT_LOAD
    u32(5, headerSize + (wide ? 4 : 24)); // PF_R | PF_X
    word(0, headerSize + (wide ? 8 : 4));
    word(0x1000, headerSize + (wide ? 16 : 8));
    word(contents.length, headerSize + (wide ? 32 : 16));
    word(contents.length, headerSize + (wide ? 40 : 20));
    const check = () => linuxExecutableHeader(contents, contents.length, architecture, little ? "LE" : "BE");
    expect(check()).toBe(true);
    expect(linuxExecutableHeader(contents.subarray(0, headerSize), contents.length, architecture, little ? "LE" : "BE")).toBe(false);
    u16(machine + 1, 18); expect(check()).toBe(false); u16(machine, 18);
    u16(3, 16); word(0, 24); expect(check()).toBe(false); // shared object without entry
    word(0x1000, 24); expect(check()).toBe(true); // PIE
    u32(4, headerSize + (wide ? 4 : 24)); expect(check()).toBe(false); // non-executable load
    u32(5, headerSize + (wide ? 4 : 24));
    word(contents.length + 1, headerSize + (wide ? 32 : 16)); expect(check()).toBe(false);
  });

  it("requires a native Mach-O CPU or compatible universal slice", () => {
    const thin = Buffer.alloc(256);
    thin.writeUInt32LE(0xfeedfacf, 0); thin.writeUInt32LE(0x0100000c, 4);
    thin.writeUInt32LE(2, 12); thin.writeUInt32LE(2, 16); thin.writeUInt32LE(96, 20);
    thin.writeUInt32LE(0x19, 32); thin.writeUInt32LE(72, 36);
    thin.writeBigUInt64LE(256n, 64); thin.writeBigUInt64LE(256n, 80); thin.writeUInt32LE(5, 92);
    thin.writeUInt32LE(0x80000028, 104); thin.writeUInt32LE(24, 108); thin.writeBigUInt64LE(128n, 112);
    expect(nativeExecutableHeader(thin, thin.length, "darwin", "arm64")).toBe(true);
    expect(nativeExecutableHeader(thin, thin.length, "darwin", "x64")).toBe(false);
    const fat = Buffer.alloc(512);
    fat.writeUInt32BE(0xcafebabe, 0); fat.writeUInt32BE(1, 4);
    fat.writeUInt32BE(0x0100000c, 8); fat.writeUInt32BE(256, 16); fat.writeUInt32BE(256, 20);
    thin.copy(fat, 256);
    expect(nativeExecutableHeader(fat, fat.length, "darwin", "arm64")).toBe(true);
    expect(nativeExecutableHeader(fat, fat.length, "darwin", "x64")).toBe(false);
    fat.writeUInt32LE(6, 256 + 12); // a dylib is not an executable slice
    expect(nativeExecutableHeader(fat, fat.length, "darwin", "arm64")).toBe(false);
    fat.writeUInt32LE(2, 256 + 12); fat.writeUInt32LE(0, 256 + 36);
    expect(nativeExecutableHeader(fat, fat.length, "darwin", "arm64")).toBe(false);
    fat.fill(0, 256);
    expect(nativeExecutableHeader(fat, fat.length, "darwin", "arm64")).toBe(false);
  });

  it.each([["ia32", 0x14c, 0x10b], ["x64", 0x8664, 0x20b], ["arm64", 0xaa64, 0x20b]] as const)("requires matching PE machine and optional-header class for %s", (architecture, machine, magic) => {
    const pe = Buffer.alloc(512), offset = 128;
    pe.set([0x4d, 0x5a]); pe.writeUInt32LE(offset, 60); pe.writeUInt32LE(0x4550, offset);
    pe.writeUInt16LE(machine, offset + 4); pe.writeUInt16LE(1, offset + 6);
    pe.writeUInt16LE(112, offset + 20); pe.writeUInt16LE(2, offset + 22); pe.writeUInt16LE(magic, offset + 24);
    pe.writeUInt32LE(0x1000, offset + 40); pe.writeUInt32LE(0x2000, offset + 80);
    const section = offset + 24 + 112;
    pe.writeUInt32LE(128, section + 8); pe.writeUInt32LE(0x1000, section + 12);
    pe.writeUInt32LE(128, section + 16); pe.writeUInt32LE(384, section + 20); pe.writeUInt32LE(0x60000020, section + 36);
    expect(nativeExecutableHeader(pe, pe.length, "win32", architecture)).toBe(true);
    expect(nativeExecutableHeader(pe, pe.length, "win32", architecture === "arm64" ? "x64" : "arm64")).toBe(false);
    pe.writeUInt16LE(magic === 0x10b ? 0x20b : 0x10b, offset + 24);
    expect(nativeExecutableHeader(pe, pe.length, "win32", architecture)).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("refuses shebang wrappers for direct Windows scheduler launches", async () => {
    const root = await mkdtemp(join(tmpdir(), "canonfig-windows-shebang-"));
    try {
      const wrapper = join(root, "wrapper");
      await writeFile(wrapper, `#!${process.execPath}\nthrow new Error('must not run');\n`);
      expect(await installedBindingProblem({ executable: wrapper, arguments: [] })).toContain("cannot directly execute a shebang");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects executable text and truncated native headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "canonfig-executable-format-"));
    try {
      const runtime = join(root, "runtime");
      for (const contents of [Buffer.from("not a native executable\n"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(0)]) {
        await writeFile(runtime, contents, { mode: 0o755 });
        await chmod(runtime, 0o755);
        expect(await installedBindingProblem({ executable: runtime, arguments: [] })).toContain("format");
      }
      expect(await installedBindingProblem({ executable: process.execPath, arguments: [import.meta.filename] })).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not claim unknown commands are available", async () => {
    expect(await installedBindingProblem(undefined)).toContain("cannot be verified");
    expect(await installedBindingProblem({ executable: "node", arguments: [] })).toContain("cannot be verified");
  });
});
