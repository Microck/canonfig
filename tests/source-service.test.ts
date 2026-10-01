import { createHash, X509Certificate } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer, type Server } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Schema } from "effect";
import { generate } from "selfsigned";
import { afterEach, describe, expect, it } from "vitest";

import { CertificateFingerprint } from "../src/domain/brand.ts";
import { linuxMachineStateLayer } from "../src/machine/linux.layer.ts";
import { renderSourceService } from "../src/source-service/source-service.render.ts";
import { sourceServiceLayer } from "../src/source-service/source-service.layer.ts";
import { SourceService } from "../src/source-service/source-service.service.ts";
import type { SourceServiceSpecification } from "../src/source-service/source-service.types.ts";

const decode = Schema.decodeUnknownSync;
const sourceFingerprint = decode(CertificateFingerprint)("b".repeat(64));
const roots: Array<string> = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const serveArguments = [
  "/opt/canonfig/dist/runtime/main.js",
  "source",
  "serve",
  "--host",
  "127.0.0.1",
  "--port",
  "17342",
];

const specification = (
  overrides: Partial<SourceServiceSpecification>,
): SourceServiceSpecification => ({
  platform: "linux",
  home: "/home/source",
  executable: "/usr/local/bin/node",
  arguments: serveArguments,
  environment: [],
  logPath: "/home/source/.canonfig/source-service.log",
  ...overrides,
});

describe("source service definitions", () => {
  it("quotes systemd paths and escapes native argument expansion", async () => {
    const rendered = await Effect.runPromise(renderSourceService(specification({
      home: "/home/100% source",
      executable: "/home/100% source/.nvm/node",
      environment: [
        { name: "HOME", value: "/home/100% source" },
        { name: "CANONFIG_LOCAL_CREDENTIAL_ROOT", value: "/srv/$keys" },
      ],
      arguments: [...serveArguments.slice(0, -1), "$PORT"],
    })));

    expect(rendered).toMatchObject({
      mechanism: "systemd-user-service",
      serviceName: "canonfig-source.service",
      definitionPath: "/home/100% source/.config/systemd/user/canonfig-source.service",
    });
    const lines = rendered.definition.split("\n");
    // `%` is a specifier everywhere; `$` expands only in ExecStart arguments.
    expect(lines).toContain("Environment=\"HOME=/home/100%% source\"");
    expect(lines).toContain("Environment=\"CANONFIG_LOCAL_CREDENTIAL_ROOT=/srv/$keys\"");
    expect(lines).toContain(
      "ExecStart=\"/home/100%% source/.nvm/node\" \"/opt/canonfig/dist/runtime/main.js\" "
        + "\"source\" \"serve\" \"--host\" \"127.0.0.1\" \"--port\" \"$$PORT\"",
    );
  });

  it("renders a launchd agent that runs at login and restarts after a crash", async () => {
    const rendered = await Effect.runPromise(renderSourceService(specification({
      platform: "macos",
      home: "/Users/source",
      executable: "/opt/homebrew/opt/node@24/bin/node",
      environment: [{ name: "HOME", value: "/Users/source" }],
      logPath: "/Users/source/.canonfig/source-service.log",
    })));

    expect(rendered).toMatchObject({
      mechanism: "launchd-user-agent",
      serviceName: "dev.canonfig.source",
      definitionPath: "/Users/source/Library/LaunchAgents/dev.canonfig.source.plist",
    });
    expect(rendered.definition).toContain(
      "<key>ProgramArguments</key><array><string>/opt/homebrew/opt/node@24/bin/node</string>"
        + "<string>/opt/canonfig/dist/runtime/main.js</string><string>source</string>"
        + "<string>serve</string><string>--host</string><string>127.0.0.1</string>"
        + "<string>--port</string><string>17342</string></array>",
    );
    expect(rendered.definition).toContain("<key>RunAtLoad</key><true/>");
    expect(rendered.definition).toContain(
      "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    );
    expect(rendered.definition).toContain(
      "<key>EnvironmentVariables</key><dict><key>HOME</key><string>/Users/source</string></dict>",
    );
    expect(rendered.definition).toContain(
      "<key>StandardErrorPath</key><string>/Users/source/.canonfig/source-service.log</string>",
    );
  });

  it("renders an at-logon Task Scheduler task without a time limit", async () => {
    const rendered = await Effect.runPromise(renderSourceService(specification({
      platform: "windows",
      home: "C:\\Users\\Source User",
      executable: "C:\\Program Files\\nodejs\\node.exe",
      arguments: ["C:\\Program Files\\canonfig\\dist\\runtime\\main.js", ...serveArguments.slice(1)],
      principal: "HOST\\Source User",
    })));

    expect(rendered).toMatchObject({
      mechanism: "task-scheduler-logon",
      serviceName: "Canonfig\\canonfig-source",
    });
    expect(rendered.definition).toContain(
      "<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>HOST\\Source User</UserId></LogonTrigger></Triggers>",
    );
    expect(rendered.definition).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(rendered.definition).toContain(
      "<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>",
    );
    expect(rendered.definition).toContain(
      "<Command>C:\\Program Files\\nodejs\\node.exe</Command>"
        + "<Arguments>&quot;C:\\Program Files\\canonfig\\dist\\runtime\\main.js&quot; source serve --host 127.0.0.1 --port 17342</Arguments>",
    );
    expect(rendered.definition).toContain(`[canonfig:${rendered.fingerprint}]`);
  });

  it("refuses environment Task Scheduler cannot carry", async () => {
    const error = await Effect.runPromise(Effect.flip(renderSourceService(specification({
      platform: "windows",
      home: "C:\\Users\\source",
      principal: "HOST\\source",
      environment: [{ name: "CANONFIG_LOCAL_CREDENTIAL_ROOT", value: "C:\\keys" }],
    }))));

    expect(error.message).toContain("CANONFIG_LOCAL_CREDENTIAL_ROOT");
  });
});

const freePort = (): Promise<number> =>
  new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });

/** A systemctl stand-in: records calls and reports the state it is told to. */
const fakeSystemctl = async (root: string, script: string): Promise<string> => {
  const path = join(root, "systemctl");
  await writeFile(path, `#!/bin/sh\necho "$@" >> "${join(root, "systemctl.calls")}"\n${script}\n`);
  await chmod(path, 0o700);
  return path;
};

describe.skipIf(process.platform === "win32")("systemd Source service lifecycle", () => {
  const setup = async (systemctlScript: string) => {
    const root = await mkdtemp(join(tmpdir(), "canonfig-source-service-"));
    roots.push(root);
    const systemctl = await fakeSystemctl(root, systemctlScript);
    const layer = sourceServiceLayer({
      stateDirectory: join(root, ".canonfig"),
      platform: "linux",
      home: root,
      environment: { CANONFIG_SYSTEMCTL: systemctl },
      readinessTimeoutMilliseconds: 1_000,
    }).pipe(Layer.provide(linuxMachineStateLayer()));
    const run = <Success, Failure>(program: Effect.Effect<Success, Failure, SourceService>) =>
      Effect.runPromise(program.pipe(Effect.provide(layer)));
    return { root, run };
  };

  it("installs, is verifiable through status, and removes the unit", async () => {
    const port = await freePort();
    const { root, run } = await setup(
      "case \"$2\" in show) printf 'LoadState=loaded\\nActiveState=active\\nSubState=running\\nUnitFileState=enabled\\nMainPID=4242\\n';; esac\nexit 0",
    );
    const certificate = await generate([{ name: "commonName", value: "loopback-test" }], {
      keyType: "ec",
      curve: "P-256",
      extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }],
    });
    const identity = {
      tlsFingerprint: decode(CertificateFingerprint)(
        createHash("sha256").update(new X509Certificate(certificate.cert).raw).digest("hex"),
      ),
      sourceFingerprint,
    };

    // Nothing serves the Source yet: install must not claim success.
    const notServing = await run(Effect.flip(Effect.flatMap(SourceService, (service) =>
      service.install({ hostname: "127.0.0.1", port }, identity)
    )));
    expect(notServing).toMatchObject({ _tag: "SourceServiceVerificationError", state: "not-serving" });
    const unit = await readFile(
      join(root, ".config", "systemd", "user", "canonfig-source.service"),
      "utf8",
    );
    expect(unit).toContain(`"--port" "${port}"`);
    const calls = await readFile(join(root, "systemctl.calls"), "utf8");
    expect(calls).toContain("--user daemon-reload");
    expect(calls).toContain("--user enable canonfig-source.service");
    expect(calls).toContain("--user restart canonfig-source.service");

    // The supervised process comes up: status verifies manager state and identity.
    const server: Server = createHttpsServer(
      { key: certificate.private, cert: certificate.cert },
      (request, response) => {
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          source: { keyId: "source-key", publicKeyFingerprint: sourceFingerprint },
          tlsFingerprint: identity.tlsFingerprint,
        }));
      },
    );
    await new Promise<void>((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
    cleanups.push(() => new Promise<void>((resolveClose) => {
      server.closeAllConnections();
      server.close(() => resolveClose());
    }));
    const status = await run(Effect.flatMap(SourceService, (service) => service.status(identity)));
    expect(status).toMatchObject({
      state: "running",
      serving: true,
      endpoint: `https://127.0.0.1:${port}`,
      manager: { installed: true, matches: true, enabled: true, active: true, pid: 4242 },
      logs: "journalctl --user -u canonfig-source.service",
    });

    const removed = await run(Effect.flatMap(SourceService, (service) => service.remove()));
    expect(removed.change).toBe("removed");
    expect(await readFile(join(root, "systemctl.calls"), "utf8"))
      .toContain("--user disable --now canonfig-source.service");
    await expect(access(join(root, ".config", "systemd", "user", "canonfig-source.service")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("names the missing session bus and the supported modes", async () => {
    const { run } = await setup(
      "echo 'Failed to connect to bus: No medium found' >&2\nexit 1",
    );
    const port = await freePort();
    const error = await run(Effect.flip(Effect.flatMap(SourceService, (service) =>
      service.install({ hostname: "127.0.0.1", port }, {
        tlsFingerprint: decode(CertificateFingerprint)("a".repeat(64)),
        sourceFingerprint,
      })
    )));

    expect(error._tag).toBe("SourceServiceManagerError");
    expect(error.message).toContain("no user session bus");
    expect(error.message).toContain("loginctl enable-linger");
  });
});
