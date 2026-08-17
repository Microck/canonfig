/**
 * Structural classification for npm package specifications.
 *
 * npm accepts more than registry names in the package position. Keeping this
 * parser independent from command authorization lets discovery, deterministic
 * installers, and agent proposals apply the same fail-closed rules.
 */
export type NpmPackageSpecification =
  | {
    readonly kind: "registry";
  }
  | {
    readonly kind: "local";
    readonly path?: string | undefined;
  }
  | {
    readonly kind: "remote";
    readonly origin: string;
  }
  | {
    readonly kind: "ambiguous";
  };

const hostedOrigins = {
  bitbucket: "https://bitbucket.org",
  github: "https://github.com",
  gitlab: "https://gitlab.com",
} as const satisfies Readonly<Record<"bitbucket" | "github" | "gitlab", string>>;

const hostedProtocol = /^(github|gitlab|bitbucket):/iu;
const localProtocol = /^(?:file|link|workspace):/iu;
const githubShorthand = /^[^/@\s:]+\/[^/@\s:]+(?:#.*)?$/u;

const originForHttpUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username.length > 0 || url.password.length > 0) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
};

const hostedOriginForUrl = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (!["git:", "http:", "https:", "ssh:"].includes(url.protocol)) return undefined;
    const host = url.hostname.toLowerCase();
    const hosted = Object.entries(hostedOrigins).find(([, origin]) =>
      new URL(origin).hostname === host
    );
    if (hosted === undefined) return undefined;
    if (url.username.length > 0 && url.username.toLowerCase() !== "git") return undefined;
    if (url.password.length > 0) return undefined;
    const defaultPort = (url.protocol === "http:" && url.port === "80")
      || (url.protocol === "https:" && url.port === "443");
    const port = url.port.length === 0 || defaultPort ? "" : `:${url.port}`;
    return `${hosted[1]}${port}`;
  } catch {
    return undefined;
  }
};

const hostedNameForHost = (
  host: string,
): keyof typeof hostedOrigins | undefined => {
  const normalized = host.toLowerCase();
  if (normalized === "github.com" || normalized === "www.github.com") return "github";
  if (normalized === "gitlab.com" || normalized === "www.gitlab.com") return "gitlab";
  if (normalized === "bitbucket.org" || normalized === "www.bitbucket.org") return "bitbucket";
  return undefined;
};

const remoteOrigin = (value: string): string | undefined => {
  if (/^git@/iu.test(value)) {
    const match = /^git@([^/:?#\s]+):([^?#\s]+)$/iu.exec(value);
    if (match === null) return undefined;
    const host = match[1]!.toLowerCase();
    const hostedName = hostedNameForHost(host);
    const hosted = hostedName === undefined ? undefined : hostedOrigins[hostedName];
    return hosted === undefined
      ? undefined
      : hosted;
  }
  const withoutGitPrefix = value.replace(/^git\+/iu, "");
  const hosted = hostedOriginForUrl(withoutGitPrefix);
  if (hosted !== undefined) return hosted;
  return originForHttpUrl(withoutGitPrefix);
};

const isRegistryName = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._~-]*$/u.test(value)
  || /^@[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+$/u.test(value);

const isRegistryVersion = (value: string): boolean =>
  value.length > 0
  && !/[\s/:\\]/u.test(value)
  && !value.startsWith("#");

const packageNameAndTarget = (
  value: string,
): { readonly name: string; readonly target: string } | undefined => {
  const separator = value.startsWith("@")
    ? value.indexOf("@", 1)
    : value.indexOf("@");
  if (separator <= 0) return undefined;
  const name = value.slice(0, separator);
  const target = value.slice(separator + 1);
  return target.length === 0 ? undefined : { name, target };
};

const classifyRemoteTarget = (
  value: string,
): NpmPackageSpecification | undefined => {
  const hosted = hostedProtocol.exec(value);
  if (hosted !== null) {
    const protocol = hosted[1]!.toLowerCase();
    const rest = value.slice(hosted[0].length);
    if (!/^[^/#\s?@:]+\/[^#\s?@:]+(?:#.*)?$/u.test(rest)) {
      return { kind: "ambiguous" };
    }
    const origin = protocol === "github"
      ? hostedOrigins.github
      : protocol === "gitlab"
      ? hostedOrigins.gitlab
      : hostedOrigins.bitbucket;
    return { kind: "remote", origin };
  }
  if (/^(?:git\+|git:\/\/|git@|https?:\/\/|ssh:\/\/)/iu.test(value)) {
    const origin = remoteOrigin(value);
    return origin === undefined
      ? { kind: "ambiguous" }
      : { kind: "remote", origin };
  }
  if (githubShorthand.test(value)) {
    return { kind: "remote", origin: hostedOrigins.github };
  }
  return undefined;
};

const classifyRegistryOrAlias = (
  value: string,
): NpmPackageSpecification => {
  const remote = classifyRemoteTarget(value);
  if (remote !== undefined) return remote;
  if (localProtocol.test(value)) return localSpecification(value);
  if (value.startsWith("npm:")) {
    const target = value.slice("npm:".length);
    if (!isRegistryName(target) && !packageNameAndTarget(target)) {
      return { kind: "ambiguous" };
    }
    return classifyRegistryOrAlias(target);
  }
  const alias = packageNameAndTarget(value);
  if (alias !== undefined) {
    if (!isRegistryName(alias.name)) return { kind: "ambiguous" };
    if (alias.target.startsWith("npm:")) {
      return classifyRegistryOrAlias(alias.target.slice("npm:".length));
    }
    const remote = classifyRemoteTarget(alias.target);
    if (remote !== undefined) return remote;
    if (localProtocol.test(alias.target)) return localSpecification(alias.target);
    return isRegistryVersion(alias.target)
      ? { kind: "registry" }
      : { kind: "ambiguous" };
  }
  if (isRegistryName(value)) return { kind: "registry" };
  return { kind: "ambiguous" };
};

const localSpecification = (
  value: string,
): NpmPackageSpecification => {
  const separator = value.indexOf(":");
  if (separator < 0) return { kind: "local" };
  const protocol = value.slice(0, separator).toLowerCase();
  const path = value.slice(separator + 1);
  if (protocol === "workspace" && (path === "*" || path === "^" || path === "~")) {
    return { kind: "local" };
  }
  if (path.length === 0 || /\s/u.test(path)) return { kind: "ambiguous" };
  return { kind: "local", path };
};

/**
 * Classify one value in an npm package position.
 *
 * `foo/bar` is npm's GitHub shorthand. Explicit relative, absolute, and
 * workspace forms remain local, while unsupported protocol-like values are
 * ambiguous and must not be treated as registry packages.
 */
export const parseNpmPackageSpecification = (
  value: string,
): NpmPackageSpecification => {
  if (value.length === 0 || /\s/u.test(value)) return { kind: "ambiguous" };
  if (localProtocol.test(value)) return localSpecification(value);
  if (
    value.startsWith("/")
    || value.startsWith("./")
    || value.startsWith("../")
    || value.startsWith("~/")
    || /^[A-Za-z]:[\\/]/u.test(value)
  ) {
    return { kind: "local", path: value };
  }
  const remote = classifyRemoteTarget(value);
  if (remote !== undefined) return remote;
  if (
    (value.includes("://") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value))
    && packageNameAndTarget(value) === undefined
  ) {
    return { kind: "ambiguous" };
  }
  return classifyRegistryOrAlias(value);
};
