/**
 * The invitation envelope's framing, shared by the envelope file and the
 * private stdin reader. It stays free of Effect because the CLI entrypoint
 * routes enrollment commands through that reader before loading any command
 * graph.
 */
export const invitationEnvelopeEof = "CANONFIG-INVITE-EOF";
export const maximumEnvelopeBytes = 16 * 1024;
