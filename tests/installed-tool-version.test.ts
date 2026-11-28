import { describe, expect, it } from "vitest";

import {
  compareInstalledVersion,
  installedVersionMatches,
  parseBrewInstalledInfo,
  parseBunGlobalList,
  parseCargoInstalls,
  parseDpkgQuery,
  parseNodeGlobalList,
  parseUvToolList,
  parseWingetList,
} from "../src/synchronization/installed-tool-version.ts";

// Each fixture is the verbatim output shape of the installer's listing.
describe("installed tool version listings", () => {
  it("reads uv tool list by normalized distribution name", () => {
    const output = "black v24.8.0\n- black\n- blackd\nisort v6.0.1\n- isort\n- isort-identify-imports\n";
    expect(parseUvToolList(output, "isort")).toBe("6.0.1");
    expect(parseUvToolList("ruamel-yaml v0.18.6\n- ruamel\n", "ruamel.yaml")).toBe("0.18.6");
    expect(parseUvToolList("No tools installed\n", "isort")).toBeUndefined();
    // An entrypoint line is not a tool line.
    expect(parseUvToolList("other v1.0.0\n- isort\n", "isort")).toBeUndefined();
  });

  it("reads npm and pnpm global JSON listings", () => {
    const npm = JSON.stringify({ name: "lib", dependencies: { "is-number": { version: "7.0.0", overridden: false } } });
    expect(parseNodeGlobalList(npm, "is-number")).toBe("7.0.0");
    expect(parseNodeGlobalList(JSON.stringify({ name: "lib" }), "is-number")).toBeUndefined();
    const pnpm = JSON.stringify([{ path: "/home/u/.local/share/pnpm/global/5", dependencies: { "@scope/tool": { version: "2.1.0" } } }]);
    expect(parseNodeGlobalList(pnpm, "@scope/tool")).toBe("2.1.0");
    // Inherited object keys are not packages.
    expect(parseNodeGlobalList(npm, "constructor")).toBeUndefined();
    expect(parseNodeGlobalList("npm ERR! not json", "is-number")).toBeUndefined();
  });

  it("reads bun's global tree", () => {
    const output = "/home/u/.bun/install/global node_modules (6)\n├── @residue/cli@0.0.12\n└── typescript@5.6.2\n";
    expect(parseBunGlobalList(output, "@residue/cli")).toBe("0.0.12");
    expect(parseBunGlobalList(output, "typescript")).toBe("5.6.2");
    expect(parseBunGlobalList(output, "missing")).toBeUndefined();
  });

  it("reads Cargo's install metadata", () => {
    const crates = JSON.stringify({
      installs: {
        "ripgrep 14.1.0 (registry+https://github.com/rust-lang/crates.io-index)": { bins: ["rg"] },
        "agg 1.7.0 (git+https://github.com/asciinema/agg#489de4da)": { bins: ["agg"] },
      },
    });
    expect(parseCargoInstalls(crates, "ripgrep")).toBe("14.1.0");
    expect(parseCargoInstalls(crates, "rip")).toBeUndefined();
    expect(parseCargoInstalls("{}", "ripgrep")).toBeUndefined();
  });

  it("reads winget's table and skips undetermined versions", () => {
    const output = [
      "\r   - \r   \\ \r",
      "Name                 Id                       Version Available Source",
      "-----------------------------------------------------------------------",
      "ripgrep              BurntSushi.ripgrep.MSVC  14.1.0  14.1.1    winget",
    ].join("\r\n");
    expect(parseWingetList(output, "BurntSushi.ripgrep.MSVC")).toBe("14.1.0");
    expect(parseWingetList("Name Id Version\n---\nTool Vendor.Tool Unknown\n", "Vendor.Tool")).toBeUndefined();
    expect(parseWingetList("Name Id Version\n---\nTool Vendor.Tool < 2.0\n", "Vendor.Tool")).toBeUndefined();
    expect(parseWingetList("No installed package found matching input criteria.\n", "Vendor.Tool")).toBeUndefined();
  });

  it("reads only installed dpkg packages", () => {
    expect(parseDpkgQuery("ii |14.1.0-1")).toBe("14.1.0-1");
    expect(parseDpkgQuery("rc |14.1.0-1")).toBeUndefined();
    expect(parseDpkgQuery("un |")).toBeUndefined();
  });

  it("reads the linked Homebrew keg rather than the available formula or an older installed keg", () => {
    expect(parseBrewInstalledInfo(JSON.stringify({ formulae: [{
      versions: { stable: "5.0.0" },
      installed: [{ version: "4.0.1" }, { version: "4.1.0_2" }],
      linked_keg: "4.1.0_2",
    }] }))).toBe("4.1.0_2");
  });

  it("recognizes a single installed keg-only formula without inventing an active version", () => {
    expect(parseBrewInstalledInfo(JSON.stringify({ formulae: [{
      installed: [{ version: "3.13.9" }], linked_keg: null,
    }] }))).toBe("3.13.9");
    expect(parseBrewInstalledInfo(JSON.stringify({ formulae: [{
      installed: [{ version: "3.13.8" }, { version: "3.13.9" }], linked_keg: null,
    }] }))).toBeUndefined();
  });

  it.each([
    "not JSON",
    JSON.stringify({ formulae: [] }),
    JSON.stringify({ formulae: [{ versions: { stable: "4.1.0" }, installed: [] }] }),
    JSON.stringify({ formulae: [{ installed: [{ version: "4.0.1" }], linked_keg: "4.1.0" }] }),
  ])("does not mistake unavailable Homebrew installation evidence for a version: %s", (output) => {
    expect(parseBrewInstalledInfo(output)).toBeUndefined();
  });

  it("compares versions the way each installer resolves them", () => {
    expect(installedVersionMatches("uv", "6.0.0rc1", "6.0.0RC1")).toBe(true);
    expect(installedVersionMatches("uv", "6.0.1", "5.13.2")).toBe(false);
    expect(installedVersionMatches("npm", "1.0.0-Beta", "1.0.0-beta")).toBe(false);
  });

  // The sign is what the planner acts on: negative installs the pin, zero or
  // positive keeps an `at-least` tool, undefined installs the pin as before.
  const order = (method: string, installed: string, pinned: string) => {
    const result = compareInstalledVersion(method, installed, pinned);
    return result === undefined ? undefined : Math.sign(result);
  };

  it.each([
    ["npm", "0.172.0", "0.167.1", 1],
    ["npm", "0.167.0", "0.167.1", -1],
    ["npm", "0.167.1", "0.167.1", 0],
    ["pnpm", "10.0.0", "9.99.99", 1],
    ["bun", "1.2.3+build.5", "1.2.3", 0],
    // A release is above its own pre-releases, and a newer pre-release is above an older release.
    ["npm", "0.172.0-alpha.1", "0.172.0", -1],
    ["npm", "0.173.0-alpha.1", "0.172.0", 1],
    ["npm", "1.0.0-alpha.2", "1.0.0-alpha.10", -1],
    ["npm", "1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["npm", "1.0.0-1", "1.0.0-alpha", -1],
    ["npm", "1.0.0-beta", "1.0.0-alpha.beta", 1],
    ["cargo", "99999999999999999999.0.0", "9999999999999999999.0.0", 1],
  ])("orders %s versions by SemVer precedence: %s against %s", (method, installed, pinned, expected) => {
    expect(order(method, installed, pinned)).toBe(expected);
  });

  it.each([
    ["14.1.1-1", "14.1.0-1", 1],
    ["14.1.0-2", "14.1.0-1", 1],
    ["14.1.0-1ubuntu1", "14.1.0-1", 1],
    ["14.1.0~rc1-1", "14.1.0-1", -1],
    ["1:1.0-1", "2.0-1", 1],
    ["1.0", "1.0-0", 0],
    ["1.0+dfsg-1", "1.0-1", 1],
  ])("orders Debian versions like dpkg: %s against %s", (installed, pinned, expected) => {
    expect(order("apt", installed, pinned)).toBe(expected);
  });

  it.each([
    ["uv", "6.0.1", "5.13.2", 1],
    ["uv", "5.13", "5.13.0", 0],
    ["winget", "14.1.1.0", "14.1.1", 0],
    ["winget", "2.0.0.1", "2.0.0", 1],
    ["brew", "14.1.1_1", "14.1.1", 1],
    ["brew", "1.2_3", "1.2.1", -1],
    ["brew", "1.2.1", "1.2_3", 1],
    ["brew", "1.2_3", "1.2_1", 1],
    ["brew", "1.2_0", "1.2", 0],
    ["homebrew", "1.2.0_2", "1.2_1", 1],
    ["homebrew", "0.9.6", "0.9.7", -1],
  ])("orders dotted numeric %s versions: %s against %s", (method, installed, pinned, expected) => {
    expect(order(method, installed, pinned)).toBe(expected);
  });

  it.each([
    ["uv", "6.0.0rc1", "5.13.2"],
    ["winget", "Unknown", "1.0.0"],
    ["npm", "latest", "1.0.0"],
    ["apt", "14.1.0-1", "not a version"],
    ["binary", "1.0.0", "0.9.0"],
    ["source", "abc123", "def456"],
  ])("cannot order %s versions %s against %s", (method, installed, pinned) => {
    expect(compareInstalledVersion(method, installed, pinned)).toBeUndefined();
  });
});
