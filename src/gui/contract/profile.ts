import { Schema } from "effect";

/** Scan without regex backtracking or decoded copies, including multi-megabyte files. */
export const GuiBase64 = Schema.String.check(Schema.makeFilter((value) => {
  if (value.length % 4 !== 0) return "Expected padded base64.";
  let end = value.length;
  if (value.endsWith("==")) end -= 2;
  else if (value.endsWith("=")) end--;
  for (let index = 0; index < end; index++) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) || code === 43 || code === 47)) return "Expected padded base64.";
  }
  return undefined;
}));

/** Bytes use base64 so authored binary files round-trip without text conversion. */
export const GuiProfileFile = Schema.Struct({
  path: Schema.String,
  base64: GuiBase64,
  executable: Schema.Boolean,
});
export const GuiProfileItem = Schema.Struct({ path: Schema.String, digest: Schema.NullOr(Schema.String), files: Schema.Array(GuiProfileFile) });
export interface GuiProfileItem extends Schema.Schema.Type<typeof GuiProfileItem> {}
export const GuiProfileSnapshot = Schema.Struct({ items: Schema.Array(GuiProfileItem), config: Schema.Record(Schema.String, Schema.Json), supportedSurfaces: Schema.Record(Schema.String, Schema.Array(Schema.String)) });
export interface GuiProfileSnapshot extends Schema.Schema.Type<typeof GuiProfileSnapshot> {}
export const GuiProfileChange = Schema.Struct({ path: Schema.NonEmptyString, expectedDigest: Schema.NullOr(Schema.String), files: Schema.Array(GuiProfileFile) });
export const GuiProfileWrite = Schema.Struct({ changes: Schema.Array(GuiProfileChange) });
export const GuiProfileConfigEdit = Schema.Struct({ path: Schema.Array(Schema.Union([Schema.String, Schema.Int])), value: Schema.optionalKey(Schema.Json) });
export const GuiProfileConfigWrite = Schema.Struct({ expectedDigest: Schema.NullOr(Schema.String), edits: Schema.Array(GuiProfileConfigEdit), changes: Schema.Array(GuiProfileChange) });
export const GuiProfileSaved = Schema.Struct({ saved: Schema.Literal(true) });
export const GuiPublicationRequest = Schema.Struct({ reviewer: Schema.NonEmptyString });
export const GuiRevisionSelection = Schema.Struct({ revision: Schema.NonEmptyString });
export const GuiRevisions = Schema.Struct({ revisions: Schema.Array(Schema.Struct({ id: Schema.String, profileId: Schema.String, sequence: Schema.Number, digest: Schema.String, publishedAt: Schema.String })) });
export interface GuiRevisions extends Schema.Schema.Type<typeof GuiRevisions> {}
export const GuiProfileValidation = Schema.Struct({ valid: Schema.Boolean, errors: Schema.Array(Schema.String), profile: Schema.Json });
export interface GuiProfileValidation extends Schema.Schema.Type<typeof GuiProfileValidation> {}
export const GuiSkillTrack = Schema.Struct({ name: Schema.NonEmptyString, source: Schema.NonEmptyString, ref: Schema.NonEmptyString, subdir: Schema.NonEmptyString });
export const GuiSkillSelection = Schema.Struct({ name: Schema.NonEmptyString });
export const GuiTrackedSkill = Schema.Struct({ name: Schema.String, path: Schema.String, source: Schema.String, ref: Schema.String, subdir: Schema.String, commit: Schema.String, digest: Schema.String });
export const GuiSkills = Schema.Struct({ version: Schema.Literal(1), skills: Schema.Array(GuiTrackedSkill) });
export interface GuiSkills extends Schema.Schema.Type<typeof GuiSkills> {}
export const GuiSkillCheck = Schema.Struct({ name: Schema.String, path: Schema.String, previousCommit: Schema.String, nextCommit: Schema.String, status: Schema.Literals(["unchanged", "update-available", "local-edits"]), added: Schema.Array(Schema.String), changed: Schema.Array(Schema.String), removed: Schema.Array(Schema.String) });
export const GuiSkillChecks = Schema.Array(GuiSkillCheck);
export interface GuiSkillCheck extends Schema.Schema.Type<typeof GuiSkillCheck> {}
export const profileEndpoints = { items: "/api/profile/items", config: "/api/profile/config", validate: "/api/profile/validate", scan: "/api/profile/scan", publications: "/api/publications", revisions: "/api/revisions", revision: "/api/revisions/inspect", skills: "/api/skills", track: "/api/skills/track", check: "/api/skills/check", update: "/api/skills/update" } as const;
