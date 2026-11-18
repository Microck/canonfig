import { Schema } from "effect";

export const revisionSelector = /^(?:[1-9][0-9]*|[0-9a-f]{7,40})$/iu;

/** A digits-only selector means a Profile Revision sequence. Include a hex letter in short IDs. */
export const shortHistoryId = (id: string): string => {
  const short = id.slice(0, 7);
  return /^[0-9]+$/u.test(short) ? /^[0-9]+[a-f]/u.exec(id)?.[0] ?? id : short;
};

export const HistoryRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({ action: Schema.Literal("disable") }),
  Schema.Struct({ action: Schema.Literal("push") }),
  Schema.Struct({ action: Schema.Literals(["enable", "check"]), remote: Schema.optionalKey(Schema.String), branch: Schema.String }),
  Schema.Struct({ action: Schema.Literal("diff"), from: Schema.String, to: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ action: Schema.Literal("restore"), revision: Schema.String, reviewer: Schema.optionalKey(Schema.String) }),
]);
export type HistoryRequest = typeof HistoryRequest.Type;

export const HistoryStatus = Schema.Struct({
  enabled: Schema.Boolean,
  remote: Schema.optionalKey(Schema.String),
  branch: Schema.String,
  backlog: Schema.Number,
  lastPushError: Schema.optionalKey(Schema.String),
  entries: Schema.Array(Schema.Struct({
    id: Schema.String, date: Schema.String, author: Schema.String, subject: Schema.String, pushed: Schema.Boolean,
    sequence: Schema.optionalKey(Schema.Number),
  })),
});

export const HistoryDiff = Schema.Struct({
  from: Schema.String, to: Schema.String, names: Schema.Array(Schema.String), patch: Schema.String,
});

export const HistoryOperationResult = Schema.Struct({
  warnings: Schema.optionalKey(Schema.Array(Schema.String)),
  backup: Schema.optionalKey(Schema.String),
});
