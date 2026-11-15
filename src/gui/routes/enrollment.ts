import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { FollowerCommands } from "../../cli/follower-commands.ts";
import { SetupCommands } from "../../cli/setup-commands.ts";
import { CliCommandFailure, SourceCommands, type CliPayload } from "../../cli/source-commands.ts";
import { readInvitationEnvelope } from "../../enrollment/invitation-envelope.ts";
import { StateRepository } from "../../state/state-repository.service.ts";
import {
  GuiEnrollInput, GuiEnrollmentTunnelInput, GuiInvitationInput, GuiInviteInput,
  GuiRevokeInput, GuiSetupApplyInput, GuiSetupApproveInput, GuiSetupPlanInput,
  GuiSetupStatus, GuiSourceLook, type GuiMachines,
} from "../contract/enrollment.ts";
import { GuiOperations } from "../operations.ts";
import { GuiQueries } from "../queries.ts";
import { commandFailure, mutationRoute, queryRoute } from "../routing.ts";
import { fetchSourceLook } from "../../enrollment/follower-client.ts";
import { readSourceLook, writeSourceLook } from "../../enrollment/source-look.ts";
import { MachineState } from "../../machine/machine-state.service.ts";

const json = (value: CliPayload | GuiMachines) => Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
  Effect.mapError(() => new CliCommandFailure({ category: "internal", message: "The command returned an invalid JSON response." })),
);
const io = <A>(operation: () => Promise<A>) => Effect.tryPromise({
  try: operation,
  catch: () => new CliCommandFailure({ category: "usage-or-configuration", message: "The private invitation file could not be read or written." }),
});

/** Invitations never enter URLs, logs, persistent browser storage or arbitrary output paths. */
const withInvitationFile = <A>(operation: (path: string) => Effect.Effect<A, CliCommandFailure>) => Effect.acquireUseRelease(
  io(() => mkdtemp(join(tmpdir(), "canonfig-gui-invitation-"))),
  (directory) => operation(join(directory, "invitation.canonfig")),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
);
const decodeEnvelope = (envelope: string) => withInvitationFile((path) =>
  io(() => writeFile(path, envelope, { mode: 0o600 })).pipe(
    Effect.andThen(readInvitationEnvelope({ path }).pipe(Effect.mapError(commandFailure))),
  ),
);

export const enrollmentRoutes = Effect.gen(function*() {
  const source = yield* SourceCommands;
  const follower = yield* FollowerCommands;
  const setup = yield* SetupCommands;
  const repository = yield* StateRepository;
  const queries = yield* GuiQueries;
  const operations = yield* GuiOperations;
  const machine = yield* MachineState;
  const requireRole = (roles: ReadonlyArray<string>) => queries.session().pipe(Effect.flatMap((session) =>
    roles.includes(session.role) ? Effect.void : Effect.fail(new CliCommandFailure({
      category: "usage-or-configuration", message: `This operation is not available on a ${session.role} machine.`,
    })),
  ));
  const setupStatus = () => setup.status().pipe(Effect.flatMap((value) =>
    Schema.decodeUnknownEffect(GuiSetupStatus)(value).pipe(Effect.mapError(() => new CliCommandFailure({
      category: "internal", message: "The setup service returned an invalid status.",
    }))),
  ));
  const enrollment = () => Effect.gen(function*() {
    yield* requireRole(["follower"]);
    const configuration = yield* repository.getFollowerSynchronizationConfiguration().pipe(Effect.mapError(commandFailure));
    if (configuration === undefined) return yield* new CliCommandFailure({ category: "usage-or-configuration", message: "This machine has no follower enrollment." });
    const { id, name, groups, enrolledAt, revoked } = configuration.follower;
    return { follower: { id, name, groups, enrolledAt, revoked }, source: configuration.source, pending: configuration.lifecycle._tag !== "Active" };
  });
  return [
    queryRoute("/api/machines", () => Effect.gen(function*() {
      yield* requireRole(["source"]);
      const followers = yield* repository.listEnrollmentFollowers().pipe(Effect.mapError(commandFailure));
      const invitations = yield* repository.listEnrollmentInvitations().pipe(Effect.mapError(commandFailure));
      return yield* json({ followers, invitations });
    })),
    queryRoute("/api/enrollment", enrollment),
    mutationRoute("POST", "/api/invitations", GuiInviteInput, (input) => Effect.gen(function*() {
      yield* requireRole(["source"]);
      return yield* withInvitationFile((path) => Effect.gen(function*() {
        yield* source.invite({ ...input, outputPath: path, timeoutMilliseconds: 10_000 });
        const grant = yield* readInvitationEnvelope({ path }).pipe(Effect.mapError(commandFailure));
        const envelope = yield* io(() => readFile(path, "utf8"));
        return { filename: "canonfig-invitation.txt", envelope, endpoint: grant.endpoint, expiresAt: grant.expiresAt, groups: grant.groups };
      }));
    })),
    mutationRoute("POST", "/api/machines/revoke", GuiRevokeInput, (input) => requireRole(["source"]).pipe(
      Effect.andThen(source.revoke(input.follower)), Effect.flatMap(json),
    )),
    mutationRoute("POST", "/api/enrollment/inspect", GuiInvitationInput, (input) => Effect.gen(function*() {
      yield* requireRole(["unconfigured", "follower"]);
      const grant = yield* decodeEnvelope(input.envelope);
      return { endpoint: grant.endpoint, sourceFingerprint: grant.sourceFingerprint, tlsFingerprint: grant.tlsFingerprint, groups: grant.groups, expiresAt: grant.expiresAt };
    })),
    mutationRoute("POST", "/api/enrollment", GuiEnrollInput, (input) => Effect.gen(function*() {
      yield* requireRole(["unconfigured", "follower"]);
      const invitation = yield* decodeEnvelope(input.envelope);
      return yield* operations.start(follower.enroll({ invitation, followerName: input.followerName, replace: input.replace }).pipe(Effect.flatMap(json)), () => Effect.succeed(null));
    }), 202),
    mutationRoute("POST", "/api/enrollment/tunnel", GuiEnrollmentTunnelInput, (input) => Effect.gen(function*() {
      yield* requireRole(["unconfigured", "follower"]);
      yield* decodeEnvelope(input.envelope);
      return yield* operations.start(withInvitationFile((path) => io(() => writeFile(path, input.envelope, { mode: 0o600 })).pipe(
        Effect.andThen(follower.startTunnel({ invitationPath: path, sshHost: input.sshHost, sshUser: input.sshUser, sshPort: input.sshPort, sshHostKeyPath: input.sshHostKeyPath, localHost: "127.0.0.1", localPort: input.localPort, sshArguments: [], timeoutMilliseconds: 10_000 })),
        Effect.flatMap(json),
      )), () => Effect.succeed(null));
    }), 202),
    // A Source reads its saved look; a Follower asks its Source, and an older or unreachable Source just means the default card.
    queryRoute("/api/source-look", () => Effect.gen(function*() {
      const session = yield* queries.session();
      if (session.role === "source") return { look: (yield* readSourceLook().pipe(Effect.provideService(MachineState, machine))) ?? null };
      if (session.role !== "follower") return { look: null };
      const configuration = yield* repository.getFollowerSynchronizationConfiguration().pipe(Effect.mapError(commandFailure));
      if (configuration === undefined) return { look: null };
      const look = yield* fetchSourceLook({
        endpoint: configuration.source.endpoint,
        tlsFingerprint: configuration.source.tlsFingerprint,
        credentialReference: configuration.credentialReference,
      }).pipe(Effect.provideService(MachineState, machine), Effect.orElseSucceed(() => undefined));
      return { look: look ?? null };
    })),
    mutationRoute("PUT", "/api/source-look", GuiSourceLook, (input) => Effect.gen(function*() {
      yield* requireRole(["source"]);
      yield* writeSourceLook(input.look ?? undefined).pipe(
        Effect.provideService(MachineState, machine),
        Effect.mapError((cause) => new CliCommandFailure({ category: "internal", message: cause.message })),
      );
      return { look: input.look };
    })),
    queryRoute("/api/setup", () => setupStatus().pipe(Effect.flatMap(json))),
    mutationRoute("POST", "/api/setup/plan", GuiSetupPlanInput, (input) => setup.plan(input).pipe(Effect.flatMap(json))),
    mutationRoute("POST", "/api/setup/approve", GuiSetupApproveInput, (input) => setup.approve(input).pipe(Effect.flatMap(json))),
    mutationRoute("POST", "/api/setup/apply", GuiSetupApplyInput, (input) => operations.start(
      setup.apply(input).pipe(Effect.flatMap(json)),
      () => setupStatus().pipe(Effect.flatMap((status) => json(status.planDigest === input.planDigest ? status : null))),
    ), 202),
  ];
});
