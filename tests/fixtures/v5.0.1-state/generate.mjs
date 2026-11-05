// Regenerates the v5.0.1 state fixtures by driving a real v5.0.1 CLI.
//
//   node tests/fixtures/v5.0.1-state/generate.mjs <v5.0.1 checkout with dependencies>
//
// The checkout is a throwaway copy of tag v5.0.1 (`git archive v5.0.1`, then
// `npm install --ignore-scripts` with the `website` workspace removed, then
// `npm run build:cli`). The
// script builds a Source and an enrolled Follower under fixed placeholder
// homes, publishes, applies, sets an overlay and a schedule, publishes again,
// applies again, and copies the resulting state into this directory:
//
//   source/   the Source's ~/.canonfig (state.sqlite and its files)
//   follower/ the Follower's home: ~/.canonfig plus every applied target
//   multi-profile/ a Source that published two profiles (not migratable)
//
// Secret values never reach the fixture. Credentials go to a stand-in
// `secret-tool` that writes under `$HOME/.secret-store`, which is not copied,
// and the profile's credential resource names a dummy reference. The state
// keeps only references, exactly as v5.0.1 stored them.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = resolve(process.argv[2] ?? "");
const here = dirname(fileURLToPath(import.meta.url));
// Fixed homes, so the stored absolute paths are predictable placeholders the
// tests relocate into their own temporary homes.
const root = "/tmp/canonfig-v501-fixture";
const sourceHome = join(root, "source-home");
const followerHome = join(root, "follower-home");
const multiHome = join(root, "multi-home");
const bin = join(root, "bin");

rmSync(root, { recursive: true, force: true });
for (const directory of [sourceHome, followerHome, multiHome, bin]) mkdirSync(directory, { recursive: true });

writeFileSync(join(bin, "secret-tool"), `#!/bin/sh
set -eu
operation="$1"
key=""
for argument in "$@"; do key="$argument"; done
directory="$HOME/.secret-store"
case "$operation" in
  store) mkdir -p "$directory"; cat > "$directory/$key" ;;
  lookup) cat "$directory/$key" ;;
  clear) rm -f "$directory/$key" ;;
  *) exit 2 ;;
esac
`);
writeFileSync(join(bin, "systemctl"), `#!/bin/sh
set -eu
operation="\${2:-}"
marker="$HOME/.systemd-enabled"
case "$operation" in
  show)
    state=inactive; unit=disabled
    if test -f "$marker"; then state=active; unit=enabled; fi
    printf 'Id=canonfig-sync.timer\\nLoadState=loaded\\nActiveState=%s\\nUnitFileState=%s\\nDropInPaths=\\n\\nId=canonfig-sync.service\\nLoadState=loaded\\nActiveState=inactive\\n' "$state" "$unit"
    ;;
  enable) touch "$marker" ;;
  disable) rm -f "$marker" ;;
  *) exit 0 ;;
esac
`);
chmodSync(join(bin, "secret-tool"), 0o700);
chmodSync(join(bin, "systemctl"), 0o700);

const environment = (home) => ({
  PATH: `${bin}:${process.env.PATH}`,
  HOME: home,
  USERPROFILE: home,
  LANG: "C.UTF-8",
  TZ: "UTC",
  CANONFIG_SYSTEMCTL: join(bin, "systemctl"),
  // The stand-in secret-tool answers; no real Secret Service is reached.
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/canonfig-fixture-bus",
});
// The built entrypoint, as an npm installation runs it: `schedule set`
// refuses to schedule a source checkout.
const node = process.execPath;
const main = join(checkout, "dist", "runtime", "main.js");

const run = (home, args, input) => {
  const result = spawnSync(node, [main, ...args, "--json"], {
    cwd: home,
    env: environment(home),
    input,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`canonfig ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
};

const freePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });

const serve = async (home) => {
  const port = await freePort();
  const child = spawn(node, [main, "source", "serve", "--host", "127.0.0.1", "--port", String(port), "--json"], {
    cwd: home,
    env: environment(home),
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((ready, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("\n")) ready();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (status) => reject(new Error(`source serve exited ${status}: ${stderr}`)));
  });
  // SIGTERM lets the server close its database, so its rows leave the WAL.
  const stop = () => new Promise((stopped) => {
    child.removeAllListeners("exit");
    child.once("exit", stopped);
    child.kill("SIGTERM");
  });
  return { endpoint: `https://127.0.0.1:${port}`, stop };
};

const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

// A profile with every authored kind this release carries forward: files
// from a source path and inline, append-local, a directory, JSON and TOML
// config keys, and a grouped resource. A `skill` resource with its own
// target has no equivalent (the upgrade refuses it), so it is left out.
const profile = (instructions) => `{
  "version": 2,
  "id": "workstation",
  "name": "Workstation",
  "groups": [{ "name": "work" }],
  "resources": [
    {
      "id": "codex-instructions",
      "kind": "file",
      "target": "~/.codex/AGENTS.md",
      "spec": { "kind": "file", "source": "authored/AGENTS.md" },
      "verify": { "method": "digest" }
    },
    {
      "id": "claude-instructions",
      "kind": "file",
      "policy": "append-local",
      "target": "~/.claude/CLAUDE.md",
      "spec": { "kind": "file", "content": ${JSON.stringify(instructions)} },
      "verify": { "method": "digest" }
    },
    {
      "id": "claude-commands",
      "kind": "directory",
      "target": "~/.claude/commands",
      "spec": {
        "kind": "directory",
        "files": [
          { "path": "review.md", "content": "Review the staged diff.\\n" },
          { "path": "nested/ship.md", "content": "Ship it.\\n" }
        ]
      },
      "verify": { "method": "digest" }
    },
    {
      "id": "claude-settings",
      "kind": "config",
      "target": "~/.claude/settings.json",
      "spec": {
        "kind": "config",
        "format": "json",
        "keys": [
          { "path": "permissions.allow", "value": ["Bash(npm test:*)"] },
          { "path": "model", "value": "opus" }
        ]
      },
      "verify": { "method": "digest" }
    },
    {
      "id": "codex-config",
      "kind": "config",
      "target": "~/.codex/config.toml",
      "groups": ["work"],
      "spec": {
        "kind": "config",
        "format": "toml",
        "keys": [
          { "path": "model_reasoning_effort", "value": "high" },
          { "path": "mcp_servers.memory", "value": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] } }
        ]
      },
      "verify": { "method": "digest" }
    }
  ]
}
`;

const source = await (async () => {
  run(sourceHome, ["source", "init"]);
  write(join(sourceHome, "authored", "AGENTS.md"), "Follow the repository conventions.\n");
  write(join(sourceHome, "profile.jsonc"), profile("Shared instructions.\n"));
  run(sourceHome, ["source", "publish", "--profile-file", join(sourceHome, "profile.jsonc"), "--reviewer", "fixture"]);
  return serve(sourceHome);
})();

try {
  run(sourceHome, ["source", "invite", "--endpoint", source.endpoint, "--output", join(sourceHome, "invite"), "--expires", "1h", "--group", "work"]);
  run(followerHome, ["follower", "enroll", "--stdin", "--name", "laptop", "--profile", "workstation"], readFileSync(join(sourceHome, "invite"), "utf8"));
  rmSync(join(sourceHome, "invite"));
  // A shared secret: the Source and Follower state keep its name, the value
  // stays in the stand-in secret store, which the fixture does not copy.
  run(sourceHome, ["secrets", "set", "docs-token"], "dummy-value");
  run(followerHome, ["secrets", "sync"]);
  // Follower-owned keys and text that must survive an upgrade.
  write(join(followerHome, ".claude", "settings.json"), `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
  run(followerHome, ["sync", "--apply", "--no-input"]);
  run(followerHome, ["overlay", "set", "claude-settings", "--target", "~/.claude/settings.json", "--key", "theme"]);
  run(followerHome, ["schedule", "set", "daily@09:00", "--timezone", "UTC"]);
  const claude = join(followerHome, ".claude", "CLAUDE.md");
  writeFileSync(claude, `${readFileSync(claude, "utf8")}\nFollower-local instructions.\n`);

  write(join(sourceHome, "authored", "AGENTS.md"), "Follow the repository conventions.\nRun the tests before you push.\n");
  write(join(sourceHome, "profile.jsonc"), profile("Shared instructions, second revision.\n"));
  run(sourceHome, ["source", "publish", "--profile-file", join(sourceHome, "profile.jsonc"), "--reviewer", "fixture"]);
  run(followerHome, ["sync", "--apply", "--no-input"]);
  run(followerHome, ["status"]);
} finally {
  await source.stop();
}

// A Source that publishes two profiles: this release publishes exactly one.
run(multiHome, ["source", "init"]);
write(join(multiHome, "authored", "AGENTS.md"), "One.\n");
for (const id of ["workstation", "laptop"]) {
  write(join(multiHome, `${id}.jsonc`), `{
  "version": 2,
  "id": "${id}",
  "name": "${id}",
  "resources": [{
    "id": "codex-instructions",
    "kind": "file",
    "target": "~/.codex/AGENTS.md",
    "spec": { "kind": "file", "source": "authored/AGENTS.md" },
    "verify": { "method": "digest" }
  }]
}
`);
  run(multiHome, ["source", "publish", "--profile-file", join(multiHome, `${id}.jsonc`), "--reviewer", "fixture"]);
}

// Fold each database's WAL into the file, so the fixture is one file per database.
for (const database of [sourceHome, followerHome, multiHome].map((home) => join(home, ".canonfig", "state.sqlite"))) {
  const connection = new DatabaseSync(database);
  connection.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
  connection.close();
}

const copy = (from, to, skip) => {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, {
    recursive: true,
    filter: (path) => !skip.some((excluded) => path === excluded || path.startsWith(`${excluded}/`) || path.endsWith(excluded)),
  });
};
// Left out: the stand-in secret store (credential values), logs, run locks,
// and the systemd units and empty rollback cache, which name this machine's
// Node installation rather than anything Canonfig state means.
const skipped = (home) => [
  join(home, ".secret-store"),
  join(home, ".systemd-enabled"),
  join(home, ".config", "systemd"),
  join(home, ".local", "share", "systemd"),
  join(home, ".cache"),
  join(home, ".canonfig", "canonfig.log"),
  ".run-lock",
];
copy(join(sourceHome, ".canonfig"), join(here, "source"), skipped(sourceHome));
copy(followerHome, join(here, "follower"), skipped(followerHome));
copy(join(multiHome, ".canonfig"), join(here, "multi-profile"), skipped(multiHome));
rmSync(root, { recursive: true, force: true });
