import { describe, expect, it } from "vitest";
import { describeTailnet, isTailnetAddress, resolveSourceEndpoint, sourceEndpointUrl, tailnetBinding } from "../../src/enrollment/tailnet.ts";

const status = {
  BackendState: "Running", TUN: true,
  TailscaleIPs: ["100.64.0.10", "fd7a:115c:a1e0::10"],
  Self: { DNSName: "source.private.example.", Expired: false },
  CurrentTailnet: { Name: "Private", MagicDNSEnabled: true },
  CertDomains: [],
};
const prefs = { ControlURL: "https://headscale.example" };

describe("tailnet network boundary", () => {
  it("accepts Headscale MagicDNS without public certificates", () => {
    const report = describeTailnet(JSON.stringify(status), JSON.stringify(prefs));
    expect(report).toMatchObject({ ready: true, dnsName: "source.private.example", controlUrl: prefs.ControlURL, httpsAvailable: false });
  });

  it("accepts a node without key expiry, which LocalAPI reports as null fields", () => {
    const report = describeTailnet(JSON.stringify({ ...status, Self: { DNSName: "source.private.example.", Expired: null, KeyExpiry: null } }), JSON.stringify(prefs));
    expect(report.ready).toBe(true);
  });

  it.each(["Stopped", "NeedsLogin", "NeedsMachineAuth", "Starting"])("refuses a %s client", (BackendState) => {
    const report = describeTailnet(JSON.stringify({ ...status, BackendState }), JSON.stringify(prefs));
    expect(report.ready).toBe(false);
    expect(report.backendState).toBe(BackendState);
    expect(() => tailnetBinding(report)).toThrow();
  });

  it("refuses expired, userspace and DNS-disabled clients", () => {
    for (const changed of [
      { ...status, Self: { ...status.Self, Expired: true } },
      { ...status, Self: { ...status.Self, KeyExpiry: "2020-01-01T00:00:00Z" } },
      { ...status, TUN: false },
      { ...status, CurrentTailnet: { ...status.CurrentTailnet, MagicDNSEnabled: false } },
      { ...status, TailscaleIPs: ["192.168.1.20"] },
    ]) {
      const report = describeTailnet(JSON.stringify(changed), JSON.stringify(prefs), Date.parse("2026-01-01T00:00:00Z"));
      expect(report.ready).toBe(false);
      expect(() => tailnetBinding(report)).toThrow();
    }
  });

  it("requires a complete LocalAPI status, not successful CLI text", () => {
    expect(() => describeTailnet("Running", JSON.stringify(prefs))).toThrow();
    expect(() => describeTailnet("{}", JSON.stringify(prefs))).toThrow();
  });

  it.each(["100.64.0.0", "100.127.255.255", "fd7a:115c:a1e0::1"])("recognizes private range address %s", (address) => {
    expect(isTailnetAddress(address)).toBe(true);
  });
  it.each(["100.63.255.255", "100.128.0.0", "192.168.1.20", "0.0.0.0", "::", "::ffff:100.64.0.10", "fd7a:115c:a1e1::1"])("refuses non-tailnet address %s", (address) => {
    expect(isTailnetAddress(address)).toBe(false);
  });

  it.each([
    "http://source.private.example:17342", "https://user:secret@source.private.example:17342",
    "https://source.private.example:17342/path", "https://source.private.example:17342/?token=value",
    "https://source.private.example:17342/#fragment", "https://192.168.1.20:17342", "https://0.0.0.0:17342",
  ])("refuses unsafe endpoint %s", (endpoint) => {
    expect(() => sourceEndpointUrl(endpoint)).toThrow();
  });
});

describe("MagicDNS resolution before authentication", () => {
  it("freezes the checked IPv4 address for both TLS and credential requests", async () => {
    const endpoint = await resolveSourceEndpoint("https://source.private.example:17342", 10_000, async () => [
      { address: "fd7a:115c:a1e0::10", family: 6 },
      { address: "100.64.0.10", family: 4 },
    ]);
    expect(endpoint.origin).toBe("https://100.64.0.10:17342");
  });

  it("supports an IPv6-only Headscale DNS answer", async () => {
    const endpoint = await resolveSourceEndpoint("https://source.private.example", 10_000, async () => [
      { address: "fd7a:115c:a1e0::10", family: 6 },
    ]);
    expect(endpoint.origin).toBe("https://[fd7a:115c:a1e0::10]");
  });

  it.each([[], ["100.64.0.10", "192.168.1.20"], ["127.0.0.1"], ["203.0.113.20"]])("refuses empty or mixed DNS answers %j", async (...addresses: string[]) => {
    await expect(resolveSourceEndpoint("https://source.private.example:17342", 10_000, async () =>
      addresses.map((address) => ({ address, family: 4 }))
    )).rejects.toThrow("Source DNS must resolve only to Tailscale addresses");
  });

  it("gives up on a resolver that never answers", async () => {
    await expect(resolveSourceEndpoint("https://source.private.example", 20, () => new Promise<never>(() => undefined)))
      .rejects.toThrow("Resolving the Source name timed out");
  });
});
