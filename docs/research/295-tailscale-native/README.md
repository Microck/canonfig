# #295: Tailscale-native Canonfig

## Findings and design

Canonfig should use the existing Tailscale client as transport and discovery, not as its application authority. Source certificate pins, signing keys, single-use invitations and Follower credentials remain mandatory. Headscale users use the same Tailscale client with their own control server.

The implementation uses the native client's read-only LocalAPI bridge, `tailscale debug localapi GET /localapi/v0/status?peers=false`, and `/localapi/v0/prefs`. This returns JSON response bodies, not human-readable CLI status. Tailscale's client owns Unix socket access, Windows named-pipe security and macOS GUI authentication. The bridge and some LocalAPI methods are unstable upstream; errors must remain explicit. No shell commands are constructed from API values. Calls have a time and output limit.

`doctor`, setup planning and Source service settings detect the client, daemon state, control server, tailnet, addresses, MagicDNS, certificate domains, expiry and userspace networking. Detection alone never changes network exposure. Operators opt in with `source serve --tailnet`, `source service install --tailnet`, or `ui --tailnet`.

Tailnet listeners bind one exact address reported by a running kernel-mode client, prefer IPv4, and advertise the node's MagicDNS name. They never bind a wildcard, LAN address or loopback proxy. Tailnet GUI traffic uses HTTP inside WireGuard, as Canonfig's existing tailnet GUI does; Source transport keeps its pinned HTTPS certificate. GUI sign-in, cookies and exact-origin checks remain in force. No Serve or Funnel configuration is written.

Followers use the invitation's HTTPS MagicDNS endpoint directly. DNS is resolved before connecting and every returned address must belong to Tailscale's ranges. One checked address is used throughout each request, preventing DNS rebinding between the certificate check and credential submission. The exact certificate pin, rather than a mutable node name, authenticates the Source. CA validation still enforces certificate validity; signing pins authenticate revisions independently.

## Executor

Inspected repository: [UsefulSoftwareCo/executor](https://github.com/UsefulSoftwareCo/executor), revision `847a50b1e119d0e33e92313e99e0f4fc609bf204b`.

The inspected local server configuration accepts an explicit HTTPS `EXECUTOR_BROWSER_ORIGIN`. Its docs describe a manually configured Tailscale Serve proxy. The local service discovers itself through `server.json` and uses a per-process password. This is useful precedent for exact-origin checks and keeping application authentication above the private transport. The inspected code does not establish automatic tailnet detection or enrollment. Canonfig should not describe that manual proxy recipe as an automatic discovery implementation.

## Prior art and rejected alternatives

| Approach | Evidence | Decision |
| --- | --- | --- |
| Executor's manual Serve proxy | Explicit HTTPS browser origin and local service contract | Reuse origin discipline, not proxy configuration ownership. |
| golink | Go `tsnet` listener and LocalAPI identity lookup | Useful authority and network boundary precedent; embedding Go would add a second runtime and node identity lifecycle. |
| tsidp | Go `tsnet.Server`, tailnet identity provider | Its identity-provider authority is not Canonfig's Source authority. |
| tclip | Go `tsnet` service, auth-key/state lifecycle | A separate embedded node is unnecessary when an installed client already supplies the tailnet. |
| Direct native IPC reimplementation | LocalAPI client has platform-specific authentication and ownership checks | Use the native client's raw LocalAPI bridge instead of duplicating those sensitive details in Node. |
| Managed Serve | Tailnet proxy, machine-global configuration; Headscale feature gap | Rejected: would conflict with existing Serve state and exclude Headscale. |
| CIDR-only GUI/source binding | A CGNAT address alone does not prove local Tailscale ownership | Require the running LocalAPI node's exact address in opt-in mode. |
| Public DNS or loopback fallback | Can expose credentials or silently select the wrong transport | Refuse. |

## Failure modes

| Condition | Required behavior |
| --- | --- |
| Client missing | Detection reports unavailable with installation guidance; loopback operation remains possible. |
| Daemon stopped or unreachable | Detection reports the state/error; tailnet startup refuses. |
| Logged out or awaiting machine approval | Report the backend state and require operator action. Never log in automatically. |
| Expired key | Refuse tailnet startup and ask the operator to renew it. |
| MagicDNS disabled or no node DNS name | Refuse advertised tailnet service; enable MagicDNS on Tailscale or Headscale. |
| OS cannot resolve MagicDNS | Follower fails before sending credentials; repair resolver configuration. |
| DNS resolves outside tailnet ranges | Refuse before TLS or HTTP. |
| HTTPS certificates disabled | Report availability; pinned Source HTTPS and WireGuard GUI do not require public certificates. |
| Userspace networking | Refuse native listener mode: the reported address is not an OS interface. |
| Exit node selected | Continue binding only the node's own tailnet address. No default-route or exit-node changes. |
| Existing Serve/Funnel configuration | Leave it untouched; use a non-conflicting native port. |
| macOS GUI / Windows client | Native CLI owns LocalAPI access; app-bundled executable discovery where necessary. Native-platform proof must be stated separately. |
| Headscale | Accept the configured control URL and DNS suffix; do not require `.ts.net`, Serve or public cert issuance. |
| Port occupied / interface absent | Fail startup. Never retry on wildcard or loopback. |
| Source pin changed | Refuse authentication even when DNS and tailnet membership are valid. |

## Security analysis

Tailscale adds encrypted network transport, private addressing, DNS discovery and administrator-managed network access. It does not authorize a machine to receive Canonfig configuration. Invitations, Follower credentials, TLS pins and Source signatures still do that. A compromised control plane or DNS response cannot substitute another Source certificate or signing identity. A compromised Source or stolen application credentials remain application risks.

The GUI has no Source certificate pin in a browser. Its tailnet-only HTTP connection depends on WireGuard and the authenticated native interface, plus the existing single-use sign-in and same-origin protections. Do not publish its sign-in URL or proxy it to the public internet. Operators who need browser-trusted HTTPS can separately manage a trusted proxy, outside opt-in tailnet mode.

LocalAPI Whois can map a remote address to a node, but binding Follower identity to that node would change the enrollment authority model. It is not required for this feature. This implementation does not trust forwarded identity headers or replace credentials with tailnet membership.

Policy examples must restrict the Source port to Follower nodes and the GUI port to operator devices. Tailnet-wide allow rules already present in a policy must be removed or narrowed by the administrator; adding a restrictive rule does not override broader grants.

## Observed fixtures and proof

`status.redacted.json` and `prefs.redacted.json` contain allowlisted fields from real LocalAPI responses. Personal node names and IPs are replaced with examples; no auth keys, private keys or peer inventory are retained. The live client reported `Running`, kernel networking, MagicDNS enabled and a certificate domain. Existing Serve configuration and Whois were inspected read-only. No live login, policy, Serve or Canonfig state was changed.

Task-owned Raft workspace: `paris:rf-41f42b8080574481`, one CPU and 4 GiB.
The Source used a disposable HOME and local-file credential store on port 27495.
The Follower used `/workspace/295-follower` and its own credential store. Its OS
resolver returned the Source's tailnet address for the MagicDNS name, with no
hosts-file override. The container used its host's tailnet connection, not its
own enrolled Tailscale node. Raft's SSH control connection was not a Canonfig
Source tunnel.

Commands run against those isolated roots:

```sh
canonfig source init
canonfig source publish --reviewer tailnet-proof
canonfig source serve --tailnet --port 27495
canonfig source invite --endpoint https://source.tail-example.ts.net:27495 --output ./invitation --expires 60m
# Transfer the invitation privately to the Raft environment.
cat ./invitation | canonfig follower enroll --stdin --name raft-tailnet-proof --json
canonfig sync --plan --json
canonfig sync --apply --json
canonfig status --json
canonfig tunnel status --json
```

These commands ran as `node --import tsx src/runtime/main.ts` before packaging.
The hostname above is redacted. [Follower output](follower-proof.redacted.jsonl)
records successful enrollment, `Converged`, all three file verifications, and
`tunnel.lifecycle: not-configured`. The projection included the disposable
Follower's `.codex/AGENTS.md`, not only an empty synchronization run.

[Exposure refusals](exposure-refusals.json) record exit 2 for wildcard/LAN Source
options and incompatible GUI host/proxy options. A real task-owned userspace
`tailscaled` in Raft reported `NeedsLogin`; after SIGTERM and exit 0, detection
reported `Unavailable` with `ready: false`. [Daemon output](stopped-daemon.json)
records both states. It had separate state and socket paths, never logged in,
and never changed the host daemon.

The packaged UI was also exercised in a task-owned native Chromium browser.
Source settings detected the client and offered an enabled Tailscale choice;
no native service was installed. A second disposable GUI read a MagicDNS
invitation, omitted SSH controls, verified both pins against Source output and
joined successfully. Its CLI status reported active enrollment and no tunnel.
See [GUI evidence](gui-proof.json), [Source settings](gui-tailnet.redacted.png),
and [joined Follower](gui-enrolled.redacted.png). Screenshot labels and hostnames
are redacted. Shared browser helpers failed to launch; direct Playwright with
the installed native Chromium executable supplied the actual browser proof.

## Verification results

- `npm run typecheck`, `npm run lint`, UI typecheck/lint and
  `npm run build:cli` passed in the task-owned Raft workspace. Documentation
  validation covered 451 command examples and three skills. UI lint reported
  73 warnings and no errors.
- The focused CLI, doctor and tailnet tests passed: 158 tests. Earlier
  enrollment and secret-transfer suites also passed.
- The complete UI run passed 148 tests and failed one self-update test with
  Happy DOM `AbortError: The animation was canceled.` The same resources test
  file on pristine base `7070b84` reproduced that failure, with two tests passed
  and one failed. The isolated self-update test passed unchanged. No test was
  skipped or weakened, and the unrelated animation code remains unchanged.
- The complete backend suite's output was lost when the session was
  interrupted. Its process had exited, but no result artifact was available.
  This report does not claim that suite passed.
- The research folder passed `gitleaks dir --redact --no-banner` without leaks.

## Open risks

- LocalAPI bridge is explicitly unstable upstream. Unsupported versions must fail visibly.
- macOS and Windows need native-platform verification; Linux success is not that evidence.
- The disposable Raft Follower reaches the tailnet through its host, not a separate enrolled Tailscale node. This topology proves direct MagicDNS application transport, not separate-node registration.
- No human testing has happened. The maintainer explicitly authorized a ready-for-review PR before human testing, with `human_testing: none yet; maintainer to test before merge`.

See [sources.md](sources.md) for implementation-driving references.
