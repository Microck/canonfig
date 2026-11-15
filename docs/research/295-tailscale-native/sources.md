# Sources

Read during #295 research. Source links identify the claims they support; mutable upstream files should be rechecked when the integration changes.

- https://github.com/UsefulSoftwareCo/executor/blob/847a50b1e119d0e33e92313e99e0f4fc609bf204b/apps/local/server/src/contracts/config.ts: explicit HTTPS browser-origin validation and local server configuration.
- https://github.com/UsefulSoftwareCo/executor/blob/847a50b1e119d0e33e92313e99e0f4fc609bf204b/apps/local/server/src/contracts/service.ts: local `server.json` discovery, per-process password and service pairing lifecycle.
- https://github.com/UsefulSoftwareCo/executor/blob/847a50b1e119d0e33e92313e99e0f4fc609bf204b/apps/docs/content/run/cli.mdx: documented manual Tailscale Serve recipe.
- https://github.com/tailscale/tailscale/blob/main/client/local/local.go: LocalAPI client, platform-native dial/authentication, status, preferences and Whois APIs; stability caveats.
- https://github.com/tailscale/tailscale/blob/main/cmd/tailscale/cli/debug.go: `debug localapi` uses `DoLocalRequest`, writes the response body to stdout, writes diagnostics to stderr and returns failure for non-2xx responses; debug interface is unstable.
- https://github.com/tailscale/tailscale/blob/main/ipn/ipnstate/ipnstate.go: status JSON fields, backend states, TUN, node IPs, DNS name, expiry, certificate domains and tailnet information.
- https://github.com/tailscale/tailscale/tree/main/safesocket: native socket, named-pipe and macOS authentication boundary.
- https://github.com/tailscale/tailscale/tree/main/cmd/tailscale/cli: Serve configuration management and CLI boundaries.
- https://headscale.net/stable/about/features/: Headscale feature support, including MagicDNS and lack of Tailscale Serve support.
- https://headscale.net/stable/ref/dns/: custom MagicDNS base domain and resolver configuration.
- https://github.com/tailscale/golink/blob/d4c752ba2a71793dd8035a5b23746f2c97831c89/golink.go: tsnet, control URL, LocalAPI Whois and application authorization.
- https://github.com/tailscale/tsidp/blob/1185ae6be1eaf3b00507f57334397f68f2b028d8/tsidp-server.go: Go tsnet server integration.
- https://github.com/tailscale/tsidp: identity-provider requirements and supported authentication protocols.
- https://github.com/tailscale-dev/tclip/blob/main/cmd/tclipd/main.go: tsnet service entrypoint.
- https://github.com/tailscale-dev/tclip: auth-key, state and service deployment lifecycle.
- https://tailscale.com/docs/reference/syntax/policy-file: grants, ACL syntax, groups and policy semantics.

Local evidence: `tailscale status --json`, `tailscale whois --json`, `tailscale serve status --json`, read-only `/localapi/v0/status?peers=false` and `/localapi/v0/prefs` on the existing Linux daemon; selected, redacted fields are in this folder. `tailscale debug localapi --help` confirmed the installed raw LocalAPI bridge.
