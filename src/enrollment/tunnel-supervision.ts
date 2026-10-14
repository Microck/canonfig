import { Effect } from "effect";

import { TunnelDownError } from "./tunnel.errors.ts";
import { Tunnel } from "./tunnel.service.ts";
import type { TunnelStatusReport } from "./tunnel.types.ts";

export interface ManagedTunnelGuardInput {
  /** The tunnel state directory beside the follower state. */
  readonly stateDirectory: string;
  /** The endpoint the follower reaches its Source at, when it is enrolled. */
  readonly sourceEndpoint: string | undefined;
  /**
   * Restart a down tunnel once before running. Only unattended runs do this:
   * nobody is there to run `canonfig tunnel start` for them.
   */
  readonly restart: boolean;
}

const endpointHost = (endpoint: string): string | undefined => {
  try {
    return new URL(endpoint).host;
  } catch {
    return undefined;
  }
};

/** Whether this follower's Source traffic goes through the recorded managed tunnel. */
export const tunnelCarriesSource = (
  report: TunnelStatusReport,
  sourceEndpoint: string | undefined,
): boolean => {
  if (report.lifecycle === "not-configured") return false;
  if (report.endpoint === undefined || sourceEndpoint === undefined) return false;
  const tunnelHost = endpointHost(report.endpoint);
  return tunnelHost !== undefined && tunnelHost === endpointHost(sourceEndpoint);
};

const recoveryOf = (report: TunnelStatusReport): string =>
  report.recovery ?? "canonfig tunnel start";

/**
 * Runs Source traffic that may travel through the managed SSH tunnel.
 *
 * A dead tunnel used to surface as "the source TLS certificate could not be
 * inspected", and nothing restarted it, so an unattended follower failed
 * until someone read the journal and guessed. Here a scheduled run restarts a
 * down tunnel once from its recorded configuration, and a transport failure
 * while the tunnel is not carrying traffic is reported as the tunnel outage it
 * is, naming the command that fixes it. A deliberately stopped tunnel is never
 * restarted.
 */
export const withManagedTunnel = <Success, Failure, Requirements>(
  input: ManagedTunnelGuardInput,
  isTransportFailure: (failure: Failure) => boolean,
  operation: Effect.Effect<Success, Failure, Requirements>,
): Effect.Effect<Success, Failure | TunnelDownError, Requirements | Tunnel> =>
  Effect.gen(function*() {
    const tunnel = yield* Tunnel;
    const status: Effect.Effect<TunnelStatusReport | undefined> = tunnel
      .tunnelStatus({ stateDirectory: input.stateDirectory })
      .pipe(
        Effect.map((report) => tunnelCarriesSource(report, input.sourceEndpoint) ? report : undefined),
        Effect.catch(() => Effect.succeed(undefined)),
      );
    const before = yield* status;
    if (before === undefined) return yield* operation;
    if (before.lifecycle === "down" && input.restart) {
      yield* tunnel.restartTunnel({ stateDirectory: input.stateDirectory }).pipe(
        Effect.mapError((error) =>
          new TunnelDownError({
            endpoint: before.endpoint ?? "",
            message:
              `the Source is reached through the managed tunnel ${before.endpoint ?? ""}, which is down (${before.detail}), `
              + `and restarting it failed: ${error.message}. Fix the cause, then run \`${recoveryOf(before)}\`.`,
          })
        ),
      );
    }
    return yield* operation.pipe(
      Effect.catch((failure): Effect.Effect<never, Failure | TunnelDownError> =>
        isTransportFailure(failure)
          ? status.pipe(
            Effect.flatMap((after): Effect.Effect<never, Failure | TunnelDownError> =>
              after === undefined || after.lifecycle === "running"
                ? Effect.fail(failure)
                : Effect.fail(
                  new TunnelDownError({
                    endpoint: after.endpoint ?? "",
                    message: after.lifecycle === "stopped"
                      ? `the Source is unreachable because the managed tunnel ${after.endpoint ?? ""} is stopped. Run \`${recoveryOf(after)}\`.`
                      : `the Source is unreachable because the managed tunnel ${after.endpoint ?? ""} is down: ${after.detail}. Run \`${recoveryOf(after)}\`.`,
                  }),
                )
            ),
          )
          : Effect.fail(failure)
      ),
    );
  });
