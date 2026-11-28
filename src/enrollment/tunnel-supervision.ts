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
   * Allow automatic recovery of a down tunnel. Only unattended runs do this:
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
 * Prepares the tunnel before Source traffic and returns a guard for transport errors.
 *
 * Scheduled runs recover a down tunnel from its recorded configuration.
 * Replayable operations can opt into one retry if the tunnel drops mid-run.
 * A deliberately stopped tunnel is never restarted automatically.
 */
export const prepareManagedTunnel = (input: ManagedTunnelGuardInput) =>
  Effect.gen(function*() {
    const tunnel = yield* Tunnel;
    const status: Effect.Effect<TunnelStatusReport | undefined> = input.sourceEndpoint === undefined
      ? Effect.succeed(undefined)
      : tunnel
      .tunnelStatus({ stateDirectory: input.stateDirectory })
      .pipe(
        Effect.map((report) => tunnelCarriesSource(report, input.sourceEndpoint) ? report : undefined),
        Effect.catch(() => Effect.succeed(undefined)),
      );
    const restart = (report: TunnelStatusReport) =>
      tunnel.restartTunnel({ stateDirectory: input.stateDirectory, onlyIfDown: true }).pipe(
        Effect.mapError((error) =>
          new TunnelDownError({
            endpoint: report.endpoint ?? "",
            message:
              `the Source is reached through the managed tunnel ${report.endpoint ?? ""}, which is down (${report.detail}), `
              + `and restarting it failed: ${error.message}. Fix the cause, then run \`${recoveryOf(report)}\`.`,
          })
        ),
      );
    const before = yield* status;
    if (before?.lifecycle === "down" && before.restartable && input.restart) {
      yield* restart(before);
    }
    return <Success, Failure, Requirements>(
      isTransportFailure: (failure: Failure) => boolean,
      operation: Effect.Effect<Success, Failure, Requirements>,
      // Only opt in when the operation can be replayed after a transport failure.
      options?: { readonly retryAfterRestart: true },
    ): Effect.Effect<Success, Failure | TunnelDownError, Requirements> => before === undefined ? operation : operation.pipe(
      Effect.catch((failure) => Effect.gen(function*() {
        if (!isTransportFailure(failure)) return yield* Effect.fail(failure);
        const after = yield* status;
        if (after === undefined || after.lifecycle === "running") return yield* Effect.fail(failure);
        if (after.lifecycle === "down" && after.restartable && input.restart && options?.retryAfterRestart) {
          yield* restart(after);
          return yield* operation;
        }
        return yield* new TunnelDownError({
          endpoint: after.endpoint ?? "",
          message: after.lifecycle === "stopped"
            ? `the Source is unreachable because the managed tunnel ${after.endpoint ?? ""} is stopped. Run \`${recoveryOf(after)}\`.`
            : `the Source is unreachable because the managed tunnel ${after.endpoint ?? ""} is down: ${after.detail}. Run \`${recoveryOf(after)}\`.`,
        });
      })),
    );
  });
