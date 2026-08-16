import { Context, type Effect } from "effect";

import type { ProfileRevisionId } from "../domain/brand.ts";
import type { ProfileRevision } from "../domain/profile.ts";
import type {
  DiscoveryScanInput,
  DiscoveryScanResult,
} from "./discovery.ts";
import type {
  ProfileCatalogPublishError,
  ProfileCatalogRevisionError,
  ProfileCatalogScanError,
} from "./profile-catalog.errors.ts";
import type { PublishProfileInput } from "./publication.ts";

/**
 * C7 profile boundary. Scanning itself never mutates or publishes a profile;
 * publication requires an explicit accepted review.
 */
export class ProfileCatalog extends Context.Service<ProfileCatalog, {
  readonly scan: (
    input: DiscoveryScanInput,
  ) => Effect.Effect<DiscoveryScanResult, ProfileCatalogScanError>;
  readonly publish: (
    input: PublishProfileInput,
  ) => Effect.Effect<ProfileRevision, ProfileCatalogPublishError>;
  readonly getRevision: (
    id: ProfileRevisionId,
  ) => Effect.Effect<ProfileRevision, ProfileCatalogRevisionError>;
}>()("canonfig/profile/ProfileCatalog") {}
