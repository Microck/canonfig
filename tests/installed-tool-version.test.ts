import { describe, expect, it } from "vitest";

import {
  installedVersionMatches,
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

  it("compares versions the way each installer resolves them", () => {
    expect(installedVersionMatches("uv", "6.0.0rc1", "6.0.0RC1")).toBe(true);
    expect(installedVersionMatches("uv", "6.0.1", "5.13.2")).toBe(false);
    expect(installedVersionMatches("npm", "1.0.0-Beta", "1.0.0-beta")).toBe(false);
  });
});
