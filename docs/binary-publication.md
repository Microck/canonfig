# Native file publication

Status: implementation in progress, not deployed. Publication, the CLI, durable
raw-blob storage, revision-specific authorization, bounded HTTP ranges, and
follower hydration use the byte pipeline. Local transport checks cover empty
files, a 15 MiB binary file, cache reuse, and rejected malformed responses.
Native acceptance on Linux, macOS, Windows 11, and Windows 10 verifies file,
directory, and skill bytes after Source restart and authoring-file deletion,
a no-op second apply, and local byte drift.
Rollback checks restore binary and empty prior files with their original modes.
These isolated acceptance runs use fixture credentials and a recording scheduler;
they do not prove live native credential-store or scheduled-job readiness.
Live fleet convergence remains unverified.

## Decision

Publish regular files as raw bytes addressed by their SHA-256 digest. Signed
resource metadata carries the digest and exact byte length, never encoded file
contents. Text, images, fonts, audio, and executables use the same byte pipeline.

Keep inline text convenient at the authoring boundary. A native file is named
with the `source` field, a path relative to the profile file's directory, on a
`file` resource spec or on an entry of a directory or skill `files` list:

```jsonc
{ "kind": "file", "source": "assets/icon.png" }
{ "path": "assets/icon.png", "source": "assets/icon.png" }
```

`source` and inline `content` are mutually exclusive, and `encoding: "base64"`
applies only to inline `content`. There is no `content: { file: … }` form; the
authoring schema rejects it (`Expected string | undefined at
['resources'][0]['spec']['content']`). Canonfig rejects absolute paths, parent
traversal, and paths that resolve (after following symlinks) outside the
profile directory. It reads the selected regular file without a text encoding
and does not publish its Source path.

Inline strings become UTF-8 bytes without newline or Unicode normalization.
Equivalent inline text and native-file bytes produce identical published
semantics and revision identity. The authoring locator is not part of that
identity. Symlinks remain links and do not publish their referents as file bytes.

## Why this model

The previous publisher hashed a whole resource spec as one JSON blob. Followers
parsed that blob and turned content strings back into bytes. A single changed
asset therefore invalidated the whole directory or skill payload.

Base64 can preserve bytes, but adds `4 * ceil(length / 3)` characters and a
decoding contract. A 15 MiB file becomes 20 MiB before JSON framing. Canonfig
already has an octet-stream endpoint, so this encoding buys no needed transport
capability. Raising the current 8 MiB response limit alone does not fix the
text-only authoring model or resource-level payload duplication.

Raw per-file blobs align publication identity with the file digests already
used for synchronization. Unchanged files can share stored bytes across paths
and revisions. Paths, modes, and link targets remain resource metadata.

## Required boundaries

- Use the existing SHA-256 identifier convention. Do not introduce another hash
  spelling or algorithm negotiation merely to resemble another protocol.
- Authenticate both byte digest and byte length in signed resource metadata.
  Length is a non-negative safe integer. Neither a matching filename nor a
  successful HTTP response establishes byte integrity.
- Store immutable bytes durably before making a revision visible. Publication
  must not depend on rereading mutable authoring files to serve old revisions.
  A successful publication must survive Source restart and authoring-file loss.
- Replace the resource-spec JSON blob layer with signed resource specs and
  per-file byte references. Update publisher, repository, enrollment transport,
  follower hydration, and fixtures together. Do not add a legacy decoder.
- Preserve group-filtered signed metadata. A follower must not receive hidden
  resource names, configuration values, or blob references. The research
  suggestion to distribute one full manifest to every follower is rejected.
- Authorize each blob through a visible resource in the exact requested,
  authorized revision. Knowing a digest is not permission to fetch it. Shared
  bytes can be served when at least one authorized resource references them.
- Separate logical file limits from HTTP response limits. Keep bounded raw-byte
  transfer, using contiguous HTTP ranges for files larger than one response.
  Validate offsets, total length, response length, and final byte digest. Never
  promote an incomplete or unverified download to usable content.
- Keep metadata limits independent of payload size. Preserve parser-specific
  limits for structured configuration rather than applying them to raw files.
- Feed verified bytes into the existing ownership, planning, application, and
  rollback model. Do not add binary-specific policy or shell decoding steps.
- Do not deploy the format change or republish live profiles until the complete
  new path passes conformance checks. Existing live data must remain recoverable
  during the coordinated replacement; do not erase it as a migration shortcut.

## Byte-transfer protocol

Fetch `GET /v1/transport/revisions/{revision-id}/blobs/{digest}` with the existing
follower credential and a single `Range: bytes=start-end` header. The Source
checks access in that exact revision before reading file bytes. It caps each
response at its configured blob-response limit and returns `206`, an exact
`Content-Range`, and `Content-Length`. The follower accepts a shorter bounded
response and continues from the next byte. An empty file returns `200` with a
zero content length and no content range.

Malformed or multiple ranges return `400`. An authorized range outside the file
returns `416` with `Content-Range: bytes */length`. Missing and unauthorized blobs
remain `404` and do not disclose length. The follower checks each response against
the signed file length, then checks the assembled digest before writing a usable
cache entry. Cached bytes must match both length and digest before reuse.

The response limit does not cap the logical file size. Publication and final
download assembly still hold a complete file in memory; bounded network and
database reads do not imply constant-memory processing of arbitrarily large files.

## Acceptance checks

1. Publish empty files, NULs, invalid UTF-8, LF and CRLF text, and real binary
   assets from file, directory, and skill resources. Retrieve exact bytes after
   restarting the Source and removing the original fixture inputs.
2. Equivalent inline and native-file inputs have identical file and revision
   identities. One changed byte changes both. Changing only a mode leaves the
   file-byte identity unchanged but changes desired resource semantics.
3. A 15 MiB fixture transfers in bounded responses. Its payload is absent from
   signed JSON. Two references to the same bytes store one immutable object.
4. Reject corrupted, truncated, oversized, incorrectly ranged, or wrongly
   described responses. Failed downloads never become applicable artifacts.
5. Reject traversal and source-locator escapes. Preserve the existing group
   confidentiality and exact-revision authorization tests, including a shared
   blob with one authorized and one unauthorized resource reference.
6. Apply binary fixtures, verify a second run is a no-op, detect local byte
   drift, and restore exact prior bytes and modes after a failed apply.
7. Run focused publication, repository, transport, and synchronization tests,
   then typecheck and lint. Verify native Linux, macOS, and Windows behavior
   separately before claiming fleet convergence.

## Sources and limits of the research

- [RFC 4648](https://www.rfc-editor.org/rfc/rfc4648), sections 3 and 4:
  canonical base64 rules and four-character encoding of three input bytes.
- [OCI descriptors](https://github.com/opencontainers/image-spec/blob/main/descriptor.md):
  external content identified by digest and raw byte size. Optional embedded
  content is not adopted here.
- [Node Buffer documentation](https://nodejs.org/docs/latest-v24.x/api/buffer.html):
  byte containers and permissive base64 decoding behavior.

The completed browser research compared embedded base64 with raw file blobs
against the publisher, domain profile, source server, and follower source files.
Its recommendation informs this contract, not proof of implementation. Its
suggestions to expose all metadata, redesign revision envelopes, and replace the
whole executor with a streaming cache are not blanket authorization for those
changes. Preserve current security guarantees and change only the boundaries
required for a coherent byte pipeline.
