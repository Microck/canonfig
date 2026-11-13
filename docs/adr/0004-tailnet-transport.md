# ADR 0004: Native tailnet transport without changing Source authority

Status: accepted for #295 implementation.

## Context

Followers previously needed an SSH tunnel to a loopback Source. Tailscale and
Headscale already provide private routing and MagicDNS. Canonfig runs in Node,
while Tailscale's embedded tsnet server is a Go API. Machine-wide Serve state
may already belong to other applications, and Headscale does not support Serve.

## Decision

Use the installed native client's raw LocalAPI bridge for read-only discovery.
Decode status and preferences JSON, with bounded execution and output. The
native client owns platform-specific IPC authentication. Never change login,
control-server selection, network policy, Serve or Funnel configuration.

Offer explicit `--tailnet` selection for the Source and GUI. Resolve that
selection at every process start, bind an exact address reported by the running
client and assigned to a local interface, and advertise its MagicDNS name.
Require kernel networking and MagicDNS. Refuse startup otherwise; do not fall
back to loopback, a wildcard or a proxy. Native service registration persists
the selection rather than a potentially stale IP address.

One HTTPS client path handles loopback and tailnet endpoints. Resolve DNS once
per transport operation, reject answers outside Tailscale address ranges, and
reuse the selected IP for certificate inspection and the authenticated request.
Authenticate the exact DER certificate against the existing TLS pin, retaining
CA/expiry validation. A transport name is not Source identity. Source signing
keys, revision verification, invitations and Follower credentials are unchanged.

The GUI retains its existing HTTP-over-WireGuard model, single-use sign-in,
HttpOnly/SameSite cookies and exact Host/Origin checks. Tailnet mode admits only
the discovered MagicDNS origin and tailnet remote addresses. It does not accept
an arbitrary proxy origin. Browser-trusted HTTPS remains operator-managed
outside this mode.

## Consequences

- The same client works with Headscale's custom DNS domain and control URL.
- Public HTTPS certificate issuance is not a prerequisite.
- Userspace networking cannot host native listeners; failure is explicit.
- The native CLI must expose `debug localapi`, an unstable upstream interface.
  Unsupported clients fail with recovery instructions rather than switching paths.
- LocalAPI discovery is not enrollment authority. Whois identity binding is
  deliberately not introduced; it would be a separate policy decision.
- Administrator grants must restrict Source and GUI ports. Canonfig cannot undo
  a broader existing allow rule by adding a narrow one.

Primary contracts: [Tailscale LocalAPI client](https://github.com/tailscale/tailscale/blob/main/client/local/local.go),
[raw LocalAPI command](https://github.com/tailscale/tailscale/blob/main/cmd/tailscale/cli/debug.go),
[Headscale features](https://headscale.net/stable/about/features/).
