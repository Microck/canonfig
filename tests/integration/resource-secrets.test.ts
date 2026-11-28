import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { expect, it } from "vitest";

import { FollowerCommands } from "../../src/cli/follower-commands.ts";
import { SourceCommands } from "../../src/cli/source-commands.ts";
import { GroupName } from "../../src/domain/brand.ts";
import { EnrollmentLive } from "../../src/enrollment/enrollment.layer.ts";
import { Enrollment } from "../../src/enrollment/enrollment.service.ts";
import { startSourceServer } from "../../src/enrollment/source-server.ts";
import { linuxMachineStateLayer } from "../../src/machine/linux.layer.ts";
import { MachineState } from "../../src/machine/machine-state.service.ts";
import type { FolderResourceInput } from "../../src/projection/folder.ts";
import { runtimeLayer } from "../../src/runtime/layers.ts";
import { SECRET_SHARE_GROUP, storeSecret } from "../../src/secrets/secret-store.ts";

/**
 * Authored config resources that reference shared secrets, from a Source to a
 * Follower enrolled in canonfig:secrets: real SQLite, a real Source server on
 * loopback, and the same sync command the CLI and GUI run. The credential
 * backend is a disposable local-file store reported as secure, as in the GUI
 * apply test; native provider selection has its own coverage.
 */

const machineRuntime = (home: string) => {
  const statePath = join(home, ".canonfig", "state.sqlite");
  const files = linuxMachineStateLayer({
    environment: [{ name: "HOME", value: home }, { name: "PATH", value: "/usr/bin:/bin" }],
    credentialPolicy: { kind: "local-file", path: join(home, "credentials") },
  });
  const machine = Layer.effect(MachineState, Effect.map(MachineState, (service) => ({
    ...service,
    credentialCapability: () => Effect.succeed({
      kind: "secure-noninteractive" as const, provider: "secret-service" as const,
      verification: "provider-presence" as const,
    }),
  }))).pipe(Layer.provide(files));
  const runtime = runtimeLayer({ statePath }, machine);
  return ManagedRuntime.make(Layer.merge(runtime, EnrollmentLive.pipe(Layer.provide(runtime))));
};

/** Every file under `root` except the credential store and `targets`, as text. */
const everythingElse = (root: string, targets: ReadonlyArray<string>): string => {
  const skipped = new Set([join(root, "credentials"), ...targets]);
  const read = (path: string): string => {
    if (skipped.has(path)) return "";
    if (statSync(path).isDirectory()) return readdirSync(path).map((entry) => read(join(path, entry))).join("\n");
    return readFileSync(path, "latin1");
  };
  return read(root);
};

const owner = (path: string) => statSync(path).mode & 0o777;

it.runIf(process.platform === "linux")("materializes fromSecret config resources on a follower without leaking the values", async () => {
  const root = await mkdtemp(join(tmpdir(), "canonfig-resource-secrets-"));
  const sourceHome = join(root, "source");
  const followerHome = join(root, "follower");
  await mkdir(sourceHome);
  await mkdir(followerHome);
  const source = machineRuntime(sourceHome);
  const follower = machineRuntime(followerHome);
  let closeSource: (() => Promise<void>) | undefined;
  const values = { kagi: "synthetic-kagi-value-1", firecrawl: "synthetic-firecrawl-value", parallel: "synthetic-parallel-value" };
  const rotated = "synthetic-kagi-value-2";
  const kagi = join(followerHome, ".config", "kagi-cli", "config.toml");
  const firecrawl = join(followerHome, ".config", "firecrawl-cli", "credentials.json");
  const parallel = join(followerHome, ".config", "parallel", "auth.yaml");
  const resources = {
    kagi: { kind: "config", target: "~/.config/kagi-cli/config.toml", format: "toml",
      keys: { "auth.api_key": { fromSecret: "kagi" }, "auth.region": "eu" } },
    firecrawl: { kind: "config", target: "~/.config/firecrawl-cli/credentials.json", format: "json",
      keys: { apiKey: { fromSecret: "firecrawl" }, keys: ["static", { fromSecret: "firecrawl" }] } },
    parallel: { kind: "config", target: "~/.config/parallel/auth.yaml", format: "yaml", keys: { token: { fromSecret: "parallel" } } },
  } satisfies Readonly<Record<string, FolderResourceInput>>;
  const profile = (extra: Readonly<Record<string, FolderResourceInput>> = {}) => writeFile(
    join(sourceHome, ".canonfig", "canonfig.jsonc"),
    JSON.stringify({ version: 1, profile: { id: "cli-auth", name: "CLI auth" }, harnesses: [], resources: { ...resources, ...extra } }),
  );
  const publish = () => source.runPromise(Effect.flatMap(SourceCommands, (commands) => commands.publish({ reviewer: "test" })));
  const sync = (mode: "plan" | "apply") =>
    follower.runPromise(Effect.flatMap(FollowerCommands, (commands) => commands.synchronize({ mode, noInput: false })));
  const leaks = (text: string) => [...Object.values(values), rotated].filter((value) => text.includes(value));
  try {
    await source.runPromise(Effect.flatMap(SourceCommands, (commands) => commands.initialize()));
    for (const [name, value] of Object.entries(values)) await source.runPromise(storeSecret(name, value));
    await profile();
    const published = await publish();
    const server = await source.runPromise(startSourceServer({ hostname: "127.0.0.1" }));
    closeSource = server.close;
    const invitation = await source.runPromise(Effect.flatMap(Enrollment, (enrollment) => enrollment.createInvitation({
      endpoint: server.endpoint, expiresInMilliseconds: 60_000,
      groups: [Schema.decodeUnknownSync(GroupName)(SECRET_SHARE_GROUP)],
    })));
    await follower.runPromise(Effect.flatMap(FollowerCommands, (commands) => commands.enroll({ invitation, followerName: "laptop", replace: false })));
    // An existing file keeps its other keys and is made owner-only.
    await mkdir(join(followerHome, ".config", "kagi-cli"), { recursive: true });
    await writeFile(kagi, "[ui]\ntheme = \"dark\"\n", { mode: 0o644 });

    // The follower holds no secret yet. A plan reads only this machine's
    // store, so it names the missing secret; an apply refreshes shared
    // secrets before the file run, so one apply materializes every file.
    const unplanned = await follower.runPromise(Effect.flip(Effect.flatMap(FollowerCommands, (commands) => commands.synchronize({ mode: "plan", noInput: false }))));
    expect(unplanned.message).toContain("which is missing on this machine. Run canonfig secrets sync on a follower enrolled in canonfig:secrets");
    const applied = await sync("apply");
    const planned = await sync("plan");
    expect(JSON.stringify(applied)).toContain("Converged");
    expect(parseToml(readFileSync(kagi, "utf8"))).toEqual({ ui: { theme: "dark" }, auth: { api_key: values.kagi, region: "eu" } });
    expect(JSON.parse(readFileSync(firecrawl, "utf8"))).toEqual({ apiKey: values.firecrawl, keys: ["static", values.firecrawl] });
    expect(parseYaml(readFileSync(parallel, "utf8"))).toEqual({ token: values.parallel });
    for (const path of [kagi, firecrawl, parallel]) expect(owner(path), path).toBe(0o600);

    // The revision, plans, results, mirrored folder, state database, logs and
    // run artifacts on both machines carry the references, never the values.
    expect(leaks(JSON.stringify([published, planned, applied]))).toEqual([]);
    expect(JSON.parse(readFileSync(join(followerHome, ".canonfig", "canonfig.jsonc"), "utf8").replace(/^\/\/.*$/gmu, "")).resources.kagi.keys)
      .toEqual(resources.kagi.keys);
    expect(leaks(everythingElse(followerHome, [kagi, firecrawl, parallel]))).toEqual([]);

    // The Source projects its own folder from its own store the same way.
    const sourceTargets = [kagi, firecrawl, parallel].map((path) => path.replace(followerHome, sourceHome));
    expect(JSON.stringify(await source.runPromise(Effect.flatMap(FollowerCommands, (commands) => commands.synchronize({ mode: "apply", noInput: false })))))
      .toContain("Converged");
    expect(JSON.parse(readFileSync(sourceTargets[1]!, "utf8"))).toEqual({ apiKey: values.firecrawl, keys: ["static", values.firecrawl] });
    for (const path of sourceTargets) expect(owner(path), path).toBe(0o600);
    expect(leaks(everythingElse(sourceHome, sourceTargets))).toEqual([]);

    // Unchanged secrets plan nothing; a widened mode is put back.
    chmodSync(parallel, 0o644);
    expect(JSON.stringify(await sync("apply"))).toContain("Converged");
    expect(owner(parallel)).toBe(0o600);

    // Rotation on the Source reaches the file on the next sync, with no drift.
    await source.runPromise(storeSecret("kagi", rotated));
    const rotation = await sync("apply");
    expect(JSON.stringify(rotation)).toContain("Converged");
    expect(parseToml(readFileSync(kagi, "utf8"))).toMatchObject({ ui: { theme: "dark" }, auth: { api_key: rotated } });
    expect(leaks(JSON.stringify(rotation))).toEqual([]);
    expect(leaks(everythingElse(followerHome, [kagi, firecrawl, parallel]))).toEqual([]);

    // A secret the Source never stored stops the sync before any write and names the fix.
    await profile({ gitquarry: { kind: "config", target: "~/.config/gitquarry/credentials.toml", format: "toml", keys: { token: { fromSecret: "gitquarry" } } } });
    await publish();
    const before = [kagi, firecrawl, parallel].map((path) => readFileSync(path, "utf8"));
    const missing = await follower.runPromise(Effect.flip(Effect.flatMap(FollowerCommands, (commands) => commands.synchronize({ mode: "apply", noInput: false }))));
    expect(missing.message).toContain("resources.gitquarry needs secret gitquarry, which is missing on this machine");
    expect(missing.message).toContain("canonfig secrets set gitquarry");
    expect(leaks(JSON.stringify(missing))).toEqual([]);
    expect(existsSync(join(followerHome, ".config", "gitquarry"))).toBe(false);
    expect([kagi, firecrawl, parallel].map((path) => readFileSync(path, "utf8"))).toEqual(before);

    // Once the Source stores it, the same sync converges.
    await source.runPromise(storeSecret("gitquarry", "synthetic-gitquarry-value"));
    expect(JSON.stringify(await sync("apply"))).toContain("Converged");
    expect(parseToml(readFileSync(join(followerHome, ".config", "gitquarry", "credentials.toml"), "utf8"))).toEqual({ token: "synthetic-gitquarry-value" });

    // Removing the last fromSecret key keeps parser diagnostics redacted while the prior secret stays on disk.
    await profile({
      parallel: { kind: "config", target: "~/.config/parallel/auth.yaml", format: "yaml", keys: { mode: "plain" } },
    });
    await publish();
    await writeFile(parallel, `token: ${values.parallel}\n  broken: [\n`);
    const redactedPlan = await sync("plan");
    expect(JSON.stringify(redactedPlan)).toContain("details are withheld because the file holds shared secrets");
    expect(leaks(JSON.stringify(redactedPlan))).toEqual([]);
  } finally {
    await closeSource?.();
    await follower.dispose();
    await source.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
