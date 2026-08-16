import { Effect, Layer } from "effect";

import { StateRepository } from "../state/state-repository.service.ts";
import { scanDiscovery } from "./discovery.ts";
import { PublicationNotConfiguredError } from "./profile-catalog.errors.ts";
import { ProfileCatalog } from "./profile-catalog.service.ts";
import {
  makePublication,
  type ProfileRevisionSigner,
} from "./publication.ts";

export const ProfileCatalogLive = Layer.succeed(
  ProfileCatalog,
  ProfileCatalog.of({
    scan: scanDiscovery,
    publish: () => Effect.fail(
      new PublicationNotConfiguredError({ operation: "publish" }),
    ),
    getRevision: () => Effect.fail(
      new PublicationNotConfiguredError({ operation: "getRevision" }),
    ),
  }),
);

export const profileCatalogLayer = (
  signer: ProfileRevisionSigner,
) => Layer.effect(
  ProfileCatalog,
  Effect.gen(function*() {
    const repository = yield* StateRepository;
    const publication = makePublication(signer, repository);
    return ProfileCatalog.of({
      scan: scanDiscovery,
      publish: publication.publish,
      getRevision: repository.getRevision,
    });
  }),
);
