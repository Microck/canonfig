# Backup research for #279

Compression and destination research is complete. Implementation verification and PR delivery are in progress; completed evidence is recorded below.

## Approved scope

- Branch `feat/backup`, based on `origin/main`; issue <https://github.com/Microck/canonfig/issues/279>.
- Configurable on-demand and native scheduled backups, list, restore, verify, prune, retention, and restore drills.
- Local folders, Git hosts, cloud drives, S3-compatible storage, B2, WebDAV, and SFTP.
- Optional password encryption; encryption required for source identity, shared secrets, or credential-inclusive harness capture.
- Select the Canonical Folder, managed Target Harness configuration, or entire selected Target Harness folders. Support include/exclude globs. Exclude known credential files by default.
- Reuse the canonical export/import archive, changing that format once if required. Exact harness-folder restore is an explicit offline recovery operation; Canonical Folder restore uses import/projection.
- A signed Source policy installs and updates a Follower's backup schedule on apply. Destination credentials and passwords remain local references. Missing credentials produce Human Action Required. Only the Follower can permit credential-inclusive capture. Record the scheduling authority change in an ADR.
- Implement GUI, CLI help, website documentation, domain terminology, and architectural decisions.
- Research has its own commits containing only this directory. The PR must include `remove docs/research/279-backup/ before merging`.

## Execution constraints

One implementation agent, `maisa-codex/gpt-6-astra`, through OMP in T3 Code. No delegated agents. Paid upgrades and credit purchases are not authorized. Existing research allowance only. No live service, schedule, credential-store, Tailscale, or parent-checkout changes.

Primary benchmark: copy the Canonical Folder plus harness configuration, instructions, skills, rules, agents, commands and hooks into mode-0700 local scratch. Document exclusions. Second tier: do not copy the heavy categories. Select a deterministic stratified approximately 2 GB sample with a fixed seed from sessions/history, logs, caches, dependencies and binaries; read it in place, read-only, and stream tar into each compressor. Keep only the compressed output needed to time decompression and delete it after each measurement. Stop before free disk falls below 2 GB. Record category ratios and extrapolated full-folder size/time, explicitly labelled as extrapolated. Never log, commit or upload private content or filenames. Delete primary copies after measurement. This authorization supersedes the earlier full-copy interpretation; do not ask again.

Use disposable HOME and credential directories for all behavioral checks. Heavy builds and broad suites belong in a task-owned Raft workspace. Do not upload the real benchmark corpus to Raft.

## Findings and chosen design

Use one version-2 signed export archive, with streaming verification shared by export/import and backup. Add optional [age encryption](https://age-encryption.org/v1), immutable snapshots, retention and restore drills around it. Use native filesystem I/O for local storage, Git for Git hosts, and [rclone backends](https://rclone.org/overview/) for drives and object storage. See [the destination matrix and prior-art comparison](destinations.md), [encryption and credential handling](encryption.md), and [source references](sources.md).

The alternative was to make restic, borg, kopia or rustic the backup repository. Their chunking and encrypted deduplication are more mature, but making one mandatory would add a separate archive/recovery contract and would not solve ordinary Git-host publication. This implementation deliberately favors portable, independently recoverable archives. Identical stored archive parts can be reused; independently randomized encrypted archives generally cannot. Do not describe that as content-defined or encrypted incremental deduplication.

### Compression decision

[Measurements](measurements.md) regenerate from the raw JSON with `python3 docs/research/279-backup/report.py`. The primary corpus contains 182 Canonical Folder files and 11,106 harness-configuration files. No private content or filenames are included in this research directory.

- `fast` uses Node's Zstandard level 1. It needs no native helper and restored the combined 207,697,920-byte tar in 0.279 seconds in the CLI benchmark.
- `balanced` uses Zstandard level 6. The combined stream was 49,758,568 bytes, compared with gzip's 92,843,734 bytes. This is the default for scheduled backups.
- `small` uses xz 9 extreme. The combined stream was 31,563,864 bytes, with 71.068 seconds compression, 1.883 seconds restore and 674.8 MiB peak compressor RSS.
- `max` runs xz 9 extreme and ZPAQ method 5, then stores the smaller stream. ZPAQ won the folder-only corpus at 293,867 bytes, but needed 7.436 seconds to restore that small archive. xz won the combined corpus; ZPAQ took 662.497 seconds to compress and 685.511 seconds to restore it. Snapshot metadata records the selected codec.

These presets reflect the measured size/time tradeoffs, not a claim that one algorithm is optimal for every input. Zstandard 19, Brotli 11, bzip3, LZ4 HC and 7-Zip ultra were measured too. 7-Zip's combined stream was slightly larger than xz and used more restore memory; bzip3 and Brotli lost on combined size and restore cost. They do not justify another required helper. Zstandard `--ultra -22 --long=31` exited 11 under the 1,536 MiB address-space limit before a successful stream was produced. Its unconstrained compression ratio is unknown. No WASM implementation was benchmarked or shipped. Native xz/libzpaq avoid adding an unmeasured WASM runtime; their installation cost is explicit in help and documentation.

Times are single-run observations on a shared host. Zstandard 6 appearing faster than level 1 in some rows is not a general speed claim. Cache warmth and other activity were not controlled. External compressor timings do not include Canonfig's encryption, staging, upload or read-back costs.

### Reproduce the measurements

Install the compressors listed by `benchmark.py`, plus `/usr/bin/time`. Build `zpaq-stream` from the helper and public-domain libzpaq 7.15 linked in `sources.md`. Choose private scratch storage with at least 2 GB free beyond the working set.

```sh
python3 docs/research/279-backup/benchmark.py --tier primary \
  --folder "$HOME/.canonfig" --harness "$HOME/.codex" --harness "$HOME/.claude" \
  --harness "$HOME/.omp" --scratch /dev/shm --output primary-results.json \
  --timeout 900 --memory-mib 1536
python3 docs/research/279-backup/benchmark.py --tier heavy \
  --folder "$HOME/.canonfig" --harness "$HOME/.codex" --harness "$HOME/.claude" \
  --harness "$HOME/.omp" --scratch /dev/shm --output heavy-results.json \
  --sample-bytes 2000000000 --timeout 300 --memory-mib 1536 \
  --algorithms zstd-1 zstd-6 xz-9e zpaq-max
```

The primary run copies configuration into a private local directory and removes it afterward. Dependencies, sessions/history, logs, caches, binaries and other runtime files belong to the separate heavy tier. That tier reads fixed-seed proportional samples in place, with bounded prefixes for large files. It never copies the full harness folders. Symlinks, special files and unreadable files are counted and excluded. The script rejects files changed during a measurement, caps each process's address space and runtime, and stops at the free-space reserve.

The committed heavy run sampled 1,999,999,997 bytes. It completed with fifteen successful round trips, four timeouts and five changing-file failures. Its category-level size/time extrapolations are labelled in `measurements.md`; they are estimates, not full-folder results. All algorithms failed on the changing other-runtime stratum, so a defensible complete-folder estimate is unavailable. No live writer was stopped to make a benchmark pass.


## Initial evidence

- `git fetch origin` succeeded; the worktree was clean; `git switch -c feat/backup origin/main` succeeded.
- Jujutsu initialization refused a colocated repository inside a Git worktree. Git is used only in this task's worktree; the parent checkout is untouched.
- `AGENTS.md` and `docs/agents/` do not exist on this baseline. Required global instructions are supplied by the runtime. `GLOSSARY.md`, all three ADRs, `docs/architecture.md`, the global-folder plan, and scheduler runtime documentation were read.
- The existing archive is signed PAX tar plus gzip, limited to 20,000 files and 128 MiB content. It includes authoring entries and `local/`, optionally unchanged managed harness surfaces. Harness files are verified but never imported. Credentials and runtime state are excluded.
- Takeover snapshots retain the first harness snapshot, the first Canonical Folder snapshot, and the four most recent snapshots.
- Native synchronization jobs use systemd user timers, launchd, and Task Scheduler. There is no follower daemon. Existing synchronization schedules remain locally controlled; the approved backup-policy authority is distinct.
- LSP is unconfigured. The code graph is unindexed. Semantic search is unavailable because its provider has no credit; scoped source reads and exact search are used instead.

## Active work and blockers

Task-owned Raft workspace: `paris:rf-025b35d1112741e6`, disposable, six-hour TTL, one CPU and 3 GiB RAM. It is reserved for builds and synthetic destination/scheduler proofs. Never upload the real corpus there. Primary copies were deleted by the benchmark's temporary-directory cleanup after each stopped run; the remaining benchmark helper scratch has also been removed.

Primary measurements are in `primary-results.json`, `primary-remaining-results.json` and `primary-tmpfs-results.json`. Interrupted attempts remain recorded. Heavy measurements finished in `heavy-results.json`; the script confirmed removal of its private scratch. The raw inputs remained local throughout.

Maintainer delivery decision: no human testing has happened, but open a ready-for-review PR after implementation and agent-run verification. Set `human_testing` to exactly `none yet; maintainer to test before merge`. Read the contribution policy and PR template on `origin/main`, obtain `agent_version` from the installed OMP CLI, and use `model_used: maisa-codex/gpt-6-astra via OMP`. Tick only checks actually exercised. Use a conventional PR title, never `chore(release): ...`.

Read both required PR documents from `origin/main`. `omp --version` reported `omp/18.18.7`; disclosure uses `agent_name: OMP`, `agent_version: 18.18.7`, and `model_used: maisa-codex/gpt-6-astra via OMP`. The maintainer's explicit delivery instruction overrides the repository's human-testing-before-submission restriction without claiming testing occurred.

Completed destination proof: encrypted fast/balanced/small/max restores were byte-identical; a wrong password left no restore destination; local bare Git, rclone local and Forgejo 17.0.1 SSH round-tripped; plaintext Git secret detection refused publication. See `destination-proof.json`. The earlier Node Zstandard stream interruption was fixed by using one pipeline through the complete consumer; temporary debug diagnostics were removed.

Completed native proof: `source-follower-proof.json` records signed policy delivery and execution, native systemd backup and drill timers, byte-identical Source identity and shared-secret recovery under fresh references, and authenticated synchronization by the existing Follower after Source recovery. Drills and refused restores removed only their new native credentials. A locked keyring returned Human Action Required (exit 3), with no restore destination and no plaintext credential-file writes in the syscall trace. The proof uses its own D-Bus session and foreground GNOME Keyring inside Raft; the live Secret Service is untouched.

GUI recovery, final browser validation and the staged Gitleaks scan passed. The proof tab, server and temporary GUI data are removed. See [verification](verification.md) and the [GUI screenshot](gui-backups.png). Typechecks, lint and the production build passed; the full core/UI suites remain running in Raft as task job `bg_42`. No native macOS/Windows proof or human testing is claimed.
