# Incomplete Source responses

Enrollment JSON, revision metadata, blob ranges, and the doctor Source probe
listen for request and response-stream failures. Canonfig accepts a response
only after the complete HTTP message reaches `end`. Errors and premature
`close` settle the operation and destroy the request, including when the
socket has already closed and its idle timeout cannot fire.

Truncated enrollment JSON reports `EnrollmentTransportError`. Truncated
revision and blob responses report `TransportInterruptedError`. A truncated
doctor response produces a failed Source probe.

The Follower keeps one unfinished blob transfer. It can retain complete
ranges from before the interruption. A later fetch validates the saved prefix
against the same authenticated Source, signed revision, blob digest and
length before requesting remaining ranges. Bytes from an incomplete response
cannot advance the checkpoint. Canonfig publishes the finished blob to the
verified cache only after its full length and digest match.

The transport tests use a pinned loopback HTTPS Source. They truncate
responses, exercise retries and check that subsequent fetches reuse verified
bytes.
