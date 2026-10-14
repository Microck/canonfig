import { Context, type Effect } from "effect";

import type { TunnelError } from "./tunnel.errors.ts";
import type { TunnelStartInput, TunnelStatusReport } from "./tunnel.types.ts";

export interface StopTunnelInput {
  readonly stateDirectory: string;
}

export interface StopTunnelRequest extends StopTunnelInput {
  /** Also delete the recorded restart configuration. */
  readonly forget?: boolean | undefined;
}

export interface RestartTunnelInput extends StopTunnelInput {
  readonly timeoutMilliseconds?: number | undefined;
}

export interface StopTunnelResult {
  readonly stopped: boolean;
  readonly pid?: number | undefined;
  /** Whether a restart configuration remains, so `tunnel start` can bring it back. */
  readonly restartable: boolean;
}

export class Tunnel extends Context.Service<Tunnel, {
  /**
   * Start the approved loopback SSH tunnel, or reclaim it when a previous
   * process died. Idempotent: a live, ready tunnel is returned unchanged.
   * A successful start records the restart configuration durably.
   */
  readonly startTunnel: (
    input: TunnelStartInput,
  ) => Effect.Effect<TunnelStatusReport, TunnelError>;
  /** Start the tunnel again from its recorded configuration; no invitation needed. */
  readonly restartTunnel: (
    input: RestartTunnelInput,
  ) => Effect.Effect<TunnelStatusReport, TunnelError>;
  readonly tunnelStatus: (
    input: StopTunnelInput,
  ) => Effect.Effect<TunnelStatusReport, TunnelError>;
  /** Stop the process. The restart configuration is kept unless `forget` is set. */
  readonly stopTunnel: (
    input: StopTunnelRequest,
  ) => Effect.Effect<StopTunnelResult, TunnelError>;
}>()("canonfig/enrollment/Tunnel") {}
