# Destination decision

Use native filesystem I/O for a local folder, native Git for Git hosts, and rclone for cloud and network storage. Canonfig owns snapshot identity, archive validation, retention and restore; rclone owns provider authentication and object transfer.

| Destination | Authentication | Relevant limits | Provider versions | At-rest encryption | Self-hostable |
| --- | --- | --- | --- | --- | --- |
| Local folder | OS permissions | Filesystem capacity and maximum file size | Filesystem-dependent | Disk encryption only if configured | Yes |
| GitHub | SSH key or Git credential helper | Regular Git warns above 50 MiB and blocks files above 100 MiB; repository growth matters | Git refs and objects | Do not rely on provider access controls for plaintext secrets | No |
| GitLab | SSH key or Git credential helper | Project/instance storage and push limits | Git refs and objects | Installation-dependent | Yes |
| Forgejo / Gitea | SSH key or Git credential helper | Administrator-controlled storage and push limits | Git refs and objects | Installation-dependent | Yes |
| Google Drive | rclone OAuth or service account | Account storage, upload and request quotas | Drive revisions/trash, not Canonfig retention | Provider-managed; optional client-side age remains necessary for sensitive content | No |
| Other cloud drives | rclone remote configuration | Provider-specific quotas and object limits | Provider-specific | Provider-specific plus optional age | Some |
| S3-compatible | rclone access credentials or provider identity | Endpoint-specific object and multipart limits | Bucket versioning if enabled | Endpoint policy plus optional age | Yes |
| Backblaze B2 | rclone application key | Account/bucket quotas | File versions and lifecycle rules | Bucket policy plus optional age | No |
| WebDAV | rclone remote credentials | Server/proxy limits | Server-dependent | Server-dependent plus optional age | Yes |
| SFTP | SSH key or rclone credentials | Remote filesystem capacity | No universal snapshot facility | Remote disk policy plus optional age | Yes |

Sources: [rclone backend matrix](https://rclone.org/overview/), [Drive configuration](https://rclone.org/drive/), [Drive limits](https://developers.google.com/workspace/drive/api/guides/limits), [GitHub large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github), [GitLab repository size](https://docs.gitlab.com/user/project/repository/repository_size/), [Forgejo configuration](https://forgejo.org/docs/latest/admin/config-cheat-sheet/). Limits are not interchangeable across providers or self-hosted installations.

## Alternatives

- restic and rustic offer encrypted, deduplicated repositories and mature retention. Their repository format and compression choices would become a second archive/recovery contract alongside Canonfig export. They remain appropriate external tools for backing up an entire machine, but are not selected for the portable Canonfig archive feature. [restic design](https://raw.githubusercontent.com/restic/restic/HEAD/doc/design.rst), [rustic introduction](https://rustic.cli.rs/docs/getting_started.html).
- Borg offers chunk reuse and transactional storage, but does not directly supply the requested drive/Git host transport model. [Borg internals](https://borgbackup.readthedocs.io/en/stable/internals/data-structures.html).
- Kopia combines content-addressed storage, encryption and manifests. Adopting its repository would duplicate Canonfig's portable archive contract rather than reuse it. [Kopia architecture](https://raw.githubusercontent.com/kopia/kopia/HEAD/site/content/docs/Advanced/Architecture/_index.md).
- Duplicati already solves block reuse, encrypted volumes, verification and retention. Embedding its application/service is more operational machinery than a native scheduled Canonfig command needs. [Backup design](https://docs.duplicati.com/technical-details/understanding-backup/how-backup-works.md).
- chezmoi's encrypted files protect a dotfile source tree but do not by themselves implement the required snapshot, restore drill and retention lifecycle. [chezmoi encryption](https://www.chezmoi.io/user-guide/encryption/).
- rclone crypt encrypts a storage view but does not own snapshots. Canonfig's age envelope makes an archive independently decryptable without the original remote configuration. [rclone crypt](https://rclone.org/crypt/).
- Native implementations of every cloud API would duplicate OAuth renewal, multipart transfer and provider-specific behavior. A native Git transport is still needed because a Git host is not a general rclone object backend.

No new paid service, account upgrade or real remote destination is required for development proof. Proof targets are disposable local Git, isolated Forgejo and rclone local/SFTP storage.
