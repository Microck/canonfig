# Shield redirects into the Canonical Folder

Status: accepted.

Shield routes Source installations into the Canonical Folder as unpublished changes, and Follower installations into the Local folder. It respects the Source's `local.allow` and requires an explicit Local Overlay for a name collision. It does not edit a Follower's mirror, publish a revision, or add a resident daemon.

## Native plugins

`plugins/<id>/plugin.jsonc` declares a Native Plugin's harness-specific variants. Each variant selects explicit platforms, a package directory within the item, its native entry when required, and tool requirements. The package's own manifest and executable files remain intact; Canonfig does not flatten native packages into skills and lose their hooks or dependencies. Only variants with a verified native loader contract are accepted. A plugin without a compatible variant is reported, not silently translated.

Publication uses the existing signed Profile Revision and per-file digest verification. Plugin trees are regular files only, with executable intent included. The reviewed digest covers the variant declaration and every payload file and mode; changing any of them invalidates review. Unreviewed items remain inspectable but do not activate or publish. Dependencies must be included in the reviewed package or declared as existing tool resources with platform-specific recipes, not fetched by an unsigned bootstrap step during projection.

`local.allow` can admit `plugins`; Local Overlays work by plugin id. `excludePlugins` is machine-local and can decline a published plugin. Exclusion never changes the mirrored revision. Plugin registration and payload removal use the same projection, takeover, drift and retirement machinery as other harness surfaces.

## Defense boundaries

Instructions guide agents but cannot enforce writes. Synchronous harness hooks can deny a matching tool call and name its canonical destination; they do not intercept standalone processes or prove an arbitrary shell command safe. Installer interception is explicit and scoped to supported installer invocations. Sync-time ingestion recovers new foreign items before projection, without treating changed managed items as newly installed content.

Shield ingests complete native packages before ordinary skill discovery, so plugin hooks and package dependencies are not flattened into skills. Original cache registrations are disabled before their payload is removed. A package becomes active only after digest review and projection. Identical staged packages are idempotent; changed code needs a deliberate update and another review.

The launcher intercepts its initial command as well as descendant installers. Hard mode protects configuration-only files, native module directories and shared skill directories. Mixed configuration/authentication files remain writable. Canonfig sync runs outside the protected process tree so projection retains write access.

Optional hard protection is process-scoped. It must not freeze whole harness homes, auth/session files, the Canonical Folder or Canonfig's own projection. Unsupported operating-system enforcement must fail visibly rather than claim protection. Running outside the protected launcher is outside that enforcement boundary.

## Rejected alternatives

- Blanket immutable flags and ACLs on harness homes: break login refresh, sessions and native updates; same-user processes can also undo owner permissions.
- Symlinking harness configuration roots to the Canonical Folder: mixes secrets with authored content and bypasses Follower mirror ownership.
- Inert quarantine as successful plugin installation: preserves bytes but does not install the requested capabilities.
- Rewriting every arbitrary shell command: cannot preserve shell semantics or constitute a security boundary.
- Automatically publishing redirected code: bypasses review and the existing trust model.
