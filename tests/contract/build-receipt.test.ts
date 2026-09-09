import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildReceipt, writeBuildReceipt } from "../../tools/release/build-receipt.ts";

const roots: string[] = [];
const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), "canonfig-build-receipt-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "3.1.5" }));
  writeFileSync(join(root, "src", "main.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "dist", "main.js"), "export const value=1;\n");
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("build receipts", () => {
  it("is deterministic across checkout paths and repeated writes", () => {
    const first = fixture();
    const second = fixture();
    const receipt = writeBuildReceipt(first);
    expect(writeBuildReceipt(first)).toEqual(receipt);
    expect(createBuildReceipt(second)).toEqual(receipt);
    expect(JSON.parse(readFileSync(join(first, "dist", "build-receipt.json"), "utf8"))).toEqual(receipt);
    expect(JSON.stringify(receipt)).not.toContain(first);
    expect(receipt.git).toBeNull();
  });

  it("distinguishes changed source even when the package version is unchanged", () => {
    const root = fixture();
    const before = createBuildReceipt(root);
    writeFileSync(join(root, "src", "main.ts"), "export const value = 2;\n");
    const after = createBuildReceipt(root);
    expect(after.packageVersion).toBe(before.packageVersion);
    expect(after.sourceDigest).not.toBe(before.sourceDigest);
    expect(after.compiledDigest).toBe(before.compiledDigest);
  });

  it("distinguishes changed compiled files and records every module", () => {
    const root = fixture();
    const before = createBuildReceipt(root);
    writeFileSync(join(root, "dist", "other.js"), "export {};\n");
    const after = createBuildReceipt(root);
    expect(after.compiledDigest).not.toBe(before.compiledDigest);
    expect(after.compiledFiles.map((file) => file.path)).toEqual(["dist/main.js", "dist/other.js"]);
  });

  it("requires a compiled CLI", () => {
    const root = fixture();
    rmSync(join(root, "dist"), { recursive: true });
    expect(() => createBuildReceipt(root)).toThrow("before compiling");
  });

  it.skipIf(process.platform === "win32")("rejects symlinked build inputs", () => {
    const root = fixture();
    symlinkSync(join(root, "package.json"), join(root, "src", "external.ts"));
    expect(() => createBuildReceipt(root)).toThrow("symlink");
  });
});
