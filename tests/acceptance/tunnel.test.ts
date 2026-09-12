import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  CertificateFingerprint,
  GroupName,
  InvitationCode,
  Timestamp,
} from "../../src/domain/brand.ts";
import {
  consumeInvitationEnvelope,
  deliverInvitationEnvelope,
  invitationEnvelopeEof,
  readInvitationEnvelope,
} from "../../src/enrollment/invitation-envelope.ts";
import { TunnelLive } from "../../src/enrollment/tunnel.layer.ts";
import { Tunnel } from "../../src/enrollment/tunnel.service.ts";
import type { EnrollmentInvitationGrant } from
  "../../src/enrollment/enrollment.types.ts";
import type { TunnelStateFile } from "../../src/enrollment/tunnel.types.ts";

const decode = Schema.decodeUnknownSync;
const roots: Array<string> = [];
const fingerprint = decode(CertificateFingerprint)("a".repeat(64));
const sourceFingerprint = decode(CertificateFingerprint)("b".repeat(64));

const grant: EnrollmentInvitationGrant = {
  code: decode(InvitationCode)("invitation-code"),
  nonce: "invitation-nonce",
  endpoint: "https://127.0.0.1:17342",
  sourceFingerprint,
  tlsFingerprint: fingerprint,
  groups: [decode(GroupName)("developers")],
  expiresAt: decode(Timestamp)("2026-09-12T15:00:00.000Z"),
};

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "canonfig-tunnel-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed enrollment tunnel", () => {
  it("delivers one bounded private envelope with explicit EOF and consumes it", async () => {
    const root = await temporaryRoot();
    const path = join(root, "invite.txt");

    await Effect.runPromise(deliverInvitationEnvelope({ grant, path, timeoutMilliseconds: 1_000 }));
    expect(await readFile(path, "utf8")).toMatch(
      new RegExp(`^[A-Za-z0-9_-]+\\n${invitationEnvelopeEof}\\n$`, "u"),
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await Effect.runPromise(readInvitationEnvelope({ path }))).toEqual(grant);
    expect(await Effect.runPromise(consumeInvitationEnvelope({ path }))).toEqual(grant);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects host-key bypass flags before starting a process", async () => {
    const root = await temporaryRoot();
    const error = await Effect.runPromise(Effect.flip(
      Effect.flatMap(Tunnel, (tunnel) => tunnel.startTunnel({
        sshHost: "source.example",
        sshPort: 22,
        sshUser: "operator",
        sshHostKey: `ssh-ed25519 ${Buffer.alloc(32, 1).toString("base64")}`,
        localHost: "127.0.0.1",
        localPort: 17342,
        remoteHost: "127.0.0.1",
        remotePort: 17342,
        tlsFingerprint: fingerprint,
        sourceFingerprint,
        stateDirectory: root,
        sshArguments: ["-o", "StrictHostKeyChecking=no"],
      })).pipe(Effect.provide(TunnelLive)),
    ));

    expect(error._tag).toBe("TunnelHostKeyBypassError");
  });

  it("classifies an unknown or changed SSH host key as an identity failure", async () => {
    const root = await temporaryRoot();
    const executable = join(root, "fake-ssh");
    await writeFile(executable, "#!/bin/sh\necho 'Host key verification failed' >&2\nexit 255\n");
    await chmod(executable, 0o700);

    const error = await Effect.runPromise(Effect.flip(
      Effect.flatMap(Tunnel, (tunnel) => tunnel.startTunnel({
        sshHost: "source.example",
        sshPort: 22,
        sshUser: "operator",
        sshHostKey: `ssh-ed25519 ${Buffer.alloc(32, 1).toString("base64")}`,
        localHost: "127.0.0.1",
        localPort: 17342,
        remoteHost: "127.0.0.1",
        remotePort: 17342,
        tlsFingerprint: fingerprint,
        sourceFingerprint,
        stateDirectory: root,
        sshExecutable: executable,
        timeoutMilliseconds: 1_000,
      })).pipe(Effect.provide(TunnelLive)),
    ));

    expect(error._tag).toBe("TunnelHostKeyError");
  });

  it("never signals a reused PID that does not match the recorded tunnel", async () => {
    const root = await temporaryRoot();
    const knownHostsPath = join(root, "tunnel-known_hosts");
    await writeFile(knownHostsPath, "pinned\n", { mode: 0o600 });
    const state: TunnelStateFile = {
      version: 1,
      ssh: {
        host: "source.example",
        port: 22,
        user: "operator",
        hostKeyType: "ssh-ed25519",
        hostKeyFingerprint: "SHA256:not-current",
      },
      local: { host: "127.0.0.1", port: 17342 },
      remote: { host: "127.0.0.1", port: 17342 },
      tlsFingerprint: fingerprint,
      sourceFingerprint,
      pid: process.pid,
      processArgumentFingerprint: "not-the-current-process",
      startedAt: new Date().toISOString(),
      logPath: join(root, "tunnel.log"),
      knownHostsPath,
    };
    await writeFile(join(root, "tunnel.json"), `${JSON.stringify(state)}\n`, { mode: 0o600 });

    const result = await Effect.runPromise(
      Effect.flatMap(Tunnel, (tunnel) => tunnel.stopTunnel({ stateDirectory: root })).pipe(
        Effect.provide(TunnelLive),
      ),
    );

    expect(result).toEqual({ stopped: false, pid: process.pid });
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });
});
