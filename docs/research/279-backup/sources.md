# Sources for backup #279

Retrieved 2026-11-13. Measurements are local observations in the raw benchmark results, not claims from these pages.

## Compression

- <https://nodejs.org/docs/latest-v24.x/api/zlib.html>: Node 24 provides gzip, Brotli and Zstandard streams. The Zstandard classes document their introduction in Node 22.15.0 and 23.8.0. The page currently identifies Node 24.22.3.
- <https://raw.githubusercontent.com/nodejs/node/v24.13.0/lib/zlib.js>: implementation in the installed Node release, independent of the current documentation.
- <https://www.rfc-editor.org/rfc/rfc8878.html>: Zstandard frame format, window and dictionary identifiers. The RFC page notes the later RFC 9659 revision.
- <https://github.com/facebook/zstd>: upstream compressor and CLI documentation, high compression levels, dictionaries and long-distance matching.
- <https://raw.githubusercontent.com/tukaani-project/xz/HEAD/src/xz/xz.1>: xz presets, extreme mode and decompressor memory requirements. Higher presets are not universally better choices.
- <https://raw.githubusercontent.com/google/brotli/HEAD/README.md>: upstream Brotli implementation and RFC 7932 reference.
- <https://raw.githubusercontent.com/lz4/lz4/dev/README.md>: LZ4, high-compression mode and dictionaries.
- <https://www.7-zip.org/7z.html>: 7z container, LZMA/LZMA2 and solid compression.
- <https://github.com/iczelia/bzip3/releases/tag/1.5.5>: exact bzip3 release used by the benchmark. Its README describes the Burrows-Wheeler transform and context-mixing design, build instructions and licensing.
- <https://mattmahoney.net/dc/zpaq.html>: ZPAQ methods, incremental archives and streaming format.
- <https://mattmahoney.net/dc/zpaqutil.html>: PAQ-family streaming compressors, built-in models and their resource tradeoffs.
- <https://mattmahoney.net/dc/zpaq715.zip>: public-domain libzpaq 7.15. The benchmark-only `zpaq-stream.cpp` calls its documented streaming API with method `5`; no upstream implementation is committed.

## Repositories and transports

- <https://raw.githubusercontent.com/restic/restic/HEAD/doc/design.rst>: immutable content-addressed blobs, packs, encrypted repository metadata, per-blob authentication, snapshots and Zstandard repository-format-2 compression.
- <https://borgbackup.readthedocs.io/en/stable/internals/data-structures.html>: transactional repository segments, content-addressed keys, archive objects, compaction and repository quotas.
- <https://raw.githubusercontent.com/kopia/kopia/HEAD/site/content/docs/Advanced/Architecture/_index.md>: blob storage, content-addressed storage, encryption, deduplication and manifests.
- <https://rustic.cli.rs/docs/getting_started.html>: encrypted deduplicated repositories, repeated snapshots and restore behavior.
- <https://rclone.org/overview/>: backend support and differences in hashing, modification times, duplicate names and case sensitivity. Provider checksums are not uniformly available.
- <https://rclone.org/crypt/>: crypt is a storage wrapper, not a snapshot/retention engine.
- <https://rclone.org/drive/>: Google Drive OAuth configuration, service accounts, remote paths and scopes.
- <https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github>: normal Git warns above 50 MiB and refuses individual files above 100 MiB; Git LFS is a distinct storage path.
- <https://docs.gitlab.com/user/project/repository/repository_size/>: repository storage accounting and size-management behavior differ between GitLab.com and self-managed instances.
- <https://forgejo.org/docs/latest/admin/config-cheat-sheet/>: administrator-controlled storage and LFS configuration. A self-hosted installation has no universal quota.
- <https://developers.google.com/workspace/drive/api/guides/limits>: Drive request and upload limits; quotas depend on the Google Cloud project and account.
- <https://docs.duplicati.com/technical-details/understanding-backup/how-backup-works.md>: block reuse, volume compression/encryption, publishing file lists, download checks and retention.
- <https://docs.duplicati.com/technical-details/understanding-backup/encryption-algorithms.md>: AES Crypt and optional GPG formats, version-specific KDF behavior and compatibility costs.
- <https://www.chezmoi.io/user-guide/encryption/>: age/GPG-encrypted files in a dotfile source tree. Configuration distribution is distinct from historical backup and restore.

## Encryption and leak prevention

- <https://age-encryption.org/v1>: age v1 format, scrypt password recipient, authenticated headers and chunked ChaCha20-Poly1305 payload.
- <https://raw.githubusercontent.com/FiloSottile/typage/main/README.md>: maintained TypeScript age implementation, passphrase API and streaming encryption/decryption. npm reports `age-encryption` 0.3.1 and this repository.
- <https://raw.githubusercontent.com/FiloSottile/age/main/doc/age.1>: full-input success semantics, authenticated partial output during failed decryption and password workflow. Restore must stage and verify all input before publishing files.
- Installed `gitleaks` 8.24.3, `gitleaks stdin --help`: scanner accepts stdin, supports full redaction and disabling inline allow comments. Configuration and ignore-file precedence must not let backed-up files suppress the scan.
