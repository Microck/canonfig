import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema, Semaphore } from "effect";
import { FollowerCommands } from "../../cli/follower-commands.ts";
import { SetupCommands } from "../../cli/setup-commands.ts";
import { CliCommandFailure, SourceCommands, type CliPayload } from "../../cli/source-commands.ts";
import { readInvitationEnvelope } from "../../enrollment/invitation-envelope.ts";
import { StateRepository } from "../../state/state-repository.service.ts";
import {
  GuiEnrollInput, GuiEnrollmentTunnelInput, GuiInvitationInput, GuiInviteInput,
  GuiRevokeInput, GuiSetupApplyInput, GuiSetupApproveInput, GuiSetupPlanInput,
  GuiSetupStatus, type GuiMachines,
} from "../contract/enrollment.ts";
import { GuiOperations } from "../operations.ts";
import { GuiQueries } from "../queries.ts";
import { commandFailure, mutationRoute, queryRoute } from "../routing.ts";

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
  // Serialize journal mutations so approval cannot race a re-plan in this GUI.
  const setupLock = yield* Semaphore.make(1);
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
  const checkPlan = (digest: string) => setupStatus().pipe(Effect.flatMap((status) =>
    status.planDigest === digest ? Effect.succeed(status) : Effect.fail(new CliCommandFailure({
      category: "conflict-or-drift", message: "The setup plan changed. Reload and review the current plan before approving or applying it.",
    })),
  ));
  const enrollment = () => Effect.gen(function*() {
    yield* requireRole(["follower"]);
    const configuration = yield* repository.getFollowerSynchronizationConfiguration().pipe(Effect.mapError(commandFailure));
    if (configuration === undefined) return yield* new CliCommandFailure({ category: "usage-or-configuration", message: "This machine has no follower enrollment." });
    const { id, name, groups, enrolledAt, revoked } = configuration.follower;
    return { follower: { id, name, groups, enrolledAt, revoked }, source: configuration.source, pending: configuration.enrollmentPending === true };
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
    queryRoute("/api/setup", () => setupStatus().pipe(Effect.flatMap(json))),
    mutationRoute("POST", "/api/setup/plan", GuiSetupPlanInput, (input) => setup.plan(input).pipe(Effect.flatMap(json), setupLock.withPermits(1))),
    mutationRoute("POST", "/api/setup/approve", GuiSetupApproveInput, (input) => checkPlan(input.planDigest).pipe(
      Effect.andThen(setup.approve({ approver: input.approver })), Effect.flatMap(json), setupLock.withPermits(1),
    )),
    mutationRoute("POST", "/api/setup/apply", GuiSetupApplyInput, (input) => Effect.gen(function*() {
      yield* checkPlan(input.planDigest);
      return yield* operations.start(checkPlan(input.planDigest).pipe(Effect.andThen(setup.apply()), Effect.flatMap(json), setupLock.withPermits(1)), () => setupStatus().pipe(
        Effect.flatMap((status) => json(status.planDigest === input.planDigest ? status : null)),
      ));
    }), 202),
  ];
});
