import type { BlobTransferEvent } from "../enrollment/blob-transfer-progress.ts";

const size = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KiB`
    : bytes < 1024 * 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;

export interface TransferProgressOptions {
  /** Least time between two progress lines. */
  readonly intervalMilliseconds?: number | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * Download progress for a person, one stderr line at a time.
 *
 * A download that finishes within the interval prints nothing, since the
 * command's own summary already counts its blobs. A longer one prints at most
 * one line per interval, naming the current blob and its bytes, and a closing
 * line once every blob is cached. Plain lines rather than a redrawn one keep
 * the output readable when stderr is a log file.
 */
export const humanTransferProgress = (
  write: (text: string) => void,
  options: TransferProgressOptions = {},
): (event: BlobTransferEvent) => void => {
  const interval = options.intervalMilliseconds ?? 1000;
  const now = options.now ?? Date.now;
  let startedAt: number | undefined;
  let lastLineAt: number | undefined;
  return (event) => {
    const at = now();
    startedAt ??= at;
    if (event.received === event.total) {
      if (lastLineAt !== undefined) {
        const seconds = Math.max(0, Math.round((at - startedAt) / 1000));
        write(`downloaded ${event.blobCount} blob(s), ${size(event.total)} in ${seconds} s\n`);
      }
      lastLineAt = undefined;
      startedAt = undefined;
      return;
    }
    if (at - (lastLineAt ?? startedAt) < interval) return;
    lastLineAt = at;
    write(
      `downloading blob ${event.blobIndex}/${event.blobCount} (${event.blob.slice(0, 12)}): `
        + `${size(event.blobReceived)} of ${size(event.blobBytes)}; `
        + `${size(event.received)} of ${size(event.total)} in total\n`,
    );
  };
};
