import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { macosMachineStateLayer } from "../../src/machine/macos.layer.ts";
import { windowsMachineStateLayer } from "../../src/machine/windows.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import { packageManagerProbe } from "../../src/runtime/doctor.ts";
import { removeInstallerBinding, saveInstallerBinding } from "../../src/synchronization/installer-bindings.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "canonfig-doctor-installers-")); roots.push(home);
  const bin = join(home, "bin"); mkdirSync(bin);
  const entry = join(home, "npm-cli.js"); writeFileSync(entry, "console.log('1.0.0-fixture');");
  const environment = Object.entries({ ...process.env, HOME: home, USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), PATH: bin,
  }).flatMap(([name, value]) => value === undefined || (name.toLowerCase() === "path" && name !== "PATH") ? [] : [{ name, value }]);
  const options = { environment, credentialPolicy: { kind: "local-file" as const, path: join(home, "credentials") } };
  const layer = process.platform === "win32" ? windowsMachineStateLayer(options)
    : process.platform === "darwin" ? macosMachineStateLayer(options) : linuxMachineStateLayer(options);
  const probe = () => Effect.runPromise(Effect.flatMap(MachineState, packageManagerProbe).pipe(Effect.provide(layer)));
  return { home, bin, entry, layer, probe };
};

it("uses an explicit npm binding without PATH and stops reporting removed or broken bindings", async () => {
  const f = fixture();
  expect((await f.probe()).status).toBe("fail");
  await Effect.runPromise(saveInstallerBinding("npm", process.execPath, [f.entry]).pipe(Effect.provide(f.layer)));
  expect(await f.probe()).toMatchObject({ status: "pass", details: { available: "npm" } });
  rmSync(f.entry);
  expect((await f.probe()).status).toBe("fail");
  writeFileSync(f.entry, "console.log('1.0.0-fixture');");
  await Effect.runPromise(removeInstallerBinding("npm").pipe(Effect.provide(f.layer)));
  expect((await f.probe()).status).toBe("fail");
});

it.skipIf(process.platform === "win32")("recognizes uv-only PATH, excludes yarn, and honors removal over PATH", async () => {
  const f = fixture();
  for (const name of ["yarn", "uv", "npm"]) {
    writeFileSync(join(f.bin, name), "#!/bin/sh\nexit 0\n"); chmodSync(join(f.bin, name), 0o755);
  }
  await Effect.runPromise(saveInstallerBinding("npm", process.execPath, [f.entry]).pipe(Effect.provide(f.layer)));
  await Effect.runPromise(removeInstallerBinding("npm").pipe(Effect.provide(f.layer)));
  expect(await f.probe()).toMatchObject({ status: "pass", details: { available: "uv" } });
  rmSync(join(f.bin, "uv"));
  expect((await f.probe()).status).toBe("fail");
});
