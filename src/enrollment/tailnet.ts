import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { access } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { Config, Effect, Schema } from "effect";
import { promisify } from "node:util";
import type { TailnetReport } from "../domain/tailnet.ts";

const ipv4Addresses = new BlockList();
ipv4Addresses.addSubnet("100.64.0.0", 10, "ipv4");
const ipv6Addresses = new BlockList();
ipv6Addresses.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

export const isTailnetAddress = (address: string): boolean => {
  const family = isIP(address);
  return family === 4 ? ipv4Addresses.check(address, "ipv4")
    : family === 6 && ipv6Addresses.check(address, "ipv6");
};

const LocalStatus = Schema.Struct({
  BackendState: Schema.String,
  TUN: Schema.optional(Schema.Boolean),
  TailscaleIPs: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  CertDomains: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  Self: Schema.optional(Schema.NullOr(Schema.Struct({
    DNSName: Schema.optional(Schema.String),
    Expired: Schema.optional(Schema.Boolean),
    KeyExpiry: Schema.optional(Schema.String),
  }))),
  CurrentTailnet: Schema.optional(Schema.NullOr(Schema.Struct({
    Name: Schema.String,
    MagicDNSEnabled: Schema.Boolean,
  }))),
});
const LocalPrefs = Schema.Struct({ ControlURL: Schema.String });

/** Decodes only fields used for discovery; unknown LocalAPI fields are not persisted. */
export const describeTailnet = (statusJson: string, prefsJson: string, now = Date.now()): TailnetReport => {
  const status = Schema.decodeUnknownSync(Schema.fromJsonString(LocalStatus))(statusJson);
  const prefs = Schema.decodeUnknownSync(Schema.fromJsonString(LocalPrefs))(prefsJson);
  const dnsName = status.Self?.DNSName?.replace(/\.$/u, "").toLowerCase();
  const ips = (status.TailscaleIPs ?? []).filter(isTailnetAddress);
  const expiry = status.Self?.KeyExpiry;
  const expired = status.Self?.Expired === true || (expiry !== undefined && Date.parse(expiry) <= now);
  const problem = status.BackendState !== "Running"
    ? `Tailscale is ${status.BackendState}. Start the client and complete login or machine approval.`
    : expired ? "The Tailscale node key has expired. Renew it before starting tailnet mode."
    : status.TUN !== true ? "Tailscale uses userspace networking. Tailnet listeners require kernel networking."
    : !status.CurrentTailnet?.MagicDNSEnabled || !dnsName || !dnsName.includes(".")
      ? "MagicDNS is unavailable. Enable it on your Tailscale or Headscale control server."
    : ips.length === 0 ? "Tailscale reported no address in its supported IPv4 or IPv6 ranges."
    : undefined;
  return {
    installed: true,
    ready: problem === undefined,
    backendState: status.BackendState,
    addresses: ips,
    dnsName: dnsName || undefined,
    tailnet: status.CurrentTailnet?.Name,
    controlUrl: prefs.ControlURL,
    httpsAvailable: (status.CertDomains?.length ?? 0) > 0,
    userspace: status.TUN === false,
    detail: problem ?? `Tailscale is ready at ${dnsName}. Use --tailnet for direct connections without an SSH tunnel.`,
  };
};

const bundledExecutable = async (programFiles: string): Promise<string> => {
  const candidate = process.platform === "darwin"
    ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    : process.platform === "win32" ? join(programFiles, "Tailscale", "tailscale.exe") : undefined;
  if (candidate !== undefined && await access(candidate).then(() => true, () => false)) return candidate;
  return process.platform === "win32" ? "tailscale.exe" : "tailscale";
};

const executeFile = promisify(execFile);
const localApi = async (executable: string, socket: string, path: string, signal: AbortSignal): Promise<string> => {
  // The native client owns macOS app authentication and Windows pipe ownership checks.
  // stdout is the LocalAPI body; stderr is never parsed or exposed (it can contain local details).
  const { stdout } = await executeFile(executable, [...(socket ? [`--socket=${socket}`] : []), "debug", "localapi", "GET", path], {
    encoding: "utf8", timeout: 3_000, maxBuffer: 1024 * 1024, windowsHide: true, signal,
  });
  return stdout;
};

export const detectTailnet = Effect.fn("Tailnet.detect")(function*(): Effect.fn.Return<TailnetReport> {
  return yield* Effect.gen(function*() {
    const configured = yield* Config.string("CANONFIG_TAILSCALE_EXECUTABLE").pipe(Config.withDefault(""));
    const socket = yield* Config.string("CANONFIG_TAILSCALE_SOCKET").pipe(Config.withDefault(""));
    const programFiles = yield* Config.string("ProgramFiles").pipe(Config.withDefault("C:\\Program Files"));
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const executable = configured || await bundledExecutable(programFiles);
        const status = await localApi(executable, socket, "/localapi/v0/status?peers=false", signal);
        const prefs = await localApi(executable, socket, "/localapi/v0/prefs", signal);
        return describeTailnet(status, prefs);
      },
      catch: (cause) => cause,
    });
  }).pipe(Effect.catch((cause) => {
    const missing = cause instanceof Error && "code" in cause && cause.code === "ENOENT";
    return Effect.succeed({
      installed: !missing, ready: false, backendState: missing ? "NotInstalled" : "Unavailable",
      addresses: [], httpsAvailable: false, userspace: false,
      detail: missing
        ? "Tailscale CLI was not found. Install the client, or set CANONFIG_TAILSCALE_EXECUTABLE to its executable."
        : "Tailscale LocalAPI could not be read. Start the client, check local permissions and CANONFIG_TAILSCALE_SOCKET, and use a client with debug localapi support.",
    });
  }));
});

export const tailnetBinding = (report: TailnetReport) => {
  if (!report.ready || !report.dnsName) throw new Error(report.detail);
  const assigned = Object.values(networkInterfaces()).flatMap((entries) => entries ?? []);
  const available = report.addresses.filter((address) => assigned.some((entry) => entry.address === address));
  const address = available.find((value) => isIP(value) === 4) ?? available[0];
  if (address === undefined) throw new Error("The Tailscale address is not assigned to a local interface. Enable kernel networking before starting tailnet mode.");
  return { address, dnsName: report.dnsName };
};

/** Syntactic boundary. DNS names are permitted here, but must be resolved before any connection. */
export const sourceEndpointUrl = (endpoint: string): URL => {
  const url = new URL(endpoint);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const loopback = host === "127.0.0.1" || host === "::1";
  const dnsName = isIP(host) === 0 && host.includes(".") && /^[a-z0-9.-]+$/iu.test(host);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (!loopback && !isTailnetAddress(host) && !dnsName)) {
    throw new Error("Source endpoint must be a loopback or tailnet HTTPS origin. MagicDNS names must resolve only to tailnet addresses.");
  }
  return url;
};

/** Freeze one validated address so TLS inspection and credential submission cannot re-resolve DNS. */
export const resolveSourceEndpoint = async (
  endpoint: string,
  resolver: (hostname: string, options: { all: true }) => Promise<readonly { address: string; family: number }[]> = lookup,
): Promise<URL> => {
  const url = sourceEndpointUrl(endpoint);
  if (isIP(url.hostname.replace(/^\[|\]$/gu, "")) !== 0) return url;
  const resolved = await resolver(url.hostname, { all: true });
  if (resolved.length === 0 || resolved.some(({ address }) => !isTailnetAddress(address))) {
    throw new Error("Source DNS must resolve only to Tailscale addresses; no connection was made.");
  }
  const selected = resolved.find(({ family }) => family === 4) ?? resolved[0];
  if (selected === undefined) throw new Error("Source DNS returned no addresses");
  url.hostname = selected.family === 6 ? `[${selected.address}]` : selected.address;
  return url;
};
