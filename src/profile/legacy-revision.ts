import { Schema } from "effect";

import {
  PublishedMachineProfileSchema,
  type ProfileRevision,
} from "../domain/profile.ts";
import { digestOf, sha256BytesHex, type JsonValue } from "./profile-codec.ts";

/**
 * Revisions published before 3.2.1 signed the authored profile itself: every
 * file body travels inline as UTF-8 `content`, and each resource's blob index
 * names the digest of its whole spec. This release transports files as
 * content-addressed blobs instead, so a Source upgraded in place would refuse
 * every revision it published earlier.
 *
 * These are the only reads of that format. The state migration backfills the
 * file blobs, and the Source projects a legacy revision, after verifying it
 * exactly as the release that published it did, into the transport shape
 * that followers of this release apply.
 */

const JsonObject = Schema.Record(Schema.String, Schema.MutableJson);
type JsonObject = typeof JsonObject.Type;

/** A legacy revision that this release cannot represent faithfully. */
export class LegacyRevisionFormatIssue extends Error {}

const isJsonObject = Schema.is(JsonObject);

const isObject = (value: JsonValue | undefined): value is JsonObject => isJsonObject(value);

const objectsIn = (value: JsonValue | undefined): ReadonlyArray<JsonObject> =>
  Array.isArray(value) ? value.filter(isObject) : [];

const text = (value: JsonValue | undefined): string | undefined =>
  Schema.is(Schema.String)(value) ? value : undefined;

/** Published revisions of this release always carry each resource's spec. */
export const isLegacyRevision = (
  revision: Pick<ProfileRevision, "resources">,
): boolean => revision.resources.some((resource) => resource.spec === undefined);

const legacyProfile = (canonicalBytes: string): JsonObject => {
  const parsed: unknown = JSON.parse(canonicalBytes);
  if (!isJsonObject(parsed)) {
    throw new LegacyRevisionFormatIssue("the signed profile is not a JSON object");
  }
  return parsed;
};

const legacySpecDigest = (resource: JsonObject): string => {
  const spec = resource.spec;
  if (spec === undefined) {
    throw new LegacyRevisionFormatIssue(`resource ${text(resource.id) ?? "?"} has no spec`);
  }
  return digestOf(spec);
};

interface LegacyFileBlob {
  readonly id: string;
  readonly content: Uint8Array;
}

const legacyFileEntries = (spec: JsonObject): ReadonlyArray<JsonObject> => {
  const kind = text(spec.kind);
  if (kind === "file") return [spec];
  if (kind === "directory" || kind === "skill") return objectsIn(spec.files);
  return [];
};

const fileBytes = (file: JsonObject): Uint8Array => {
  const content = text(file.content);
  if (content === undefined) {
    throw new LegacyRevisionFormatIssue("a regular file carries no inline content");
  }
  return Buffer.from(content, "utf8");
};

/**
 * The file blobs of one legacy resource, keyed by the spec digest that the
 * legacy blob index recorded for it. A resource whose spec does not hash to
 * that digest is not a legacy resource, so it yields nothing. Neither does a
 * resource this release cannot represent: the state must still open, and the
 * Source names the problem when a follower asks for that revision.
 */
export const legacyResourceFileBlobs = (
  canonicalBytes: string,
  resourceId: string,
  specDigest: string,
): ReadonlyArray<LegacyFileBlob> => {
  try {
    const resource = objectsIn(legacyProfile(canonicalBytes).resources)
      .find((candidate) => text(candidate.id) === resourceId);
    if (resource === undefined || !isObject(resource.spec)) return [];
    if (legacySpecDigest(resource) !== specDigest) return [];
    return legacyFileEntries(resource.spec).flatMap((file) => {
      if (text(file.symlinkTo) !== undefined) return [];
      const content = fileBytes(file);
      return [{ id: sha256BytesHex(content), content }];
    });
  } catch (cause) {
    if (cause instanceof LegacyRevisionFormatIssue || cause instanceof SyntaxError) return [];
    throw cause;
  }
};

/**
 * Native schedules became the follower's own choice in 3.0: a v2.x revision
 * may still carry a `schedule` resource, or a schedule default in a named
 * timezone, and neither exists in this release. They are left out, with a
 * notice, so the rest of the revision stays listable and servable.
 */
const retired = (resource: JsonObject): boolean => text(resource.kind) === "schedule";

const withoutRetired = (
  resources: ReadonlyArray<JsonObject>,
): ReadonlyArray<JsonObject> => {
  const retiredIds = new Set(resources.filter(retired).map((resource) => text(resource.id)));
  return resources.filter((resource) => !retired(resource)).map((resource) =>
    Array.isArray(resource.dependsOn)
      ? {
        ...resource,
        dependsOn: resource.dependsOn.filter((dependency) => !retiredIds.has(text(dependency))),
      }
      : resource
  );
};

const retiredScheduleDefault = (value: JsonValue | undefined): boolean =>
  value !== undefined && !(isObject(value) && text(value.timezone) === "local");

/**
 * The stored revision JSON as this release decodes it. Only a legacy
 * revision changes, and only by leaving out retired schedule items; the
 * Source still verifies the signature over what was actually signed.
 */
export const storedRevisionJson = (stored: string): string => {
  try {
    const revision: unknown = JSON.parse(stored);
    if (!isJsonObject(revision)) return stored;
    const resources = objectsIn(revision.resources);
    if (!resources.some((resource) => resource.spec === undefined)) return stored;
    const { scheduleDefault, ...rest } = revision;
    const kept: JsonObject = retiredScheduleDefault(scheduleDefault) || scheduleDefault === undefined
      ? {}
      : { scheduleDefault };
    return JSON.stringify({ ...rest, ...kept, resources: withoutRetired(resources) });
  } catch {
    return stored;
  }
};

const legacyIndex = (resources: ReadonlyArray<JsonObject>): JsonValue =>
  resources.map((resource) => {
    const entry = {
      id: resource.id ?? null,
      kind: resource.kind ?? null,
      policy: resource.policy ?? null,
      target: resource.target ?? null,
      dependsOn: resource.dependsOn ?? [],
      blobs: [legacySpecDigest(resource)],
    };
    return resource.groups === undefined ? entry : { ...entry, groups: resource.groups };
  });

/** The resource index a legacy revision was signed with, retired items included. */
export const legacySignedResources = (canonicalBytes: string): JsonValue =>
  legacyIndex(objectsIn(legacyProfile(canonicalBytes).resources));

/**
 * The resource index this release stores for a legacy revision. The Source
 * compares it with the stored metadata, which is what the publishing release
 * checked before it served the revision.
 */
export const legacyStoredResources = (canonicalBytes: string): JsonValue =>
  legacyIndex(withoutRetired(objectsIn(legacyProfile(canonicalBytes).resources)));

const publishedFile = (file: JsonObject) => {
  const path: JsonObject = file.path === undefined ? {} : { path: file.path };
  const symlinkTo = text(file.symlinkTo);
  if (symlinkTo !== undefined) {
    return { ...path, executable: false, mode: 0, symlinkTo };
  }
  const content = fileBytes(file);
  const mode: JsonObject = file.mode === undefined ? {} : { mode: file.mode };
  return {
    ...path,
    blob: sha256BytesHex(content),
    bytes: content.byteLength,
    executable: file.executable === true,
    ...mode,
  };
};

const SupportedKind = Schema.Literals(["file", "directory", "config", "skill", "tool", "credential"]);

const publishedResource = (resource: JsonObject) => {
  const id = text(resource.id) ?? "?";
  const spec = resource.spec;
  if (!isObject(spec)) throw new LegacyRevisionFormatIssue(`resource ${id} has no spec`);
  const kind = text(spec.kind) ?? "?";
  if (!Schema.is(SupportedKind)(kind)) {
    throw new LegacyRevisionFormatIssue(
      `resource ${id} has kind ${kind}, which this release no longer supports`,
    );
  }
  const published: JsonObject = kind === "file"
    ? { kind, ...publishedFile(spec) }
    : kind === "directory" || kind === "skill"
    ? { ...spec, files: objectsIn(spec.files).map(publishedFile) }
    : spec;
  const blobs = legacyFileEntries(published).flatMap((file) => {
    const blob = text(file.blob);
    return blob === undefined ? [] : [blob];
  });
  const entry = {
    id: resource.id ?? null,
    kind: resource.kind ?? null,
    policy: resource.policy ?? null,
    target: resource.target ?? null,
    dependsOn: resource.dependsOn ?? [],
    spec: published,
    blobs: [...new Set(blobs)],
    verify: resource.verify ?? null,
  };
  return resource.groups === undefined ? entry : { ...entry, groups: resource.groups };
};

/**
 * The legacy signed profile in the shape a revision of this release carries,
 * with a notice for each retired item left out. Its file blobs are exactly
 * the ones `legacyResourceFileBlobs` backfills.
 */
export const projectLegacyProfile = (canonicalBytes: string) => {
  const profile = legacyProfile(canonicalBytes);
  const resources = objectsIn(profile.resources);
  const notices = resources.filter(retired).map((resource) =>
    `resource ${text(resource.id) ?? "?"} is a v2 schedule resource and was left out: native schedules are chosen per follower with 'canonfig schedule set' since 3.0`
  );
  const { scheduleDefault, ...rest } = profile;
  const retiredDefault = retiredScheduleDefault(scheduleDefault);
  if (retiredDefault) {
    notices.push(
      "the revision's schedule default names a timezone other than the follower's local one and was left out: set a schedule with 'canonfig schedule set'",
    );
  }
  const kept: JsonObject = retiredDefault || scheduleDefault === undefined
    ? {}
    : { scheduleDefault };
  const projected = {
    ...rest,
    ...kept,
    resources: withoutRetired(resources).map(publishedResource),
  };
  try {
    return {
      profile: Schema.decodeUnknownSync(PublishedMachineProfileSchema)(projected),
      notices,
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    throw new LegacyRevisionFormatIssue(
      `it does not fit this release's revision format: ${detail}`,
    );
  }
};
