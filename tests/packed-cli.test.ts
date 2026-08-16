import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");
const packedRoot = mkdtempSync(resolve(tmpdir(), "canonfig-packed-"));
const installRoot = resolve(packedRoot, "install");
const fixtureBin = resolve(packedRoot, "bin");
const sourceHome = resolve(packedRoot, "source-home");
const followerHome = resolve(packedRoot, "follower-home");
const tamperedFollowerHome = resolve(packedRoot, "tampered-follower-home");
let executable = "";
let sourceProcess: ChildProcessWithoutNullStreams | undefined;
let sourceEndpoint = "";
let packedRevision = "";
const PackResult = Schema.Array(Schema.Struct({ filename: Schema.String }));

interface PackedInvocation {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const invoke = (
  home: string,
  arguments_: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = {},
): PackedInvocation => {
  const result = spawnSync(executable, arguments_, {
    cwd: installRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
      HOME: home,
      PATH: `${fixtureBin}:${dirname(executable)}:${process.env.PATH ?? ""}`,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/canonfig-packed-test-bus",
    },
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const unusedPort = (): Promise<number> =>
  new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const decodedAddress = Schema.decodeUnknownOption(
        Schema.Struct({ port: Schema.Int }),
      )(server.address());
      if (decodedAddress._tag === "None") {
        server.close();
        rejectPort(new Error("could not reserve a loopback port"));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolvePort(decodedAddress.value.port);
        else rejectPort(error);
      });
    });
  });

const startPackedSource = (
  port: number,
): Promise<{ readonly endpoint: string }> =>
  new Promise((resolveSource, rejectSource) => {
    const child = spawn(
      executable,
      ["source", "serve", "--host", "127.0.0.1", "--port", `${port}`, "--json"],
      {
        cwd: installRoot,
        env: {
          ...process.env,
          HOME: sourceHome,
          PATH: `${fixtureBin}:${dirname(executable)}:${process.env.PATH ?? ""}`,
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/canonfig-packed-test-bus",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    sourceProcess = child;
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectSource(new Error(`packed source did not start: ${stderr}`));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        const envelope = JSON.parse(stdout.slice(0, newline));
        resolveSource({ endpoint: envelope.data.endpoint });
      } catch (error) {
        rejectSource(error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", (status) => {
      clearTimeout(timeout);
      if (stdout.length === 0) {
        rejectSource(new Error(
          `packed source exited before startup (${String(status)}): ${stderr}`,
        ));
      }
    });
  });

beforeAll(async () => {
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(fixtureBin, { recursive: true });
  mkdirSync(sourceHome, { recursive: true });
  mkdirSync(followerHome, { recursive: true });
  mkdirSync(tamperedFollowerHome, { recursive: true });
  const secretTool = resolve(fixtureBin, "secret-tool");
  writeFileSync(secretTool, `#!/bin/sh
set -eu
operation="$1"
key=""
for argument in "$@"; do key="$argument"; done
directory="$HOME/.canonfig-packed-secrets"
path="$directory/$key"
case "$operation" in
  store)
    mkdir -p "$directory"
    cat > "$path"
    ;;
  lookup)
    cat "$path"
    ;;
  clear)
    rm -f "$path"
    ;;
  *)
    exit 2
    ;;
esac
`);
  chmodSync(secretTool, 0o700);
  const packed = spawnSync(
    "npm",
    [
      "pack",
      "--ignore-scripts=false",
      "--json",
      "--pack-destination",
      packedRoot,
    ],
    { cwd: projectRoot, encoding: "utf8", timeout: 120_000 },
  );
  expect(packed.status, packed.stderr).toBe(0);
  const packedResult = Schema.decodeUnknownSync(PackResult)(
    JSON.parse(packed.stdout),
  );
  const tarball = resolve(packedRoot, packedResult[0]!.filename);
  writeFileSync(
    resolve(installRoot, "package.json"),
    `${JSON.stringify({ private: true })}\n`,
  );
  const installed = spawnSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    { cwd: installRoot, encoding: "utf8", timeout: 120_000 },
  );
  expect(installed.status, installed.stderr).toBe(0);
  executable = resolve(installRoot, "node_modules/.bin/canonfig");
  expect(readFileSync(
    resolve(installRoot, "node_modules/canonfig/package.json"),
    "utf8",
  )).toContain('"canonfig": "dist/runtime/main.js"');

  const initialized = invoke(sourceHome, ["source", "init", "--json"]);
  expect(initialized.status, initialized.stderr).toBe(0);
  const proposal = resolve(sourceHome, "package.json");
  writeFileSync(proposal, JSON.stringify({
    canonfig: {
      tools: [{
        ecosystem: "npm",
        name: "node",
        executable: "node",
        version: process.versions.node,
        source: `lock:node:${process.versions.node}`,
        upstream: "https://nodejs.org",
      }],
    },
  }));
  const published = invoke(sourceHome, [
    "source",
    "publish",
    "--proposal",
    proposal,
    "--profile",
    "packed-profile",
    "--name",
    "Packed profile",
    "--reviewer",
    "packed-test",
    "--json",
  ]);
  expect(published.status, published.stderr).toBe(0);
  packedRevision = JSON.parse(published.stdout).data.id;
  const port = await unusedPort();
  const source = await startPackedSource(port);
  sourceEndpoint = source.endpoint;
}, 180_000);

afterAll(() => {
  sourceProcess?.kill("SIGKILL");
  rmSync(packedRoot, { recursive: true, force: true });
});

describe("packed Canonfig executable", () => {
  it("runs shipped help and version entrypoints", () => {
    const help = invoke(sourceHome, ["--help"]);
    const version = invoke(followerHome, ["--version"]);
    expect(help).toMatchObject({ status: 0, stderr: "" });
    expect(help.stdout).toContain("Usage: canonfig");
    expect(version).toEqual({ status: 0, stdout: "2.0.0\n", stderr: "" });
  });

  it("runs representative safe routes with stable JSON", () => {
    const profiles = invoke(followerHome, ["profile", "list", "--json"]);
    expect(profiles).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(profiles.stdout)).toMatchObject({
      schema: "canonfig.cli/v1",
      command: "profile.list",
      status: "success",
      exitCode: 0,
      data: { revisions: [] },
    });

    const policy = invoke(
      followerHome,
      ["agent", "policy", "deterministic-only", "--json"],
    );
    expect(policy).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(policy.stdout)).toMatchObject({
      command: "agent.policy.set",
      exitCode: 0,
      data: "deterministic-only",
    });
  });

  it("maps invalid input to the stable usage exit code", () => {
    const result = invoke(followerHome, ["sync", "--plan", "--apply"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--plan and --apply are mutually exclusive");
  });

  it("runs doctor with bounded noninteractive probes and redaction", () => {
    const secret = "packed-doctor-secret-must-not-leak";
    const result = invoke(
      followerHome,
      ["doctor", "--json", "--no-input", "--timeout-ms", "2000"],
      {
        CANONFIG_SOURCE_ENDPOINT: "https://127.0.0.1:9",
        CANONFIG_SOURCE_TLS_FINGERPRINT: "packed-fingerprint",
        CANONFIG_SOURCE_CREDENTIAL_REFERENCE: secret,
      },
    );
    expect(result.status).toBe(5);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(secret);
    const envelope = JSON.parse(result.stderr);
    expect(envelope).toMatchObject({
      schema: "canonfig.cli/v1",
      command: "doctor",
      status: "error",
      exitCode: 5,
      data: {
        schema: "canonfig.doctor/v1",
        noInput: true,
        status: "unhealthy",
      },
    });
    expect(envelope.data.probes).toHaveLength(7);
  });

  it("keeps unavailable scheduled apply quiet on stdout and truthful on stderr", () => {
    const first = invoke(
      followerHome,
      ["sync", "--apply", "--no-input"],
    );
    const second = invoke(
      followerHome,
      ["sync", "--apply", "--no-input"],
    );
    expect(first.status).toBe(2);
    expect(first.stdout).toBe("");
    expect(first.stderr).toBe(
      "follower synchronization configuration is not enrolled\n",
    );
    expect(second).toEqual(first);
    expect(first.stderr).not.toContain("completed");
  });

  it("runs an authenticated source-to-follower lifecycle across packed processes", () => {
    const invitationResult = invoke(sourceHome, [
      "source",
      "invite",
      "--endpoint",
      sourceEndpoint,
      "--expires",
      "5m",
      "--json",
    ]);
    expect(invitationResult.status, invitationResult.stderr).toBe(0);
    const invitation = JSON.parse(invitationResult.stdout).data.invite;
    const enrolled = invoke(followerHome, [
      "follower",
      "enroll",
      invitation,
      "--name",
      "packed-follower",
      "--profile",
      "packed-profile",
      "--json",
    ]);
    expect(enrolled.status, enrolled.stderr).toBe(0);
    const follower = JSON.parse(enrolled.stdout).data.follower.id;

    const first = invoke(followerHome, ["sync", "--apply", "--json"]);
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).data).toMatchObject({
      revision: packedRevision,
      downloadedBlobs: 1,
      reusedBlobs: 0,
      outcome: { outcome: "Converged" },
    });

    const second = invoke(
      followerHome,
      ["sync", "--apply", "--no-input", "--json"],
    );
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).data).toMatchObject({
      revision: packedRevision,
      downloadedBlobs: 0,
      reusedBlobs: 1,
      outcome: { outcome: "Converged" },
    });

    const status = invoke(followerHome, ["status", "--json"]);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).data.follower.id).toBe(follower);
    const recovery = invoke(followerHome, ["recover", "--no-input", "--json"]);
    expect(recovery.status).toBe(2);
    expect(recovery.stdout).toBe("");
    expect(JSON.parse(recovery.stderr)).toMatchObject({
      command: "recover",
      status: "error",
      exitCode: 2,
    });

    const revoked = invoke(sourceHome, [
      "source",
      "revoke",
      follower,
      "--json",
    ]);
    expect(revoked.status, revoked.stderr).toBe(0);
    const rejected = invoke(followerHome, ["sync", "--apply", "--json"]);
    expect(rejected.status).toBe(5);
    expect(rejected.stdout).toBe("");
  }, 60_000);

  it("rejects a tampered TLS fingerprint from the packed executable", () => {
    const secondInvitation = invoke(sourceHome, [
      "source",
      "invite",
      "--endpoint",
      sourceEndpoint,
      "--expires",
      "5m",
      "--json",
    ]);
    expect(secondInvitation.status, secondInvitation.stderr).toBe(0);
    const tamperedEnrollment = invoke(tamperedFollowerHome, [
      "follower",
      "enroll",
      JSON.parse(secondInvitation.stdout).data.invite,
      "--name",
      "tampered-follower",
      "--profile",
      "packed-profile",
      "--json",
    ]);
    expect(tamperedEnrollment.status, tamperedEnrollment.stderr).toBe(0);
    const statePath = resolve(tamperedFollowerHome, ".canonfig/state.sqlite");
    const database = new DatabaseSync(statePath);
    const row = Schema.decodeUnknownSync(Schema.Struct({
      configuration_json: Schema.String,
    }))(database.prepare(`
      SELECT configuration_json
      FROM follower_sync_configuration
      WHERE singleton = 1
    `).get());
    const configuration = JSON.parse(row.configuration_json);
    configuration.source.tlsFingerprint = "tampered-tls-fingerprint";
    database.prepare(`
      UPDATE follower_sync_configuration
      SET configuration_json = ?
      WHERE singleton = 1
    `).run(JSON.stringify(configuration));
    database.close();
    const tampered = invoke(
      tamperedFollowerHome,
      ["sync", "--apply", "--json"],
    );
    expect(tampered.status).not.toBe(0);
    expect(tampered.stdout).toBe("");
  });
});
