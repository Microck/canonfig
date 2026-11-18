import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitArgs, gitWhere, localGitEnvironment, pushOptions, transportEnvironment } from "../git/git-transport.ts";
import { scanPlaintextGit } from "../git/plaintext-scan.ts";
import { probeBackupTool, probeFailure, runBackupTool } from "../git/tool-process.ts";
import { archivePathProblem, caseCollision, folderEntryOf } from "../projection/archive.ts";
import type { FolderFile } from "../projection/folder.ts";
import { revisionSelector, shortHistoryId } from "../gui/contract/history.ts";
import { HistoryError, historyWork } from "./history-config.ts";

const headRef = "refs/heads/canonfig";
const pushedRef = "refs/canonfig/pushed";
const pendingRef = "refs/canonfig/pending";
const diffLimit = 1024 * 1024;
const restoreLimit = 256 * 1024 * 1024;
const revisionInMessage = (message: string) => /^Canonfig-Revision: (\S+)$/mu.exec(message)?.[1];

export const historyPath = (folder: string) => join(folder, ".history.git");

export const withHistoryScratch = async <A>(use: (scratch: string) => Promise<A>): Promise<A> => {
  const scratch = await mkdtemp(join(tmpdir(), "canonfig-history-"));
  try { return await use(scratch); }
  finally { await rm(scratch, { recursive: true, force: true }); }
};

export type HistoryFile = {
  readonly path: string; readonly executable: boolean;
} & ({ readonly content: Uint8Array } | { readonly source: string; readonly digest: string });

export interface HistoryEntry {
  readonly id: string;
  readonly sequence?: number | undefined;
  readonly revision?: string | undefined;
  readonly date: string;
  readonly author: string;
  readonly subject: string;
  readonly pushed: boolean;
}

export type HistoryPush =
  | { readonly status: "local" | "up-to-date" }
  | { readonly status: "pushed"; readonly remote: string }
  | { readonly status: "not-pushed"; readonly reason: string; readonly code: "conflict" | "integrity" | "tool" | "transport" };

export interface HistoryCapture {
  readonly commit?: string | undefined;
  readonly push?: HistoryPush;
  readonly error?: string;
}

const select = (entries: ReadonlyArray<HistoryEntry>, selector: string): HistoryEntry => {
  if (!revisionSelector.test(selector)) throw new HistoryError({ code: "usage", message: "Use a Profile Revision number or a commit prefix of at least seven hex characters" });
  const matches = /^[1-9][0-9]*$/u.test(selector)
    ? entries.filter(entry => entry.sequence === Number(selector))
    : entries.filter(entry => entry.id.startsWith(selector.toLowerCase()));
  if (matches.length !== 1) throw new HistoryError({ code: "usage", message: matches.length > 1
    ? "Commit prefix is ambiguous. Use more characters." : "That revision is not in this Canonical Folder's history" });
  return matches[0]!;
};

const validPaths = (paths: ReadonlyArray<string>) => {
  const ancestors = new Set(paths.flatMap(path => path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"))));
  if (paths.some(path => archivePathProblem(path) !== undefined || folderEntryOf(path) === undefined || path.startsWith("local/"))
    || caseCollision([...ancestors]) !== undefined) {
    throw new HistoryError({ code: "integrity", message: "History contains an invalid authored path or paths that collide on another filesystem" });
  }
};

async function* fileChunks(source: string, digest: string): AsyncGenerator<Uint8Array> {
  const hash = createHash("sha256");
  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error("History requires a regular file");
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      yield chunk;
    }
  } finally {
    await file.close();
  }
  if (hash.digest("hex") !== digest) throw new HistoryError({
    code: "conflict", message: "An authored file changed while staging the Profile Revision for history.",
  });
}

const counts = (changes: ReadonlyArray<string>): string => {
  const parts = Object.entries({ A: "added", M: "changed", D: "removed" })
    .flatMap(([status, verb]) => {
      const count = changes.filter(change => change === status).length;
      return count === 0 ? [] : [`${count} ${verb}`];
    });
  return parts.length === 0 ? "no file changes" : parts.join(", ");
};

const openHistoryRepository = async (folder: string, executable: string, signal: AbortSignal) => {
  const repository = historyPath(folder);
  const args = gitArgs(repository);
  const cwd = folder;
  const environment = localGitEnvironment();
  const git = (command: ReadonlyArray<string>, options?: Partial<Parameters<typeof runBackupTool>[2]>) =>
    runBackupTool(executable, [...args, ...command], { cwd, signal, environment, ...options });
  const probe = (command: ReadonlyArray<string>, env: Record<string, string | undefined> = environment) => probeBackupTool(executable, [...args, ...command],
    { cwd, signal, environment: env, timeoutMilliseconds: 30_000 });

  const info = await lstat(repository).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined;
    throw cause;
  });
  let present = info !== undefined;
  if (info !== undefined && (!info.isDirectory() || (await git(["rev-parse", "--is-bare-repository"])).trim() !== "true")) {
    throw new HistoryError({ code: "integrity", message: ".history.git must be a Canonfig-owned bare repository" });
  }

  const ref = async (name: string): Promise<string | undefined> => {
    if (!present) return undefined;
    const result = await probe(["rev-parse", "--verify", "--quiet", "--end-of-options", `${name}^{commit}`]);
    if (result.ok) return result.stdout.trim();
    if (result.code === 1) return undefined;
    throw new HistoryError({ code: "integrity", message: "Could not read a history reference" });
  };

  const entries = async (): Promise<ReadonlyArray<HistoryEntry>> => {
    const head = await ref(headRef);
    if (head === undefined) return [];
    const acknowledged = await ref(pushedRef);
    const log = await git(["log", "--first-parent", "-z", "--format=%H%x00%aI%x00%an%x00%B", head, "--"]);
    const fields = log.split("\0");
    const result: Array<HistoryEntry> = [];
    let pushed = false;
    for (let index = 0; index + 3 < fields.length; index += 4) {
      const [id, date, author, message] = fields.slice(index, index + 4);
      const sequence = /^Canonfig-Sequence: ([1-9][0-9]*)$/mu.exec(message!)?.[1];
      const revision = revisionInMessage(message!);
      pushed ||= id === acknowledged;
      result.push({ id: id!, date: date!, author: author!, subject: message!.split("\n", 1)[0]!, pushed,
        revision, sequence: sequence === undefined ? undefined : Number(sequence) });
    }
    return result;
  };

  const writeTree = async (files: ReadonlyArray<HistoryFile>, scratch: string): Promise<string> => {
    validPaths(files.map(file => file.path));
    const indexEnvironment = { ...environment, GIT_INDEX_FILE: join(scratch, "index") };
    const records: Array<string> = [];
    for (const file of files) {
      const input = "content" in file ? [file.content] : fileChunks(file.source, file.digest);
      const oid = (await git(["hash-object", "-w", "--stdin", "--no-filters"], {
        cwd, signal, input: (async function*() { yield* input; })(),
      })).trim();
      records.push(`${file.executable ? "100755" : "100644"} ${oid}\t${file.path}\0`);
    }
    await git(["update-index", "-z", "--index-info"], { cwd, signal, text: records.join(""), environment: indexEnvironment });
    return (await git(["write-tree"], { cwd, signal, environment: indexEnvironment })).trim();
  };

  const commitTree = async (input: { readonly files: ReadonlyArray<HistoryFile>; readonly date: string; readonly author: string;
    readonly publication?: { readonly id: string; readonly sequence: number; readonly summary: string };
  }): Promise<string | undefined> => {
    const tree = await withHistoryScratch(scratch => writeTree(input.files, scratch));
    const old = await ref(headRef);
    const publication = input.publication;
    let message: string;
    if (publication === undefined) {
      const previousTree = old === undefined ? undefined : (await git(["rev-parse", `${old}^{tree}`])).trim();
      if (previousTree === tree) return undefined;
      const changes = previousTree === undefined
        ? (await git(["ls-tree", "-r", "--name-only", "-z", tree])).split("\0").filter(Boolean).map(() => "A")
        : (await git(["diff", "--no-renames", "--name-status", "-z", previousTree, tree, "--"])).split("\0")
          .filter((_, index) => index % 2 === 0);
      message = `Apply: ${counts(changes)}\n`;
    } else {
      message = `Revision ${publication.sequence}: ${publication.summary}\n\nCanonfig-Revision: ${publication.id}\nCanonfig-Sequence: ${publication.sequence}\n`;
    }
    const slug = input.author.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "reviewer";
    const date = `${Math.floor(Date.parse(input.date) / 1000)} +0000`;
    const commit = (await git(["commit-tree", tree, ...(old === undefined ? [] : ["-p", old]), "--no-gpg-sign", "-F", "-"], {
      cwd, signal, text: message, environment: { ...environment, GIT_AUTHOR_NAME: input.author,
        GIT_AUTHOR_EMAIL: `${slug}@canonfig.invalid`, GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: "Canonfig", GIT_COMMITTER_EMAIL: "canonfig@canonfig.invalid", GIT_COMMITTER_DATE: date },
    })).trim();
    if (publication !== undefined) {
      await git(["update-ref", "--no-deref", pendingRef, commit]);
      return undefined;
    }
    await git(["update-ref", "--no-deref", "--create-reflog", "-m", "record Canonfig history", headRef, commit, old ?? ""]);
    return shortHistoryId(commit);
  };

  const finishPublication = async (revision: string): Promise<string | undefined> => {
    const pending = await ref(pendingRef);
    if (pending === undefined) return undefined;
    const [parent, message] = (await git(["show", "-s", "--format=%P%x00%B", pending])).split("\0");
    if (revisionInMessage(message!) !== revision) return undefined;
    const head = await ref(headRef);
    // Keep the pending commit reachable until the branch advances. If a
    // process ends before cleanup, the next publish only removes the ref.
    if (head !== pending) {
      await git(["update-ref", "--no-deref", "--create-reflog", "-m", "record Canonfig history", headRef, pending, parent ?? ""]);
    }
    await git(["update-ref", "--no-deref", "-d", pendingRef, pending]);
    return head === pending ? undefined : shortHistoryId(pending);
  };

  const push = async (remote: string, branch: string, scanner: string, tip: string): Promise<HistoryPush> => {
    const finding = await withHistoryScratch(scratch =>
      scanPlaintextGit({ executable: scanner, scratch, signal, target: { kind: "git", repository, tip } }));
    if (finding !== undefined) return { status: "not-pushed", code: "integrity", reason: finding };
    const transport = await transportEnvironment({ executable, repository, cwd, signal });
    const result = await probe(["push", ...pushOptions, "--", remote, `${tip}:refs/heads/${branch}`], transport);
    if (result.ok && /^[* =]\t/mu.test(result.stdout)) {
      await git(["update-ref", "--no-deref", pushedRef, tip]);
      return { status: "pushed", remote: gitWhere(remote) };
    }
    if (/^!\t.*\((?:non-fast-forward|fetch first|stale info)\)\r?$/mu.test(result.stdout)) {
      return { status: "not-pushed", code: "conflict", reason: "remote branch diverged" };
    }
    const reason = result.ok ? "other" : probeFailure(result);
    return { status: "not-pushed", code: "transport",
      reason: reason === "network" || reason === "not-found" ? "remote unreachable"
        : reason === "auth" ? "remote authentication failed" : "remote rejected the push" };
  };

  const diff = async (from: string, to: string | undefined) => {
    const history = await entries();
    const left = select(history, from);
    const right = to === undefined ? history[0]! : select(history, to);
    const options = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames=50%"];
    const raw = await git([...options, "--name-status", "-z", left.id, right.id, "--"], { cwd, signal, maximumOutputBytes: diffLimit });
    const names: Array<string> = [];
    const fields = raw.split("\0");
    for (let index = 0; index < fields.length - 1;) {
      const status = fields[index++]!;
      const path = fields[index++]!;
      names.push(status.startsWith("R") ? `${status}\t${path}\t${fields[index++]}` : `${status}\t${path}`);
    }
    const patch = await git([...options, "--patch", left.id, right.id, "--"], { cwd, signal, maximumOutputBytes: diffLimit });
    return { from: left.id, to: right.id, names, patch };
  };

  const extract = async (selector: string) => {
    const entry = select(await entries(), selector);
    const tree = await git(["ls-tree", "-r", "-z", "--full-tree", entry.id]);
    const blobs = tree.split("\0").filter(Boolean).map(row => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/su.exec(row);
      if (match === null) throw new HistoryError({ code: "integrity", message: "History restore requires regular Git blobs" });
      return { executable: match[1] === "100755", oid: match[2]!, path: match[3]! };
    });
    validPaths(blobs.map(blob => blob.path));
    const files = await runBackupTool(executable, [...args, "cat-file", "--batch"], {
      cwd, signal, environment, text: blobs.map(blob => `${blob.oid}\n`).join(""), maximumOutputBytes: restoreLimit,
      consume: async (chunks: AsyncIterable<Uint8Array>) => {
        const buffers: Array<Uint8Array> = [];
        for await (const chunk of chunks) buffers.push(chunk);
        const bytes = Buffer.concat(buffers);
        const files = new Map<string, FolderFile>();
        let offset = 0;
        for (const blob of blobs) {
          const newline = bytes.indexOf(10, offset);
          const header = /^(\S+) blob (\d+)$/u.exec(bytes.toString("utf8", offset, newline));
          const end = newline + 1 + Number(header?.[2]);
          if (header?.[1] !== blob.oid || bytes[end] !== 10) {
            throw new HistoryError({ code: "integrity", message: "History restore could not verify the blob stream" });
          }
          files.set(blob.path, { executable: blob.executable, content: bytes.subarray(newline + 1, end) });
          offset = end + 1;
        }
        return files;
      },
    });
    return { entry, files };
  };

  return {
    entries, diff, extract, push, commitTree, finishPublication,
    init: async () => {
      if (present) return;
      // Publish the private directory only after Git finishes initialization.
      const staged = await mkdtemp(join(folder, ".history-"));
      try {
        await runBackupTool(executable, [...gitArgs(staged), "init", "--bare", "--template=", "--initial-branch=canonfig", "--quiet"],
          { cwd, signal, environment });
        await rename(staged, repository);
        present = true;
      } finally {
        await rm(staged, { recursive: true, force: true });
      }
    },
    validateBranch: async (branch: string) => {
      if (!(await probe(["check-ref-format", `refs/heads/${branch}`])).ok || branch.startsWith("-") || branch === "HEAD")
        throw new HistoryError({ code: "usage", message: "Choose a valid Git branch name" });
    },
    clearAcknowledgement: async () => { await git(["update-ref", "--no-deref", "-d", pushedRef]); },
    pendingTip: async () => {
      if (!present) throw new HistoryError({ code: "integrity", message: ".history.git is missing" });
      const tip = await ref(headRef);
      return tip === await ref(pushedRef) ? undefined : tip;
    },
  };
};

export const historyRepositoryWork = <A>(folder: string, executable: string, message: string,
  work: (repo: Awaited<ReturnType<typeof openHistoryRepository>>) => Promise<A>) =>
  historyWork(message, async signal => work(await openHistoryRepository(folder, executable, signal)));
