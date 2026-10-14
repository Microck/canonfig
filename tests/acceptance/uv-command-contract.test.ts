import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const uv = process.env.CANONFIG_TEST_UV ?? "uv";
const probe = spawnSync(uv, ["--version"], {
  encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true,
});
const available = probe.status === 0 && probe.error === undefined;

// Native installer CI must exercise the provider contract, not silently skip it.
describe.runIf(available || process.env.CANONFIG_REQUIRE_UV_TESTS === "1")("native uv compatibility contract", () => {
  it.each([false, true])("rejects a Python upper-bound violation in installed metadata (dependency: %s)", (dependency) => {
    expect(available, "native UV is required").toBe(true);
    const root = mkdtempSync(join(tmpdir(), "canonfig-uv-compat-"));
    const run = (args: ReadonlyArray<string>) => spawnSync(uv, [...args, "--no-config", "--no-python-downloads"], {
      encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true,
    });
    try {
      const found = run(["python", "find"]);
      expect(found.status, found.stderr).toBe(0);
      const python = found.stdout.trim();
      const wheel = spawnSync(python, ["-I", "-c", `
import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
dependency = sys.argv[2] == 'true'
def wheel(name, requires_python, requires_dist=''):
    info = name + '-1.0.dist-info'
    metadata = 'Metadata-Version: 2.1\\nName: ' + name + '\\nVersion: 1.0\\nRequires-Python: ' + requires_python + '\\n'
    if requires_dist:
        metadata += 'Requires-Dist: ' + requires_dist + '\\n'
    with zipfile.ZipFile(root / (name + '-1.0-py3-none-any.whl'), 'w') as archive:
        archive.writestr(info + '/METADATA', metadata)
        archive.writestr(info + '/WHEEL', 'Wheel-Version: 1.0\\nGenerator: canonfig-fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
        archive.writestr(info + '/RECORD', '')
        archive.writestr(name + '.py', 'raise RuntimeError("fixture package code must not run during metadata validation")\\n')
wheel('canonfig_incompatible', '<0')
if dependency:
    wheel('canonfig_parent', '>=0', 'canonfig_incompatible==1.0')
`, root, String(dependency)], { encoding: "utf8", timeout: 10_000, windowsHide: true });
      expect(wheel.status, wheel.stderr).toBe(0);
      const venv = join(root, "venv");
      const created = run(["venv", venv, "--python", python]);
      expect(created.status, created.stderr).toBe(0);
      const venvPython = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
      const installed = run(["pip", "install", "--python", venvPython, "--no-index", "--find-links", root,
        dependency ? "canonfig_parent==1.0" : "canonfig_incompatible==1.0", "--no-build", "--offline"]);
      expect(installed.status, installed.stderr).toBe(0);
      const checked = run(["pip", "check", "--python", venvPython, "--offline"]);
      expect(checked.status).toBe(1);
      expect(checked.stderr).toContain("canonfig-incompatible");
      expect(checked.stderr).toContain("<0");
      expect(checked.stderr).not.toContain("fixture package code must not run");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
