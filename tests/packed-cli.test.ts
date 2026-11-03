import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  resolve,
} from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConfigValue } from "../src/domain/resource.ts";
import { adapterFor } from "../src/projection/adapters/index.ts";
import type { TargetId } from "../src/projection/model.ts";

/**
 * The published npm package, packed and installed as a consumer would, run
 * as separate processes: one Source authoring `~/.canonfig/`, publishing it
 * and serving it over loopback HTTPS, and followers in their own temporary
 * HOMEs. Each machine's PATH holds only its fake harness executables and the
 * shared fixtures, so nothing installed on the host running the tests is
 * detected or written. Nothing is mocked.
 */

const projectRoot = resolve(import.meta.dirname, "..");
const packedRoot = mkdtempSync(resolve(tmpdir(), "canonfig-packed-"));
const installRoot = resolve(packedRoot, "install");
const packageRoot = resolve(installRoot, "node_modules", "@microck", "canonfig");
const fixtureBin = resolve(packedRoot, "bin");
const compileCache = resolve(packedRoot, "compile-cache");
const failingSystemctl = resolve(fixtureBin, "systemctl-fail");
/** While this file is not empty, the `probe` tool's verification kills the run verifying it, once. */
const crashMarker = resolve(packedRoot, "crash-once");
/** What `packed-probe`, the real node under another name, runs to verify the `probe` tool. */
const probeScript = resolve(fixtureBin, "packed-probe.cjs");
/** npm's own entrypoint, which Windows runs as Node plus this script instead of through the npm.cmd shim. */
const npmCli = process.env.npm_execpath;
if (process.platform === "win32" && npmCli === undefined) {
  throw new Error("npm_execpath is required for shell-free npm execution on Windows");
}
const nodeVersion = process.versions.node;
let executable = "";
let packedEntry = "";
let sourceProcess: ChildProcessWithoutNullStreams | undefined;
let sourceEndpoint = "";
let packedRevision = "";
const PackResult = Schema.Array(Schema.Struct({ filename: Schema.String }));

const write = (path: string, content: string, mode?: number) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
};

/**
 * A fixture executable's file name. Windows runs only the extensions PATHEXT
 * lists, and Canonfig never starts a shell, so there it is `<name>.exe`.
 */
const executableName = (name: string) => process.platform === "win32" ? `${name}.exe` : name;

const runNpm = (
  cwd: string,
  arguments_: ReadonlyArray<string>,
) => {
  if (npmCli !== undefined && process.platform === "win32") {
    return spawnSync(process.execPath, [npmCli, ...arguments_], {
      cwd,
      encoding: "utf8",
      timeout: 240_000,
    });
  }
  return spawnSync("npm", [...arguments_], {
    cwd,
    encoding: "utf8",
    timeout: 240_000,
  });
};

interface PackedInvocation {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Machine {
  readonly home: string;
  /** This machine's `~/.canonfig/`. */
  readonly folder: string;
  readonly state: string;
  /** Where this machine's fake harness executables live; first on its PATH. */
  readonly bin: string;
  /** This machine's simulated systemctl, used on Linux instead of the host's. */
  readonly systemctl: string;
}

/**
 * One machine: a HOME of its own and a PATH holding only `harnesses`' fake
 * executables, then the shared fixtures (`node`, `npm`, `secret-tool`, the
 * probe tool). No inherited variable such as CODEX_HOME leaks in.
 */
const machine = (name: string, harnesses: ReadonlyArray<TargetId> = []): Machine => {
  const home = resolve(packedRoot, name, "home");
  const bin = resolve(packedRoot, name, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // Detection only looks for the file, so an empty one stands for the harness.
  for (const harness of harnesses) {
    write(
      resolve(bin, executableName(adapterFor(harness).descriptor.executables[0]!)),
      "",
      process.platform === "win32" ? undefined : 0o755,
    );
  }
  // Windows has no npm Canonfig can run from PATH: npm.cmd needs a shell. A
  // Windows operator binds npm to Node and npm-cli.js instead, and this is
  // the document `canonfig installer set npm` records for that binding.
  if (process.platform === "win32") {
    write(resolve(home, ".canonfig", "installers", "npm.json"), `${JSON.stringify({
      schema: "canonfig.installer/v1",
      method: "npm",
      platform: "windows",
      executable: process.execPath,
      arguments: [npmCli!],
    })}\n`);
  }
  // A systemd user manager of this machine's own: enabling the timer writes a
  // marker that `show` then reports. Canonfig runs systemctl with no
  // environment, not even PATH, so the script names the marker by absolute
  // path and uses shell builtins only.
  const systemctl = resolve(packedRoot, name, "systemctl");
  write(systemctl, `#!/bin/sh
set -eu
operation="\${2:-}"
marker="${resolve(home, ".canonfig-packed-systemd-enabled")}"
case "$operation" in
  daemon-reload) exit 0 ;;
  show)
    state=inactive; unit=disabled
    if test -s "$marker"; then state=active; unit=enabled; fi
    printf 'Id=canonfig-sync.timer\\nLoadState=loaded\\nActiveState=%s\\nUnitFileState=%s\\nDropInPaths=\\n\\nId=canonfig-sync.service\\nLoadState=loaded\\nActiveState=inactive\\n' "$state" "$unit"
    ;;
  enable) echo enabled > "$marker" ;;
  disable) : > "$marker" ;;
  *) exit 0 ;;
esac
`, 0o700);
  const folder = resolve(home, ".canonfig");
  return { home, folder, state: resolve(folder, "state.sqlite"), bin, systemctl };
};

const environmentFor = (
  target: Machine,
  environment: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => {
  const base: NodeJS.ProcessEnv = {
    HOME: target.home,
    USERPROFILE: target.home,
    APPDATA: resolve(target.home, "AppData", "Roaming"),
    LOCALAPPDATA: resolve(target.home, "AppData", "Local"),
    XDG_CONFIG_HOME: resolve(target.home, ".config"),
    XDG_DATA_HOME: resolve(target.home, ".local", "share"),
    XDG_CACHE_HOME: resolve(target.home, ".cache"),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    CANONFIG_LOCAL_CREDENTIAL_ROOT: resolve(target.home, ".canonfig-credentials"),
    // This file spawns the packed CLI around a hundred times, and each cold
    // start spends most of its ~1.4s compiling the same modules. Node's
    // on-disk compile cache keeps the bytecode between spawns (about 25% off
    // every invocation) without changing what the CLI does. The directory
    // lives under packedRoot so afterAll removes it.
    NODE_COMPILE_CACHE: compileCache,
    PATH: [target.bin, fixtureBin].join(delimiter),
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/canonfig-packed-test-bus",
  };
  // Windows processes need these to start at all; nothing else of the host's
  // environment reaches the CLI.
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (process.env[name] !== undefined) base[name] = process.env[name];
  }
  // The systemd user manager of the host running the tests is never touched:
  // every Linux machine talks to a simulated systemctl of its own.
  if (process.platform === "linux") base.CANONFIG_SYSTEMCTL = target.systemctl;
  // The caller's overrides win, including removing a variable by passing
  // undefined, so a case can turn off the local-file credential policy.
  const merged: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete merged[name];
    else merged[name] = value;
  }
  return merged;
};

const invoke = (
  target: Machine,
  arguments_: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = {},
  input?: string | undefined,
): PackedInvocation => {
  const result = spawnSync(executable, [packedEntry, ...arguments_], {
    cwd: installRoot,
    encoding: "utf8",
    env: environmentFor(target, environment),
    input,
    timeout: 60_000,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

/** Pipe an invitation envelope over stdin: argv never carries the secret. */
const envelopeInput = (invitation: string): string =>
  `${invitation}\nCANONFIG-INVITE-EOF\n`;

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
      [
        packedEntry,
        "source",
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        `${port}`,
        "--json",
      ],
      {
        cwd: installRoot,
        env: environmentFor(source),
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

/** The canonfig.cli/v1 envelope; its `data` shape depends on the command. */
const parseEnvelope = (result: PackedInvocation) =>
  JSON.parse(result.stdout.length > 0 ? result.stdout : result.stderr);

const requireSuccess = (
  result: PackedInvocation,
  label: string,
): ReturnType<typeof parseEnvelope> => {
  expect(result.status, `${label}: ${result.stdout}${result.stderr}`).toBe(0);
  expect(result.stderr, label).toBe("");
  return parseEnvelope(result);
};

/** A canonfig.jsonc as followers' mirrors render it: a comment header, then JSON. */
const readJsonc = (path: string) =>
  JSON.parse(readFileSync(path, "utf8").replace(/^\/\/.*$/gmu, ""));

const readText = (path: string) => readFileSync(path, "utf8");

let invitationSequence = 0;

const issueInvitation = (
  groups: ReadonlyArray<string> = [],
  label = "issue invitation",
): string => {
  invitationSequence += 1;
  const output = resolve(source.home, `invitation-${String(invitationSequence)}.txt`);
  const result = requireSuccess(
    invoke(source, [
      "source",
      "invite",
      "--endpoint",
      sourceEndpoint,
      "--expires",
      "15m",
      "--output",
      output,
      ...groups.flatMap((group) => ["--group", group]),
      "--json",
    ]),
    label,
  );
  expect(result.data?.["outputPath"]).toBe(output);
  const [invitation, eof, trailing] = readFileSync(output, "utf8").split("\n");
  expect(eof).toBe("CANONFIG-INVITE-EOF");
  expect(trailing).toBe("");
  expect(invitation).toBeTruthy();
  rmSync(output);
  return invitation!;
};

/** Enroll `follower` with a fresh invitation; returns its follower id. */
const enroll = (
  follower: Machine,
  name: string,
  groups: ReadonlyArray<string> = [],
): string => {
  const result = requireSuccess(
    invoke(follower, [
      "follower",
      "enroll",
      "--stdin",
      "--name",
      name,
      "--json",
    ], {}, envelopeInput(issueInvitation(groups, `issue ${name} invitation`))),
    `enroll ${name}`,
  );
  expect(result.data.profile).toBe("packed-profile");
  return String(result.data.follower.id);
};

const platforms = ["linux", "macos", "windows"] as const;

/** Versions in recipes for every platform: the follower selects its own. */
const recipesFor = (method: string, packageName: string, version: string) =>
  platforms.map((platform) => ({ platform, method, package: packageName, version }));

/** Bytes outside the authoring allowlist; publication must never carry them. */
const machineLocalSecret = "packed-machine-local-secret-must-not-publish";

/**
 * The Source's Canonical Folder. The first edition holds an item of every
 * kind: instructions, a rule, a skill with an executable script, a hook and
 * its script, two MCP servers (one requiring the `node` tool), Claude Code
 * settings, three tools, a credential, two groups, a suggested schedule and
 * a local policy. The second edition changes the instructions and a skill,
 * drops a settings key and a script, and removes the restricted group's items.
 */
const authorSourceFolder = (folder: string, edition: 1 | 2) => {
  const config = {
    version: 1,
    profile: { id: "packed-profile", name: "Packed profile" },
    harnesses: ["claude-code", "codex"],
    mcp: {
      docs: {
        transport: "streamable-http",
        url: "https://example.invalid/mcp",
        headers: { Authorization: { fromEnv: "DOCS_MCP_TOKEN" } },
      },
      "node-version": {
        transport: "stdio",
        command: "node",
        args: ["--version"],
        requires: ["tools/node"],
      },
    },
    hooks: [{ id: "format", event: "after_tool", run: ["hooks/format.sh"] }],
    settings: {
      "claude-code": edition === 1 ? { model: "opus", cleanupPeriodDays: 30 } : { model: "opus" },
    },
    tools: {
      // The real node running these tests: present on every follower, so it
      // verifies without installing, and running it proves the runtime the
      // `node-version` MCP server needs actually loads.
      node: {
        executable: "node",
        recipes: recipesFor("npm", "node", nodeVersion),
        verify: {
          method: "command",
          command: ["node", "--version"],
          expectContains: `v${nodeVersion}`,
          proves: "client-load",
        },
      },
      probe: {
        executable: "packed-probe",
        recipes: recipesFor("source", "packed-probe", "v1.0.0"),
        verify: { method: "command", command: ["packed-probe", probeScript] },
      },
      ...edition === 1
        ? {
          // No follower has it and a source recipe is never automatic, so a
          // follower that receives it has to act by hand.
          human: {
            executable: "packed-human-tool",
            recipes: recipesFor("source", "packed-human-tool", "v1.0.0"),
          },
        }
        : undefined,
    },
    credentials: { "docs-token": { reference: "DOCS_MCP_TOKEN" } },
    groups: {
      // Nobody joins `secrets`, so the credential's presence is never required.
      secrets: ["credentials/docs-token"],
      ...edition === 1 ? { restricted: ["skills/restricted", "tools/human"] } : undefined,
    },
    scheduleDefault: "daily@04:30",
    local: { allow: ["skills"] },
  } satisfies Readonly<Record<string, ConfigValue>>;
  write(resolve(folder, "canonfig.jsonc"), `// The packed Source's folder\n${JSON.stringify(config, undefined, 2)}\n`);
  write(
    resolve(folder, "AGENTS.md"),
    edition === 1
      ? "# Packed instructions\n\n```sh\nnode --version\nnpm install --global canonfig-fixture@1.0.0\n```\n"
      : "# Packed instructions, second edition\n",
  );
  write(resolve(folder, "rules", "style.md"), "---\ndescription: Style\n---\nUse two spaces.\n");
  write(
    resolve(folder, "skills", "deploy", "SKILL.md"),
    `---\nname: deploy\ndescription: Deploy the service\n---\n${edition === 1 ? "Run scripts/run.sh." : "Deploy, second edition."}\n`,
  );
  if (edition === 1) {
    write(resolve(folder, "skills", "deploy", "scripts", "run.sh"), "#!/bin/sh\necho deploy\n", 0o755);
    write(resolve(folder, "skills", "restricted", "SKILL.md"), "---\nname: restricted\ndescription: Restricted\n---\nRestricted.\n");
  } else {
    rmSync(resolve(folder, "skills", "deploy", "scripts"), { recursive: true });
    rmSync(resolve(folder, "skills", "restricted"), { recursive: true });
  }
  write(resolve(folder, "hooks", "format.sh"), "#!/bin/sh\nnode --version\n", 0o755);
  // Machine-local by definition: outside the seven authoring entries.
  write(resolve(folder, "notes.txt"), `${machineLocalSecret}\n`);
};

const source = machine("source");
const bare = machine("bare");

beforeAll(async () => {
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(fixtureBin, { recursive: true });
  write(resolve(fixtureBin, "secret-tool"), `#!/bin/sh
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
`, 0o700);
  write(failingSystemctl, "#!/bin/sh\nexit 42\n", 0o700);
  // The real node and npm, as every follower's tools see them. npm also makes
  // the doctor's package-manager probe pass; on Windows each machine binds it
  // instead (`machine`).
  symlinkSync(process.execPath, resolve(fixtureBin, executableName("node")));
  if (process.platform !== "win32") {
    symlinkSync(resolve(dirname(process.execPath), "npm"), resolve(fixtureBin, "npm"));
  }
  // The `probe` tool verifies like node, except that while the crash marker
  // is armed (not empty) it disarms it and kills the canonfig process
  // verifying it, which interrupts that apply after its artifacts and journal
  // are on disk. It is node running a script rather than a shell script, so
  // Canonfig, which never starts a shell, can run it on Windows too.
  symlinkSync(process.execPath, resolve(fixtureBin, executableName("packed-probe")));
  write(probeScript, `const { existsSync, statSync, writeFileSync } = require("node:fs");
const marker = ${JSON.stringify(crashMarker)};
if (existsSync(marker) && statSync(marker).size > 0) {
  writeFileSync(marker, "");
  process.kill(process.ppid, "SIGKILL");
  process.exit(1);
}
console.log(process.version);
`);
  const packed = runNpm(
    projectRoot,
    [
      "pack",
      "--ignore-scripts=false",
      "--json",
      "--pack-destination",
      packedRoot,
    ],
  );
  expect(packed.status, packed.stderr).toBe(0);
  const packedResult = Schema.decodeUnknownSync(PackResult)(
    JSON.parse(packed.stdout),
  );
  const tarball = resolve(packedRoot, packedResult[0]!.filename);
  // Install as an ordinary consumer without root overrides. Every runtime
  // package that must share Canonfig's Effect release candidate is a direct,
  // exact dependency of the published package.
  writeFileSync(
    resolve(installRoot, "package.json"),
    `${JSON.stringify({ private: true })}\n`,
  );
  const installed = runNpm(
    installRoot,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
  );
  expect(installed.status, installed.stderr).toBe(0);
  executable = process.execPath;
  packedEntry = resolve(packageRoot, "dist", "runtime", "main.js");
  expect(readFileSync(resolve(packageRoot, "package.json"), "utf8"))
    .toContain('"canonfig": "dist/runtime/main.js"');

  authorSourceFolder(source.folder, 1);
  requireSuccess(invoke(source, ["source", "init", "--json"]), "source init");
  const published = requireSuccess(
    invoke(source, ["source", "publish", "--reviewer", "packed-test", "--json"]),
    "publish the Source folder",
  );
  packedRevision = String(published.data.id);
  const port = await unusedPort();
  sourceEndpoint = (await startPackedSource(port)).endpoint;
}, 360_000);

afterAll(() => {
  sourceProcess?.kill("SIGKILL");
  rmSync(packedRoot, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 10 : 0,
    retryDelay: 100,
  });
});

describe("packed Canonfig executable", () => {
  it("runs shipped help and version entrypoints", () => {
    const help = invoke(source, ["--help"]);
    const version = invoke(bare, ["--version"]);
    const versionJson = invoke(bare, ["--version", "--json"]);
    const sourceStatus = invoke(source, ["status", "--json"]);
    expect(help).toMatchObject({ status: 0, stderr: "" });
    expect(help.stdout).toContain("Usage: canonfig");
    expect(version).toMatchObject({ status: 0, stdout: "5.0.1\n", stderr: "" });
    expect(versionJson).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(versionJson.stdout)).toMatchObject({
      packageVersion: "5.0.1",
      sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(sourceStatus).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(sourceStatus.stdout).data.machineRole).toMatchObject({
      role: "source",
      sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      tlsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("runs representative safe routes with stable JSON", () => {
    const profiles = invoke(bare, ["profile", "list", "--json"]);
    expect(profiles).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(profiles.stdout)).toMatchObject({
      schema: "canonfig.cli/v1",
      command: "profile.list",
      status: "success",
      exitCode: 0,
      data: { revisions: [] },
    });

    const policy = invoke(bare, ["agent", "policy", "deterministic-only", "--json"]);
    expect(policy).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(policy.stdout)).toMatchObject({
      command: "agent.policy.set",
      exitCode: 0,
      data: "deterministic-only",
    });
  });

  it("maps invalid input to the stable usage exit code", () => {
    const result = invoke(bare, ["sync", "--plan", "--apply"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--plan and --apply are mutually exclusive");
  });

  it("publishes the Canonical Folder into a signed immutable revision and republishes equal content idempotently", () => {
    const shown = requireSuccess(
      invoke(source, ["profile", "show", packedRevision, "--json"]),
      "show the published revision",
    );
    expect(shown.data).toMatchObject({
      id: packedRevision,
      profileId: "packed-profile",
      signature: expect.stringMatching(/^ed25519:/u),
      scheduleDefault: { type: "daily", at: "04:30", timezone: "local" },
      groups: [{ name: "restricted" }, { name: "secrets" }],
    });
    expect(shown.data.resources.map((resource: { readonly id: string }) => resource.id).sort())
      .toEqual([
        "credentials:docs-token",
        "harnesses",
        "hook-scripts:format.sh",
        "hooks:format",
        "instructions",
        "local-policy",
        "mcp:docs",
        "mcp:node-version",
        "rules:style",
        "settings:claude-code",
        "skills:deploy",
        "skills:restricted",
        "tools:human",
        "tools:node",
        "tools:probe",
      ]);
    // Only the authoring allowlist is read, and the credential is a reference.
    expect(JSON.stringify(shown)).not.toContain(machineLocalSecret);
    expect(JSON.stringify(shown)).not.toContain("notes.txt");

    // Equal content is the same revision, not a new sequence.
    const republished = requireSuccess(
      invoke(source, ["source", "publish", "--reviewer", "packed-test", "--json"]),
      "republish equal content",
    );
    expect(republished.data.id).toBe(packedRevision);
    const listed = requireSuccess(invoke(source, ["profile", "list", "--json"]), "list revisions");
    expect(listed.data.revisions).toEqual([
      expect.objectContaining({ id: packedRevision, profileId: "packed-profile", sequence: 1 }),
    ]);
  });

  it("rejects malformed, escaping and secret-bearing folder input without leakage", () => {
    const secret = "packed-folder-secret-must-not-leak";
    const rejecting = machine("rejecting-source");
    requireSuccess(invoke(rejecting, ["source", "init", "--json"]), "init the rejecting Source");
    const valid = { version: 1, profile: { id: "rejected", name: "Rejected" }, harnesses: ["codex"] };
    const writeConfig = (config: Readonly<Record<string, ConfigValue>>) =>
      write(resolve(rejecting.folder, "canonfig.jsonc"), JSON.stringify(config));
    const cases: ReadonlyArray<readonly [string, () => void, string]> = [
      ["invalid canonfig.jsonc", () => write(resolve(rejecting.folder, "canonfig.jsonc"), `{"version": 1, "profile": `), "is not valid JSONC"],
      ["a literal credential in an MCP header", () => writeConfig({
        ...valid,
        mcp: { remote: { transport: "streamable-http", url: "https://example.test/mcp", headers: { Authorization: `Bearer ${secret}` } } },
      }), "literal credential"],
      ["a literal credential in an MCP environment entry", () => writeConfig({
        ...valid,
        mcp: { local: { transport: "stdio", command: "tool", env: { API_TOKEN: secret } } },
      }), "literal credential"],
      ["an undeclared canonfig.jsonc key", () => writeConfig({ ...valid, extra: true }), "extra"],
      ["a file in rules/ that is not a document", () => {
        writeConfig(valid);
        write(resolve(rejecting.folder, "rules", "notes.txt"), secret);
      }, "only <id>.md documents"],
      ["a hook script no hook runs", () => {
        writeConfig(valid);
        write(resolve(rejecting.folder, "hooks", "orphan.sh"), `#!/bin/sh\necho ${secret}\n`, 0o755);
      }, "is not run by any hook"],
      // Windows cannot create the link without privileges.
      ...process.platform === "win32" ? [] : [["instructions linked outside the folder", () => {
        writeConfig(valid);
        const outside = resolve(rejecting.home, "outside.md");
        write(outside, `${secret}\n`);
        symlinkSync(outside, resolve(rejecting.folder, "AGENTS.md"));
      }, "links and special files are not authoring input"] as const],
    ];
    for (const [name, author, message] of cases) {
      for (const entry of ["canonfig.jsonc", "AGENTS.md", "rules", "hooks"]) {
        rmSync(resolve(rejecting.folder, entry), { recursive: true, force: true });
      }
      author();
      const result = invoke(rejecting, ["source", "publish", "--reviewer", "packed-test", "--json"]);
      expect(result.status, `${name}: ${result.stdout}${result.stderr}`).toBe(2);
      expect(result.stdout, name).toBe("");
      expect(result.stderr, name).not.toContain(secret);
      expect(result.stderr, name).toContain("the publication input is not valid");
      expect(result.stderr, name).toContain(message);
    }
    // A refused publication stores nothing.
    expect(requireSuccess(invoke(rejecting, ["profile", "list", "--json"]), "list after refusals").data)
      .toEqual({ revisions: [] });
  }, 120_000);

  it("scans the Canonical Folder for tool evidence without writing it", () => {
    const configBefore = readText(resolve(source.folder, "canonfig.jsonc"));
    const scan = requireSuccess(invoke(source, ["source", "scan", "--json"]), "scan the Source folder");
    // The authoring entries, and nothing machine-local such as notes.txt.
    expect(scan.data.scannedPaths).toEqual([
      "AGENTS.md",
      "canonfig.jsonc",
      "hooks/format.sh",
      "rules/style.md",
      "skills/deploy/SKILL.md",
      "skills/deploy/scripts/run.sh",
      "skills/restricted/SKILL.md",
    ].map((path) => resolve(source.folder, path)));
    expect(scan.data.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "agents",
        invocation: ["npm", "install", "--global", "canonfig-fixture@1.0.0"],
        package: expect.objectContaining({ ecosystem: "npm", name: "canonfig-fixture", version: "1.0.0" }),
      }),
      expect.objectContaining({
        kind: "mcp",
        invocation: ["node", "--version"],
        location: { kind: "field", field: "mcp.node-version.command" },
      }),
    ]));
    expect(scan.data.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "canonfig-fixture",
        reviewStatus: "needs-review",
        recipes: [expect.objectContaining({ method: "npm", package: "canonfig-fixture", version: "1.0.0" })],
      }),
    ]));
    expect(readText(resolve(source.folder, "canonfig.jsonc"))).toBe(configBefore);
  });

  const transport = machine("transport-follower");

  it("exposes the published revision through signed follower transport", () => {
    enroll(transport, "packed-transport-follower");
    const plan = requireSuccess(invoke(transport, ["sync", "--plan", "--json"]), "plan over transport");
    expect(plan.data).toMatchObject({ revision: packedRevision, notInstalled: ["claude-code", "codex"] });
  });

  it("resolves the enrolled credential policy without the environment", () => {
    // A native scheduled job carries no environment, and the local-file policy
    // used to be selected only by CANONFIG_LOCAL_CREDENTIAL_ROOT, so a follower
    // enrolled under it had no credential during a scheduled run and every
    // fire failed. The enrolled configuration is the authority now.
    const withoutEnvironment = invoke(
      transport,
      ["status", "--json"],
      { CANONFIG_LOCAL_CREDENTIAL_ROOT: undefined },
    );
    expect(withoutEnvironment.status, withoutEnvironment.stderr).toBe(0);
    expect(JSON.parse(withoutEnvironment.stdout).data.follower.name).toBe(
      "packed-transport-follower",
    );

    // A plan needs the credential to authenticate to the source, so this is
    // the assertion that actually exercises credential resolution.
    const planned = invoke(
      transport,
      ["sync", "--plan", "--json"],
      { CANONFIG_LOCAL_CREDENTIAL_ROOT: undefined },
    );
    expect(planned.status, planned.stderr).toBe(0);

    // Conflicting environment hints must not replace the enrolled authority.
    const diagnosed = invoke(transport, [
      "doctor", "--no-input", "--timeout-ms", "5000", "--json",
    ], {
      CANONFIG_LOCAL_CREDENTIAL_ROOT: undefined,
      CANONFIG_SOURCE_ENDPOINT: "https://127.0.0.1:9",
      CANONFIG_SOURCE_TLS_FINGERPRINT: "0".repeat(64),
      CANONFIG_SOURCE_CREDENTIAL_REFERENCE: "local-file:/missing-doctor-fixture",
    });
    expect(parseEnvelope(diagnosed).data.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "source", status: "pass",
        details: { reachable: true, tlsPinned: true, authenticated: true },
      }),
    ]));
  });

  it("probes the agent policy the enrolled follower actually runs under", () => {
    // `agent policy` writes to the follower configuration once enrolled, and a
    // run reads it from there. The doctor probe read ~/.canonfig/policy.json,
    // which enrollment stops using, so an enrolled follower with an agent
    // policy and no harness reported a skipped probe instead of the failure a
    // run would hit.
    requireSuccess(invoke(transport, ["agent", "policy", "agent-apply", "--json"]), "set agent-apply");

    const result = invoke(
      transport,
      ["doctor", "--json", "--no-input", "--timeout-ms", "2000"],
    );
    const agentProbe = parseEnvelope(result).data.probes.find(
      (probe: { readonly name: string }) => probe.name === "agent-adapter",
    );
    expect(agentProbe).toMatchObject({
      name: "agent-adapter",
      status: "fail",
      details: { policy: "agent-apply", configured: false },
    });

    requireSuccess(invoke(transport, ["agent", "policy", "deterministic-only", "--json"]), "restore the policy");
  });

  it("refuses to replace a completed enrollment unless asked", () => {
    // A completed enrollment is a singleton. Enrolling over it silently left
    // the previous identity's records orphaned under an id nothing used.
    const again = invoke(transport, [
      "follower",
      "enroll",
      "--stdin",
      "--name",
      "packed-second-name",
      "--json",
    ], {}, envelopeInput(issueInvitation()));
    expect(again.status).toBe(4);
    const envelope = JSON.parse(again.stderr);
    expect(envelope.message).toContain("already enrolled");
    expect(envelope.message).toContain("--replace");

    // The original identity is untouched.
    const status = requireSuccess(invoke(transport, ["status", "--json"]), "status after refusal");
    expect(status.data.follower.name).toBe("packed-transport-follower");
  });

  it("runs doctor with bounded noninteractive probes and redaction", () => {
    const secret = "packed-doctor-secret-must-not-leak";
    const result = invoke(
      bare,
      ["doctor", "--json", "--no-input", "--timeout-ms", "2000"],
      {
        CANONFIG_SOURCE_ENDPOINT: "https://127.0.0.1:9",
        CANONFIG_SOURCE_TLS_FINGERPRINT: "packed-fingerprint",
        CANONFIG_SOURCE_CREDENTIAL_REFERENCE: secret,
      },
    );
    // The injected reference is not one this machine's local-file store owns,
    // so the source probe fails locally (CF-37: Human Action Required) and
    // makes no Source request, instead of reporting an authentication failure.
    const doctorExitCodes = process.platform === "win32" ? [3, 7] : [3];
    expect(doctorExitCodes).toContain(result.status);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(secret);
    const envelope = JSON.parse(result.stderr);
    expect(envelope).toMatchObject({
      schema: "canonfig.cli/v1",
      command: "doctor",
      status: "error",
      exitCode: result.status,
      data: {
        schema: "canonfig.doctor/v1",
        noInput: true,
        status: "unhealthy",
      },
    });
    expect(envelope.data.probes).toHaveLength(8);
    expect(envelope.data.probes).toContainEqual(expect.objectContaining({
      name: "source",
      status: "fail",
      category: "human-action-required",
    }));
  });

  it("keeps unavailable scheduled apply quiet on stdout and truthful on stderr", () => {
    const first = invoke(bare, ["sync", "--apply", "--no-input"]);
    const second = invoke(bare, ["sync", "--apply", "--no-input"]);
    expect(first.status).toBe(2);
    expect(first.stdout).toBe("");
    // Human output ends a failure with its exit code and category. An
    // unenrolled machine projects its own folder, which does not exist here.
    expect(first.stderr).toMatch(
      /canonfig\.jsonc: does not exist; scaffold the folder with 'canonfig setup plan --role source', or enroll this machine as a follower\nexit 2: usage or configuration\n$/u,
    );
    expect(second).toEqual(first);
    expect(first.stderr).not.toContain("completed");
  });

  // The installed CLI is JavaScript, so a native scheduled job has to name both
  // a Node runtime and the entrypoint. Prove the shipped layout resolves both
  // from the package itself, with no PATH and an unrelated working directory.
  it("binds the scheduled command to an absolute runtime and shipped entrypoint", () => {
    const moduleUrl = pathToFileURL(
      resolve(packageRoot, "dist", "schedule", "schedule-command.js"),
    ).href;
    const entrypoint = resolve(packageRoot, "dist", "runtime", "main.js");
    // The package root can sit behind a symlinked temporary directory, so the
    // entrypoint comparison has to go through realpath on both sides.
    const script = `
      const { realpathSync } = await import("node:fs");
      const { spawnSync } = await import("node:child_process");
      const { scheduleCommand } = await import(${JSON.stringify(moduleUrl)});
      const command = scheduleCommand();
      if (command.executable !== process.execPath) process.exit(90);
      if (realpathSync(command.arguments[0]) !== realpathSync(${JSON.stringify(entrypoint)})) {
        process.exit(91);
      }
      if (JSON.stringify(command.arguments.slice(1)) !==
          JSON.stringify(["sync", "--apply", "--no-input", "--scheduled"])) process.exit(92);
      const started = spawnSync(command.executable, [command.arguments[0], "--version"], {
        shell: false, encoding: "utf8", timeout: 30000, env: { ...process.env, PATH: "" },
      });
      if (started.error || started.status !== 0) process.exit(93);
      process.stdout.write(started.stdout);
    `;
    const result = spawnSync(executable, ["--input-type=module", "--eval", script], {
      cwd: packedRoot,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: "" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("runs an authenticated source-to-follower lifecycle across packed processes", () => {
    const laptop = machine("lifecycle-follower", ["claude-code"]);
    const follower = enroll(laptop, "packed-follower");

    // Every platform converges. This used to expect exit 7 on Linux, because
    // the plan always appended a schedule-default action and that action failed
    // without a systemd user session, so a container or headless host could
    // never converge. The native job is no longer a planned action.
    const first = requireSuccess(invoke(laptop, ["sync", "--apply", "--json"]), "first apply");
    expect(first).toMatchObject({
      command: "sync.apply",
      status: "success",
      exitCode: 0,
      data: {
        revision: packedRevision,
        notInstalled: ["codex"],
        outcome: { outcome: "Converged" },
      },
    });

    // The mirror holds what the Source published, rendered for this follower:
    // the grouped items stay with the Source.
    expect(readText(resolve(laptop.folder, "AGENTS.md"))).toBe(readText(resolve(source.folder, "AGENTS.md")));
    // Windows has no execute bit to carry.
    if (process.platform !== "win32") {
      expect(statSync(resolve(laptop.folder, "skills", "deploy", "scripts", "run.sh")).mode & 0o100).toBe(0o100);
    }
    expect(existsSync(resolve(laptop.folder, "skills", "restricted"))).toBe(false);
    expect(existsSync(resolve(laptop.folder, "notes.txt"))).toBe(false);
    const mirrorConfig = readJsonc(resolve(laptop.folder, "canonfig.jsonc"));
    expect(Object.keys(mirrorConfig.mcp).sort()).toEqual(["docs", "node-version"]);
    expect(mirrorConfig.settings).toEqual({ "claude-code": { model: "opus", cleanupPeriodDays: 30 } });
    // Tools and credentials are applied on the follower, never written into
    // its mirror, and the profile identity stays with the Source.
    expect(mirrorConfig.tools).toBeUndefined();
    expect(mirrorConfig.credentials).toBeUndefined();
    expect(mirrorConfig.profile).toBeUndefined();
    // The packed binary projected the mirror into the installed harness only.
    expect(readText(resolve(laptop.home, ".claude", "CLAUDE.md"))).toContain("Packed instructions");
    expect(readText(resolve(laptop.home, ".claude", "skills", "deploy", "SKILL.md"))).toContain("Run scripts/run.sh.");
    expect(readText(resolve(laptop.home, ".claude", "rules", "style.md"))).toContain("Use two spaces.");
    expect(JSON.parse(readText(resolve(laptop.home, ".claude.json"))).mcpServers).toMatchObject({
      docs: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "${DOCS_MCP_TOKEN}" } },
      "node-version": { type: "stdio", command: "node", args: ["--version"] },
    });
    expect(JSON.parse(readText(resolve(laptop.home, ".claude", "settings.json")))).toMatchObject({
      model: "opus",
      cleanupPeriodDays: 30,
    });
    expect(existsSync(resolve(laptop.home, ".codex"))).toBe(false);

    const second = requireSuccess(
      invoke(laptop, ["sync", "--apply", "--no-input", "--json"]),
      "second apply",
    );
    expect(second).toMatchObject({
      command: "sync.apply",
      status: "success",
      exitCode: 0,
      data: {
        revision: packedRevision,
        outcome: { outcome: "Converged" },
      },
    });

    const status = requireSuccess(invoke(laptop, ["status", "--json"]), "status");
    expect(status.data.follower.id).toBe(follower);
    expect(status.data.machineRole).toMatchObject({
      role: "follower",
      follower,
    });
    expect(status.data.completionReceipt.revision).toMatch(
      new RegExp(`^${packedRevision}:view:[a-f0-9]{64}$`, "u"),
    );
    expect(status.data.completionReceipt).toMatchObject({
      published: { status: "verified" },
      applied: { status: "verified" },
      // The node tool's verification runs node, which proves it loads.
      clientLoaded: { status: "verified" },
      scheduled: { status: "not-selected" },
      independentlyVerified: { status: "verified" },
      secondRunNoOp: true,
    });
    const recovery = invoke(laptop, ["recover", "--no-input", "--json"]);
    expect(recovery.status).toBe(2);
    expect(recovery.stdout).toBe("");
    expect(JSON.parse(recovery.stderr)).toMatchObject({
      command: "recover",
      status: "error",
      exitCode: 2,
    });

    // `abandon` is the terminal close for a run `recover` cannot resolve. It
    // reports the same way when there is nothing open, so an operator can tell
    // "nothing to abandon" from "abandoned it".
    const abandon = invoke(laptop, ["abandon", "--json"]);
    expect(abandon.status).toBe(2);
    expect(abandon.stdout).toBe("");
    expect(JSON.parse(abandon.stderr)).toMatchObject({
      command: "abandon",
      status: "error",
      exitCode: 2,
    });

    requireSuccess(invoke(source, ["source", "revoke", follower, "--json"]), "revoke");
    const rejected = invoke(laptop, ["sync", "--apply", "--json"]);
    expect(rejected.status).toBe(5);
    expect(rejected.stdout).toBe("");
  }, 180_000);

  it("rejects a tampered TLS fingerprint from the packed executable", () => {
    const tampered = machine("tampered-follower");
    enroll(tampered, "tampered-follower");
    const database = new DatabaseSync(tampered.state);
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
    const result = invoke(tampered, ["sync", "--apply", "--json"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(existsSync(resolve(tampered.folder, "AGENTS.md"))).toBe(false);
  }, 60_000);

  it("converges a packed source across multiple isolated followers", () => {
    const workstation = machine("workstation", ["claude-code"]);
    const restricted = machine("restricted");
    const rotated = machine("rotated");
    const revisionOne = packedRevision;

    const workstationId = enroll(workstation, "packed-workstation");
    enroll(restricted, "packed-restricted", ["restricted"]);
    const rotatedInvitation = issueInvitation([], "issue rotated invitation");
    const rotatedId = String(requireSuccess(
      invoke(rotated, ["follower", "enroll", "--stdin", "--name", "packed-rotated", "--json"], {}, envelopeInput(rotatedInvitation)),
      "enroll packed-rotated",
    ).data.follower.id);
    const replay = invoke(
      machine("replay"),
      ["follower", "enroll", "--stdin", "--name", "packed-replay", "--json"],
      {},
      envelopeInput(rotatedInvitation),
    );
    // Replaying a consumed invitation is an authorization refusal, not a
    // transport failure: the request reached the Source Machine and was
    // answered. It exited 6 only because the old categorizer matched the word
    // "Invitation" in the error type name and filed it under transport.
    expect(replay.status).toBe(5);
    expect(replay.stdout).toBe("");

    const workstationStatus = requireSuccess(
      invoke(workstation, ["status", "--json"]),
      "render workstation status",
    );
    expect(workstationStatus.data.follower.id).toBe(workstationId);
    expect(workstationStatus.data.sourceIdentity).toMatchObject({
      publicKeyFingerprint: expect.any(String),
    });
    expect(statSync(workstation.state).isFile()).toBe(true);

    // The workstation already used Claude Code: its own instructions, a
    // setting, and the account state Claude keeps in ~/.claude.json.
    write(resolve(workstation.home, ".claude", "CLAUDE.md"), "# The workstation's own instructions\n");
    write(resolve(workstation.home, ".claude", "settings.json"), `${JSON.stringify({ theme: "dark" })}\n`);
    write(
      resolve(workstation.home, ".claude.json"),
      `${JSON.stringify({ oauthAccount: { emailAddress: "workstation@example.test" } })}\n`,
    );

    const workstationPlan = requireSuccess(
      invoke(workstation, ["sync", "--plan", "--json"]),
      "plan workstation revision one",
    );
    const planOne = workstationPlan.data.plan;
    expect(workstationPlan.data).toMatchObject({
      revision: revisionOne,
      downloadedBlobs: expect.any(Number),
      reusedBlobs: expect.any(Number),
    });
    expect(
      Number(workstationPlan.data.downloadedBlobs)
        + Number(workstationPlan.data.reusedBlobs),
    ).toBeGreaterThan(0);
    const planned = planOne.actions.map((action: { readonly resource: string }) => action.resource);
    expect(planned).toEqual(expect.arrayContaining([
      "instructions",
      "rules:style",
      "skills:deploy",
      "tools:node",
      "tools:probe",
      "harness:claude-code:instructions",
      "harness:claude-code:mcp",
      "harness:claude-code:settings",
      "harness:claude-code:skills",
    ]));
    // Grouped items never reach a follower outside their group.
    expect(planned).not.toContain("skills:restricted");
    expect(planned).not.toContain("tools:human");
    expect(planned).not.toContain("credentials:docs-token");

    // The restricted group admits its items, including a tool nobody can
    // install automatically.
    const restrictedPlanOne = requireSuccess(
      invoke(restricted, ["sync", "--plan", "--json"]),
      "plan restricted follower revision one",
    ).data.plan;
    expect(restrictedPlanOne.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: "skills:restricted" }),
      expect.objectContaining({ resource: "tools:human", kind: "human-action" }),
    ]));

    const doctor = requireSuccess(
      invoke(
        workstation,
        ["doctor", "--no-input", "--timeout-ms", "10000", "--json"],
        {
          CANONFIG_SOURCE_ENDPOINT: sourceEndpoint,
          CANONFIG_SOURCE_TLS_FINGERPRINT: String(
            JSON.parse(Buffer.from(issueInvitation(), "base64url").toString("utf8")).tlsFingerprint,
          ),
          CANONFIG_SOURCE_CREDENTIAL_REFERENCE: workstationStatus.data.follower.credentialReference,
        },
      ),
      "run healthy doctor probes",
    );
    expect(doctor.data).toMatchObject({
      schema: "canonfig.doctor/v1",
      status: "degraded",
      noInput: true,
      probes: expect.arrayContaining([
        expect.objectContaining({ name: "source", status: "pass" }),
        expect.objectContaining({ name: "credentials", status: "warning" }),
      ]),
    });

    const firstApply = requireSuccess(
      invoke(workstation, ["sync", "--apply", "--json"]),
      "apply workstation revision one",
    );
    // The plan already fetched every blob; the apply reuses them.
    expect(firstApply.data).toMatchObject({
      revision: revisionOne,
      downloadedBlobs: 0,
      outcome: { outcome: "Converged" },
    });
    const claude = resolve(workstation.home, ".claude");
    expect(readText(resolve(claude, "CLAUDE.md"))).toContain("# Packed instructions");
    if (process.platform !== "win32") {
      expect(statSync(resolve(claude, "skills", "deploy", "scripts", "run.sh")).mode & 0o100).toBe(0o100);
    }
    // Canonfig owns only its keys in the files Claude shares with its own state.
    expect(JSON.parse(readText(resolve(claude, "settings.json")))).toMatchObject({
      theme: "dark",
      model: "opus",
      cleanupPeriodDays: 30,
    });
    expect(JSON.parse(readText(resolve(workstation.home, ".claude.json")))).toMatchObject({
      oauthAccount: { emailAddress: "workstation@example.test" },
      mcpServers: { docs: expect.any(Object), "node-version": expect.any(Object) },
    });
    // Taking over Claude Code first snapshotted what the workstation had.
    const snapshots = readdirSync(resolve(workstation.folder, ".backups"));
    expect(snapshots).toHaveLength(1);
    expect(existsSync(resolve(workstation.folder, ".backups", snapshots[0]!, "manifest.json"))).toBe(true);
    expect(readText(resolve(workstation.folder, ".backups", snapshots[0]!, "claude-code", ".claude", "CLAUDE.md")))
      .toBe("# The workstation's own instructions\n");

    // Native scheduling is reconciled only after the first successful apply;
    // this follower now selects its required 04:00 Madrid calendar.
    const schedulerInstall = invoke(workstation, [
      "schedule",
      "set",
      "daily@04:00",
      "--timezone",
      "Europe/Madrid",
      "--json",
    ]);
    if (process.platform !== "linux" && schedulerInstall.status !== 0) {
      console.warn(
        `native scheduler installation unavailable on ${process.platform}; `
          + "packed multi-follower coverage stops after the first apply "
          + `(${schedulerInstall.stderr.trim()})`,
      );
      return;
    }
    requireSuccess(schedulerInstall, "install the native scheduler");
    const schedulerState = requireSuccess(
      invoke(workstation, ["schedule", "status", "--json"]),
      "verify installed native scheduler",
    );
    expect(schedulerState.data.state).toBe("current");
    expect(schedulerState.data.schedule).toMatchObject({
      kind: "daily",
      localTime: "04:00",
      timezone: "Europe/Madrid",
    });
    expect(schedulerState.data).toMatchObject({
      platform: process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
        ? "windows"
        : "linux",
      definition: {
        mechanism: process.platform === "darwin"
          ? "launchd-user-agent"
          : process.platform === "win32"
          ? "task-scheduler"
          : "systemd-user-timer",
      },
    });

    const secondApply = requireSuccess(
      invoke(workstation, ["sync", "--apply", "--no-input", "--scheduled", "--json"]),
      "run the native unattended command without mutations",
    );
    expect(secondApply.data).toMatchObject({
      revision: revisionOne,
      downloadedBlobs: 0,
      reusedBlobs: expect.any(Number),
      outcome: { outcome: "Converged" },
    });
    expect(secondApply.data.outcome.verified).toEqual(expect.arrayContaining([
      "instructions",
      "mirror:canonfig.jsonc",
      "skills:deploy",
      "tools:node",
      "tools:probe",
      "harness:claude-code:instructions",
      "harness:claude-code:mcp",
      "harness:claude-code:settings",
      "harness:claude-code:skills",
    ]));
    const completionStatus = requireSuccess(
      invoke(workstation, ["status", "--json"]),
      "render the final completion receipt",
    );
    // The receipt names the view of revision one that the last run applied.
    expect(completionStatus.data.completionReceipt).toMatchObject({
      revision: expect.stringMatching(new RegExp(`^${revisionOne}:view:[a-f0-9]{64}$`, "u")),
      published: { status: "verified" },
      applied: { status: "verified" },
      clientLoaded: { status: "verified" },
      scheduled: { status: "verified" },
      independentlyVerified: { status: "verified" },
      secondRunNoOp: true,
    });

    const oldRotatedReference = String(requireSuccess(
      invoke(rotated, ["status", "--json"]),
      "capture pre-revocation follower status",
    ).data.follower.credentialReference);
    const oldRotatedCredential = readText(oldRotatedReference.replace(/^local-file:/u, ""));

    authorSourceFolder(source.folder, 2);
    const revisionTwo = String(requireSuccess(
      invoke(source, ["source", "publish", "--reviewer", "packed-multi-reviewer", "--json"]),
      "publish revision two",
    ).data.id);
    expect(revisionTwo).not.toBe(revisionOne);

    const scheduleDrift = requireSuccess(
      invoke(workstation, ["schedule", "set", "daily@01:00", "--json"]),
      "mutate native schedule before revision two",
    );
    expect(scheduleDrift.data).toMatchObject({ status: { state: "current" } });

    // The apply of revision two dies mid-run, after its artifacts and journal
    // are on disk; `recover` finishes it from the journal.
    write(crashMarker, "armed\n");
    const interrupted = invoke(workstation, ["sync", "--apply", "--no-input", "--json"]);
    expect(interrupted.signal, interrupted.stdout + interrupted.stderr).toBe("SIGKILL");
    expect(readText(crashMarker)).toBe("");
    const recovered = requireSuccess(
      invoke(workstation, ["recover", "--no-input", "--json"]),
      "recover the interrupted apply",
    );
    expect(recovered.data).toMatchObject({
      revision: expect.stringMatching(new RegExp(`^${revisionTwo}:view:`, "u")),
      outcome: { outcome: "Converged", run: expect.any(String) },
    });
    expect(readText(resolve(claude, "CLAUDE.md"))).toContain("Packed instructions, second edition");
    expect(readText(resolve(claude, "skills", "deploy", "SKILL.md"))).toContain("Deploy, second edition.");
    expect(existsSync(resolve(claude, "skills", "deploy", "scripts"))).toBe(false);
    // `cleanupPeriodDays` was declared in revision one and dropped in revision
    // two, so it is gone; the workstation's own key stays.
    expect(JSON.parse(readText(resolve(claude, "settings.json")))).toEqual(expect.objectContaining({
      theme: "dark",
      model: "opus",
    }));
    expect(JSON.parse(readText(resolve(claude, "settings.json"))).cleanupPeriodDays).toBeUndefined();
    expect(JSON.parse(readText(resolve(workstation.home, ".claude.json"))).oauthAccount)
      .toEqual({ emailAddress: "workstation@example.test" });

    // A broken native scheduler no longer fails the run. Scheduler
    // reconciliation is not part of the resource transaction, so it cannot roll
    // back configuration that applied correctly, and the follower converges on
    // a host whose scheduler does not work at all.
    const brokenScheduler = invoke(
      workstation,
      ["sync", "--apply", "--no-input", "--json"],
      process.platform === "linux" ? { CANONFIG_SYSTEMCTL: failingSystemctl } : {},
    );
    expect(brokenScheduler.status, brokenScheduler.stderr).toBe(0);
    expect(parseEnvelope(brokenScheduler).data).toMatchObject({
      revision: revisionTwo,
      outcome: { outcome: "Converged" },
    });
    // The operator's own `schedule set daily@01:00` survives the apply. It used
    // to last exactly one run, because the plan reinstalled the profile default
    // over it every time.
    expect(requireSuccess(
      invoke(workstation, ["schedule", "status", "--json"]),
      "verify the follower's own schedule survives an apply",
    ).data.schedule).toMatchObject({ kind: "daily", localTime: "01:00" });

    const restrictedPlan = requireSuccess(
      invoke(restricted, ["sync", "--plan", "--json"]),
      "plan restricted follower after resource removal",
    ).data.plan;
    expect(restrictedPlan.revision.split(":view:")[0]).toBe(revisionTwo);
    const restrictedResources = restrictedPlan.actions.map((action: { readonly resource: string }) => action.resource);
    expect(restrictedResources).not.toContain("skills:restricted");
    expect(restrictedResources).not.toContain("tools:human");
    const restrictedApply = requireSuccess(
      invoke(restricted, ["sync", "--apply", "--no-input", "--json"]),
      "apply the restricted follower's authorized view",
    );
    // No listed harness is installed there; the mirror still converges.
    expect(restrictedApply.data).toMatchObject({
      notInstalled: ["claude-code", "codex"],
      outcome: { outcome: "Converged" },
      // The restricted follower never ran `schedule set`: the profile default
      // is offered, never installed (CF-47).
      schedule: { action: "available" },
    });
    expect(requireSuccess(
      invoke(restricted, ["schedule", "status", "--json"]),
      "verify the restricted follower's profile default was not installed",
    ).data).toMatchObject({ state: "not-selected" });
    expect(existsSync(resolve(restricted.folder, "skills", "restricted"))).toBe(false);
    expect(readText(resolve(restricted.folder, "AGENTS.md"))).toBe("# Packed instructions, second edition\n");

    const revoked = requireSuccess(
      invoke(source, ["source", "revoke", rotatedId, "--json"]),
      "revoke rotated follower",
    );
    expect(revoked.data).toMatchObject({ follower: rotatedId, revoked: true });
    const denied = invoke(rotated, ["sync", "--plan", "--json"]);
    expect(denied.status).toBe(5);
    expect(denied.stdout).toBe("");
    expect(JSON.parse(denied.stderr)).toMatchObject({
      command: "sync.plan",
      exitCode: 5,
      message: "the follower credential has been revoked",
    });

    expect(enroll(rotated, "packed-rotated")).toBe(rotatedId);
    const newRotatedStatus = requireSuccess(
      invoke(rotated, ["status", "--json"]),
      "capture post-reenrollment follower status",
    );
    // Rotation stores the new credential as a new item and retires the old
    // one, so the superseded credential no longer exists on the follower.
    const newRotatedReference = String(newRotatedStatus.data.follower.credentialReference);
    expect(newRotatedReference).not.toBe(oldRotatedReference);
    expect(readText(newRotatedReference.replace(/^local-file:/u, ""))).not.toBe(oldRotatedCredential);
    expect(existsSync(oldRotatedReference.replace(/^local-file:/u, ""))).toBe(false);
    expect(newRotatedStatus.data.sourceIdentity).toMatchObject({
      publicKeyFingerprint: workstationStatus.data.sourceIdentity.publicKeyFingerprint,
    });
    expect(requireSuccess(
      invoke(rotated, ["sync", "--plan", "--json"]),
      "plan rotated follower after reenrollment",
    ).data.revision).toBe(revisionTwo);
  }, 600_000);
});
