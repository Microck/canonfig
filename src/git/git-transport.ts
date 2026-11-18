import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { devNull } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BackupIoError, probeBackupTool, probeFailure, runBackupTool, type ProbeResult } from "./tool-process.ts";

/** Validate schemes shared by Git backups and version history. */
export const checkGitRemote = (remote: string): URL | undefined => {
  if (isAbsolute(remote) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9/_~.-]+$/u.test(remote)) return undefined;
  try {
    const url = new URL(remote);
    if (remote.startsWith("file:///")
      || (url.protocol === "https:" && url.username === "" && url.password === "")
      || (url.protocol === "ssh:" && url.password === "")) return url;
  } catch { /* Report one safe message without echoing a credential-bearing URL. */ }
  throw new BackupIoError("BACKUP_INVALID", "Git backup needs an HTTPS, SSH, file URL or absolute local repository path. Keep tokens in the Git credential helper, never in the URL.");
};

export interface DestinationCheck { readonly warnings: ReadonlyArray<string> }

export const unreachable = (where: string): DestinationCheck => ({
  warnings: [`Couldn't reach ${where} just now. The backup is saved and tries again when it runs; check the connection if this keeps happening.`],
});

export const gitWhere = (remote: string): string => {
  if (isAbsolute(remote)) return remote;
  try {
    const url = new URL(remote);
    return url.protocol === "file:" ? fileURLToPath(url) : `${url.host}${url.pathname}`;
  } catch { return remote.replace(/^[^@/]+@/u, "").replace(/^(?<host>[^:/]+):/u, "$<host>/"); }
};

const localGitPath = (remote: string): string | undefined =>
  isAbsolute(remote) ? remote : remote.startsWith("file:///") ? fileURLToPath(remote) : undefined;

const writable = (path: string) => access(path, constants.W_OK).then(() => true, () => false);

// Keep OS and authentication settings, while excluding ambient Git repo, config and tracing overrides.
const baseEnvironment = () => Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !/^GIT_/iu.test(name)));

export const localGitEnvironment = () => ({
  ...baseEnvironment(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_ATTR_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", LC_ALL: "C",
});

export const gitArgs = (repository: string) => [
  "--no-pager", `--git-dir=${repository}`, "-c", `core.hooksPath=${devNull}`,
  "-c", `core.attributesFile=${devNull}`, "-c", "core.autocrlf=false", "-c", "core.fsmonitor=false",
  "-c", "commit.gpgsign=false", "-c", "protocol.ext.allow=never",
];

export const pushOptions = ["--porcelain", "--no-signed", "--no-follow-tags", "--recurse-submodules=no"];

export const transportEnvironment = async (input: {
  readonly executable: string; readonly repository: string; readonly cwd: string; readonly signal: AbortSignal;
}): Promise<Record<string, string | undefined>> => {
  const environment = { ...baseEnvironment(), GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never", GIT_NO_REPLACE_OBJECTS: "1", LC_ALL: "C" };
  const command = process.env.GIT_SSH_COMMAND;
  if (command !== undefined) return { ...environment, GIT_SSH_COMMAND: command };
  const configured = await probeBackupTool(input.executable, [...gitArgs(input.repository), "config", "--get", "core.sshCommand"],
    { ...input, timeoutMilliseconds: 30_000, environment });
  return configured.ok ? environment : { ...environment, GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
};

export const checkGitDestination = async (input: {
  readonly remote: string; readonly executable: string; readonly scratch: string; readonly signal: AbortSignal;
  readonly probeRef: string;
}): Promise<DestinationCheck> => {
  const probe = (executable: string, args: ReadonlyArray<string>, environment?: Record<string, string | undefined>) =>
    probeBackupTool(executable, args, { cwd: input.scratch, signal: input.signal, timeoutMilliseconds: 30_000, environment });
  const { remote, executable, scratch, signal, probeRef } = input;
  if (!(await probe(executable, ["--version"], localGitEnvironment())).ok) {
    throw new BackupIoError("BACKUP_TOOL_REQUIRED", "Git isn't installed on this machine, or it isn't on PATH. Install Git, then save again.");
  }
  const where = gitWhere(remote);
  const localPath = localGitPath(remote);
  if (localPath !== undefined) {
    if (!(await stat(localPath).catch(() => undefined))?.isDirectory()) {
      throw new BackupIoError("BACKUP_INVALID", `There is no Git repository at ${localPath}. Create one with git init --bare, then save again.`);
    }
    if (!(await writable(localPath))) throw new BackupIoError("BACKUP_INVALID", `Canonfig can't write to the Git repository at ${localPath}. Check its permissions.`);
  }
  const repository = join(scratch, "check-git");
  const environment = await transportEnvironment({ executable, repository, cwd: scratch, signal });
  const failed = (result: Extract<ProbeResult, { readonly ok: false }>, stage: "read" | "push"): DestinationCheck => {
    const reason = probeFailure(result);
    if (reason === "network") return unreachable(where);
    if (reason === "auth") {
      throw new BackupIoError("BACKUP_CREDENTIAL_REQUIRED", stage === "read"
        ? `Git couldn't sign in to ${where}. Set up an SSH key or a credential helper for it on this machine, then save again.`
        : `Git can read ${where} but can't push to it. Give this machine's sign-in write access, then save again.`);
    }
    if (reason === "not-found") throw new BackupIoError("BACKUP_INVALID", `There is no Git repository at ${where}. Create an empty one there first, then save again.`);
    throw new BackupIoError("BACKUP_INVALID", `Git couldn't use ${where}. Run git ls-remote with that address in a terminal to see why; Canonfig doesn't show Git's output because it can contain credentials.`);
  };
  const read = await probe(executable, [...gitArgs(repository), "ls-remote", "--heads", "--", remote], environment);
  if (!read.ok) return failed(read, "read");
  // A dry-run push asks the host for write access without creating anything there.
  const local = (args: ReadonlyArray<string>, text?: string) => runBackupTool(executable, args, { cwd: scratch, signal, text });
  await local([...gitArgs(repository), "init", "--bare", "--quiet", "--template="]);
  const tree = (await local([...gitArgs(repository), "mktree"], "")).trim();
  const commit = (await runBackupTool(executable, [...gitArgs(repository), "commit-tree", tree, "--no-gpg-sign"], {
    cwd: scratch, signal, text: "Canonfig destination check\n",
    environment: { ...localGitEnvironment(), GIT_AUTHOR_NAME: "Canonfig", GIT_AUTHOR_EMAIL: "backup@canonfig.invalid", GIT_COMMITTER_NAME: "Canonfig", GIT_COMMITTER_EMAIL: "backup@canonfig.invalid" },
  })).trim();
  const push = await probe(executable, [...gitArgs(repository),
    "push", "--dry-run", ...pushOptions, "--", remote, `${commit}:refs/heads/${probeRef}`], environment);
  return push.ok ? { warnings: [] } : failed(push, "push");
};
