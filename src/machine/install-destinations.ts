import { posix, win32 } from "node:path";

import type { InstallDestinationHint, MachinePlatform } from "./machine-state.types.ts";

/**
 * The directories where Canonfig's own installers place executables for the
 * given recipe methods, in the order a lookup should try them.
 *
 * A verifier used to search only the inherited PATH. A scheduled run gets a
 * bounded PATH (the runtime's directory plus the system directories), and a
 * fresh account's shell PATH need not contain ~/.local/bin either, so a tool
 * uv had just installed there failed verification on every run. These are the
 * same locations the installers resolve with the environment Canonfig gives
 * them: config-file and UV_/NPM_CONFIG_ variables are cleared for the install,
 * so only the variables read here can move a destination.
 */
export const installDestinationDirectories = (input: {
  readonly platform: MachinePlatform;
  readonly home: string;
  readonly environment: (name: string) => string | undefined;
  readonly methods: ReadonlyArray<InstallDestinationHint>;
}): ReadonlyArray<string> => {
  if (input.methods.length === 0) return [];
  const windows = input.platform === "windows";
  const path = windows ? win32 : posix;
  const variable = (name: string): string | undefined => {
    const value = input.environment(name);
    return value === undefined || value.length === 0 || !path.isAbsolute(value) ? undefined : value;
  };
  const localBin = path.join(input.home, ".local", "bin");
  const localAppData = variable("LOCALAPPDATA") ?? path.join(input.home, "AppData", "Local");
  const directories: Array<string> = [];
  for (const hint of input.methods) {
    const installerDirectory = hint.installer === undefined
      ? undefined
      : path.dirname(hint.installer.absolute);
    switch (hint.method) {
      case "uv": {
        // uv's own order once UV_TOOL_BIN_DIR is cleared for the install.
        const xdgData = variable("XDG_DATA_HOME");
        directories.push(
          variable("XDG_BIN_HOME")
            ?? (xdgData === undefined ? localBin : path.join(xdgData, "..", "bin")),
        );
        break;
      }
      case "npm": {
        // npm's global prefix is PREFIX, or the prefix of the Node that runs
        // it: the npm (or node) executable's own directory on POSIX, and the
        // prefix itself on Windows, where installers also default to %APPDATA%\npm.
        const prefix = variable("PREFIX");
        if (prefix !== undefined) directories.push(windows ? prefix : path.join(prefix, "bin"));
        if (installerDirectory !== undefined) directories.push(installerDirectory);
        const appData = variable("APPDATA");
        if (windows && appData !== undefined) directories.push(path.join(appData, "npm"));
        break;
      }
      case "pnpm": {
        const pnpmHome = variable("PNPM_HOME");
        directories.push(
          pnpmHome
            ?? (windows
              ? path.join(localAppData, "pnpm")
              : input.platform === "macos"
              ? path.join(input.home, "Library", "pnpm")
              : path.join(variable("XDG_DATA_HOME") ?? path.join(input.home, ".local", "share"), "pnpm")),
        );
        if (installerDirectory !== undefined) directories.push(installerDirectory);
        break;
      }
      case "bun":
        directories.push(path.join(variable("BUN_INSTALL") ?? path.join(input.home, ".bun"), "bin"));
        break;
      case "cargo":
        directories.push(path.join(
          variable("CARGO_INSTALL_ROOT") ?? variable("CARGO_HOME") ?? path.join(input.home, ".cargo"),
          "bin",
        ));
        break;
      case "brew":
      case "homebrew":
        // Formulae link into the prefix that holds brew itself.
        if (installerDirectory !== undefined) directories.push(installerDirectory);
        directories.push(
          ...(input.platform === "macos"
            ? ["/opt/homebrew/bin", "/usr/local/bin"]
            : ["/home/linuxbrew/.linuxbrew/bin"]),
        );
        break;
      case "winget":
        directories.push(path.join(localAppData, "Microsoft", "WinGet", "Links"));
        break;
      // apt installs into the system directories, which every PATH Canonfig
      // runs under (including the scheduler's) already contains.
    }
  }
  directories.push(localBin);
  return [...new Set(directories)];
};
