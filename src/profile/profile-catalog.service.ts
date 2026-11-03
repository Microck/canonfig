import { Context, type Effect } from "effect";

import type { ProfileRevisionId } from "../domain/brand.ts";
import type { ProfileRevision } from "../domain/profile.ts";
import type { FolderScanInput, FolderScanResult } from "./discovery.ts";
import type {
  ProfileCatalogPublishError,
  ProfileCatalogRevisionError,
  ProfileCatalogScanError,
} from "./profile-catalog.errors.ts";
import type { PublishFolderInput } from "./publication.ts";

/**
 * C7 profile boundary. Scanning never publishes; `--write` only adds
 * reviewed tool entries to `canonfig.jsonc`, and publication signs what the
 * Canonical Folder holds under a named reviewer.
 */
export class ProfileCatalog extends Context.Service<ProfileCatalog, {
  readonly scan: (
    input: FolderScanInput,
  ) => Effect.Effect<FolderScanResult, ProfileCatalogScanError>;
  readonly publish: (
    input: PublishFolderInput,
  ) => Effect.Effect<ProfileRevision, ProfileCatalogPublishError>;
  readonly getRevision: (
    id: ProfileRevisionId,
  ) => Effect.Effect<ProfileRevision, ProfileCatalogRevisionError>;
}>()("canonfig/profile/ProfileCatalog") {}
