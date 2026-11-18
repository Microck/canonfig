import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { GuiArchiveDownload, GuiArchiveImportResult, GuiBackups, GuiLocalItems, GuiOperation, GuiOperationTicket, GuiScheduleStatus, GuiSyncApplyRequest } from "../../src/gui/contract.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { macosMachineStateLayer } from "../../src/machine/macos.layer.ts";
import { windowsMachineStateLayer } from "../../src/machine/windows.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import { synchronizeLocal } from "../../src/projection/sync.ts";
import { stateRepositoryLayer } from "../../src/state/state-repository.layer.ts";
import { SynchronizationLive } from "../../src/synchronization/synchronization.layer.ts";

const project = resolve(import.meta.dirname, "../..");
const children = new Set<ChildProcess>();
const homes: string[] = [];
const write = (path: string, contents: string, mode = 0o600) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents, { mode }); };

function fixture(label: string, built = false) {
  const home = mkdtempSync(join(tmpdir(), `canonfig-gui-sync-${label}-`));
  homes.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin);
  const env: NodeJS.ProcessEnv = {
    HOME: home, USERPROFILE: home, PATH: bin, TMPDIR: tmpdir(), NODE_NO_WARNINGS: "1",
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"), CANONFIG_LOCAL_CREDENTIAL_ROOT: join(home, "credentials"), CANONFIG_LOG: "off",
  };
  // Native jobs bind main.js, so scheduler tests must run the built installation.
  const runtime = built ? ["dist/runtime/main.js"] : ["--import", "tsx", "src/runtime/main.ts"];
  const invoke = (args: string[], input?: string) => spawnSync(process.execPath, [...runtime, ...args, "--json"], { cwd: project, env, input, encoding: "utf8", timeout: 120_000 });
  return { home, folder: join(home, ".canonfig"), bin, env, runtime, invoke };
}

type Fixture = ReturnType<typeof fixture>;
const success = (result: ReturnType<Fixture["invoke"]>) => { expect(result.status, result.stdout + result.stderr).toBe(0); return result; };


/** Same marker-file user-manager seam as schedule-manager.test.ts, never the host's systemd. */
function scheduleHost(machine: Fixture) {
  const systemctl = join(machine.bin, "systemctl");
  const loginctl = join(machine.bin, "loginctl");
  const active = join(machine.home, "timer-active");
  const calls = join(machine.home, "scheduler-calls");
  const timer = join(machine.home, ".config/systemd/user/canonfig-sync.timer");
  write(systemctl, `#!/bin/sh
echo "$*" >> '${calls}'
case "$2" in
  show)
    state=inactive; enabled=disabled
    if test -f '${active}'; then state=active; enabled=enabled; fi
    calendar=
    while IFS= read -r line; do
      case "$line" in OnCalendar=*) calendar="\${line#OnCalendar=}";; esac
    done < '${timer}'
    printf 'Id=canonfig-sync.timer\\nLoadState=loaded\\nActiveState=%s\\nUnitFileState=%s\\nDropInPaths=\\nTimersCalendar={ OnCalendar=%s ; next_elapse=n/a }\\n\\nId=canonfig-sync.service\\nLoadState=loaded\\nActiveState=inactive\\nResult=success\\nExecMainStatus=0\\n' "$state" "$enabled" "$calendar"
    ;;
  enable|start) : > '${active}' ;;
  disable|stop) /bin/rm -f '${active}' ;;
esac
exit 0
`, 0o755);
  write(loginctl, "#!/bin/sh\nprintf 'Linger=yes\\n'\n", 0o755);
  machine.env.CANONFIG_SYSTEMCTL = systemctl;
  machine.env.CANONFIG_LOGINCTL = loginctl;
  machine.env.TZ = "Pacific/Honolulu";
  return { timer, calls };
}
/** Hold real projection preparation at its filesystem boundary, then interrupt only this fixture's fiber. */
async function interruptLocalPreparation(machine: Fixture) {
  const nativeLayer = process.platform === "win32" ? windowsMachineStateLayer : process.platform === "darwin" ? macosMachineStateLayer : linuxMachineStateLayer;
  const original = nativeLayer({
    environment: Object.entries(machine.env).flatMap(([name, value]) => value === undefined ? [] : [{ name, value }]),
    credentialPolicy: { kind: "local-file", path: join(machine.home, "credentials") },
  });
  const captured = Effect.runSync(Deferred.make<void>());
  const paused = Layer.effect(MachineState, Effect.gen(function*() {
    const service = yield* MachineState;
    return MachineState.of({
      ...service,
      ensureDirectory: (input) => input.path.absolute.replaceAll("\\", "/").includes("/canonfig/projection/")
        ? Deferred.succeed(captured, undefined).pipe(Effect.andThen(Effect.never))
        : service.ensureDirectory(input),
    });
  })).pipe(Layer.provide(original));
  const layer = SynchronizationLive.pipe(
    Layer.provideMerge(stateRepositoryLayer(join(machine.folder, "state.sqlite"))),
    Layer.provideMerge(paused),
  );
  const fiber = Effect.runFork(synchronizeLocal(join(machine.folder, "state.sqlite"), "apply", {
    noBackup: false, environment: (name) => machine.env[name],
  }).pipe(Effect.provide(layer)));
  try {
    await Effect.runPromise(Deferred.await(captured).pipe(Effect.timeout("10 seconds")));
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber));
  }
}
async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || Schema.is(Schema.String)(address)) throw new Error("No listening address");
  const { promise, resolve: closed, reject } = Promise.withResolvers<void>();
  server.close((error) => error ? reject(error) : closed());
  await promise;
  return address.port;
}

async function launch(machine: Fixture, args: string[], ready: RegExp) {
  const child = spawn(process.execPath, [...machine.runtime, ...args], { cwd: project, env: machine.env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const { promise, resolve: resolveReady, reject } = Promise.withResolvers<string>();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); const match = stdout.match(ready); if (match) resolveReady(match[0]); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.once("error", reject);
  child.once("exit", (code) => reject(new Error(`Child exited ${code}: ${stderr}`)));
  const timer = setTimeout(() => reject(new Error(`Startup timeout: ${stderr}`)), 60_000);
  try { return { child, ready: await promise, stderrTail: () => stderr.slice(-4096) }; } finally { clearTimeout(timer); }
}

async function gui(machine: Fixture) {
  const launched = await launch(machine, ["ui", "--no-open"], /http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/u);
  const origin = new URL(launched.ready).origin;
  const exchange = await fetch(launched.ready, { redirect: "manual" });
  const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("GUI did not establish a session");
  const call = async (path: string, method = "GET", body?: Schema.Json) => {
    const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "x-canonfig-request": "browser" };
    let requestBody: string | undefined;
    if (method !== "GET") requestBody = Schema.is(Schema.String)(body) ? body : JSON.stringify(body ?? {});
    try {
      return await new Promise<{ status: number | undefined; payload: unknown }>((resolve, reject) => {
        // Keep uploads and operation polls independent of idle pooled sockets.
        const request = httpRequest(origin + path, { method, headers, agent: false }, (response) => {
          let responseText = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => { responseText += chunk; });
          response.once("error", reject);
          response.once("end", () => {
            try {
              const payload: unknown = JSON.parse(responseText);
              resolve({ status: response.statusCode, payload });
            } catch (cause) { reject(cause); }
          });
        });
        request.once("error", reject);
        // DELETE bodies need explicit framing with node:http.
        if (requestBody !== undefined) request.setHeader("Content-Length", Buffer.byteLength(requestBody));
        request.end(requestBody);
      });
    } catch (cause) {
      throw new Error(`GUI ${method} ${path} failed (exitCode=${launched.child.exitCode}, signal=${launched.child.signalCode}).\n${launched.stderrTail()}`, { cause });
    }
  };
  const operation = async (path: string, body: Schema.Json = {}) => {
    const started = await call(path, "POST", body);
    expect(started.status).toBe(202);
    const ticket = Schema.decodeUnknownSync(GuiOperationTicket)(started.payload);
    let polled = Schema.decodeUnknownSync(GuiOperation)((await call(`/api/operations/${ticket.id}`)).payload);
    const deadline = Date.now() + 60_000;
    while (polled.state === "running") {
      if (Date.now() > deadline) throw new Error("Operation did not finish");
      // This polls a separate CLI process over HTTP, not an in-process timer under TestClock.
      const { promise, resolve: tick } = Promise.withResolvers<void>();
      setTimeout(tick, 20);
      await promise;
      polled = Schema.decodeUnknownSync(GuiOperation)((await call(`/api/operations/${ticket.id}`)).payload);
    }
    return polled;
  };
  return { call, operation };
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill("SIGTERM"); await closed;
    }
  }
  children.clear();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

it("serves real role-gated secrets and a verified Source archive without leaking secret input", async () => {
  const machine = fixture("source");
  success(machine.invoke(["source", "init"]));
  write(join(machine.folder, "canonfig.jsonc"), JSON.stringify({ version: 1, profile: { id: "gui-test", name: "GUI test" }, harnesses: [] }));
  write(join(machine.folder, "AGENTS.md"), "Source instructions\n");
  const api = await gui(machine);
  const marker = "private-value-do-not-echo";
  for (const body of [JSON.stringify({ name: "test", value: { private: marker } }), `{"name":"test","value":"${marker}",bad}`]) {
    const failed = await api.call("/api/secrets", "PUT", body);
    expect(failed.payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
    expect(JSON.stringify(failed.payload)).not.toContain(marker);
  }
  const storageFailure = await api.call("/api/secrets", "PUT", { name: "test", value: marker });
  expect(storageFailure.payload).toMatchObject({ category: "human-action-required", exitCode: 3 });
  expect(JSON.stringify(storageFailure.payload)).not.toContain(marker);
  expect((await api.call("/api/secrets")).payload).toMatchObject({ secrets: [] });
  expect((await api.call("/api/secrets", "DELETE", { name: "test" })).payload).toEqual({ name: "test", removed: false });
  expect((await api.call("/api/secrets", "DELETE", { name: "../invalid" })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  for (const [path, method, body] of [
    ["/api/secrets/sync", "POST", {}],
    ["/api/schedule", "GET", undefined], ["/api/schedule", "PUT", { profileDefault: true }],
    ["/api/schedule", "DELETE", {}],

    ["/api/tunnel", "GET", undefined], ["/api/tunnel/start", "POST", {}], ["/api/tunnel/stop", "POST", { forget: false }], ["/api/enrollment", "DELETE", {}],
  ] as const) expect((await api.call(path, method, body)).payload, path).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  const unconfigured = await gui(fixture("unconfigured"));
  expect((await unconfigured.call("/api/schedule", "DELETE", {})).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  const exported = await api.call("/api/exports", "POST", { includeHarnesses: false });
  expect(exported.status).toBe(200);
  const archive = Schema.decodeUnknownSync(GuiArchiveDownload)(exported.payload);
  expect(createHash("sha256").update(Buffer.from(archive.base64, "base64")).digest("hex")).toBe(archive.sha256);
  expect(archive.signer).not.toBe("unsigned");
  const path = join(machine.home, "download.tar.gz");
  writeFileSync(path, Buffer.from(archive.base64, "base64"));
  success(machine.invoke(["import", path, "--dry-run", "--replace"]));
}, 180_000);

it("round trips a signed archive through GUI preview/import with signer checks, replacement snapshots and private upload cleanup", async () => {
  const source = fixture("archive-source");
  success(source.invoke(["source", "init"]));
  write(join(source.folder, "canonfig.jsonc"), JSON.stringify({ version: 1, profile: { id: "archive-roundtrip", name: "Archive round trip" }, harnesses: [] }));
  write(join(source.folder, "AGENTS.md"), "Round trip instructions\n");
  write(join(source.folder, "skills", "sample", "SKILL.md"), "# Sample\n");
  const asset = randomBytes(1024 * 1024 + 64);
  writeFileSync(join(source.folder, "skills", "sample", "asset.bin"), asset);
  const sourceApi = await gui(source);
  const exported = Schema.decodeUnknownSync(GuiArchiveDownload)((await sourceApi.call("/api/exports", "POST", { includeHarnesses: true })).payload);
  const target = fixture("archive-target");
  const privateTmp = join(target.home, "tmp");
  mkdirSync(privateTmp);
  target.env.TMPDIR = privateTmp;
  const api = await gui(target);
  const input = { base64: exported.base64, replace: false, expectKey: exported.signer };
  const mismatch = await api.operation("/api/imports/preview", { ...input, expectKey: "0".repeat(64) });
  expect(mismatch.state).toBe("failed");
  if (mismatch.state === "failed") expect(mismatch.failure.message).toContain("--expect-key");
  expect(existsSync(join(target.folder, "canonfig.jsonc"))).toBe(false);
  expect(readdirSync(privateTmp).filter((entry) => entry.startsWith("canonfig-gui-archive-"))).toEqual([]);
  expect((await api.call("/api/imports/preview", "POST", { ...input, expectKey: "invalid" })).status).toBe(400);
  const privateMarker = "private-archive-input-do-not-echo";
  for (const path of ["/api/imports/preview", "/api/imports"]) {
    const rejected = await api.call(path, "POST", { base64: privateMarker, replace: false });
    expect(rejected.status).toBe(400);
    expect(JSON.stringify(rejected.payload)).not.toContain(privateMarker);
  }
  const preview = await api.operation("/api/imports/preview", input);
  expect(preview.state).toBe("succeeded");
  if (preview.state !== "succeeded") throw new Error("Archive preview failed");
  const plan = Schema.decodeUnknownSync(GuiArchiveImportResult)(preview.result);
  expect(plan).toMatchObject({ sha256: exported.sha256, signer: exported.signer, folderFiles: 4, replaced: [] });
  expect(existsSync(join(target.folder, "AGENTS.md"))).toBe(false);
  expect((await api.operation("/api/imports", { ...input, sha256: "0".repeat(64) })).state).toBe("failed");
  const imported = await api.operation("/api/imports", { ...input, sha256: plan.sha256 });
  expect(imported.state).toBe("succeeded");
  expect(readFileSync(join(target.folder, "AGENTS.md"), "utf8")).toBe("Round trip instructions\n");
  expect(readFileSync(join(target.folder, "skills", "sample", "SKILL.md"), "utf8")).toBe("# Sample\n");
  expect(readFileSync(join(target.folder, "skills", "sample", "asset.bin"))).toEqual(asset);
  expect((await api.call("/api/session")).payload).toMatchObject({ role: "unconfigured" });
  expect(readdirSync(privateTmp).filter((entry) => entry.startsWith("canonfig-gui-archive-"))).toEqual([]);
  const conflict = await api.operation("/api/imports/preview", input);
  expect(conflict.state).toBe("failed");
  if (conflict.state === "failed") expect(conflict.failure.category).toBe("conflict-or-drift");
  write(join(target.folder, "AGENTS.md"), "Keep this in a snapshot\n");
  write(join(target.folder, "rules", "untouched.md"), "Not in archive\n");
  const replace = { ...input, replace: true };
  expect((await api.operation("/api/imports/preview", replace)).state).toBe("succeeded");
  const replaced = await api.operation("/api/imports", { ...replace, sha256: plan.sha256 });
  expect(replaced.state).toBe("succeeded");
  if (replaced.state !== "succeeded") throw new Error("Replacement failed");
  const receipt = Schema.decodeUnknownSync(GuiArchiveImportResult)(replaced.result);
  expect(receipt.replaced).toContain("AGENTS.md");
  expect(receipt.kept).toContain("rules");
  expect(receipt.backup).toBeTruthy();
  expect(readFileSync(join(target.folder, "rules", "untouched.md"), "utf8")).toBe("Not in archive\n");
  if (!receipt.backup) throw new Error("Replacement did not report its snapshot");
  success(target.invoke(["restore", receipt.backup]));
  expect(readFileSync(join(target.folder, "AGENTS.md"), "utf8")).toBe("Keep this in a snapshot\n");
  expect(readdirSync(privateTmp).filter((entry) => entry.startsWith("canonfig-gui-archive-"))).toEqual([]);
  const unsignedPath = join(target.home, "unsigned.tar.gz");
  success(target.invoke(["export", "--output", unsignedPath]));
  const unsigned = { base64: readFileSync(unsignedPath).toString("base64") };
  const unsignedRefused = await sourceApi.operation("/api/imports/preview", { base64: unsigned.base64, replace: true, expectKey: exported.signer });
  expect(unsignedRefused.state).toBe("failed");
  if (unsignedRefused.state === "failed") expect(unsignedRefused.failure.message).toContain("unsigned");
  expect((await sourceApi.operation("/api/imports/preview", { base64: unsigned.base64, replace: true })).state).toBe("succeeded");
}, 300_000);

it("keeps Source harness exclusions, item overlays and key claims machine-local without applying files", async () => {
  const machine = fixture("source-local");
  success(machine.invoke(["source", "init"]));
  const canonical = JSON.stringify({
    version: 1, profile: { id: "source-local", name: "Source local" }, harnesses: ["codex"],
    local: { allow: ["rules", "settings"] }, settings: { codex: { model: "published-model" } },
  });
  write(join(machine.folder, "canonfig.jsonc"), canonical);
  write(join(machine.folder, "rules/test.md"), "Canonical rule\n");
  write(join(machine.folder, "local/rules/test.md"), "Machine-local rule\n");
  write(join(machine.home, ".codex/config.toml"), 'model = "native-model"\n');
  const api = await gui(machine);
  for (const harness of ["codex", "claude-code"]) {
    const excluded = await api.call("/api/harnesses", "PUT", { harness, action: "exclude" });
    expect(excluded.status, JSON.stringify(excluded.payload)).toBe(200);
    expect(excluded.payload).toMatchObject({ excluded: expect.arrayContaining([harness]) });
    const included = await api.call("/api/harnesses", "PUT", { harness, action: "include" });
    expect(included.status).toBe(200);
    if (harness === "claude-code") expect(included.payload).toMatchObject({ warnings: [expect.stringContaining("not listed")] });
    expect(JSON.parse(readFileSync(join(machine.folder, "local/local.jsonc"), "utf8")).excludeHarnesses).not.toContain(harness);
  }
  expect((await api.call("/api/local/overlays", "PUT", { item: "rules/test" })).status).toBe(200);
  expect((await api.call("/api/local/overlays")).payload).toMatchObject({ overlays: [{ item: "rules/test", local: true, published: true }] });
  for (const item of ["settings/codex", "settings/codex#model"]) {
    expect((await api.call("/api/local/overlays", "PUT", { item })).status).toBe(200);
    expect((await api.call("/api/local/items")).payload).toMatchObject({ config: { overlays: ["rules/test", item] } });
    expect((await api.call("/api/local/overlays")).status).toBe(200);
    // A claim changes ownership metadata, not the native value.
    expect(readFileSync(join(machine.home, ".codex/config.toml"), "utf8")).toBe('model = "native-model"\n');
    expect((await api.call("/api/local/overlays", "DELETE", { item })).status).toBe(200);
    expect((await api.call("/api/local/items")).payload).toMatchObject({ config: { overlays: ["rules/test"] } });
  }
  for (const method of ["PUT", "DELETE"]) expect((await api.call("/api/local/overlays", method, { item: "instructions" })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api.call("/api/local/overlays", "PUT", { item: "settings/hermes#model" })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  const local = Schema.decodeUnknownSync(GuiLocalItems)((await api.call("/api/local/items")).payload);
  const preferences = await api.call("/api/local/preferences", "PUT", {
    expectedDigest: local.items.find((item) => item.path === "local.jsonc")!.digest,
    edits: [{ path: ["settings", "codex", "theme"], value: "local-theme" }],
  });
  expect(preferences.status).toBe(200);
  expect(preferences.payload).toMatchObject({ config: { settings: { codex: { theme: "local-theme" } } } });
  expect((await api.call("/api/local/overlays", "DELETE", { item: "rules/test" })).status).toBe(200);
  expect((await api.call("/api/local/overlays")).payload).toMatchObject({ category: "human-action-required", exitCode: 3 });
  expect(readFileSync(join(machine.folder, "canonfig.jsonc"), "utf8")).toBe(canonical);
  expect(readFileSync(join(machine.folder, "local/rules/test.md"), "utf8")).toBe("Machine-local rule\n");
  expect(readFileSync(join(machine.home, ".codex/config.toml"), "utf8")).toBe('model = "native-model"\n');
}, 180_000);

it("plans and applies an enrolled follower and performs digest-checked local operations", async () => {
  const source = fixture("source");
  success(source.invoke(["source", "init"]));
  write(join(source.folder, "canonfig.jsonc"), JSON.stringify({ version: 1, profile: { id: "gui-test", name: "GUI test" }, harnesses: ["codex"], local: { allow: ["instructions", "rules", "skills", "agents", "mcp", "settings"] } }));
  write(join(source.folder, "AGENTS.md"), "Source instructions\n");
  success(source.invoke(["source", "publish", "--reviewer", "gui-test"]));
  const port = await unusedPort();
  await launch(source, ["source", "serve", "--host", "127.0.0.1", "--port", String(port), "--json"], /"endpoint":"https:\/\/127\.0\.0\.1:\d+"/u);
  const follower = fixture("follower", process.platform === "linux");
  const scheduler = process.platform === "linux" ? scheduleHost(follower) : null;
  write(join(follower.bin, "codex"), "", 0o755);
  const invitation = join(source.home, "invitation");
  success(source.invoke(["source", "invite", "--endpoint", `https://127.0.0.1:${port}`, "--output", invitation]));
  success(follower.invoke(["follower", "enroll", "--stdin", "--name", "GUI follower"], readFileSync(invitation, "utf8")));
  const api = await gui(follower);
  expect((await api.call("/api/guard")).payload).toMatchObject({ mode: "static", latest: null });
  expect((await api.call("/api/guard", "PUT", { policy: { version: 1 }, digest: "fixture", consent: true })).payload)
    .toMatchObject({ exitCode: 2 });
  for (const path of ["/api/imports/preview", "/api/imports"]) {
    expect((await api.call(path, "POST", { base64: "YWJj", replace: true, ...(path === "/api/imports" ? { sha256: createHash("sha256").update("abc").digest("hex") } : {}) })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  }
  for (const path of [
    "/api/sync/plan", "/api/sync/apply", "/api/sync/reviews", "/api/recovery",
    "/api/recovery/abandon", "/api/secrets/sync", "/api/tunnel/start", "/api/tunnel/stop", "/api/enrollment", "/api/schedule",
  ]) {
    const refused = await api.call(path, path === "/api/enrollment" || path === "/api/schedule" ? "DELETE" : "POST", { unexpected: true });
    expect(refused.payload, path).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  }
  const plan = await api.operation("/api/sync/plan");
  expect(plan.state).toBe("succeeded");
  const applied = await api.operation("/api/sync/apply", Schema.decodeUnknownSync(GuiSyncApplyRequest)(plan.result));
  expect(applied.state, JSON.stringify(applied)).toBe("succeeded");
  expect(applied.journal).toMatchObject({ evidence: { outcome: "Converged" } });
  expect(readFileSync(join(follower.home, ".codex/AGENTS.md"), "utf8")).toContain("Source instructions");
  expect((await api.operation("/api/sync/reviews")).state).toBe("succeeded");
  for (const path of ["/api/recovery", "/api/recovery/abandon"]) {
    const failed = await api.operation(path);
    expect(failed.state).toBe("failed");
    expect(failed.failure).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  }
  const localInstructions = `Local instructions\n${"a".repeat(1024 * 1024)}`;
  const change = { path: "AGENTS.md", expectedDigest: null, files: [{ path: "AGENTS.md", base64: Buffer.from(localInstructions).toString("base64"), executable: false }] };
  const created = await api.call("/api/local/items", "PUT", { changes: [change] });
  expect(created.status).toBe(200);
  const items = Schema.decodeUnknownSync(GuiLocalItems)(created.payload).items;
  expect(created.payload).toMatchObject({
    config: {},
    canonicalConfig: { local: { allow: ["instructions", "rules", "skills", "agents", "mcp", "settings"] } },
  });
  const item = items.find((value) => value.path === "AGENTS.md");
  expect(item?.digest).toBeTypeOf("string");
  expect((await api.call("/api/local/items", "PUT", { changes: [change] })).payload).toMatchObject({ category: "conflict-or-drift", exitCode: 4 });
  expect(readFileSync(join(follower.folder, "local/AGENTS.md"), "utf8")).toBe(localInstructions);
  expect((await api.call("/api/local/items", "PUT", { changes: [{ ...change, path: "../escape" }] })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api.call("/api/local/items", "PUT", { changes: [{
    ...change, files: [{ ...change.files[0], base64: "invalid base64!" }],
  }] })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api.call("/api/local/items", "PUT", { changes: [{
    path: "commands/blocked.md", expectedDigest: null,
    files: [{ path: "commands/blocked.md", base64: Buffer.from("Not allowed\n").toString("base64"), executable: false }],
  }] })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api.call("/api/local/items", "PUT", { changes: [{ ...change, expectedDigest: item?.digest, files: [] }] })).status).toBe(200);
  const rule = { path: "rules/first.md", expectedDigest: null, files: [{ path: "rules/first.md", base64: Buffer.from("First\n").toString("base64"), executable: false }] };
  const ruleCreated = Schema.decodeUnknownSync(GuiLocalItems)((await api.call("/api/local/items", "PUT", { changes: [rule] })).payload).items.find((entry) => entry.path === rule.path);
  const ruleEdited = Schema.decodeUnknownSync(GuiLocalItems)((await api.call("/api/local/items", "PUT", { changes: [{
    ...rule, expectedDigest: ruleCreated?.digest, files: [{ ...rule.files[0], base64: Buffer.from("Edited\n").toString("base64") }],
  }] })).payload).items.find((entry) => entry.path === rule.path);
  expect(readFileSync(join(follower.folder, "local/rules/first.md"), "utf8")).toBe("Edited\n");
  const renamed = await api.call("/api/local/items", "PUT", { changes: [
    { path: "rules/renamed.md", expectedDigest: null, files: [{ path: "rules/renamed.md", base64: Buffer.from("Edited\n").toString("base64"), executable: false }] },
    { path: rule.path, expectedDigest: ruleEdited?.digest, files: [] },
  ] });
  expect(renamed.status).toBe(200);
  const renamedRule = Schema.decodeUnknownSync(GuiLocalItems)(renamed.payload).items.find((entry) => entry.path === "rules/renamed.md");
  expect((await api.call("/api/local/items", "PUT", { changes: [{ path: "rules/renamed.md", expectedDigest: renamedRule?.digest, files: [] }] })).status).toBe(200);
  const skillFiles = [
    { path: "skills/binary/SKILL.md", base64: Buffer.from("---\nname: binary\ndescription: Test binary assets\n---\nInstructions\n").toString("base64"), executable: false },
    { path: "skills/binary/data.bin", base64: Buffer.from([0, 255, 128, 239, 187, 191]).toString("base64"), executable: true },
  ];
  const skill = await api.call("/api/local/items", "PUT", { changes: [{ path: "skills/binary", expectedDigest: null, files: skillFiles }] });
  expect(skill.status).toBe(200);
  const skillItem = Schema.decodeUnknownSync(GuiLocalItems)(skill.payload).items.find((entry) => entry.path === "skills/binary");
  expect(skillItem?.files.find((file) => file.path.endsWith("data.bin"))).toMatchObject(skillFiles[1]!);
  expect((await api.call("/api/local/items", "PUT", { changes: [{ path: "skills/binary", expectedDigest: skillItem?.digest, files: [] }] })).status).toBe(200);
  const getConfig = async () => Schema.decodeUnknownSync(GuiLocalItems)((await api.call("/api/local/items")).payload).items.find((entry) => entry.path === "local.jsonc");
  const config = await getConfig();
  const preference = { expectedDigest: config?.digest ?? null, edits: [{ path: ["backups"], value: false }] };
  expect((await api.call("/api/local/preferences", "PUT", preference)).status).toBe(200);
  expect((await api.call("/api/local/items")).payload).toMatchObject({ config: { backups: false } });
  expect((await api.call("/api/local/preferences", "PUT", preference)).payload).toMatchObject({ category: "conflict-or-drift", exitCode: 4 });
  const preservation = { expectedDigest: (await getConfig())?.digest ?? null, edits: [{ path: ["preserveMcp"], value: true }] };
  expect((await api.call("/api/local/preferences", "PUT", preservation)).status).toBe(200);
  expect((await api.call("/api/local/items")).payload).toMatchObject({ config: { preserveMcp: true } });
  expect((await api.call("/api/local/preferences", "PUT", preservation)).payload).toMatchObject({ category: "conflict-or-drift", exitCode: 4 });
  const deniedSkill = await api.call("/api/local/preferences", "PUT", {
    expectedDigest: (await getConfig())?.digest ?? null, edits: [{ path: ["excludeSkills"], value: ["deploy"] }],
  });
  expect(deniedSkill.payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect(JSON.stringify(deniedSkill.payload)).toContain("local.appendLocal");
  const beforeInvalidOverlay = readFileSync(join(follower.folder, "local/local.jsonc"), "utf8");
  for (const method of ["PUT", "DELETE"]) {
    const refused = await api.call("/api/local/overlays", method, { item: "instructions" });
    expect(refused.payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
    expect(readFileSync(join(follower.folder, "local/local.jsonc"), "utf8")).toBe(beforeInvalidOverlay);
  }
  expect((await api.call("/api/local/overlays", "PUT", { item: "settings/codex#model" })).status).toBe(200);
  expect((await api.call("/api/local/overlays")).status).toBe(200);
  expect((await api.call("/api/local/overlays", "DELETE", { item: "settings/codex#model" })).status).toBe(200);
  expect((await api.call("/api/local/overlays", "PUT", { item: "settings/hermes#model" })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  for (const action of ["exclude", "include"]) expect((await api.call("/api/harnesses", "PUT", { harness: "codex", action })).status).toBe(200);
  expect((await api.call("/api/harnesses")).status).toBe(200);
  expect((await api.call("/api/harnesses", "PUT", { harness: "unknown", action: "include" })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api.call("/api/schedule")).status).toBe(200);
  expect((await api.call("/api/schedule", "PUT", { schedule: { kind: "daily", localTime: "99:99" } })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  const noDefault = await api.call("/api/schedule", "PUT", { profileDefault: true });
  expect(noDefault.payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  expect((await api.call("/api/schedule", "PUT", { schedule: { kind: "daily", localTime: "09:00", timezone: "Mars/Olympus" } })).payload).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  if (scheduler) {
    const selected = { kind: "weekly", localTime: "12:30", weekdays: ["Mon"], timezone: "europe/paris" };
    const saved = await api.call("/api/schedule", "PUT", { schedule: selected });
    expect(saved.status, JSON.stringify(saved.payload)).toBe(200);
    const status = Schema.decodeUnknownSync(GuiScheduleStatus)((await api.call("/api/schedule")).payload);
    expect(status).toMatchObject({
      machineTimezone: "Pacific/Honolulu", timezone: "Europe/Paris",
      schedule: { ...selected, timezone: "Europe/Paris" }, state: "current",
    });
    expect(readFileSync(scheduler.timer, "utf8")).toContain("Europe/Paris");
    expect((await api.call("/api/schedule", "DELETE", {})).payload).toEqual({ change: "removed" });
    expect(existsSync(scheduler.timer)).toBe(false);
    expect(readFileSync(scheduler.calls, "utf8")).toContain("--user disable --now canonfig-sync.timer");
    expect((await api.call("/api/schedule")).payload).toMatchObject({ state: "not-selected", machineTimezone: "Pacific/Honolulu" });
    expect((await api.call("/api/schedule", "DELETE", {})).payload).toEqual({ change: "unchanged" });
    // The CLI sees the same disabled decision, and applying cannot recreate the removed job.
    expect(JSON.parse(success(follower.invoke(["schedule", "status"])).stdout).data.state).toBe("not-selected");
    const replan = await api.operation("/api/sync/plan");
    expect((await api.operation("/api/sync/apply", Schema.decodeUnknownSync(GuiSyncApplyRequest)(replan.result))).state).toBe("succeeded");
    expect(existsSync(scheduler.timer)).toBe(false);
  }
  expect((await api.call("/api/tunnel")).status).toBe(200);
  expect(await api.operation("/api/tunnel/start")).toMatchObject({ state: "failed", failure: { category: "usage-or-configuration", exitCode: 2 } });
  expect((await api.call("/api/tunnel/stop", "POST", { forget: false })).status).toBe(200);
  expect((await api.call("/api/secrets")).status).toBe(200);
  expect((await api.call("/api/secrets/sync", "POST", {})).status).toBe(200);
  expect((await api.call("/api/secrets", "PUT", { name: "no", value: "private" })).payload).toMatchObject({ category: "human-action-required", exitCode: 3 });
  expect((await api.call("/api/secrets", "DELETE", { name: "no" })).payload).toEqual({ name: "no", removed: false });
  const backups = Schema.decodeUnknownSync(GuiBackups)((await api.call("/api/backups")).payload);
  expect(backups.snapshots.length).toBeGreaterThan(0);
  const failedRestore = await api.operation("/api/backups/restore", { snapshot: "missing" });
  expect(failedRestore.state).toBe("failed");
  expect(failedRestore.failure).toMatchObject({ category: "usage-or-configuration", exitCode: 2 });
  const restored = await api.operation("/api/backups/restore", { snapshot: backups.snapshots[0] });
  expect(restored.state, JSON.stringify(restored)).toBe("succeeded");
  expect(restored.result).toMatchObject({ restored: backups.snapshots[0], excludedHarnesses: ["codex"] });
  expect((await api.call("/api/exports", "POST", { includeHarnesses: false })).status).toBe(200);
  const unenrolled = await api.call("/api/enrollment", "DELETE", {});
  expect(unenrolled.payload).toMatchObject({ unenrolled: true, credentialRemoved: true });
  expect((await api.operation("/api/sync/plan")).state).toBe("succeeded");
}, 300_000);

for (const role of ["source", "unconfigured"] as const) {
  it(`plans, reviews, applies and restores a ${role} folder without enrollment`, async () => {
    const machine = fixture(role);
    if (role === "source") success(machine.invoke(["source", "init"]));
    write(join(machine.bin, "codex"), "", 0o755);
    const config = { version: 1, profile: { id: "gui-local", name: "Local GUI" }, harnesses: ["codex"], surfaces: { codex: ["instructions"] }, local: { appendLocal: ["instructions"] } };
    write(join(machine.folder, "canonfig.jsonc"), JSON.stringify(config));
    write(join(machine.folder, "AGENTS.md"), "Canonical instructions\n");
    const target = join(machine.home, ".codex/AGENTS.md");
    const privateText = "Private local instructions that must stay on disk\n";
    write(target, privateText);
    const api = await gui(machine);
    expect((await api.call("/api/local/synchronization")).status).toBe(200);
    for (const path of ["/api/sync/plan", "/api/sync/apply", "/api/sync/reviews", "/api/recovery", "/api/recovery/abandon"]) {
      expect((await api.call(path, "POST", { unexpected: true })).status).toBe(400);
    }
    const plan = await api.operation("/api/sync/plan");
    expect(plan.state).toBe("succeeded");
    expect(readFileSync(target, "utf8")).toBe(privateText);
    const review = await api.operation("/api/sync/reviews");
    expect(review.state, JSON.stringify(review)).toBe("succeeded");
    expect(JSON.stringify(review)).not.toContain(privateText.trim());
    expect(review.result).toMatchObject({ adoptionReviews: [expect.objectContaining({ target })] });
    const applied = await api.operation("/api/sync/apply", Schema.decodeUnknownSync(GuiSyncApplyRequest)(plan.result));
    expect(applied.state, JSON.stringify(applied)).toBe("succeeded");
    expect(applied.journal).toMatchObject({ evidence: { outcome: "Converged" } });
    expect(readFileSync(target, "utf8")).toContain("Canonical instructions");
    expect(readFileSync(target, "utf8")).toContain(privateText);
    const backups = Schema.decodeUnknownSync(GuiBackups)((await api.call("/api/backups")).payload);
    expect(backups.snapshots).toHaveLength(1);
    expect((await api.call("/api/backups/restore", "POST", {})).status).toBe(400);
    expect((await api.operation("/api/backups/restore", { snapshot: "../outside" })).state).toBe("failed");
    // A real filesystem failure leaves restore finalization open, without signalling a live process.
    const preferences = join(machine.folder, "local/local.jsonc");
    mkdirSync(preferences, { recursive: true });
    expect((await api.operation("/api/backups/restore", { snapshot: backups.snapshots[0] })).state).toBe("failed");
    expect((await api.call("/api/local/synchronization")).payload).toMatchObject({ activeRecovery: { run: expect.any(String) } });
    const refusedAbandon = await api.operation("/api/recovery/abandon");
    expect(refusedAbandon.state).toBe("failed");
    expect(refusedAbandon.failure?.message).toContain("recover");
    rmSync(preferences, { recursive: true });
    const recovered = await api.operation("/api/recovery");
    expect(recovered.state, JSON.stringify(recovered)).toBe("succeeded");
    expect(readFileSync(target, "utf8")).toBe(privateText);
    expect(JSON.parse(readFileSync(preferences, "utf8"))).toMatchObject({ excludeHarnesses: ["codex"] });
    rmSync(preferences);
    await interruptLocalPreparation(machine);
    const abandoned = await api.operation("/api/recovery/abandon");
    expect(abandoned.state, JSON.stringify(abandoned)).toBe("succeeded");
    expect(abandoned.result).toMatchObject({ abandoned: true });
    expect((await api.call("/api/local/synchronization")).payload).toEqual({ activeRecovery: null });
    if (role === "source") {
      const exported = Schema.decodeUnknownSync(GuiArchiveDownload)((await api.call("/api/exports", "POST", { includeHarnesses: false })).payload);
      const archive = join(machine.home, "folder.tar.gz");
      writeFileSync(archive, Buffer.from(exported.base64, "base64"));
      write(join(machine.folder, "AGENTS.md"), "Folder content before replacement\n");
      success(machine.invoke(["import", archive, "--replace"]));
      expect(readFileSync(join(machine.folder, "AGENTS.md"), "utf8")).toBe("Canonical instructions\n");
      const replacementBackups = Schema.decodeUnknownSync(GuiBackups)((await api.call("/api/backups")).payload);
      const snapshot = replacementBackups.snapshots.at(-1);
      expect(snapshot).toBeDefined();
      const restored = await api.operation("/api/backups/restore", { snapshot });
      expect(restored.state, JSON.stringify(restored)).toBe("succeeded");
      expect(readFileSync(join(machine.folder, "AGENTS.md"), "utf8")).toBe("Folder content before replacement\n");
    }
  }, 180_000);
}

it("rejects changed Source plans before takeover and applies only a fresh review", async () => {
  const machine = fixture("reviewed-source");
  success(machine.invoke(["source", "init"]));
  write(join(machine.bin, "codex"), "", 0o755);
  write(join(machine.folder, "canonfig.jsonc"), JSON.stringify({
    version: 1, harnesses: ["codex"], surfaces: { codex: ["instructions"] }, local: { appendLocal: ["instructions"] },
  }));
  const instructions = join(machine.folder, "AGENTS.md");
  const target = join(machine.home, ".codex/AGENTS.md");
  write(instructions, "Reviewed instructions\n");
  const api = await gui(machine);
  const approval = GuiSyncApplyRequest;
  const original = await api.operation("/api/sync/plan");
  expect(original.result).toMatchObject({ planDigest: expect.any(String) });
  const reviewed = Schema.decodeUnknownSync(approval)(original.result);
  write(instructions, "Changed canonical instructions\n");
  const changedFolder = await api.operation("/api/sync/apply", reviewed);
  expect(changedFolder.state).toBe("failed");
  expect(changedFolder.failure).toMatchObject({ category: "conflict-or-drift", exitCode: 4 });
  expect((await api.call("/api/backups")).payload).toEqual({ snapshots: [] });
  expect((await api.call("/api/local/synchronization")).payload).toEqual({ activeRecovery: null });
  const second = Schema.decodeUnknownSync(approval)((await api.operation("/api/sync/plan")).result);
  write(target, "New local instructions\n");
  const changedTarget = await api.operation("/api/sync/apply", second);
  expect(changedTarget.state).toBe("failed");
  expect(changedTarget.failure).toMatchObject({ category: "conflict-or-drift", exitCode: 4 });
  expect(readFileSync(target, "utf8")).toBe("New local instructions\n");
  expect((await api.call("/api/backups")).payload).toEqual({ snapshots: [] });
  const fresh = Schema.decodeUnknownSync(approval)((await api.operation("/api/sync/plan")).result);
  expect(Schema.decodeUnknownSync(approval)((await api.operation("/api/sync/plan")).result)).toEqual(fresh);
  const applied = await api.operation("/api/sync/apply", fresh);
  expect(applied.state, JSON.stringify(applied)).toBe("succeeded");
  expect(readFileSync(target, "utf8")).toContain("Changed canonical instructions");
  expect(readFileSync(target, "utf8")).toContain("New local instructions");
}, 180_000);
