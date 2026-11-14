# Encryption and credential handling

## Threat model

Protect backup contents from the destination operator, accidental public Git visibility, and someone who obtains a stored archive without its password. Detect damaged or truncated archives before any restored file becomes visible. Do not claim protection from a compromised machine or a process running as the same user while capture or restore is active. Sizes, snapshot times and the selected compression preset remain visible in storage metadata.

Adopt [age v1](https://age-encryption.org/v1), using the maintained [age-encryption TypeScript implementation](https://github.com/FiloSottile/typage), pinned to 0.3.1. The installed implementation uses scrypt with default logN 18, r 8 and p 1 for passphrases. It rejects password stanzas above logN 20 on decryption. Its authenticated payload uses 64 KiB ChaCha20-Poly1305 chunks with an authenticated final-chunk marker. A random file key and nonce are generated for each encryption.

Scrypt is selected because it is the password KDF in the existing age format. Replacing it with Argon2id would require another format or recipient implementation and would lose ordinary age interoperability. Do not create a custom AES-GCM envelope or derive the content key directly from a password hash.

Decryption may yield authenticated earlier chunks before discovering a truncated final chunk. Therefore restore stages privately, consumes the complete ciphertext, verifies every manifest digest, and publishes only after all checks succeed. A wrong password, changed header or missing final chunk fails closed. The password is not recoverable from Canonfig or from the destination. Losing it loses the encrypted backups.

Credential recovery is explicit (`--recover-credentials`) and uses the recovery machine's native secure store. It allocates fresh references, rewrites the verified Source database and shared-secret manifest to those references, and never replaces existing credentials. Decryption and decompression stream into verification. Recovery credential values stay in bounded memory, not an extracted file or temporary plaintext tar. A locked or unavailable native store is Human Action Required. Failed publication removes only newly allocated references; a restore drill also removes its temporary references after verification.

Password input is a local native credential reference. Source policy carries only that reference, never its value. The same rule applies to destination credentials: Git uses the local SSH/credential-helper configuration and rclone uses its local configuration. Scheduled jobs contain no password or access token in their arguments.

## Capture rules

- Canonical authoring and managed harness capture reuse export's allowlist and literal-credential checks.
- Full harness roots are an explicit choice. Known authentication files, OAuth caches, `.env` files, credential directories and private-key files are excluded unless the machine operator permits credential-inclusive capture.
- Source identity and shared secrets are independent opt-ins and require encryption regardless of destination.
- A Source cannot grant a Follower permission to include its credentials. The local grant is checked at execution, including scheduled runs.
- Before any plaintext Git publication, run gitleaks on the exact staged content. Scanner absence or failure blocks publication. Use its default rules through an explicit task-owned configuration, an empty ignore file, full redaction and `--ignore-gitleaks-allow`; neither the captured directory nor inherited environment may change scanner rules.
- A clean scanner result is not proof that arbitrary binary databases or history contain no secrets. Full runtime capture therefore requires encryption even when known credential filenames are excluded.
- Generated manifests and journals must never contain secret values. Private staging directories use protected permissions, and are removed after successful or failed operations.

## Rejected alternatives and risks

Provider-side encryption does not protect against provider access or an accidentally public repository. rclone crypt can protect a remote, but independently decryptable age archives do not require recovering that remote configuration first. Password reuse permits offline guessing against any obtained archive; recommend a generated multiword passphrase stored separately.

The JavaScript scrypt implementation performs CPU-intensive work and allocates substantial memory. Encryption is a bounded command, not a GUI-thread operation; GUI mutations run through the existing operation mechanism. No claim of audited application integration is made merely because the cryptographic format is established.
