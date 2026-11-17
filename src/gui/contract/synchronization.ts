import { Schema } from "effect";
import { ContentDigest } from "../../domain/brand.ts";
import { TARGET_IDS } from "../../projection/model.ts";
import { SyncScheduleSchema } from "../../schedule/schedule-manager.types.ts";
import { GuiBase64 } from "./profile.ts";

export const GuiTunnelStartInput = Schema.Struct({
  timeoutMilliseconds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 300_000 }))),
});
export const GuiTunnelStopInput = Schema.Struct({ forget: Schema.Boolean });

export const GuiSynchronizationResult = Schema.Record(Schema.String, Schema.Json);
export interface GuiSynchronizationResult extends Schema.Schema.Type<typeof GuiSynchronizationResult> {}
/** The scheduler runs on the GUI host, which can be in a different zone from the browser. */
export const GuiScheduleStatus = Schema.StructWithRest(
  Schema.Struct({ machineTimezone: Schema.NonEmptyString }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type GuiScheduleStatus = typeof GuiScheduleStatus.Type;
export const GuiSyncApplyRequest = Schema.Struct({ planDigest: ContentDigest });
export const GuiLocalSynchronization = Schema.Struct({
  activeRecovery: Schema.NullOr(Schema.Struct({ run: Schema.String })),
});
export const GuiScheduleRequest = Schema.Union([
  Schema.Struct({ profileDefault: Schema.Literal(true) }),
  Schema.Struct({ schedule: SyncScheduleSchema }),
]);
export const GuiHarnessRequest = Schema.Struct({
  harness: Schema.Literals(TARGET_IDS), action: Schema.Literals(["include", "exclude"]),
});
export const GuiHarnessReport = Schema.Struct({
  folder: Schema.String, configured: Schema.Boolean,
  listed: Schema.Array(Schema.Literals(TARGET_IDS)), excluded: Schema.Array(Schema.Literals(TARGET_IDS)),
  detected: Schema.Array(Schema.Literals(TARGET_IDS)), notInstalled: Schema.Array(Schema.Literals(TARGET_IDS)),
  snapshots: Schema.Number, latestSnapshot: Schema.optionalKey(Schema.String),
  change: Schema.optionalKey(GuiHarnessRequest), warnings: Schema.optionalKey(Schema.Array(Schema.String)),
  harnesses: Schema.Array(Schema.Struct({
    harness: Schema.Literals(TARGET_IDS), name: Schema.String, installed: Schema.Boolean,
    executable: Schema.optionalKey(Schema.String), root: Schema.String, rootExists: Schema.Boolean,
    status: Schema.Literals(["selected", "not-installed", "excluded", "detected", "absent"]),
    listed: Schema.Boolean, excluded: Schema.Boolean,
    pinnedRoot: Schema.optionalKey(Schema.String), snapshot: Schema.optionalKey(Schema.String),
  })),
});
export interface GuiHarnessReport extends Schema.Schema.Type<typeof GuiHarnessReport> {}
export const GuiOverlayRequest = Schema.Struct({ item: Schema.NonEmptyString });
export const GuiRestoreRequest = Schema.Struct({ snapshot: Schema.NonEmptyString });
export const GuiBackups = Schema.Struct({ snapshots: Schema.Array(Schema.String) });
export interface GuiBackups extends Schema.Schema.Type<typeof GuiBackups> {}

export const GuiLocalFile = Schema.Struct({
  path: Schema.String, base64: Schema.String, executable: Schema.Boolean, digest: Schema.String,
});
export const GuiLocalItem = Schema.Struct({
  path: Schema.String, digest: Schema.NullOr(Schema.String), files: Schema.Array(GuiLocalFile),
});
export interface GuiLocalItem extends Schema.Schema.Type<typeof GuiLocalItem> {}
export const GuiLocalItems = Schema.Struct({
  items: Schema.Array(GuiLocalItem),
  config: Schema.Record(Schema.String, Schema.Json),
  canonicalConfig: Schema.Record(Schema.String, Schema.Json),
});
export interface GuiLocalItems extends Schema.Schema.Type<typeof GuiLocalItems> {}
export const GuiLocalChange = Schema.Struct({
  path: Schema.NonEmptyString,
  expectedDigest: Schema.NullOr(Schema.String),
  files: Schema.Array(Schema.Struct({
    path: Schema.NonEmptyString,
    base64: GuiBase64,
    executable: Schema.Boolean,
  })),
});
export const GuiLocalWrite = Schema.Struct({ changes: Schema.Array(GuiLocalChange) });
export const GuiLocalConfigRequest = Schema.Struct({
  expectedDigest: Schema.NullOr(Schema.String),
  edits: Schema.Array(Schema.Struct({
    path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
    value: Schema.optionalKey(Schema.Json),
  })),
});

/** Both roles list metadata and set/remove machine-local entries. Source-owned values cannot be replaced locally. Values are request-body-only. */
export const GuiSecretSummary = Schema.Struct({ name: Schema.String, origin: Schema.Literals(["local", "source"]) });
export interface GuiSecretSummary extends Schema.Schema.Type<typeof GuiSecretSummary> {}
export const GuiSecrets = Schema.Struct({ secrets: Schema.Array(GuiSecretSummary) });
export interface GuiSecrets extends Schema.Schema.Type<typeof GuiSecrets> {}
export const GuiSecretSet = Schema.Struct({ name: Schema.String, value: Schema.String });
export const GuiSecretName = Schema.Struct({ name: Schema.String });
export const GuiSecretRemoval = Schema.Struct({ name: Schema.String, removed: Schema.Boolean });
export interface GuiSecretRemoval extends Schema.Schema.Type<typeof GuiSecretRemoval> {}
export const GuiSecretSync = Schema.Struct({
  status: Schema.Literals(["not-enrolled", "not-shared", "synchronized"]), secrets: Schema.Array(Schema.String),
});
export interface GuiSecretSync extends Schema.Schema.Type<typeof GuiSecretSync> {}

/** POST /api/exports returns verified archive bytes. Decode into a Blob; never persist in browser storage. */
export const GuiExportRequest = Schema.Struct({ includeHarnesses: Schema.Boolean });
export const GuiArchiveDownload = Schema.Struct({
  filename: Schema.String,
  mediaType: Schema.Literal("application/gzip"),
  base64: Schema.String,
  sha256: Schema.String,
  manifestSha256: Schema.String,
  signer: Schema.String,
});
export interface GuiArchiveDownload extends Schema.Schema.Type<typeof GuiArchiveDownload> {}

/** Archive bytes stay in memory in the browser and in a private, short-lived server file. */
export const GuiArchiveImportInput = Schema.Struct({
  base64: GuiBase64,
  replace: Schema.Boolean,
  expectKey: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
});
export const GuiArchiveImportApply = Schema.Struct({
  ...GuiArchiveImportInput.fields,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export const GuiArchiveImportResult = Schema.Struct({
  sha256: Schema.String,
  manifestSha256: Schema.String,
  signer: Schema.String,
  folderFiles: Schema.Number,
  replaced: Schema.Array(Schema.String),
  kept: Schema.optionalKey(Schema.Array(Schema.String)),
  harnessFiles: Schema.optionalKey(Schema.Struct({
    verified: Schema.Number, harnesses: Schema.Array(Schema.String), note: Schema.String,
  })),
  plan: Schema.Json,
  backup: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(Schema.Json),
});
export interface GuiArchiveImportResult extends Schema.Schema.Type<typeof GuiArchiveImportResult> {}
