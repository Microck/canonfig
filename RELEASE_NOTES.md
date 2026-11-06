# Canonfig v6.1.0

## Use Canonfig in your browser

`canonfig ui` opens a browser interface for this machine's actual Canonfig state.
It runs in the foreground on `127.0.0.1` and opens a one-time login link.
Keep that link private and keep the terminal open while using the interface.
Node.js 24 or newer is required.

```sh
canonfig ui
canonfig ui --port 5317 --no-open
```

Without `--port`, the operating system chooses a free port. `--no-open` prints
the login link instead of opening the browser. Stop the server with Ctrl-C.
The public demo still uses made-up machines, not your configuration.

On a Source, you can set up the machine, edit the profile and its harnesses and
groups, validate and publish revisions, manage upstream skills and shared
secrets, export the profile, and invite or revoke followers. On a Follower,
you can join a Source, inspect and apply sync plans, recover or abandon
interrupted runs, edit allowed local items and overlays, manage harness
exclusions and key claims, restore backups, refresh secrets, configure schedules
and tunnels, and unenroll. Both roles expose status, doctor checks, agent policy,
installer checks and the applicable service settings.

Profile and local configuration edits preserve comments. If a file changed
since the browser read it, saving refuses the conflict instead of overwriting
the other edit. Reload to compare the disk version with your draft, then discard
or re-apply your edits. Machine-map names, icons, colours and layout stay in the
browser; they do not rename machines or change enrollment identities.

You can check, enable, disable and install self-updates from the Canonfig version
page. Stop other Canonfig processes before updating. After a successful update,
the GUI server exits and asks you to start `canonfig ui` again.

Archive import, installer binding and removal, and agent-assisted apply remain
CLI-only. Invitation cancellation, selective scan writes, service restart and
private-review deletion are not available in the live GUI; these are not
supported CLI operations either.

## Fixes and behavior changes

- Windows Ctrl-Break and console-close signals now shut Canonfig down cleanly.
- Leases left by dead processes no longer block self-update. Running Canonfig
  processes still block activation.
- Applying sync from the GUI refreshes shared secrets. CLI sync behavior is
  unchanged.
- The npm package is larger, about 1.24 MB packed, because it includes the GUI.

## Upgrade all machines together

Install the release on every Source and Follower:

```sh
npm install --global @microck/canonfig@6.1.0
canonfig --version
```

6.0 and 6.1 are different major.minor lines. Every Source and Follower must move
to 6.1 together; mixed lines fail the source/follower version handshake.
Self-update stays within a major.minor line and will not move 6.0.x to 6.1.
Once on 6.1, it can install stable 6.1.x patch releases.
