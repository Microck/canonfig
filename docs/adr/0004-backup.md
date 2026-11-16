# Portable backups share the export archive

Status: accepted for #279.

## Decision

Backup and export use one version-2 manifest and one strict PAX tar codec. The version-2 reader verifies entries while streaming and admits explicit recovery entries in addition to configuration. Configuration import still refuses recovery-only entries. Version 1 is replaced, not retained as a second reader. Backup storage adds compression, optional age password encryption, immutable snapshot records, retention and transports around that archive. It does not introduce another configuration serialization or another Projection implementation.

The Canonical Folder, managed harness configuration and explicitly selected full Target Harness roots are separate capture choices. Capture is read-only and refuses changing files and unsafe filesystem objects. Full harness capture can include runtime history and caches; these can contain credentials under unknown names. Known credential files are excluded unless the operator explicitly permits encrypted credential capture. Source identity and shared secrets are independent, encrypted-only choices.

A backup is restored into a private staging directory and checked in full before publication. Wrong passwords, incomplete age streams, changed blobs, unsafe paths and unsupported manifest entries fail before a restore publishes anything. Folder application uses the existing import/projection path. Exact harness and Source recovery are explicit offline recovery operations, not an alternate live synchronization path.

Local folders and rclone remotes store immutable objects and snapshot metadata. Git hosts use an explicitly selected backup namespace and immutable snapshot refs. Native Git credentials and rclone configuration stay outside the published policy. Retention deletes only Canonfig's snapshot namespace; it never rewrites an unrelated branch. A successful upload is downloaded and checked before it is reported as a verified backup. Provider encryption at rest is not a substitute for client-side encryption.

Passwords are local credential references, never command arguments or fields copied from a Source. Losing the password makes the encrypted backup unrecoverable. The encryption format is age v1 with its scrypt recipient and authenticated streaming payload, implemented by the pinned `age-encryption` dependency. No custom cryptographic format is introduced.

`restore --recover-credentials` imports verified recovery material into the recovery machine's native secure credential store under newly generated references. It never replaces existing credentials or writes plaintext credential files. Locked or unavailable storage is Human Action Required. Decryption and decompression stream into verification; recovery credential values remain in bounded memory, not an extracted JSON file or a temporary tar file. Failed publication removes only credentials created by that restore. Restore drills use the same path and remove their temporary credential references afterward.

A signed Source may declare backup policies through Canonical Folder items, including a backup schedule. This is distinct from `scheduleDefault`, which remains only a suggestion for synchronization. Applying a backup policy reconciles its own native job through MachineState's systemd, launchd or Task Scheduler adapter. It does not install a daemon or take over `canonfig-sync`. A Follower's local credential-capture permission cannot be granted by the Source. Missing local credentials are Human Action Required, never plaintext fallback.

Restore drills use the same download, decryption and archive verification as restore and materialize files in disposable private storage. Scheduling a drill uses the same native scheduler and command path as running it on demand.

## Consequences

Compression and encryption must stream. The current 128 MiB in-memory export limit is not a viable limit for full harness backups. Import retains its safe application budget; a larger archive can be verified or recovered offline without silently attempting a live Projection of runtime state.

The `max` preset compares xz 9e with ZPAQ method 5 and stores the smaller stream. ZPAQ won the folder-only benchmark; xz won the combined configuration corpus. The snapshot records the chosen codec independently of the requested preset, so restore never guesses. `max` requires both native helpers at capture time and the recorded codec at restore time. This is a measured candidate set, not a claim that one algorithm is optimal for every possible input.

Git is a portability option for small configuration backups, not an efficient large-file backup store. Deleting a snapshot ref does not guarantee immediate erasure from the host's object database. Cloud retention is also subject to provider versioning, legal holds and trash policies.

Secret detection is defense in depth, not proof that arbitrary history is safe to publish. Plaintext Git publication requires an isolated gitleaks scan, with no backup-supplied ignore file or inline suppression. Sensitive capture requires encryption on every destination.
