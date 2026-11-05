import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { ConfigValue } from "../../src/domain/resource.ts";
import { adapterFor } from "../../src/projection/adapters/index.ts";
import type { TargetId } from "../../src/projection/model.ts";

/**
 * What a follower keeps of its own, end to end through the CLI: append-local
 * instructions and skills, `sync --review-local`, Local Overlays, and the
 * authored `resources` of canonfig.jsonc. Each machine runs in its own
 * temporary HOME with real SQLite, a real `canonfig source serve` over
 * loopback HTTPS, and fake harness executables on a PATH that holds nothing
 * else. Nothing is mocked.
 */

const project = resolve(import.meta.dirname, "../..");
const roots: Array<string> = [];
const servers: Array<ChildProcess> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.exitCode === null && server.signalCode === null) {
      const closed = once(server, "close");
      server.kill("SIGKILL");
      await closed;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 60_000);

const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const read = (path: string) => readFileSync(path, "utf8");
const jsonc = (path: string) => JSON.parse(read(path).replace(/^\/\/.*$/gmu, ""));

interface CliResult {
  readonly status: number | null;
  readonly output: string;
  readonly data: Readonly<Record<string, ConfigValue>>;
}

interface Machine {
  readonly home: string;
  readonly folder: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly run: (arguments_: ReadonlyArray<string>, input?: string) => CliResult;
}

/** One machine with its own HOME and a PATH holding only `harnesses`' fake executables. */
const machine = (name: string, harnesses: ReadonlyArray<TargetId> = []): Machine => {
  const root = mkdtempSync(join(tmpdir(), `canonfig-local-modes-${name}-`));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  for (const harness of harnesses) {
    const executable = adapterFor(harness).descriptor.executables[0]!;
    const path = join(bin, process.platform === "win32" ? `${executable}.exe` : executable);
    write(path, "");
    chmodSync(path, 0o755);
  }
  mkdirSync(bin, { recursive: true });
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    PATH: bin,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CANONFIG_LOCAL_CREDENTIAL_ROOT: join(root, "credentials"),
    CANONFIG_LOG: "off",
    NODE_NO_WARNINGS: "1",
  };
  const run = (arguments_: ReadonlyArray<string>, input?: string): CliResult => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/runtime/main.ts", ...arguments_, "--json"], {
      cwd: project,
      env: environment,
      encoding: "utf8",
      input,
      timeout: 60_000,
    });
    const text = result.stdout.trim().length > 0 ? result.stdout : result.stderr;
    let data: CliResult["data"] = {};
    try {
      const envelope = JSON.parse(text);
      data = envelope.data ?? envelope;
    } catch {
      // The assertion on `status` reports the output.
    }
    return { status: result.status, output: `${result.stdout}${result.stderr}`, data };
  };
  return { home, folder: join(home, ".canonfig"), environment, run };
};

const succeed = (result: CliResult, label: string): CliResult => {
  expect(result.status, `${label}: ${result.output}`).toBe(0);
  return result;
};

const unusedPort = (): Promise<number> =>
  new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const decoded = Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Int }))(server.address());
      const port = decoded._tag === "Some" ? decoded.value.port : 0;
      server.close(() => resolvePort(port));
    });
  });

/** `canonfig source serve` in the background; resolves with its endpoint once it listens. */
const serve = async (source: Machine): Promise<string> => {
  const port = await unusedPort();
  const child = spawn(process.execPath, [
    "--import", "tsx", "src/runtime/main.ts", "source", "serve", "--host", "127.0.0.1", "--port", `${port}`, "--json",
  ], { cwd: project, env: source.environment, stdio: ["ignore", "pipe", "pipe"] });
  servers.push(child);
  return new Promise((resolveEndpoint, rejectEndpoint) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => rejectEndpoint(new Error(`source serve did not start: ${stderr}`)), 60_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolveEndpoint(JSON.parse(stdout.slice(0, newline)).data.endpoint);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
  });
};

const publish = (source: Machine) => succeed(source.run(["source", "publish", "--reviewer", "reviewer@example.test"]), "publish");

/** A Source whose folder is `config` plus the files `files` names, published and served. */
const startSource = async (config: Readonly<Record<string, ConfigValue>>, files: Readonly<Record<string, string>>) => {
  const source = machine("source");
  write(join(source.folder, "canonfig.jsonc"), JSON.stringify({ version: 1, profile: { id: "team", name: "Team" }, ...config }, undefined, 2));
  for (const [path, content] of Object.entries(files)) write(join(source.folder, path), content);
  succeed(source.run(["source", "init"]), "source init");
  publish(source);
  return { source, endpoint: await serve(source) };
};

const enroll = (source: Machine, endpoint: string, follower: Machine, name: string) => {
  const output = join(source.home, `${name}.invite`);
  succeed(source.run(["source", "invite", "--endpoint", endpoint, "--output", output]), "invite");
  const envelope = read(output);
  rmSync(output);
  succeed(follower.run(["follower", "enroll", "--stdin", "--name", name], envelope), `enroll ${name}`);
};

const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;

describe("what a follower keeps of its own", () => {
  it("keeps the follower's instructions and skills beside the Source's in Codex, across updates and restore", async () => {
    const { source, endpoint } = await startSource({
      harnesses: ["codex"],
      local: { allow: ["instructions", "skills"], appendLocal: ["instructions", "skills"] },
    }, {
      "AGENTS.md": "# Team rules\n\nPrefer small diffs.\n",
      "skills/deploy/SKILL.md": skill("deploy", "Deploy carefully."),
    });
    const laptop = machine("laptop", ["codex"]);
    const codexAgents = join(laptop.home, ".codex", "AGENTS.md");
    const skills = join(laptop.home, ".agents", "skills");
    // The laptop already has Codex instructions and a skill of its own, plus
    // a snippet and a skill it keeps in ~/.canonfig/local/.
    const ownText = "# Laptop notes\n\nUse fish, not bash.\n";
    write(codexAgents, ownText);
    write(join(skills, "mine", "SKILL.md"), skill("mine", "Only on the laptop."));
    write(join(laptop.folder, "local", "AGENTS.md"), "Laptop snippet: run tests with -x.\n");
    write(join(laptop.folder, "local", "skills", "notes", "SKILL.md"), skill("notes", "Laptop notes."));
    enroll(source, endpoint, laptop, "laptop");

    // Review is for an interactive plan only.
    expect(laptop.run(["sync", "--apply", "--review-local"]).status).toBe(2);

    // The plan says the whole existing file stays local; the review holds the exact texts.
    const planned = succeed(laptop.run(["sync", "--plan", "--review-local"]), "review plan");
    expect(JSON.stringify(planned.data)).toContain("First adoption preserves the entire existing file as local text");
    // SAFETY: `sync --plan --review-local` returns adoptionReviews as this list; the next lines check its shape.
    const reviews = planned.data.adoptionReviews as ReadonlyArray<{ resource: string; target: string; path: string }>;
    expect(reviews.map((review) => review.target)).toEqual([codexAgents]);
    const review = JSON.parse(read(reviews[0]!.path));
    expect(review).toMatchObject({ schema: "canonfig.adoption-review/v1", retainedLocal: ownText });
    expect(review.sourceAddition).toContain("Prefer small diffs.");
    expect(review.sourceAddition).toContain("Laptop snippet: run tests with -x.");
    expect(JSON.stringify(planned.data)).not.toContain("Use fish");
    if (process.platform !== "win32") {
      expect(statSync(reviews[0]!.path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(reviews[0]!.path)).mode & 0o777).toBe(0o700);
    }
    // Planning wrote nothing to Codex.
    expect(read(codexAgents)).toBe(ownText);

    const applied = succeed(laptop.run(["sync", "--apply"]), "first apply").data;
    expect(applied).toMatchObject({ outcome: { outcome: "Converged" } });
    expect(read(codexAgents)).toBe(review.proposedText);
    expect(read(codexAgents).endsWith(`<!-- canonfig:source:end -->\n\n${ownText}`)).toBe(true);
    for (const name of ["deploy", "mine", "notes"]) expect(existsSync(join(skills, name, "SKILL.md")), name).toBe(true);

    // The Source changes its instructions and adds a skill; the laptop keeps
    // its own text (edited since) and its own skill.
    write(join(source.folder, "AGENTS.md"), "# Team rules\n\nPrefer tiny diffs.\n");
    write(join(source.folder, "skills", "review", "SKILL.md"), skill("review", "Review first."));
    publish(source);
    write(codexAgents, `${read(codexAgents)}Added on the laptop later.\n`);
    succeed(laptop.run(["sync", "--apply"]), "second apply");
    const updated = read(codexAgents);
    expect(updated).toContain("Prefer tiny diffs.");
    expect(updated).not.toContain("Prefer small diffs.");
    expect(updated).toContain("Laptop snippet: run tests with -x.");
    expect(updated.endsWith(`<!-- canonfig:source:end -->\n\n${ownText}Added on the laptop later.\n`)).toBe(true);
    for (const name of ["deploy", "review", "mine", "notes"]) expect(existsSync(join(skills, name, "SKILL.md")), name).toBe(true);
    expect(succeed(laptop.run(["sync", "--apply"]), "third apply").data).toMatchObject({ outcome: { outcome: "Converged" } });

    // Restore takes Canonfig's part out and leaves everything the laptop had or added.
    const restored = succeed(laptop.run(["restore"]), "restore").data;
    expect(restored.excludedHarnesses).toEqual(["codex"]);
    expect(read(codexAgents)).toBe(`${ownText}Added on the laptop later.\n`);
    expect(existsSync(join(skills, "mine", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skills, "deploy"))).toBe(false);
  }, 300_000);

  it("lets a Local Overlay replace a published item on one machine, across revisions", async () => {
    const { source, endpoint } = await startSource({
      harnesses: ["codex"],
      mcp: { docs: { transport: "streamable-http", url: "https://docs.example.invalid/mcp" } },
      local: { allow: ["mcp"] },
    }, {});
    const laptop = machine("laptop", ["codex"]);
    const config = join(laptop.home, ".codex", "config.toml");
    enroll(source, endpoint, laptop, "laptop");
    succeed(laptop.run(["sync", "--apply"]), "first sync");
    expect(read(config)).toContain("https://docs.example.invalid/mcp");

    // A local server under a published name stops the run until someone decides.
    write(join(laptop.folder, "local", "local.jsonc"), JSON.stringify({
      mcp: { docs: { transport: "streamable-http", url: "http://127.0.0.1:9000/mcp" } },
    }));
    const collided = laptop.run(["sync", "--apply"]);
    expect(collided.status, collided.output).toBe(3);
    expect(collided.output).toContain("canonfig overlay set mcp/docs");

    expect(laptop.run(["overlay", "set", "mcp/nope/extra"]).status).toBe(2);
    expect(succeed(laptop.run(["overlay", "set", "mcp/docs"]), "overlay set").data).toMatchObject({ overlays: ["mcp/docs"] });
    expect(succeed(laptop.run(["overlay", "list"]), "overlay list").data).toEqual({
      overlays: [{ item: "mcp/docs", local: true, published: true }],
    });
    succeed(laptop.run(["sync", "--apply"]), "overlaid sync");
    expect(read(config)).toContain("http://127.0.0.1:9000/mcp");
    expect(read(config)).not.toContain("docs.example.invalid");

    // A new revision changes the published server; the overlay still holds,
    // and nothing of it reaches the Source.
    write(join(source.folder, "canonfig.jsonc"), JSON.stringify({
      version: 1,
      profile: { id: "team", name: "Team" },
      harnesses: ["codex"],
      mcp: {
        docs: { transport: "streamable-http", url: "https://docs-v2.example.invalid/mcp" },
        search: { transport: "streamable-http", url: "https://search.example.invalid/mcp" },
      },
      local: { allow: ["mcp"] },
    }));
    publish(source);
    succeed(laptop.run(["sync", "--apply"]), "sync after new revision");
    expect(read(config)).toContain("http://127.0.0.1:9000/mcp");
    expect(read(config)).toContain("https://search.example.invalid/mcp");
    expect(read(config)).not.toContain("docs-v2.example.invalid");
    expect(jsonc(join(laptop.folder, "canonfig.jsonc")).mcp.docs.url).toBe("https://docs-v2.example.invalid/mcp");
    expect(existsSync(join(source.folder, "local"))).toBe(false);

    expect(succeed(laptop.run(["overlay", "remove", "mcp/docs"]), "overlay remove").data).toMatchObject({ overlays: [] });
    expect(laptop.run(["sync", "--apply"]).status).toBe(3);
  }, 300_000);

  it("publishes authored file, directory and config resources, keeps follower drift, and retires them", async () => {
    const { source, endpoint } = await startSource({
      harnesses: [],
      resources: {
        gitconfig: { kind: "file", target: "~/.gitconfig", source: "files/gitconfig" },
        team: { kind: "file", target: "~/notes/TEAM.md", source: "files/TEAM.md", policy: "append-local" },
        scripts: { kind: "directory", target: "~/.local/share/team-scripts", source: "files/scripts" },
        tool: { kind: "config", target: "~/.config/tool/settings.json", format: "json", keys: { editor: "vim", "ui.color": true } },
      },
    }, {
      "files/gitconfig": "[user]\n\tname = Team\n",
      "files/TEAM.md": "Team notes.\n",
      "files/scripts/build.sh": "#!/bin/sh\nexit 0\n",
      "files/scripts/lib/common.sh": "# shared\n",
    });
    const laptop = machine("laptop");
    const settings = join(laptop.home, ".config", "tool", "settings.json");
    const notes = join(laptop.home, "notes", "TEAM.md");
    write(settings, JSON.stringify({ theme: "dark", ui: { font: "mono" } }));
    write(notes, "My own notes.\n");
    enroll(source, endpoint, laptop, "laptop");
    succeed(laptop.run(["sync", "--apply"]), "first sync");

    expect(read(join(laptop.home, ".gitconfig"))).toBe("[user]\n\tname = Team\n");
    expect(read(join(laptop.home, ".local", "share", "team-scripts", "lib", "common.sh"))).toBe("# shared\n");
    expect(JSON.parse(read(settings))).toEqual({ theme: "dark", ui: { font: "mono", color: true }, editor: "vim" });
    expect(read(notes)).toContain("Team notes.");
    expect(read(notes).endsWith("My own notes.\n")).toBe(true);
    // The follower mirrors the definitions and their files like every other item.
    expect(jsonc(join(laptop.folder, "canonfig.jsonc")).resources.gitconfig.target).toBe("~/.gitconfig");
    expect(read(join(laptop.folder, "files", "scripts", "build.sh"))).toBe("#!/bin/sh\nexit 0\n");

    // A follower edit is drift: kept and reported, never overwritten.
    write(join(laptop.home, ".gitconfig"), "[user]\n\tname = Laptop\n");
    write(join(source.folder, "files", "gitconfig"), "[user]\n\tname = Team v2\n");
    publish(source);
    const drifted = laptop.run(["sync", "--apply"]);
    expect(drifted.status, drifted.output).toBe(4);
    expect(drifted.output).toContain("FollowerDrift");
    expect(read(join(laptop.home, ".gitconfig"))).toBe("[user]\n\tname = Laptop\n");

    // Removing the resources from the Source retires what Canonfig wrote and
    // nothing else: the drifted file stays, the machine's keys and text stay.
    write(join(source.folder, "canonfig.jsonc"), JSON.stringify({ version: 1, profile: { id: "team", name: "Team" }, harnesses: [] }));
    rmSync(join(source.folder, "files"), { recursive: true });
    publish(source);
    succeed(laptop.run(["sync", "--apply"]), "retiring sync");
    expect(read(join(laptop.home, ".gitconfig"))).toBe("[user]\n\tname = Laptop\n");
    expect(existsSync(join(laptop.home, ".local", "share", "team-scripts"))).toBe(false);
    expect(JSON.parse(read(settings))).toEqual({ theme: "dark", ui: { font: "mono" } });
    expect(read(notes)).toBe("My own notes.\n");
    for (const path of ["gitconfig", "TEAM.md", "scripts/build.sh", "scripts/lib/common.sh"]) {
      expect(existsSync(join(laptop.folder, "files", ...path.split("/"))), path).toBe(false);
    }
  }, 300_000);

  it("refuses a resource that reaches into a harness's own files", async () => {
    const source = machine("source");
    write(join(source.folder, "canonfig.jsonc"), JSON.stringify({
      version: 1,
      harnesses: [],
      resources: { auth: { kind: "file", target: "~/.codex/auth.json", source: "files/auth.json" } },
    }));
    write(join(source.folder, "files", "auth.json"), "{}\n");
    const refused = source.run(["sync", "--plan"]);
    expect(refused.status, refused.output).toBe(2);
    expect(refused.output).toContain("which belongs to OpenAI Codex");
  }, 120_000);
});
