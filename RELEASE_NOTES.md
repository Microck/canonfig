# Canonfig v7.1.0

`canonfig ui` can now be used from other devices on your tailnet, and
`canonfig self-update` can move to new minor and major versions.

## Reach the browser interface over Tailscale

- `canonfig ui --host <address>` listens on this machine's Tailscale address
  instead of `127.0.0.1`. It accepts loopback and Tailscale ranges only
  (`::1`, `100.64.0.0/10`, `fd7a:115c:a1e0::/48`) and refuses any other
  address, because the interface is served over plain HTTP. `100.64.0.0/10`
  is also used for carrier-grade NAT, so pass the address `tailscale ip`
  prints; on any other network the sign-in link and session cookie would
  travel unencrypted.
- `canonfig ui --port <n> --origin <https-url>` works behind an HTTPS proxy
  such as `tailscale serve`. The printed sign-in link uses that address, and
  the browser session cookie is marked `Secure`.

```bash
tailscale serve --bg 5317
canonfig ui --port 5317 --no-open --origin https://atlas.tailnet.ts.net
```

The sign-in link still works only once, and requests from any other host or
origin are still refused. Without these options `canonfig ui` listens on
`127.0.0.1` only, as before.

## Self-update beyond patches

- Automatic updates (`canonfig self-update auto`) install the newest patch in
  your current `major.minor` line, or the newest release of a newer major
  version when one exists. They never move to a new minor on their own.
- Manual updates (`canonfig self-update apply` and the Version page in
  `canonfig ui`) install the newest release in your current major version,
  including new minors. A newer major is reported with the command that
  installs it.
- An update to a new minor or major warns that a Source and its Followers
  only pair on the same `major.minor`, so every machine needs it. A major
  update also warns that it may refuse older state.

## Fixes

- The Machines page no longer shows the List view's loading skeleton on the
  Map, or the Map under the List's skeleton, when switching views.
- The Map's loading skeleton no longer shows a stray dot for an unreachable
  machine's connection.

## Upgrading

Stop running Canonfig commands, including `canonfig ui`, before installing. A
Source's background service keeps running the old code until it restarts, so
run `canonfig source service remove` before installing and
`canonfig source service install` afterwards.

Install with `npm install --global @microck/canonfig@7.1.0` on every machine.
Machines on 7.0.x run the earlier updater, which installs patches only, so
`canonfig self-update` cannot reach 7.1.0 from there; from 7.1.0 on it can
move between minor versions. A 7.1 Source and its Followers must all run
7.1.x, because Canonfig only pairs machines on the same minor version.
