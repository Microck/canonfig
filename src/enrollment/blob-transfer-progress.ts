import { Context } from "effect";

/** Where a revision's blob download stands, after each verified byte range. */
export interface BlobTransferEvent {
  /** The blob's content digest. */
  readonly blob: string;
  /** 1-based position among the blobs this fetch downloads; cached blobs are not counted. */
  readonly blobIndex: number;
  readonly blobCount: number;
  readonly blobReceived: number;
  readonly blobBytes: number;
  /** Bytes received across every blob this fetch downloads. */
  readonly received: number;
  readonly total: number;
}

/**
 * Receives download progress. The default discards it; the CLI provides a
 * stderr reporter for an interactive human-mode sync, so a large revision no
 * longer downloads for minutes in silence.
 */
export const BlobTransferProgress = Context.Reference<(event: BlobTransferEvent) => void>(
  "canonfig/enrollment/BlobTransferProgress",
  { defaultValue: () => () => undefined },
);
