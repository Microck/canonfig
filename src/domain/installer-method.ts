export const installerMethods = ["apt", "brew", "bun", "cargo", "npm", "pnpm", "uv", "winget"] as const;
export type InstallerMethod = typeof installerMethods[number];
const homebrewAlias = "homebrew";
export const installerMethodInputs = [...installerMethods, homebrewAlias] as const;

export const normalizeInstallerMethod = (method: string): InstallerMethod => {
  const requested = method === homebrewAlias ? "brew" : method;
  const normalized = installerMethods.find((candidate) => candidate === requested);
  if (normalized === undefined) {
    throw new Error("Unsupported installer method");
  }
  return normalized;
};
