import { Context, type Effect } from "effect";

import type { TunnelError } from "./tunnel.errors.ts";
import type { TunnelStartInput, TunnelStatusReport } from "./tunnel.types.ts";

export interface StopTunnelInput {
  readonly stateDirectory: string;
}

export interface StopTunnelResult {
  readonly stopped: boolean;
  readonly pid?: number | undefined;
}

export class Tunnel extends Context.Service<Tunnel, {
  /**
   * Start the approved loopback SSH tunnel, or reclaim it when a previous
   * process died. Idempotent: a live, ready tunnel is returned unchanged.
   */
  readonly startTunnel: (
    input: TunnelStartInput,
  ) => Effect.Effect<TunnelStatusReport, TunnelError>;
  readonly tunnelStatus: (
    input: StopTunnelInput,
  ) => Effect.Effect<TunnelStatusReport, TunnelError>;
  readonly stopTunnel: (
    input: StopTunnelInput,
  ) => Effect.Effect<StopTunnelResult, TunnelError>;
}>()("canonfig/enrollment/Tunnel") {}
