/** Match generated files by kind so a cache-like symlink or special file stays visible. */
export const isRuntimeArtifact = (name: string, kind: string): boolean =>
  kind === "directory" ? name === "__pycache__"
    : kind === "regular" && (name === ".DS_Store" || name.endsWith(".pyc") || name.endsWith(".pyo"));
