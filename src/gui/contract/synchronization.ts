import { Schema } from "effect";
import { TARGET_IDS } from "../../projection/model.ts";
import { SyncScheduleSchema } from "../../schedule/schedule-manager.types.ts";
import { GuiBase64 } from "./profile.ts";

export const GuiSynchronizationResult = Schema.Record(Schema.String, Schema.Json);
export interface GuiSynchronizationResult extends Schema.Schema.Type<typeof GuiSynchronizationResult> {}
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

/** Both roles may list metadata. Only Source may set/remove; values are request-body-only. */
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
