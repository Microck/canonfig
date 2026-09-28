import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { evaluateCli } from "../src/cli/cli.ts";
import {
  programDisplayName,
  programName,
  programVersion,
} from "../src/cli/help.ts";

const projectRoot = resolve(import.meta.dirname, "..");
const runtimeEntrypoint = resolve(projectRoot, "src/runtime/main.ts");

const executeCli = (arguments_: ReadonlyArray<string>) =>
  spawnSync(process.execPath, ["--import", "tsx", runtimeEntrypoint, ...arguments_], {
    cwd: projectRoot,
    encoding: "utf8",
  });

describe("Canonfig foundation CLI", () => {
  it("renders Canonfig help with a successful outcome", () => {
    const outcome = evaluateCli(["--help"]);
    expect(outcome._tag).toBe("Help");
    if (outcome._tag === "Help") {
      expect(outcome.text).toContain(`${programDisplayName} ${programVersion}`);
      expect(outcome.text).toContain(`Usage: ${programName}`);
      expect(outcome.exitCode).toBe(0);
    }
  });

  // CF-61: every command group is discoverable from global help, and each
  // group answers its own --help instead of repeating the global listing.
  const commandAreas = [
    "source", "follower", "sync", "recover", "abandon", "status", "overlay",
    "doctor", "tunnel", "profile", "agent", "setup", "schedule",
    "secrets", "harness", "installer",
  ] as const;

  it.each(commandAreas)("lists the %s command group in global help", (area) => {
    const outcome = evaluateCli(["--help"]);
    expect(outcome._tag === "Help" ? outcome.text : "").toMatch(
      new RegExp(`^  ${programName} ${area}( |$)`, "mu"),
    );
  });

  it.each(commandAreas.filter((area) => !["secrets", "harness", "installer"].includes(area)))(
    "renders group help for %s --help",
    (area) => {
      const global = evaluateCli(["--help"]);
      for (const arguments_ of [[area, "--help"], ["--json", area, "-h"]]) {
        const outcome = evaluateCli(arguments_);
        expect(outcome._tag).toBe("Help");
        if (outcome._tag !== "Help" || global._tag !== "Help") continue;
        expect(outcome.exitCode).toBe(0);
        expect(outcome.text).not.toBe(global.text);
        expect(outcome.text).toMatch(new RegExp(`^  ${programName} ${area}( |$)`, "mu"));
        expect(outcome.text).toContain(`Run '${programName} --help' for every command group.`);
      }
    },
  );

  it("keeps an unknown area on the global listing", () => {
    const outcome = evaluateCli(["no-such-group", "--help"]);
    const global = evaluateCli(["--help"]);
    expect(outcome).toEqual(global);
  });

  // Help reads no state. `installer --help` used to build the machine layer
  // first, which loads the state module and reads state.sqlite for the
  // enrolled credential policy. The preload makes any load of node:sqlite
  // fail the command, and the empty HOME must stay empty.
  it("answers every group's --help without loading or creating state", async () => {
    const denyStateDatabase = "data:text/javascript,"
      + "import{registerHooks}from'node:module';"
      + "registerHooks({resolve(specifier,context,next){"
      + "if(specifier==='node:sqlite')throw new Error('help loaded the state database module');"
      + "return next(specifier,context)}})";
    const invocations = [
      ...commandAreas.map((area) => [area, "--help"]),
      ["secrets"],
      ["secrets", "set", "--help"],
      ["--json", "installer", "-h"],
      ["installer", "set", "npm", "--help"],
      ["follower", "enroll", "--stdin", "--help"],
      ["--help"],
      ["--version"],
    ];
    const home = mkdtempSync(join(tmpdir(), "canonfig-help-home-"));
    try {
      const results = await Promise.all(invocations.map((arguments_) =>
        promisify(execFile)(
          process.execPath,
          ["--import", denyStateDatabase, "--import", "tsx", runtimeEntrypoint, ...arguments_],
          {
            cwd: projectRoot,
            encoding: "utf8",
            env: { ...process.env, HOME: home, USERPROFILE: home, CANONFIG_LOG: "off" },
          },
        ).then(
          ({ stdout }) => ({ arguments_, exitCode: 0, stdout, stderr: "" }),
          (error: { code?: number; stdout?: string; stderr?: string }) =>
            ({ arguments_, exitCode: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }),
        )
      ));
      for (const result of results) {
        expect(result, result.arguments_.join(" ")).toMatchObject({ exitCode: 0, stderr: "" });
        expect(result.stdout.trim().length, result.arguments_.join(" ")).toBeGreaterThan(0);
      }
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

  it("renders the package version with a successful outcome", () => {
    expect(evaluateCli(["--version"])).toEqual({
      _tag: "Version",
      text: "4.0.0",
      exitCode: 0,
    });
  });

  it("uses Canonfig naming at the CLI and package boundaries", () => {
    const packageManifest = readFileSync(resolve(projectRoot, "package.json"), "utf8");
    expect(programName).toBe("canonfig");
    expect(programDisplayName).toBe("Canonfig");
    expect(packageManifest).toContain('"name": "@microck/canonfig"');
    expect(packageManifest).toContain('"canonfig": "dist/runtime/main.js"');
  });

  it("maps invalid input to exit code 2 and stderr", () => {
    const result = executeCli(["unsupported"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown argument: unsupported");
    expect(result.stderr).toContain("canonfig --help");
  });

  it("runs help and version through the Effect runtime entrypoint", () => {
    const help = executeCli(["--help"]);
    const version = executeCli(["--version"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: canonfig");
    expect(help.stderr).toBe("");
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe("4.0.0");
    expect(version.stderr).toBe("");
  }, 60_000);

  it("does not depend on the legacy src/index.ts entrypoint", () => {
    const cliSource = readFileSync(resolve(projectRoot, "src/cli/cli.ts"), "utf8");
    const runtimeSource = readFileSync(runtimeEntrypoint, "utf8");
    const compilerConfig = readFileSync(resolve(projectRoot, "tsconfig.json"), "utf8");
    expect(`${cliSource}\n${runtimeSource}`).not.toContain("index.ts");
    expect(compilerConfig).toContain('"exclude": ["src/index.ts"]');
  });
});
