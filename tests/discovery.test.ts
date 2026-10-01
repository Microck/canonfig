import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanDiscovery } from "../src/profile/discovery.ts";
import {
  DiscoveryParseError,
  InvalidDiscoveryInputError,
} from "../src/profile/profile-catalog.errors.ts";
import { ProfileCatalogLive } from "../src/profile/profile-catalog.layer.ts";
import { ProfileCatalog } from "../src/profile/profile-catalog.service.ts";

describe("profile discovery", () => {
  let directory = "";
  let fixtureBin = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "canonfig-discovery-"));
    fixtureBin = join(directory, "bin");
    await mkdir(fixtureBin);
    const executable = join(fixtureBin, "rg");
    await writeFile(executable, "#!/bin/sh\nprintf 'ripgrep 14.1.0\\n'\n");
    await chmod(executable, 0o755);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const fixture = async (name: string, content: string): Promise<string> => {
    const path = join(directory, name);
    await writeFile(path, content);
    return path;
  };

  it("scans executable shell blocks while keeping prose as review-only evidence", async () => {
    const agents = await fixture("AGENTS.md", [
      "# Agent instructions",
      "Run `prose-only --fast` if you happen to have it.",
      "A plain sentence mentioning imaginary-cli is not an invocation.",
      "```sh",
      "rg --files",
      "npm install --global @scope/real-cli@2.4.0",
      "```",
      "Read skills/refactor/SKILL.md before refactors.",
      "",
    ].join("\n"));

    const result = await Effect.runPromise(scanDiscovery({
      files: [{ path: agents, kind: "agents" }],
      path: fixtureBin,
    }));

    const ripgrep = result.tools.find((tool) => tool.id === "rg");
    expect(ripgrep).toMatchObject({
      executable: "rg",
      reviewStatus: "needs-review",
      verify: { command: ["rg", "--version"] },
    });
    expect(ripgrep?.evidence[0]).toMatchObject({
      sourcePath: agents,
      location: { kind: "line", line: 5 },
      resolvedExecutable: join(fixtureBin, "rg"),
      confidence: "deterministic",
      reviewStatus: "accepted",
    });

    const prose = result.tools.find((tool) => tool.id === "prose-only");
    expect(prose).toMatchObject({ recipes: [], reviewStatus: "needs-review" });
    expect(prose?.evidence[0]).toMatchObject({
      kind: "prose",
      confidence: "review",
      reviewStatus: "needs-review",
    });
    expect(result.tools.some((tool) => tool.id === "imaginary-cli")).toBe(false);

    const npmTool = result.tools.find((tool) => tool.id === "real-cli");
    expect(npmTool?.recipes).toEqual([
      expect.objectContaining({
        method: "npm",
        package: "@scope/real-cli",
        version: "2.4.0",
        command: [
          "npm",
          "install",
          "--global",
          "@scope/real-cli@2.4.0",
          "--ignore-scripts",
        ],
      }),
    ]);
    expect(result.skills).toEqual([
      expect.objectContaining({
        kind: "skill",
        id: "refactor",
        sourcePath: agents,
        reviewStatus: "needs-review",
      }),
    ]);
  });

  it("discovers hook and MCP command fields with field locations", async () => {
    const rgHook = join(fixtureBin, "rg");
    const settings = await fixture("settings.json", JSON.stringify({
      hooks: {
        preCommit: { command: "rg", args: ["TODO", "."] },
      },
      mcpServers: {
        docs: { command: "missing-mcp", args: ["serve"] },
      },
    }, null, 2));

    const result = await Effect.runPromise(scanDiscovery({
      files: [{ path: settings, kind: "tool-config" }],
      path: fixtureBin,
    }));

    expect(result.tools.find((tool) => tool.id === "rg")?.evidence[0]).toMatchObject({
      kind: "hook",
      location: { kind: "field", field: "hooks.preCommit.command" },
      invocation: ["rg", "TODO", "."],
      resolvedExecutable: rgHook,
    });
    expect(result.tools.find((tool) => tool.id === "missing-mcp")?.evidence[0]).toMatchObject({
      kind: "mcp",
      location: { kind: "field", field: "mcpServers.docs.command" },
      invocation: ["missing-mcp", "serve"],
    });
    expect(result.agentTasks.filter((task) => task.toolId === "missing-mcp").map((task) => task.reason))
      .toEqual(["missing-upstream", "unresolved-executable"]);
  });

  it("does not accept an npm runner as evidence of the package's executable", async () => {
    const mcp = await fixture(".claude.json", JSON.stringify({
      mcpServers: {
        everything: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-everything@2026.8.31", "stdio"],
        },
      },
    }));
    const scan = async (files: ReadonlyArray<{ path: string }>) => Effect.runPromise(scanDiscovery({
      files,
      path: fixtureBin,
    }));

    const withoutBin = await scan([{ path: mcp }]);
    expect(withoutBin.tools.find((tool) => tool.id === "server-everything")).toMatchObject({
      reviewStatus: "needs-review",
      verify: { method: "executable-present" },
    });
    expect(withoutBin.agentTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolId: "server-everything", reason: "unresolved-executable" }),
    ]));

    const lock = await fixture("package-lock.json", JSON.stringify({
      packages: {
        "node_modules/@modelcontextprotocol/server-everything": {
          version: "2026.8.31",
          bin: { "mcp-server-everything": "dist/index.js" },
        },
      },
    }));
    const withBin = await scan([{ path: mcp }, { path: lock }]);
    expect(withBin.tools.find((tool) => tool.id === "server-everything")).toMatchObject({
      executable: "mcp-server-everything",
      reviewStatus: "needs-review",
      verify: { method: "executable-present", executable: "mcp-server-everything" },
    });
    expect(withBin.agentTasks.some((task) =>
      task.toolId === "server-everything" && task.reason === "unresolved-executable"
    )).toBe(false);
  });

  it("does not turn npm git dependencies into deterministic recipes", async () => {
    const agents = await fixture("AGENTS.md", [
      "```sh",
      "npm install git+https://github.com/example/tool.git#v1.2.3",
      "```",
      "",
    ].join("\n"));

    const result = await Effect.runPromise(scanDiscovery({
      files: [{ path: agents, kind: "agents" }],
      path: fixtureBin,
    }));

    expect(result.tools).toEqual([
      expect.objectContaining({
        recipes: [],
        reviewStatus: "needs-review",
      }),
    ]);
  });

  it("keeps uv binary-only defaults and preserves reviewed sdist build policy", async () => {
    const metadata = await fixture("package.json", JSON.stringify({
      canonfig: {
        tools: [
          {
            ecosystem: "uv",
            name: "binary-tool",
            version: "1.0.0",
            source: "uv.lock",
            upstream: "https://pypi.org/project/binary-tool/",
          },
          {
            ecosystem: "uv",
            name: "sdist-tool",
            version: "2.0.0",
            source: "pyproject.toml",
            upstream: "https://pypi.org/project/sdist-tool/",
            buildPolicy: {
              mode: "required",
              reviewedBy: "fixture-reviewer",
              reviewedAt: "2026-08-16T00:00:00Z",
              executables: ["python"],
              paths: ["/tmp/sdist-tool"],
              origins: ["https://pypi.org"],
              capabilities: ["execute", "read-files", "write-files"],
              steps: [{
                executable: "python",
                arguments: ["-m", "build"],
              }],
            },
          },
        ],
      },
    }, null, 2));

    const result = await Effect.runPromise(scanDiscovery({
      files: [{ path: metadata, kind: "package-metadata" }],
      path: fixtureBin,
    }));

    expect(result.tools.find((tool) => tool.id === "binary-tool")?.recipes[0])
      .toMatchObject({
        method: "uv",
        buildPolicy: { mode: "scripts-disabled" },
        command: [
          "uv",
          "tool",
          "install",
          "binary-tool==1.0.0",
          "--no-build",
          "--no-python-downloads",
          "--no-config",
          "--default-index=https://pypi.org/simple",
        ],
      });
    expect(result.tools.find((tool) => tool.id === "sdist-tool")?.recipes[0])
      .toMatchObject({
        method: "uv",
        buildPolicy: {
          mode: "required",
          reviewedBy: "fixture-reviewer",
          steps: [{ executable: "python", arguments: ["-m", "build"] }],
        },
        command: [
          "uv",
          "tool",
          "install",
          "sdist-tool==2.0.0",
          "--no-python-downloads",
          "--no-config",
          "--default-index=https://pypi.org/simple",
        ],
      });
  });

  it("rejects npm source, alias, and separator specifications during discovery", async () => {
    const agents = await fixture("AGENTS.md", [
      "```sh",
      "npm install git+https://github.com/example/tool.git#v1.2.3",
      "npm install alias@github:example/real-tool",
      "npm install @scope/alias@git+https://github.com/example/scoped-tool.git",
      "npm install -- --ignore-scripts",
      "```",
      "",
    ].join("\n"));

    const result = await Effect.runPromise(scanDiscovery({
      files: [{ path: agents, kind: "agents" }],
      path: fixtureBin,
    }));

    expect(result.tools.every((tool) => tool.recipes.length === 0)).toBe(true);
    expect(result.tools.map((tool) => tool.id)).toEqual(["npm"]);
  });

  it("scans executable hook scripts and npm lockfile bin metadata", async () => {
    const hook = await fixture("pre-commit.sh", "#!/bin/sh\nrg --quiet TODO .\n");
    const lockfile = await fixture("package-lock.json", JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/locked-cli": {
          name: "locked-cli",
          version: "8.1.0",
          resolved: "https://registry.npmjs.org/locked-cli/-/locked-cli-8.1.0.tgz",
          integrity: "sha512-c2FtcGxl",
          bin: { locked: "bin/locked.js" },
        },
      },
    }, null, 2));

    const result = await Effect.runPromise(scanDiscovery({
      files: [
        { path: lockfile, kind: "package-metadata" },
        { path: hook, kind: "hooks" },
      ],
      path: fixtureBin,
    }));

    expect(result.tools.find((tool) => tool.id === "rg")?.evidence[0]).toMatchObject({
      kind: "hook",
      location: { kind: "line", line: 2 },
      resolvedExecutable: join(fixtureBin, "rg"),
    });
    expect(result.tools.find((tool) => tool.id === "locked-cli")).toMatchObject({
      executable: "locked",
      recipes: [
        expect.objectContaining({
          method: "npm",
          package: "locked-cli",
          version: "8.1.0",
          source: "https://registry.npmjs.org/locked-cli/-/locked-cli-8.1.0.tgz",
          integrity: "sha512-c2FtcGxl",
        }),
      ],
    });
  });

  it("uses package-manager metadata for every supported deterministic recipe", async () => {
    const packageJson = await fixture("package.json", JSON.stringify({
      name: "fixture-package",
      version: "3.0.0",
      repository: "https://github.com/example/fixture-package",
      bin: { fixture: "./cli.js" },
      canonfig: {
        tools: [
          {
            ecosystem: "npm",
            name: "@example/npm-tool",
            executable: "npm-tool",
            version: "1.2.3",
            source: "package-lock.json",
            upstream: "https://github.com/example/npm-tool",
          },
          {
            ecosystem: "homebrew",
            name: "brew-tool",
            executable: "brew-tool",
            version: "2.0",
            source: "Brewfile.lock.json",
            upstream: "https://github.com/example/brew-tool",
          },
          {
            ecosystem: "winget",
            name: "Example.WingetTool",
            executable: "winget-tool",
            version: "4.5.6",
            source: "winget-pkgs manifest",
            upstream: "https://github.com/example/winget-tool",
          },
          {
            ecosystem: "uv",
            name: "uv-tool",
            executable: "uv-tool",
            version: "5.0.0",
            source: "uv.lock",
            upstream: "https://github.com/example/uv-tool",
          },
          {
            ecosystem: "cargo",
            name: "cargo-tool",
            executable: "cargo-tool",
            version: "6.7.8",
            source: "Cargo.lock",
            upstream: "https://github.com/example/cargo-tool",
          },
          {
            ecosystem: "source",
            name: "source-tool",
            executable: "source-tool",
            version: "v7.0.0",
            source: "https://github.com/example/source-tool",
            upstream: "https://github.com/example/source-tool",
            buildCommands: [
              ["cmake", "-S", ".", "-B", "build"],
              ["cmake", "--build", "build"],
            ],
            buildPolicy: {
              mode: "required",
              reviewedBy: "fixture-reviewer",
              reviewedAt: "2026-08-15T00:00:00Z",
              executables: ["cmake"],
              paths: ["/tmp/source-tool"],
              origins: ["https://github.com"],
              capabilities: ["execute", "read-files", "write-files"],
              steps: [
                { executable: "cmake", arguments: ["-S", ".", "-B", "build"] },
                { executable: "cmake", arguments: ["--build", "build"] },
              ],
            },
          },
        ],
      },
    }, null, 2));

    const result = await Effect.runPromise(scanDiscovery({
      files: [{ path: packageJson, kind: "package-metadata" }],
      path: fixtureBin,
    }));

    expect(result.tools.find((tool) => tool.id === "fixture-package")).toMatchObject({
      upstream: "https://github.com/example/fixture-package",
      recipes: [
        expect.objectContaining({
          method: "npm",
          package: "fixture-package",
          version: "3.0.0",
        }),
      ],
    });
    expect(result.tools.find((tool) => tool.id === "npm-tool")?.recipes[0]).toMatchObject({
      method: "npm",
      command: [
        "npm",
        "install",
        "--global",
        "@example/npm-tool@1.2.3",
        "--ignore-scripts",
      ],
    });
    expect(result.tools.find((tool) => tool.id === "brew-tool")?.recipes[0]).toMatchObject({
      method: "homebrew",
      command: ["brew", "install", "brew-tool@2.0"],
    });
    expect(result.tools.find((tool) => tool.id === "example.wingettool")?.recipes[0]).toMatchObject({
      method: "winget",
      command: [
        "winget",
        "install",
        "--id",
        "Example.WingetTool",
        "--version",
        "4.5.6",
        "--exact",
      ],
    });
    expect(result.tools.find((tool) => tool.id === "uv-tool")?.recipes[0]).toMatchObject({
      method: "uv",
      command: [
        "uv",
        "tool",
        "install",
        "uv-tool==5.0.0",
        "--no-build",
        "--no-python-downloads",
        "--no-config",
        "--default-index=https://pypi.org/simple",
      ],
    });
    expect(result.tools.find((tool) => tool.id === "cargo-tool")?.recipes[0]).toMatchObject({
      method: "cargo",
      command: ["cargo", "install", "cargo-tool", "--version", "6.7.8", "--locked"],
      buildPolicy: { mode: "scripts-disabled" },
    });
    expect(result.tools.find((tool) => tool.id === "source-tool")?.recipes[0]).toMatchObject({
      method: "source",
      repository: "https://github.com/example/source-tool",
      revision: "v7.0.0",
      buildCommands: [
        ["cmake", "-S", ".", "-B", "build"],
        ["cmake", "--build", "build"],
      ],
    });
  });

  it("discovers Brewfile, winget, Cargo, and pyproject package metadata", async () => {
    const brewfile = await fixture("Brewfile", 'brew "ripgrep", version: "14.1.0"\n');
    const winget = await fixture("fixture.winget.yaml", [
      "PackageIdentifier: BurntSushi.ripgrep.MSVC",
      "PackageVersion: 14.1.0",
      "PackageUrl: https://github.com/BurntSushi/ripgrep",
    ].join("\n"));
    const cargo = await fixture("Cargo.toml", [
      "[package]",
      'name = "cargo-fixture"',
      'version = "1.3.0"',
      'repository = "https://github.com/example/cargo-fixture"',
    ].join("\n"));
    const pyproject = await fixture("pyproject.toml", [
      "[project]",
      'name = "python-fixture"',
      'version = "2.1.0"',
      "[project.scripts]",
      'pyfixture = "fixture:main"',
      "[project.urls]",
      'Repository = "https://github.com/example/python-fixture"',
    ].join("\n"));

    const result = await Effect.runPromise(scanDiscovery({
      files: [
        { path: pyproject, kind: "package-metadata" },
        { path: cargo, kind: "package-metadata" },
        { path: winget, kind: "package-metadata" },
        { path: brewfile, kind: "package-metadata" },
      ],
      path: fixtureBin,
    }));

    expect(result.tools.find((tool) => tool.id === "ripgrep")?.recipes[0]).toMatchObject({
      method: "homebrew",
      version: "14.1.0",
    });
    expect(result.tools.find((tool) => tool.id === "burntsushi.ripgrep.msvc")?.recipes[0])
      .toMatchObject({ method: "winget", version: "14.1.0" });
    expect(result.tools.find((tool) => tool.id === "cargo-fixture")?.recipes[0])
      .toMatchObject({ method: "cargo", version: "1.3.0" });
    expect(result.tools.find((tool) => tool.id === "python-fixture")?.recipes[0])
      .toMatchObject({ method: "uv", version: "2.1.0" });
  });

  it("emits bounded tasks for ambiguous and incomplete evidence without guessing", async () => {
    const metadata = await fixture("package.json", JSON.stringify({
      canonfig: {
        tools: [
          {
            ecosystem: "npm",
            name: "ambiguous",
            version: "1.0.0",
            source: "lock-a",
            upstream: "https://example.test/ambiguous",
          },
          {
            ecosystem: "npm",
            name: "ambiguous",
            version: "2.0.0",
            source: "lock-b",
            upstream: "https://example.test/ambiguous",
          },
          {
            ecosystem: "cargo",
            name: "missing-version",
            source: "Cargo.lock",
            upstream: "https://example.test/missing-version",
          },
        ],
      },
    }));
    const bounds = {
      allowedCapabilities: ["lookup-package-metadata"] as const,
      paths: [metadata],
      executables: ["npm"],
      origins: ["https://registry.npmjs.org"],
      timeLimitSeconds: 12,
      outputLimitBytes: 2048,
    };

    const result = await Effect.runPromise(scanDiscovery({
      files: [{ path: metadata, kind: "package-metadata" }],
      path: fixtureBin,
      agentTaskBounds: bounds,
    }));

    expect(result.tools.find((tool) => tool.id === "ambiguous")?.recipes).toEqual([]);
    expect(result.tools.find((tool) => tool.id === "missing-version")?.recipes).toEqual([]);
    const ambiguity = result.agentTasks.find((task) =>
      task.toolId === "ambiguous" && task.reason === "ambiguous-recipe"
    );
    expect(ambiguity).toMatchObject({
      allowedCapabilities: ["lookup-package-metadata"],
      lookupBounds: {
        paths: [metadata],
        executables: ["npm"],
        origins: ["https://registry.npmjs.org"],
      },
      forbidden: ["elevation", "login", "restart", "reboot"],
      timeLimitSeconds: 12,
      outputLimitBytes: 2048,
    });
    expect(result.agentTasks.some((task) =>
      task.toolId === "missing-version" && task.reason === "missing-version"
    )).toBe(true);
  });

  it("deduplicates evidence and orders files, tools, evidence, recipes, and tasks deterministically", async () => {
    const second = await fixture("z.json", JSON.stringify({
      hooks: { zed: { command: "z-tool" } },
    }));
    const first = await fixture("a.json", JSON.stringify({
      mcpServers: { alpha: { command: "a-tool" } },
    }));
    const input = {
      files: [
        { path: second, kind: "hooks" as const },
        { path: first, kind: "mcp" as const },
        { path: first, kind: "mcp" as const },
      ],
      path: fixtureBin,
    };

    const firstRun = await Effect.runPromise(scanDiscovery(input));
    const secondRun = await Effect.runPromise(scanDiscovery({
      ...input,
      files: [...input.files].reverse(),
    }));

    expect(firstRun).toEqual(secondRun);
    expect(firstRun.scannedPaths).toEqual([first, first, second]);
    expect(firstRun.tools.map((tool) => tool.id)).toEqual(["a-tool", "z-tool"]);
    expect(firstRun.evidence).toHaveLength(2);
    expect(firstRun.agentTasks.map((task) => `${task.toolId}:${task.reason}`)).toEqual([
      "a-tool:missing-upstream",
      "a-tool:unresolved-executable",
      "z-tool:missing-upstream",
      "z-tool:unresolved-executable",
    ]);
  });

  it("exposes the scan through the ProfileCatalog layer without publication side effects", async () => {
    const agents = await fixture("AGENTS.md", "```sh\nrg --version\n```\n");
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const catalog = yield* ProfileCatalog;
        return yield* catalog.scan({
          files: [{ path: agents, kind: "agents" }],
          path: fixtureBin,
        });
      }).pipe(Effect.provide(ProfileCatalogLive)),
    );

    expect(result.tools.map((tool) => tool.id)).toEqual(["rg"]);
    expect(result.scannedPaths).toEqual([agents]);
  });

  it("reports typed input and parse errors", async () => {
    const malformed = await fixture("bad.json", "{ nope");

    const emptyError = await Effect.runPromise(
      scanDiscovery({ files: [] }).pipe(Effect.flip),
    );
    expect(emptyError).toBeInstanceOf(InvalidDiscoveryInputError);

    const parseError = await Effect.runPromise(
      scanDiscovery({ files: [{ path: malformed }] }).pipe(Effect.flip),
    );
    expect(parseError).toBeInstanceOf(DiscoveryParseError);
    expect(parseError).toMatchObject({ path: malformed, format: "json" });
  });

  it("identifies the pinned uv package behind uvx and uv tool invocations", async () => {
    const agents = await fixture("AGENTS.md", [
      "```sh",
      "uvx mcp-server-fetch==2025.4.7",
      "uv tool install ruff==0.6.9",
      "uvx --from 'black==24.8.0' black --check .",
      "```",
      "",
    ].join("\n"));

    const result = await Effect.runPromise(scanDiscovery({
      files: [{ path: agents, kind: "agents" }],
      path: fixtureBin,
    }));

    expect(result.tools.map((tool) => tool.id).sort()).toEqual(["black", "mcp-server-fetch", "ruff"]);
    expect(result.tools.find((tool) => tool.id === "ruff")?.recipes).toEqual([
      expect.objectContaining({ method: "uv", package: "ruff", version: "0.6.9" }),
    ]);
    expect(result.tools.find((tool) => tool.id === "mcp-server-fetch")?.recipes).toEqual([
      expect.objectContaining({ method: "uv", package: "mcp-server-fetch", version: "2025.4.7" }),
    ]);
    expect(result.tools.find((tool) => tool.id === "black")?.recipes).toEqual([
      expect.objectContaining({ method: "uv", package: "black", version: "24.8.0" }),
    ]);
  });

  it("keeps an incomplete canonfig.tools entry as needs-review evidence", async () => {
    const metadata = await fixture("package.json", JSON.stringify({
      canonfig: { tools: [{ id: "acme-internal-cli", upstream: "https://acme.example/cli" }] },
    }));

    const result = await Effect.runPromise(scanDiscovery({
      files: [{ path: metadata, kind: "package-metadata" }],
      path: fixtureBin,
    }));

    const tool = result.tools.find((candidate) => candidate.id === "acme-internal-cli");
    expect(tool).toMatchObject({ reviewStatus: "needs-review", upstream: "https://acme.example/cli", recipes: [] });
    expect(tool?.evidence[0]).toMatchObject({ incomplete: ["ecosystem", "name"], reviewStatus: "needs-review" });
    expect(result.agentTasks.map((task) => task.reason)).toContain("incomplete-declaration");
  });

  it("reports shadowed PATH copies as ambiguous, with version evidence", async () => {
    const stale = join(directory, "stale-bin");
    const current = join(directory, "home", ".local", "bin");
    await mkdir(stale, { recursive: true });
    await mkdir(current, { recursive: true });
    await writeFile(join(stale, "fdtool"), "#!/bin/sh\necho fdtool 1.0.0\n");
    await writeFile(join(current, "fdtool"), "#!/bin/sh\necho fdtool 2.0.0\n");
    await chmod(join(stale, "fdtool"), 0o755);
    await chmod(join(current, "fdtool"), 0o755);
    const hooks = await fixture("hooks.sh", "fdtool --index\n");

    const result = await Effect.runPromise(scanDiscovery({
      files: [{ path: hooks, kind: "hooks" }],
      path: [stale, current].join(":"),
    }));

    const evidence = result.tools.find((tool) => tool.id === "fdtool")?.evidence[0];
    expect(evidence).toMatchObject({
      resolvedExecutable: join(stale, "fdtool"),
      confidence: "review",
      reviewStatus: "needs-review",
    });
    expect(evidence?.candidates?.map((candidate) => candidate.path)).toEqual([
      join(stale, "fdtool"),
      join(current, "fdtool"),
    ]);
    expect(evidence?.candidates?.every((candidate) => /^[0-9a-f]{64}$/u.test(candidate.sha256 ?? ""))).toBe(true);
    const task = result.agentTasks.find((candidate) => candidate.reason === "ambiguous-executable");
    expect(task?.observedEvidence.join("\n")).toContain(join(current, "fdtool"));
  });

  it("retains package versions whose entry points have identical bytes", async () => {
    const binaries: Array<string> = [];
    for (const version of ["1.6.0", "1.5.0"]) {
      const root = join(directory, version, "node_modules", "copied-tool");
      const bin = join(root, "bin");
      await mkdir(bin, { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "copied-tool", version }));
      await writeFile(join(bin, "copied-tool"), "#!/usr/bin/env node\nconsole.log(require('../package.json').version);\n");
      await chmod(join(bin, "copied-tool"), 0o755);
      binaries.push(bin);
    }
    const hooks = await fixture("hooks.sh", "copied-tool --index\n");
    const result = await Effect.runPromise(scanDiscovery({
      files: [{ path: hooks, kind: "hooks" }],
      path: binaries.join(":"),
    }));
    const evidence = result.tools.find((tool) => tool.id === "copied-tool")?.evidence[0];
    expect(evidence?.resolvedExecutable).toBe(join(binaries[0]!, "copied-tool"));
    expect(evidence?.candidates?.map((candidate) => ({
      path: candidate.path,
      packageVersion: candidate.packageVersion,
    }))).toEqual([
      { path: join(binaries[0]!, "copied-tool"), packageVersion: "copied-tool@1.6.0" },
      { path: join(binaries[1]!, "copied-tool"), packageVersion: "copied-tool@1.5.0" },
    ]);
    expect(evidence?.candidates?.[0]?.sha256).toBe(evidence?.candidates?.[1]?.sha256);
    expect(result.agentTasks.some((task) => task.reason === "ambiguous-executable")).toBe(true);
  });

  it("verifies an MCP server by presence instead of launching it", async () => {
    const mcp = await fixture("mcp.json", JSON.stringify({
      mcpServers: { everything: { command: "rg", args: ["--stdio"] } },
    }));

    const result = await Effect.runPromise(scanDiscovery({
      files: [{ path: mcp, kind: "mcp" }],
      path: fixtureBin,
    }));

    expect(result.tools.find((tool) => tool.id === "rg")?.verify).toEqual({
      method: "executable-present",
      executable: "rg",
    });
  });
});
